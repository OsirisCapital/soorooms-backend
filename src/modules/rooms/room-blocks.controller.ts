import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth } from '@nestjs/swagger';
import { CurrentUser, type AuthenticatedUser } from '../../common/decorators/current-user.decorator.js';
import { RequireCapability } from '../../common/decorators/require-capability.decorator.js';
import { PropertyCollaboratorGuard } from '../../common/guards/property-collaborator.guard.js';
import { CreateRoomBlockDto } from './dto/room-block.dto.js';
import { RoomBlocksService } from './room-blocks.service.js';

// Fermer des dates est une affaire de réservations : gérants, gestionnaires, agents et réceptionnistes (pas le comptable).
@UseGuards(PropertyCollaboratorGuard)
@RequireCapability('bookings.manage')
@ApiBearerAuth()
@Controller('properties/:propertyId/rooms/:roomId')
export class RoomBlocksController {
  constructor(private readonly blocks: RoomBlocksService) {}

  @Get('calendar')
  calendar(@Param('propertyId') propertyId: string, @Param('roomId') roomId: string, @Query('from') from?: string, @Query('days') days?: string) {
    return this.blocks.calendar(propertyId, roomId, from, days);
  }

  @Get('blocks')
  list(@Param('propertyId') propertyId: string, @Param('roomId') roomId: string) {
    return this.blocks.list(propertyId, roomId);
  }

  @HttpCode(HttpStatus.CREATED)
  @Post('blocks')
  create(@Param('propertyId') propertyId: string, @Param('roomId') roomId: string, @CurrentUser() user: AuthenticatedUser, @Body() dto: CreateRoomBlockDto) {
    return this.blocks.create(propertyId, roomId, user.id, dto);
  }

  @HttpCode(HttpStatus.NO_CONTENT)
  @Delete('blocks/:blockId')
  async remove(@Param('propertyId') propertyId: string, @Param('roomId') roomId: string, @Param('blockId') blockId: string) {
    await this.blocks.remove(propertyId, roomId, blockId);
  }
}
