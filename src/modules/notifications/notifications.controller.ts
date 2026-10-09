import { Body, Controller, Get, HttpCode, HttpStatus, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiBearerAuth } from '@nestjs/swagger';
import { CurrentUser, type AuthenticatedUser } from '../../common/decorators/current-user.decorator.js';
import { SetPreferencesDto } from './dto/preferences.dto.js';
import { NotificationsService } from './notifications.service.js';

// Chaque personne ne voit et ne modifie que SES notifications : l'identifiant vient du jeton, jamais de l'adresse.
@ApiBearerAuth()
@Controller('notifications')
export class NotificationsController {
  constructor(private readonly notifications: NotificationsService) {}

  @Get()
  list(
    @CurrentUser() user: AuthenticatedUser,
    @Query('unread') unread?: string,
    @Query('limit') limit?: string,
    @Query('before') before?: string,
  ) {
    return this.notifications.listMine(user.id, {
      unreadOnly: unread === 'true',
      limit: limit === undefined ? undefined : Number(limit),
      before,
    });
  }

  // Déclaré avant « :id/read » pour ne jamais être pris pour un identifiant.
  @Get('unread-count')
  unreadCount(@CurrentUser() user: AuthenticatedUser) {
    return this.notifications.unreadCount(user.id);
  }

  @Get('preferences')
  preferences(@CurrentUser() user: AuthenticatedUser) {
    return this.notifications.getPreferences(user.id);
  }

  @Patch('preferences')
  setPreferences(@CurrentUser() user: AuthenticatedUser, @Body() dto: SetPreferencesDto) {
    return this.notifications.setEmailEnabled(user.id, dto.emailEnabled);
  }

  @HttpCode(HttpStatus.OK)
  @Post('read-all')
  readAll(@CurrentUser() user: AuthenticatedUser) {
    return this.notifications.markAllRead(user.id);
  }

  @HttpCode(HttpStatus.OK)
  @Post(':id/read')
  read(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) {
    return this.notifications.markRead(user.id, id);
  }
}
