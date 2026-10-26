import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, ParseIntPipe, Post } from '@nestjs/common';
import { Auth, Viewer } from '../auth/auth.decorators.js';
import { CreateCommentDto } from './articles.dto.js';
import { CommentsService } from './comments.service.js';

@Controller('articles/:slug/comments')
export class CommentsController {
  constructor(private readonly comments: CommentsService) {}

  @Get()
  @Auth('optional')
  list(@Viewer() viewer: number, @Param('slug') slug: string) {
    return this.comments.list(viewer, slug);
  }

  @Post()
  create(@Viewer() viewer: number, @Param('slug') slug: string, @Body() body: CreateCommentDto) {
    return this.comments.create(viewer, slug, body.comment.body);
  }

  // A non-integer id can't name a comment: 404, not 400.
  @Delete(':id')
  @HttpCode(204)
  async delete(
    @Viewer() viewer: number,
    @Param('slug') slug: string,
    @Param('id', new ParseIntPipe({ errorHttpStatusCode: HttpStatus.NOT_FOUND })) id: number,
  ) {
    await this.comments.delete(viewer, slug, id);
  }
}
