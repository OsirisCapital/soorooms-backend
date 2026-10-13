/**
 * Numéros WhatsApp du support, gérés par le super administrateur. Aucune API WhatsApp n'est nécessaire :
 * l'application affiche un bouton qui ouvre la conversation (lien wa.me), et le support répond depuis son téléphone.
 */
import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service.js';
import type { CreateSupportContactDto, UpdateSupportContactDto } from './dto/support-contact.dto.js';
import { normalizeSupportPhone } from './support-phone.js';

const MAX_CONTACTS = 10;
const BAD_PHONE = 'Numéro invalide. Saisissez-le avec son indicatif (par exemple +237 6XX XX XX XX) ; un mobile camerounais à 9 chiffres est accepté tel quel.';

@Injectable()
export class SupportContactsService {
  constructor(private readonly prisma: PrismaService) {}

  /** Ce que voit n'importe quel visiteur : les numéros actifs, dans l'ordre voulu. */
  async listPublic() {
    const rows = await this.prisma.supportContact.findMany({ where: { active: true }, orderBy: [{ position: 'asc' }, { createdAt: 'asc' }] });
    return rows.map((c) => ({ id: c.id, label: c.label, phone: c.phone, hours: c.hours }));
  }

  listAll() {
    return this.prisma.supportContact.findMany({ orderBy: [{ position: 'asc' }, { createdAt: 'asc' }] });
  }

  async create(actorId: string, dto: CreateSupportContactDto) {
    const phone = normalizeSupportPhone(dto.phone);
    if (!phone) throw new BadRequestException(BAD_PHONE);
    if ((await this.prisma.supportContact.count()) >= MAX_CONTACTS) {
      throw new BadRequestException(`Vous pouvez enregistrer ${MAX_CONTACTS} numéros au plus : supprimez-en un d'abord.`);
    }
    const contact = await this.prisma.supportContact.create({
      data: { label: dto.label, phone, hours: dto.hours || null, active: dto.active ?? true, position: dto.position ?? 0 },
    });
    await this.prisma.auditLog.create({ data: { actorId, action: 'support.contact.create', targetType: 'SupportContact', targetId: contact.id, meta: { label: contact.label } } });
    return contact;
  }

  async update(actorId: string, id: string, dto: UpdateSupportContactDto) {
    const data: { label?: string; phone?: string; hours?: string | null; active?: boolean; position?: number } = {};
    if (dto.label !== undefined) data.label = dto.label;
    if (dto.phone !== undefined) {
      const phone = normalizeSupportPhone(dto.phone);
      if (!phone) throw new BadRequestException(BAD_PHONE);
      data.phone = phone;
    }
    if (dto.hours !== undefined) data.hours = dto.hours || null;
    if (dto.active !== undefined) data.active = dto.active;
    if (dto.position !== undefined) data.position = dto.position;
    const res = await this.prisma.supportContact.updateMany({ where: { id }, data });
    if (res.count === 0) throw new NotFoundException('Contact introuvable.');
    await this.prisma.auditLog.create({ data: { actorId, action: 'support.contact.update', targetType: 'SupportContact', targetId: id, meta: { fields: Object.keys(data) } } });
    return this.prisma.supportContact.findUnique({ where: { id } });
  }

  async remove(actorId: string, id: string) {
    const res = await this.prisma.supportContact.deleteMany({ where: { id } });
    if (res.count === 0) throw new NotFoundException('Contact introuvable.');
    await this.prisma.auditLog.create({ data: { actorId, action: 'support.contact.delete', targetType: 'SupportContact', targetId: id } });
  }
}
