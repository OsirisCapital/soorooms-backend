import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post } from '@nestjs/common';
import { ApiBearerAuth } from '@nestjs/swagger';
import { CurrentUser, type AuthenticatedUser } from '../../common/decorators/current-user.decorator.js';
import { Public } from '../../common/decorators/public.decorator.js';
import { AttestationsService } from './attestations.service.js';
import { DeclineAttestationDto, RequestAttestationDto } from './dto/attestation.dto.js';

@ApiBearerAuth()
@Controller('bookings')
export class AttestationsController {
  constructor(private readonly attestations: AttestationsService) {}

  @Get(':id/attestation')
  get(@Param('id') id: string, @CurrentUser() user: AuthenticatedUser) {
    return this.attestations.state(id, user.id);
  }

  @Post(':id/attestation/request')
  @HttpCode(HttpStatus.OK)
  request(@Param('id') id: string, @CurrentUser() user: AuthenticatedUser, @Body() dto: RequestAttestationDto) {
    return this.attestations.request(id, user.id, dto.country);
  }

  @Post(':id/attestation/decline')
  @HttpCode(HttpStatus.OK)
  decline(@Param('id') id: string, @CurrentUser() user: AuthenticatedUser, @Body() dto: DeclineAttestationDto) {
    return this.attestations.decline(id, user.id, dto.reason);
  }

  @Post(':id/attestation/sign')
  @HttpCode(HttpStatus.OK)
  sign(@Param('id') id: string, @CurrentUser() user: AuthenticatedUser) {
    return this.attestations.sign(id, user.id);
  }
}

// Vérification ouverte à tous (ambassade, hôtel) : un code suffit, aucune donnée sensible n'est renvoyée.
@Public()
@Controller('attestations')
export class PublicAttestationsController {
  constructor(private readonly attestations: AttestationsService) {}

  @Get('verify/:code')
  verify(@Param('code') code: string) {
    return this.attestations.verify(code);
  }
}
