import { PartialType } from '@nestjs/swagger';
import { CreatePropertyDto } from './create-property.dto.js';

export class UpdatePropertyDto extends PartialType(CreatePropertyDto) {}
