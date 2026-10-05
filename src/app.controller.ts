import { Controller, Get } from '@nestjs/common';
import { Public } from './common/decorators/public.decorator.js';
import { AppService } from './app.service.js';

@Controller()
export class AppController {
  constructor(private readonly appService: AppService) {}

  // Sert de health check public — utile pour un load balancer ou un
  // service de monitoring qui n'a pas de token JWT.
  @Public()
  @Get()
  getHello(): string {
    return this.appService.getHello();
  }
}
