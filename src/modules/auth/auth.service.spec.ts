import * as bcrypt from 'bcrypt';
import { describe, expect, it, vi } from 'vitest';
import { AuthService } from './auth.service.js';

// ---------------------------------------------------------------------
// Fausse base en mémoire : on vérifie l'ÉTAT des comptes après chaque
// scénario, pas seulement que telle fonction a été appelée.
// ---------------------------------------------------------------------

type Row = Record<string, any>;

function matches(row: Row, where: Row): boolean {
  return Object.entries(where).every(([key, expected]) => {
    const actual = row[key];
    if (expected === null) return actual === null || actual === undefined;
    if (expected && typeof expected === 'object' && 'gt' in expected) return actual > expected.gt;
    return actual === expected;
  });
}

class Table {
  rows: Row[] = [];
  private counter = 0;
  constructor(
    private readonly prefix: string,
    private readonly defaults: () => Row,
    private readonly uniques: string[] = [],
  ) {}

  private clone(row: Row | undefined) {
    return row ? { ...row } : null;
  }

  async findUnique({ where }: { where: Row }) {
    return this.clone(this.rows.find((row) => matches(row, where)));
  }
  async findFirst({ where }: { where: Row }) {
    return this.clone(this.rows.find((row) => matches(row, where)));
  }
  async create({ data }: { data: Row }) {
    for (const key of this.uniques) {
      if (data[key] != null && this.rows.some((row) => row[key] === data[key])) {
        throw Object.assign(new Error(`Unique constraint failed on ${key}`), { code: 'P2002' });
      }
    }
    // Comme Prisma : un champ `undefined` signifie « ne pas renseigner », jamais « écraser par undefined ».
    const given = Object.fromEntries(Object.entries(data).filter(([, value]) => value !== undefined));
    const row = { id: `${this.prefix}${++this.counter}`, createdAt: new Date(), ...this.defaults(), ...given };
    this.rows.push(row);
    return { ...row };
  }
  async update({ where, data }: { where: Row; data: Row }) {
    const row = this.rows.find((r) => matches(r, where));
    if (!row) throw new Error('Enregistrement introuvable');
    Object.assign(row, Object.fromEntries(Object.entries(data).filter(([, value]) => value !== undefined)));
    return { ...row };
  }
  async updateMany({ where, data }: { where: Row; data: Row }) {
    const targets = this.rows.filter((r) => matches(r, where));
    targets.forEach((r) => Object.assign(r, data));
    return { count: targets.length };
  }
}

class FakeDb {
  user = new Table('u', () => ({ role: 'TRAVELER', passwordHash: null, email: null, emailVerifiedAt: null, googleId: null, avatarUrl: null }), ['email', 'phone', 'googleId']);
  emailVerificationToken = new Table('ev', () => ({ usedAt: null }));
  passwordResetToken = new Table('pr', () => ({ usedAt: null }));
  refreshToken = new Table('rt', () => ({ revokedAt: null }));

  // Les jetons de vérification portent leur utilisateur quand on le demande (include: { user: true }).
  constructor() {
    const original = this.emailVerificationToken.findUnique.bind(this.emailVerificationToken);
    this.emailVerificationToken.findUnique = async (args: any) => {
      const record = await original(args);
      return record && args.include?.user
        ? { ...record, user: await this.user.findUnique({ where: { id: record.userId } }) }
        : record;
    };
  }

  async $transaction<T>(fn: (tx: FakeDb) => Promise<T>): Promise<T> {
    return fn(this);
  }

  async addUser(data: Row = {}) {
    return this.user.create({ data: { fullName: 'Aline K.', phone: `+2376${Math.floor(Math.random() * 1e8)}`, ...data } });
  }
}

const HASH = bcrypt.hashSync('motdepasse1', 4);

function setup(nodeEnv = 'production') {
  const db = new FakeDb();
  const mail = { send: vi.fn().mockResolvedValue(true) };
  const jwt = { signAsync: vi.fn().mockResolvedValue('jwt') };
  const values: Record<string, unknown> = {
    nodeEnv,
    frontendUrl: 'https://soorooms.vercel.app',
    'jwt.accessSecret': 's1',
    'jwt.accessExpiresIn': '15m',
    'jwt.refreshSecret': 's2',
    'jwt.refreshExpiresIn': '7d',
  };
  const service = new AuthService(db as never, jwt as never, { get: (key: string) => values[key] } as never, mail as never);
  return { service, db, mail, jwt };
}

