import { Module } from '@nestjs/common';
import { CommonModule } from '../../common/common.module.js';
import { BookingsModule } from '../bookings/bookings.module.js';
import { PropertiesController } from './properties.controller.js';
import { PropertiesService } from './properties.service.js';

@Module({
  imports: [CommonModule, BookingsModule],
  controllers: [PropertiesController],
  providers: [PropertiesService],
  exports: [PropertiesService],
})
export class PropertiesModule {}
