import { describe, expect, it, vi } from 'vitest';
import { PropertiesService } from './properties.service.js';
import { SearchService } from '../search/search.service.js';

const DTO = { title: 'Villa', description: 'x'.repeat(30), propertyType: 'HOTEL', city: 'Libreville', quarter: 'Louis', latitude: 0.4, longitude: 9.4 };

function props() {
  const prisma = { property: { create: vi.fn().mockResolvedValue({ id: 'p1' }), update: vi.fn().mockResolvedValue({ id: 'p1' }) } };
  return { service: new PropertiesService(prisma as never), prisma };
}

describe('pays d’un logement', () => {
  it('Cameroun par défaut', async () => {
    const { service, prisma } = props();
    await service.create('u1', DTO as never);
    expect(prisma.property.create.mock.calls[0][0].data.country).toBe('Cameroun');
  });

  it('normalise le nom ou le code du pays', async () => {
    const { service, prisma } = props();
    await service.create('u1', { ...DTO, country: 'gabon' } as never);
    expect(prisma.property.create.mock.calls[0][0].data.country).toBe('Gabon');
    await service.update('p1', { country: 'td' } as never);
    expect(prisma.property.update.mock.calls[0][0].data.country).toBe('Tchad');
  });

  it('refuse un pays non pris en charge', async () => {
    const { service } = props();
    await expect(service.create('u1', { ...DTO, country: 'Sénégal' } as never)).rejects.toThrow(/non pris en charge/);
  });
});

describe('recherche par pays', () => {
  function search() {
    const prisma = { room: { findMany: vi.fn().mockResolvedValue([]), count: vi.fn().mockResolvedValue(0) } };
    return { service: new SearchService(prisma as never), prisma };
  }

  it('filtre sur le pays ; le Cameroun inclut les anciens logements sans pays', async () => {
    const { service, prisma } = search();
    await service.searchRooms({ country: 'Cameroun' } as never);
    expect(prisma.room.findMany.mock.calls[0][0].where.property.OR).toEqual([{ country: { equals: 'Cameroun', mode: 'insensitive' } }, { country: null }]);
    await service.searchRooms({ country: 'Gabon' } as never);
    expect(prisma.room.findMany.mock.calls[1][0].where.property.OR).toEqual([{ country: { equals: 'Gabon', mode: 'insensitive' } }]);
  });

  it('un pays inconnu ne renvoie rien', async () => {
    const { service, prisma } = search();
    const r = await service.searchRooms({ country: 'Atlantide' } as never);
    expect(r.total).toBe(0);
    expect(prisma.room.findMany).not.toHaveBeenCalled();
  });
});
