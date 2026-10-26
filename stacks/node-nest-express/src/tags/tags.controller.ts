import { Controller, Get } from '@nestjs/common';
import { Auth } from '../auth/auth.decorators.js';
import { TagsService } from './tags.service.js';

@Controller('tags')
@Auth('none')
export class TagsController {
  constructor(private readonly tags: TagsService) {}

  @Get()
  list() {
    return this.tags.list();
  }
}
