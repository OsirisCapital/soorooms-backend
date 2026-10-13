import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth } from '@nestjs/swagger';
import { CurrentUser, type AuthenticatedUser } from '../../common/decorators/current-user.decorator.js';
import { Public } from '../../common/decorators/public.decorator.js';
import { RequireCapability } from '../../common/decorators/require-capability.decorator.js';
import { PropertyCollaboratorGuard } from '../../common/guards/property-collaborator.guard.js';
import { CreateReviewDto, ReplyReviewDto } from './dto/review.dto.js';
import { ReviewsService } from './reviews.service.js';

/** Côté voyageur : noter un séjour terminé. */
@ApiBearerAuth()
@Controller('bookings/:bookingId/review')
export class BookingReviewController {
  constructor(private readonly reviews: ReviewsService) {}

  @Get()
  get(@Param('bookingId') bookingId: string, @CurrentUser() user: AuthenticatedUser) {
    return this.reviews.forBooking(bookingId, user.id);
  }

  @HttpCode(HttpStatus.CREATED)
  @Post()
  create(@Param('bookingId') bookingId: string, @CurrentUser() user: AuthenticatedUser, @Body() dto: CreateReviewDto) {
    return this.reviews.create(bookingId, user.id, dto);
  }
}

@ApiBearerAuth()
@Controller('reviews')
export class MyReviewsController {
  constructor(private readonly reviews: ReviewsService) {}

  @Get('mine')
  mine(@CurrentUser() user: AuthenticatedUser) {
    return this.reviews.mine(user.id);
  }
}

/** Visible de tous : les avis aident à choisir un logement, même sans compte. */
@Public()
@Controller('properties/:propertyId/reviews')
export class PublicReviewsController {
  constructor(private readonly reviews: ReviewsService) {}

  @Get()
  list(@Param('propertyId') propertyId: string, @Query('before') before?: string) {
    return this.reviews.forProperty(propertyId, before);
  }
}

/** Côté hôte : répondre publiquement (gérants, gestionnaires, agents et réceptionnistes ; pas le comptable). */
@UseGuards(PropertyCollaboratorGuard)
@RequireCapability('bookings.manage')
@ApiBearerAuth()
@Controller('properties/:propertyId/reviews/:reviewId/reply')
export class HostReviewReplyController {
  constructor(private readonly reviews: ReviewsService) {}

  @HttpCode(HttpStatus.OK)
  @Post()
  reply(@Param('propertyId') propertyId: string, @Param('reviewId') reviewId: string, @Body() dto: ReplyReviewDto) {
    return this.reviews.reply(propertyId, reviewId, dto.reply);
  }
}
