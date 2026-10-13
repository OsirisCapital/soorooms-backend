import { describe, expect, it } from 'vitest';
import { describeError, fingerprint, normalizeMessage, normalizePath, shouldAlert } from './monitoring.utils.js';

describe('normalizePath', () => {
  it("remplace les identifiants et ignore la requête, pour ne pas créer une erreur par réservation", () => {
    expect(normalizePath('/bookings/3f2a9c1e-1111-4222-8333-444455556666/cancel?x=1')).toBe('/bookings/:id/cancel');
    expect(normalizePath('/properties/12/rooms')).toBe('/properties/:n/rooms');
  });
});

describe('fingerprint', () => {
  it('regroupe la même erreur sur des réservations différentes, et sépare des erreurs différentes', () => {
    const a = fingerprint('post', '/bookings/3f2a9c1e-1111-4222-8333-444455556666/cancel', 'Cannot read x of undefined');
    const b = fingerprint('POST', '/bookings/aaaaaaaa-1111-4222-8333-444455556666/cancel', 'Cannot read x of undefined');
    const c = fingerprint('POST', '/bookings/aaaaaaaa-1111-4222-8333-444455556666/cancel', 'Autre erreur');
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(a).toHaveLength(16);
  });
});

describe('normalizeMessage', () => {
  it('borne le texte et masque les identifiants', () => {
    expect(normalizeMessage('Booking 3f2a9c1e-1111-4222-8333-444455556666 \n introuvable')).toBe('Booking :id introuvable');
    expect(normalizeMessage('x'.repeat(1000))).toHaveLength(300);
  });
});

describe('shouldAlert', () => {
  it("alerte à la première fois, au retour d'une erreur résolue, puis aux seuils — pas à chaque requête", () => {
    expect(shouldAlert({ isNew: true, reopened: false, count: 1 })).toBe(true);
    expect(shouldAlert({ isNew: false, reopened: true, count: 4 })).toBe(true);
    expect(shouldAlert({ isNew: false, reopened: false, count: 2 })).toBe(false);
    expect(shouldAlert({ isNew: false, reopened: false, count: 10 })).toBe(true);
    expect(shouldAlert({ isNew: false, reopened: false, count: 11 })).toBe(false);
  });
});

describe('describeError', () => {
  it('accepte une Error, un texte ou un objet quelconque', () => {
    expect(describeError(new Error('boom')).message).toBe('boom');
    expect(describeError('texte').message).toBe('texte');
    expect(describeError({ a: 1 }).message).toBe('{"a":1}');
  });
});
