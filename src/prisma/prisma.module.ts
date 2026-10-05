/**
 * Module global : PrismaService devient injectable dans n'importe quel
 * autre module sans avoir besoin de l'importer explicitement partout.
 */
import { Global, Module } from '@nestjs/common';
import { PrismaService } from './prisma.service.js';

@Global()
@Module({
  providers: [PrismaService],
  exports: [PrismaService],
})
export class PrismaModule {}
