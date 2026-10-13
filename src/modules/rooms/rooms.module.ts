import { Module } from '@nestjs/common';
import { CommonModule } from '../../common/common.module.js';
import { RoomBlocksController } from './room-blocks.controller.js';
import { RoomBlocksService } from './room-blocks.service.js';
import { RoomsController } from './rooms.controller.js';
import { RoomsService } from './rooms.service.js';

@Module({
  imports: [CommonModule],
  controllers: [RoomsController, RoomBlocksController],
  providers: [RoomsService, RoomBlocksService],
})
export class RoomsModule {}
