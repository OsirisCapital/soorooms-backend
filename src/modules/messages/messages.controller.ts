import { Body, Controller, Get, HttpCode, HttpStatus, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { ApiBearerAuth } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { CurrentUser, type AuthenticatedUser } from '../../common/decorators/current-user.decorator.js';
import { SendMessageDto } from './dto/messages.dto.js';
import { MessagesService } from './messages.service.js';

/** Chacun ne voit que les conversations des réservations auxquelles il participe. */
@ApiBearerAuth()
@Controller('messages')
export class MessagesController {
  constructor(private readonly messages: MessagesService) {}

  @Get('conversations')
  list(@CurrentUser() user: AuthenticatedUser) {
    return this.messages.listConversations(user.id);
  }

  @Get('unread-count')
  unread(@CurrentUser() user: AuthenticatedUser) {
    return this.messages.unreadConversations(user.id);
  }

  @Get('conversations/:bookingId')
  get(@CurrentUser() user: AuthenticatedUser, @Param('bookingId', ParseUUIDPipe) bookingId: string) {
    return this.messages.getConversation(user.id, bookingId);
  }

  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @HttpCode(HttpStatus.OK)
  @Post('conversations/:bookingId')
  send(@CurrentUser() user: AuthenticatedUser, @Param('bookingId', ParseUUIDPipe) bookingId: string, @Body() dto: SendMessageDto) {
    return this.messages.send(user.id, bookingId, dto.content);
  }
}
