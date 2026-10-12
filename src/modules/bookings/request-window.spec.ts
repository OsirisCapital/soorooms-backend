import { describe, expect, it } from 'vitest';
import { isExpired, responseDeadline } from './request-window.js';

describe('délai de réponse', () => {
  const offer = new Date('2026-10-12T10:00:00Z');
  it("l'échéance est 2 h après l'offre", () => {
    expect(responseDeadline(offer).toISOString()).toBe('2026-10-12T12:00:00.000Z');
  });
  it('n’expire pas avant 2 h, expire à 2 h pile', () => {
    expect(isExpired(offer, new Date('2026-10-12T11:59:59Z'))).toBe(false);
    expect(isExpired(offer, new Date('2026-10-12T12:00:00Z'))).toBe(true);
  });
});