/** Jeton brut contenu dans le lien du dernier e-mail envoyé. */
function tokenFromLastMail(mail: { send: ReturnType<typeof vi.fn> }): string {
  const sent = mail.send.mock.calls.at(-1)?.[0];
  const match = /token=([0-9a-f]{64})/.exec(sent?.text ?? '');
  if (!match) throw new Error('Aucun lien dans le dernier e-mail');
  return match[1];
}

const registration = { fullName: 'Aline K.', phone: '+237694952656', email: 'aline@example.com', password: 'motdepasse1' };

// ---------------------------------------------------------------------

describe('inscription', () => {
  it('crée le compte avec une adresse NON vérifiée et envoie le lien de vérification', async () => {
    const { service, db, mail } = setup();
    const tokens = await service.register(registration);

    expect(tokens).toEqual({ accessToken: 'jwt', refreshToken: 'jwt' });
    const user = db.user.rows[0];
    expect(user).toMatchObject({ email: 'aline@example.com', emailVerifiedAt: null });

    await vi.waitFor(() => expect(mail.send).toHaveBeenCalledTimes(1));
    const sent = mail.send.mock.calls[0][0];
    expect(sent.to).toEqual({ email: 'aline@example.com', name: 'Aline K.' });
    expect(sent.text).toContain('https://soorooms.vercel.app/verify-email?token=');
  });

  it('réussit même si l’e-mail ne part pas (Brevo en panne)', async () => {
    const { service, db, mail } = setup();
    mail.send.mockResolvedValue(false);
    await expect(service.register(registration)).resolves.toMatchObject({ accessToken: 'jwt' });
    expect(db.user.rows).toHaveLength(1);
  });

  it('refuse une adresse déjà VÉRIFIÉE par un autre compte', async () => {
    const { service, db } = setup();
    await db.addUser({ email: 'aline@example.com', emailVerifiedAt: new Date() });
    await expect(service.register(registration)).rejects.toThrow(/adresse e-mail/);
    expect(db.user.rows).toHaveLength(1); // aucun compte créé
  });

  it('libère une adresse jamais vérifiée : on ne peut pas « squatter » l’e-mail d’autrui', async () => {
    const { service, db } = setup();
    const squatter = await db.addUser({ email: 'aline@example.com', emailVerifiedAt: null, passwordHash: HASH });

    await service.register(registration);

    expect(db.user.rows.find((u) => u.id === squatter.id)?.email).toBeNull();
    expect(db.user.rows.find((u) => u.phone === registration.phone)?.email).toBe('aline@example.com');
  });

  it('traduit une course entre deux inscriptions identiques en conflit propre', async () => {
    const { service, db } = setup();
    await db.addUser({ phone: '+237611111111' });
    // Même numéro créé entre la vérification et l'écriture : la base refuse (P2002).
    vi.spyOn(db.user, 'findUnique').mockResolvedValueOnce(null).mockResolvedValueOnce(null);
    vi.spyOn(db.user, 'create').mockRejectedValue(Object.assign(new Error('dup'), { code: 'P2002' }));
    await expect(service.register({ ...registration, phone: '+237611111111' })).rejects.toThrow(/existe déjà/);
  });
});

