import { ApiBearerAuth } from '@nestjs/swagger';
import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, Patch, Post, UseGuards } from '@nestjs/common';
import { PropertyCollaboratorGuard } from '../../common/guards/property-collaborator.guard.js';
import { CreateRoomDto } from './dto/create-room.dto.js';
import { UpdateRoomDto } from './dto/update-room.dto.js';
import { RoomsService } from './rooms.service.js';

// Toutes les routes exigent un collaborateur (MANAGER ou AGENT) de
// l'établissement — PropertyCollaboratorGuard lit :propertyId dans l'URL.
@UseGuards(PropertyCollaboratorGuard)
@Controller('properties/:propertyId/rooms')
@ApiBearerAuth()
export class RoomsController {
  constructor(private readonly roomsService: RoomsService) {}

  @Get()
  list(@Param('propertyId') propertyId: string) {
    return this.roomsService.list(propertyId);
  }

  @Post()
  create(@Param('propertyId') propertyId: string, @Body() dto: CreateRoomDto) {
    return this.roomsService.create(propertyId, dto);
  }

  @Patch(':roomId')
  update(
    @Param('propertyId') propertyId: string,
    @Param('roomId') roomId: string,
    @Body() dto: UpdateRoomDto,
  ) {
    return this.roomsService.update(propertyId, roomId, dto);
  }

  @HttpCode(HttpStatus.NO_CONTENT)
  @Delete(':roomId')
  async remove(@Param('propertyId') propertyId: string, @Param('roomId') roomId: string) {
    await this.roomsService.remove(propertyId, roomId);
  }
}
