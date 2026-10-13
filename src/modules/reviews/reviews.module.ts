import { Module } from '@nestjs/common';
import { CommonModule } from '../../common/common.module.js';
import { BookingReviewController, HostReviewReplyController, MyReviewsController, PublicReviewsController } from './reviews.controller.js';
import { ReviewsService } from './reviews.service.js';

@Module({
  imports: [CommonModule],
  controllers: [BookingReviewController, MyReviewsController, PublicReviewsController, HostReviewReplyController],
  providers: [ReviewsService],
})
export class ReviewsModule {}
