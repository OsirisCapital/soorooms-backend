import { Controller, Get, Param, Query } from '@nestjs/common';
import { Public } from '../../common/decorators/public.decorator.js';
import { SearchRoomsQueryDto } from './dto/search-rooms.query.dto.js';
import { SearchService } from './search.service.js';

// Entièrement public — un voyageur n'a pas besoin de compte pour chercher
// un logement, seulement pour réserver.
@Public()
@Controller('search')
export class SearchController {
  constructor(private readonly searchService: SearchService) {}

  @Get('rooms')
  searchRooms(@Query() query: SearchRoomsQueryDto) {
    return this.searchService.searchRooms(query);
  }

  @Get('properties/:id')
  findActiveProperty(@Param('id') id: string) {
    return this.searchService.findActiveProperty(id);
  }
}
