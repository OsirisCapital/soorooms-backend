import { IsPhoneNumber } from 'class-validator';
import { Transform } from 'class-transformer';
import { normalizePhone } from '../../../common/utils/phone.js';

export class ForgotPasswordDto {
  @Transform(({ value }) => normalizePhone(value))
  @IsPhoneNumber('CM')
  phone!: string;
}
