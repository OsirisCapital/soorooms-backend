import { Body, Controller, HttpCode, HttpStatus, Post } from '@nestjs/common';
import { ApiBearerAuth } from '@nestjs/swagger';
import { UploadSignatureDto } from './dto/upload-signature.dto.js';
import { UploadsService } from './uploads.service.js';

@ApiBearerAuth()
@Controller('uploads')
export class UploadsController {
  constructor(private readonly uploadsService: UploadsService) {}

  // Authentifié (JwtAuthGuard global) : on ne signe pas d'envois pour des anonymes.
  @HttpCode(HttpStatus.OK)
  @Post('signature')
  signature(@Body() dto: UploadSignatureDto) {
    return this.uploadsService.createSignature(dto.purpose);
  }
}
