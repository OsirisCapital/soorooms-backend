import { Module } from '@nestjs/common';
import { CommonModule } from '../../common/common.module.js';
import { RoomsController } from './rooms.controller.js';
import { RoomsService } from './rooms.service.js';

@Module({
  imports: [CommonModule],
  controllers: [RoomsController],
  providers: [RoomsService],
})
export class RoomsModule {}