describe('vérification de l’adresse e-mail', () => {
  async function registered() {
    const ctx = setup();
    await ctx.service.register(registration);
    await vi.waitFor(() => expect(ctx.mail.send).toHaveBeenCalled());
    return { ...ctx, token: tokenFromLastMail(ctx.mail) };
  }

  it('vérifie l’adresse avec le lien reçu', async () => {
    const { service, db, token } = await registered();
    await expect(service.verifyEmail(token)).resolves.toEqual({ message: 'Adresse e-mail vérifiée.' });
    expect(db.user.rows[0].emailVerifiedAt).toBeInstanceOf(Date);
    expect(db.emailVerificationToken.rows[0].usedAt).toBeInstanceOf(Date);
  });

  it('ne stocke jamais le jeton en clair', async () => {
    const { db, token } = await registered();
    expect(JSON.stringify(db.emailVerificationToken.rows)).not.toContain(token);
  });

  it('accepte une seconde ouverture du même lien sans erreur', async () => {
    const { service, token } = await registered();
    await service.verifyEmail(token);
    await expect(service.verifyEmail(token)).resolves.toEqual({ message: 'Votre adresse e-mail est déjà vérifiée.' });
  });

  it('refuse un jeton inconnu', async () => {
    const { service } = await registered();
    await expect(service.verifyEmail('0'.repeat(64))).rejects.toThrow(/invalide ou expiré/);
  });

  it('refuse un lien expiré', async () => {
    const { service, db, token } = await registered();
    db.emailVerificationToken.rows[0].expiresAt = new Date(Date.now() - 1000);
    await expect(service.verifyEmail(token)).rejects.toThrow(/invalide ou expiré/);
    expect(db.user.rows[0].emailVerifiedAt).toBeNull();
  });

  it('refuse un lien dont l’adresse n’est plus celle du compte', async () => {
    const { service, db, token } = await registered();
    db.user.rows[0].email = 'autre@example.com';
    await expect(service.verifyEmail(token)).rejects.toThrow(/invalide ou expiré/);
    expect(db.user.rows[0].emailVerifiedAt).toBeNull();
  });

  it('refuse un lien dont l’adresse a été libérée au profit de quelqu’un d’autre', async () => {
    const { service, db, token } = await registered();
    db.user.rows[0].email = null; // libérée (voir « squat »)
    await expect(service.verifyEmail(token)).rejects.toThrow(/invalide ou expiré/);
  });
});

