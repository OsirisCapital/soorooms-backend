import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post } from '@nestjs/common';
import { ApiBearerAuth } from '@nestjs/swagger';
import { CurrentUser, type AuthenticatedUser } from '../../common/decorators/current-user.decorator.js';
import { BookingsService } from './bookings.service.js';
import { CreateBookingDto } from './dto/create-booking.dto.js';
import { CreateOfferDto } from './dto/create-offer.dto.js';
import { RaiseDisputeDto } from './dto/raise-dispute.dto.js';

@ApiBearerAuth()
@Controller('bookings')
export class BookingsController {
  constructor(private readonly bookingsService: BookingsService) {}

  @Post()
  create(@CurrentUser() user: AuthenticatedUser, @Body() dto: CreateBookingDto) {
    return this.bookingsService.create(user.id, dto);
  }

  @Get('mine')
  findMine(@CurrentUser() user: AuthenticatedUser) {
    return this.bookingsService.findMine(user.id);
  }

  @Get(':id')
  findOne(@Param('id') id: string, @CurrentUser() user: AuthenticatedUser) {
    return this.bookingsService.findOne(id, user.id);
  }

  // La vérification que l'appelant est bien partie prenante (voyageur ou
  // collaborateur du logement) se fait à l'intérieur du service — pas de
  // guard générique ici, car ni le voyageur ni un simple :id de
  // réservation ne correspondent au schéma de PropertyCollaboratorGuard.
  @Post(':id/offers')
  counterOffer(
    @Param('id') id: string,
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: CreateOfferDto,
  ) {
    return this.bookingsService.counterOffer(id, user.id, dto);
  }

  @HttpCode(HttpStatus.OK)
  @Post(':id/accept')
  accept(@Param('id') id: string, @CurrentUser() user: AuthenticatedUser) {
    return this.bookingsService.acceptOffer(id, user.id);
  }

  @HttpCode(HttpStatus.OK)
  @Post(':id/reject')
  reject(@Param('id') id: string, @CurrentUser() user: AuthenticatedUser) {
    return this.bookingsService.rejectOffer(id, user.id);
  }

  // Double validation post-paiement — voir BookingsService pour la
  // logique complète (les deux confirmations sont requises).
  @HttpCode(HttpStatus.OK)
  @Post(':id/confirm-checkin')
  confirmCheckin(@Param('id') id: string, @CurrentUser() user: AuthenticatedUser) {
    return this.bookingsService.confirmCheckin(id, user.id);
  }

  @HttpCode(HttpStatus.OK)
  @Post(':id/confirm-hosting')
  confirmHosting(@Param('id') id: string, @CurrentUser() user: AuthenticatedUser) {
    return this.bookingsService.confirmHosting(id, user.id);
  }

  @HttpCode(HttpStatus.OK)
  @Post(':id/dispute')
  raiseDispute(
    @Param('id') id: string,
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: RaiseDisputeDto,
  ) {
    return this.bookingsService.raiseDispute(id, user.id, dto);
  }
}
