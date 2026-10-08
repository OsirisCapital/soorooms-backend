import { Reflector } from '@nestjs/core';
import { describe, expect, it } from 'vitest';
import { PERMISSIONS_KEY } from '../../common/decorators/permissions.decorator.js';
import { KycController } from './kyc.controller.js';

const reflector = new Reflector();
const permissionsOf = (handler: object) => reflector.get(PERMISSIONS_KEY, handler as never);

describe('KycController — décisions réservées à l\'accès « kyc.review »', () => {
  it('approuver et refuser exigent kyc.review', () => {
    expect(permissionsOf(KycController.prototype.approve)).toEqual(['kyc.review']);
    expect(permissionsOf(KycController.prototype.reject)).toEqual(['kyc.review']);
  });

  it("soumettre et consulter sa propre demande n'exigent aucun accès d'équipe", () => {
    expect(permissionsOf(KycController.prototype.submit)).toBeUndefined();
    expect(permissionsOf(KycController.prototype.findMine)).toBeUndefined();
  });
});
