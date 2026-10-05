import { IsPhoneNumber, IsString } from 'class-validator';
import { Transform } from 'class-transformer';
import { normalizePhone } from '../../../common/utils/phone.js';

export class LoginDto {
  @Transform(({ value }) => normalizePhone(value))
  @IsPhoneNumber('CM')
  phone!: string;

  @IsString()
  password!: string;
}