describe('renvoi du lien de vérification', () => {
  it('refuse quand le compte n’a pas d’adresse', async () => {
    const { service, db } = setup();
    const user = await db.addUser();
    await expect(service.resendVerification(user.id)).rejects.toThrow(/Ajoutez d'abord/);
  });

  it('ne renvoie rien quand l’adresse est déjà vérifiée', async () => {
    const { service, db, mail } = setup();
    const user = await db.addUser({ email: 'a@b.cm', emailVerifiedAt: new Date() });
    await expect(service.resendVerification(user.id)).resolves.toEqual({ message: 'Votre adresse e-mail est déjà vérifiée.' });
    expect(mail.send).not.toHaveBeenCalled();
  });

  it('bloque un second envoi dans la minute (429)', async () => {
    const { service, db, mail } = setup();
    const user = await db.addUser({ email: 'a@b.cm' });
    await service.resendVerification(user.id);
    await expect(service.resendVerification(user.id)).rejects.toMatchObject({ status: 429 });
    expect(mail.send).toHaveBeenCalledTimes(1);
  });

  it('renvoie à nouveau une fois le délai écoulé', async () => {
    const { service, db, mail } = setup();
    const user = await db.addUser({ email: 'a@b.cm' });
    await service.resendVerification(user.id);
    db.emailVerificationToken.rows[0].createdAt = new Date(Date.now() - 120_000);
    await service.resendVerification(user.id);
    expect(mail.send).toHaveBeenCalledTimes(2);
  });

  it('signale honnêtement un e-mail qui n’a pas pu partir', async () => {
    const { service, db, mail } = setup();
    mail.send.mockResolvedValue(false);
    const user = await db.addUser({ email: 'a@b.cm' });
    await expect(service.resendVerification(user.id)).rejects.toThrow(/momentanément indisponible/);
  });
});

describe('ajout ou changement d’adresse e-mail', () => {
  it('exige le bon mot de passe actuel', async () => {
    const { service, db } = setup();
    const user = await db.addUser({ passwordHash: HASH });
    await expect(service.setEmail(user.id, { email: 'x@y.cm', currentPassword: 'faux' })).rejects.toThrow(/Mot de passe actuel/);
    await expect(service.setEmail(user.id, { email: 'x@y.cm' })).rejects.toThrow(/Mot de passe actuel/);
    expect(db.user.rows[0].email).toBeNull();
  });

  it('refuse aux comptes Google, dont l’adresse est gérée par Google', async () => {
    const { service, db } = setup();
    const user = await db.addUser({ googleId: 'g1', email: 'g@gmail.com', emailVerifiedAt: new Date() });
    await expect(service.setEmail(user.id, { email: 'x@y.cm', currentPassword: 'x' })).rejects.toThrow(/Google/);
    expect(db.user.rows[0].email).toBe('g@gmail.com');
  });

  it('enregistre l’adresse comme NON vérifiée et envoie le lien à la NOUVELLE adresse', async () => {
    const { service, db, mail } = setup();
    const user = await db.addUser({ passwordHash: HASH, email: 'ancienne@y.cm', emailVerifiedAt: new Date() });
    // Un lien de réinitialisation déjà émis vers l'ancienne adresse doit être annulé.
    await db.passwordResetToken.create({ data: { userId: user.id, tokenHash: 'h', expiresAt: new Date(Date.now() + 1e6) } });

    const result = await service.setEmail(user.id, { email: 'nouvelle@y.cm', currentPassword: 'motdepasse1' });

    expect(result).toMatchObject({ emailSent: true });
    expect(db.user.rows[0]).toMatchObject({ email: 'nouvelle@y.cm', emailVerifiedAt: null });
    expect(mail.send.mock.calls[0][0].to.email).toBe('nouvelle@y.cm');
    expect(db.passwordResetToken.rows[0].usedAt).toBeInstanceOf(Date);
  });

  it('refuse une adresse vérifiée par quelqu’un d’autre, sans toucher au compte', async () => {
    const { service, db } = setup();
    await db.addUser({ email: 'prise@y.cm', emailVerifiedAt: new Date() });
    const user = await db.addUser({ passwordHash: HASH, email: 'a@b.cm', emailVerifiedAt: new Date() });
    await expect(service.setEmail(user.id, { email: 'prise@y.cm', currentPassword: 'motdepasse1' })).rejects.toThrow(/existe déjà/);
    expect(db.user.rows.find((u) => u.id === user.id)).toMatchObject({ email: 'a@b.cm' });
    expect(db.user.rows.find((u) => u.id === user.id)?.emailVerifiedAt).toBeInstanceOf(Date);
  });
});

describe('mot de passe oublié', () => {
  const phone = '+237694952656';
  const verified = { phone, passwordHash: HASH, email: 'aline@example.com', emailVerifiedAt: new Date() };

  it('envoie le lien à l’adresse vérifiée, et rien d’autre dans la réponse en production', async () => {
    const { service, db, mail } = setup('production');
    await db.addUser(verified);
    const response = await service.forgotPassword({ phone });

    expect(Object.keys(response)).toEqual(['message']); // pas de devResetToken en production
    await vi.waitFor(() => expect(mail.send).toHaveBeenCalledTimes(1));
    const sent = mail.send.mock.calls[0][0];
    expect(sent.to.email).toBe('aline@example.com');
    expect(sent.text).toContain('https://soorooms.vercel.app/reset-password?token=');
    expect(db.passwordResetToken.rows).toHaveLength(1);
  });

  it('ne dit jamais si le compte existe : même réponse dans tous les cas', async () => {
    const a = setup('production');
    await a.db.addUser(verified);
    const b = setup('production'); // numéro inconnu
    const c = setup('production');
    await c.db.addUser({ ...verified, emailVerifiedAt: null }); // adresse non vérifiée
    const d = setup('production');
    await d.db.addUser({ phone, googleId: 'g1' }); // compte Google sans mot de passe

    const responses = await Promise.all([a, b, c, d].map((ctx) => ctx.service.forgotPassword({ phone })));
    expect(new Set(responses.map((r) => JSON.stringify(r))).size).toBe(1);
  });

  it('n’envoie RIEN à une adresse non vérifiée (elle peut appartenir à un inconnu)', async () => {
    const { service, db, mail } = setup('production');
    await db.addUser({ ...verified, emailVerifiedAt: null });
    await service.forgotPassword({ phone });
    expect(mail.send).not.toHaveBeenCalled();
    expect(db.passwordResetToken.rows).toHaveLength(0);
  });

  it('ne fait rien pour un compte sans adresse', async () => {
    const { service, db, mail } = setup('production');
    await db.addUser({ phone, passwordHash: HASH });
    await service.forgotPassword({ phone });
    expect(mail.send).not.toHaveBeenCalled();
    expect(db.passwordResetToken.rows).toHaveLength(0);
  });

  it('limite à un e-mail par minute et par compte', async () => {
    const { service, db, mail } = setup('production');
    await db.addUser(verified);
    await service.forgotPassword({ phone });
    await service.forgotPassword({ phone });
    await service.forgotPassword({ phone });
    await vi.waitFor(() => expect(mail.send).toHaveBeenCalledTimes(1));
    expect(db.passwordResetToken.rows).toHaveLength(1);
  });

  it('hors production, renvoie le jeton de test mais n’écrit toujours pas à une adresse non vérifiée', async () => {
    const { service, db, mail } = setup('development');
    await db.addUser({ ...verified, emailVerifiedAt: null });
    const response = (await service.forgotPassword({ phone })) as { devResetToken?: string };
    expect(response.devResetToken).toMatch(/^[0-9a-f]{64}$/);
    expect(mail.send).not.toHaveBeenCalled();
  });

  it('le lien reçu permet vraiment de changer le mot de passe, et déconnecte les sessions', async () => {
    const { service, db, mail } = setup('production');
    const user = await db.addUser(verified);
    await db.refreshToken.create({ data: { userId: user.id, tokenHash: 'session', expiresAt: new Date(Date.now() + 1e6) } });

    await service.forgotPassword({ phone });
    await vi.waitFor(() => expect(mail.send).toHaveBeenCalled());
    await service.resetPassword({ token: tokenFromLastMail(mail), newPassword: 'nouveaumotdepasse' });

    expect(await bcrypt.compare('nouveaumotdepasse', db.user.rows[0].passwordHash)).toBe(true);
    expect(db.refreshToken.rows[0].revokedAt).toBeInstanceOf(Date);
    // Le lien ne sert qu'une fois.
    await expect(service.resetPassword({ token: tokenFromLastMail(mail), newPassword: 'encoreautre12' })).rejects.toThrow(/invalide ou expiré/);
  });
});

describe('connexion Google', () => {
  const google = { googleId: 'g-123', fullName: 'Aline Google', email: 'aline@example.com', emailVerified: true };

  it('crée un compte avec une adresse vérifiée d’emblée', async () => {
    const { service, db } = setup();
    await service.loginWithGoogle(google);
    expect(db.user.rows[0]).toMatchObject({ googleId: 'g-123', email: 'aline@example.com' });
    expect(db.user.rows[0].emailVerifiedAt).toBeInstanceOf(Date);
  });

  it('ne retient pas une adresse que Google ne garantit pas', async () => {
    const { service, db } = setup();
    await service.loginWithGoogle({ ...google, emailVerified: false });
    expect(db.user.rows[0].email).toBeNull();
    expect(db.user.rows[0].emailVerifiedAt).toBeNull();
  });

  it('reconnaît un compte Google existant', async () => {
    const { service, db } = setup();
    await db.addUser({ googleId: 'g-123', email: 'aline@example.com', emailVerifiedAt: new Date() });
    await service.loginWithGoogle(google);
    expect(db.user.rows).toHaveLength(1);
  });

  it('relie Google à un compte téléphone dont l’adresse est VÉRIFIÉE (même personne)', async () => {
    const { service, db } = setup();
    await db.addUser({ passwordHash: HASH, email: 'aline@example.com', emailVerifiedAt: new Date() });
    await service.loginWithGoogle(google);
    expect(db.user.rows).toHaveLength(1);
    expect(db.user.rows[0].googleId).toBe('g-123');
  });

  it('SÉCURITÉ : ne relie JAMAIS Google à un compte dont l’adresse n’a pas été vérifiée', async () => {
    // Attaque : Mallory s'inscrit avec l'adresse d'Aline (sans pouvoir la vérifier), choisit son
    // propre mot de passe, puis attend qu'Aline se connecte avec Google pour hériter de son compte.
    const { service, db, jwt } = setup();
    const mallory = await db.addUser({ passwordHash: HASH, email: 'aline@example.com', emailVerifiedAt: null });

    await service.loginWithGoogle(google);

    const malloryAfter = db.user.rows.find((u) => u.id === mallory.id)!;
    expect(malloryAfter.googleId).toBeNull(); // jamais relié
    expect(malloryAfter.email).toBeNull(); // adresse libérée
    const aline = db.user.rows.find((u) => u.googleId === 'g-123')!;
    expect(aline.id).not.toBe(mallory.id); // compte distinct
    expect(aline.email).toBe('aline@example.com');
    // Les jetons émis sont ceux d'Aline, pas ceux du compte de Mallory.
    expect(jwt.signAsync.mock.calls[0][0].sub).toBe(aline.id);
  });
});
