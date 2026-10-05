import { PartialType } from '@nestjs/swagger';
import { CreateRoomDto } from './create-room.dto.js';

export class UpdateRoomDto extends PartialType(CreateRoomDto) {}
