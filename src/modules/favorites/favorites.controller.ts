import { Controller, Delete, Get, HttpCode, HttpStatus, Param, Put } from '@nestjs/common';
import { ApiBearerAuth } from '@nestjs/swagger';
import { CurrentUser, type AuthenticatedUser } from '../../common/decorators/current-user.decorator.js';
import { FavoritesService } from './favorites.service.js';

@ApiBearerAuth()
@Controller('favorites')
export class FavoritesController {
  constructor(private readonly favoritesService: FavoritesService) {}

  @Get()
  list(@CurrentUser() user: AuthenticatedUser) {
    return this.favoritesService.list(user.id);
  }

  // Déclarée avant ':propertyId' pour ne jamais être confondue avec lui.
  @Get('ids')
  listIds(@CurrentUser() user: AuthenticatedUser) {
    return this.favoritesService.listIds(user.id);
  }

  @Put(':propertyId')
  add(@CurrentUser() user: AuthenticatedUser, @Param('propertyId') propertyId: string) {
    return this.favoritesService.add(user.id, propertyId);
  }

  @HttpCode(HttpStatus.NO_CONTENT)
  @Delete(':propertyId')
  async remove(@CurrentUser() user: AuthenticatedUser, @Param('propertyId') propertyId: string) {
    await this.favoritesService.remove(user.id, propertyId);
  }
}
