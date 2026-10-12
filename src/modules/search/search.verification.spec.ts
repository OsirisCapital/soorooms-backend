import { describe, expect, it } from 'vitest';
import { hostIdentityVerified } from './search.service.js';

describe('badge identité vérifiée', () => {
  it('vrai si un gestionnaire a un KYC approuvé', () => {
    expect(hostIdentityVerified({ collaborators: [{ user: { kycStatus: 'APPROVED' } }] })).toBe(true);
  });
  it('faux si le KYC n’est pas approuvé ou sans gestionnaire', () => {
    expect(hostIdentityVerified({ collaborators: [{ user: { kycStatus: 'PENDING' } }] })).toBe(false);
    expect(hostIdentityVerified({ collaborators: [] })).toBe(false);
    expect(hostIdentityVerified({})).toBe(false);
  });
});
