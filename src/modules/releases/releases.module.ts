import { Module } from '@nestjs/common';
import { AppVersionController, ReleasesAdminController } from './releases.controller.js';
import { ReleasesService } from './releases.service.js';

@Module({
  controllers: [AppVersionController, ReleasesAdminController],
  providers: [ReleasesService],
})
export class ReleasesModule {}
