import { validate } from 'class-validator';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SubmitKycDto } from '../../modules/kyc/dto/submit-kyc.dto.js';
import { AddPhotoDto } from '../../modules/properties/dto/add-photo.dto.js';

const PHOTO = 'https://res.cloudinary.com/demo-cloud/image/upload/v1/soorooms/properties/abc.jpg';
const KYC_ID = 'https://res.cloudinary.com/demo-cloud/image/authenticated/v1/soorooms/kyc/id.jpg';
const KYC_PROOF = 'https://res.cloudinary.com/demo-cloud/image/authenticated/v1/soorooms/kyc/proof.pdf';

const previousCloud = process.env.CLOUDINARY_CLOUD_NAME;
beforeEach(() => {
  process.env.CLOUDINARY_CLOUD_NAME = 'demo-cloud';
});
afterEach(() => {
  if (previousCloud === undefined) delete process.env.CLOUDINARY_CLOUD_NAME;
  else process.env.CLOUDINARY_CLOUD_NAME = previousCloud;
});

function photoDto(url: unknown) {
  return Object.assign(new AddPhotoDto(), { url });
}
function kycDto(fields: Partial<Record<'idCardUrl' | 'proofOfAddressUrl', unknown>>) {
  return Object.assign(new SubmitKycDto(), fields);
}

describe('AddPhotoDto.url', () => {
  it('accepte une photo envoyée par notre application', async () => {
    expect(await validate(photoDto(PHOTO))).toHaveLength(0);
  });

  it('refuse un lien vers un site extérieur, avec un message en français', async () => {
    const errors = await validate(photoDto('https://example.com/photo.jpg'));
    expect(errors).toHaveLength(1);
    expect(Object.values(errors[0].constraints ?? {})[0]).toContain('envoyée depuis l\'application');
  });

  it('refuse un document KYC présenté comme photo', async () => {
    expect(await validate(photoDto(KYC_ID))).toHaveLength(1);
  });

  it("refuse tout quand CLOUDINARY_CLOUD_NAME n'est pas défini", async () => {
    delete process.env.CLOUDINARY_CLOUD_NAME;
    expect(await validate(photoDto(PHOTO))).toHaveLength(1);
  });

  it('refuse une valeur absente ou qui n’est pas du texte', async () => {
    expect(await validate(photoDto(undefined))).toHaveLength(1);
    expect(await validate(photoDto(12))).toHaveLength(1);
  });
});

describe('SubmitKycDto', () => {
  it("accepte une pièce d'identité privée, avec ou sans justificatif", async () => {
    expect(await validate(kycDto({ idCardUrl: KYC_ID }))).toHaveLength(0);
    expect(await validate(kycDto({ idCardUrl: KYC_ID, proofOfAddressUrl: KYC_PROOF }))).toHaveLength(0);
  });

  it("exige la pièce d'identité", async () => {
    expect(await validate(kycDto({}))).toHaveLength(1);
  });

  it('refuse un lien extérieur pour chacun des deux documents', async () => {
    const outside = 'https://example.com/cni.jpg';
    expect((await validate(kycDto({ idCardUrl: outside }))).map((e) => e.property)).toEqual(['idCardUrl']);
    expect((await validate(kycDto({ idCardUrl: KYC_ID, proofOfAddressUrl: outside }))).map((e) => e.property)).toEqual([
      'proofOfAddressUrl',
    ]);
  });

  it("refuse un fichier public (photo) donné comme document d'identité : il doit être privé", async () => {
    expect(await validate(kycDto({ idCardUrl: PHOTO }))).toHaveLength(1);
    expect(await validate(kycDto({ idCardUrl: KYC_ID, proofOfAddressUrl: PHOTO }))).toHaveLength(1);
  });
});
