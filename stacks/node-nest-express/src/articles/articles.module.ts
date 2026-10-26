import { Module } from '@nestjs/common';
import { ArticlesController } from './articles.controller.js';
import { ArticlesService } from './articles.service.js';
import { CommentsController } from './comments.controller.js';
import { CommentsService } from './comments.service.js';

@Module({
  controllers: [ArticlesController, CommentsController],
  providers: [ArticlesService, CommentsService],
})
export class ArticlesModule {}
