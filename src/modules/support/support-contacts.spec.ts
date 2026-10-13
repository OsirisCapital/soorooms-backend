import { describe, expect, it, vi } from 'vitest';
import type { PrismaService } from '../../prisma/prisma.service.js';
import { SupportContactsService } from './support-contacts.service.js';
import { normalizeSupportPhone } from './support-phone.js';

describe('normalizeSupportPhone', () => {
  it('range un mobile camerounais local ou international au format +237…', () => {
    expect(normalizeSupportPhone('6 70 00 00 00')).toBe('+237670000000');
    expect(normalizeSupportPhone('+237 670 000 000')).toBe('+237670000000');
    expect(normalizeSupportPhone('00237670000000')).toBe('+237670000000');
  });
  it('accepte un numéro étranger avec indicatif, refuse le reste', () => {
    expect(normalizeSupportPhone('+33 6 12 34 56 78')).toBe('+33612345678');
    for (const bad of ['', 'abc', '12345', '+12', '12345678901234567890']) expect(normalizeSupportPhone(bad)).toBeNull();
  });
});

function make(count = 0) {
  const prisma = {
    supportContact: {
      findMany: vi.fn().mockResolvedValue([{ id: 'c1', label: 'Support', phone: '+237670000000', hours: null, active: true, position: 0, createdAt: new Date() }]),
      count: vi.fn().mockResolvedValue(count),
      create: vi.fn().mockImplementation(async ({ data }: { data: object }) => ({ id: 'c1', ...data })),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      findUnique: vi.fn().mockResolvedValue({ id: 'c1' }),
      deleteMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    auditLog: { create: vi.fn().mockResolvedValue({}) },
  };
  return { service: new SupportContactsService(prisma as unknown as PrismaService), prisma };
}

describe('SupportContactsService', () => {
  it('n’expose publiquement que les numéros actifs, sans détail interne', async () => {
    const { service, prisma } = make();
    expect(await service.listPublic()).toEqual([{ id: 'c1', label: 'Support', phone: '+237670000000', hours: null }]);
    expect(prisma.supportContact.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { active: true } }));
  });

  it('enregistre le numéro normalisé et journalise la création', async () => {
    const { service, prisma } = make();
    await service.create('admin1', { label: 'Support', phone: '670000000', hours: 'Lun–Sam 8 h–18 h' });
    expect(prisma.supportContact.create).toHaveBeenCalledWith({ data: expect.objectContaining({ phone: '+237670000000', hours: 'Lun–Sam 8 h–18 h', active: true }) });
    expect(prisma.auditLog.create).toHaveBeenCalled();
  });

  it('refuse un numéro invalide et plus de 10 contacts', async () => {
    await expect(make().service.create('a', { label: 'S', phone: 'abc' })).rejects.toThrow(/Numéro invalide/);
    await expect(make(10).service.create('a', { label: 'Support', phone: '670000000' })).rejects.toThrow(/10 numéros/);
  });

  it('modifie, désactive et supprime ; un identifiant inconnu est refusé', async () => {
    const { service, prisma } = make();
    await service.update('a', 'c1', { active: false });
    expect(prisma.supportContact.updateMany).toHaveBeenCalledWith({ where: { id: 'c1' }, data: { active: false } });
    await service.remove('a', 'c1');
    prisma.supportContact.updateMany.mockResolvedValue({ count: 0 });
    await expect(service.update('a', 'x', { label: 'Nouveau' })).rejects.toThrow(/introuvable/);
  });
});
