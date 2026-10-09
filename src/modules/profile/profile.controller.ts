import { Body, Controller, Delete, Patch } from '@nestjs/common';
import { ApiBearerAuth } from '@nestjs/swagger';
import { CurrentUser, type AuthenticatedUser } from '../../common/decorators/current-user.decorator.js';
import { SetAvatarDto } from './dto/set-avatar.dto.js';
import { ProfileService } from './profile.service.js';

@ApiBearerAuth()
@Controller('profile')
export class ProfileController {
  constructor(private readonly profile: ProfileService) {}

  @Patch('avatar')
  setAvatar(@CurrentUser() user: AuthenticatedUser, @Body() dto: SetAvatarDto) {
    return this.profile.setAvatar(user.id, dto.avatarUrl);
  }

  @Delete('avatar')
  removeAvatar(@CurrentUser() user: AuthenticatedUser) {
    return this.profile.setAvatar(user.id, null);
  }
}
