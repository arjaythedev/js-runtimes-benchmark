import { Body, Controller, Delete, Get, HttpCode, Param, Post, Put, Query } from '@nestjs/common';
import { Auth, Viewer } from '../auth/auth.decorators.js';
import { ListArticlesQueryDto, page, PaginationQueryDto } from '../common/pagination.dto.js';
import { CreateArticleDto, UpdateArticleDto } from './articles.dto.js';
import { ArticlesService } from './articles.service.js';

@Controller('articles')
export class ArticlesController {
  constructor(private readonly articles: ArticlesService) {}

  @Get()
  @Auth('optional')
  list(@Viewer() viewer: number, @Query() query: ListArticlesQueryDto) {
    const { limit, offset } = page(query);
    return this.articles.list(viewer, limit, offset, query);
  }

  // Declared before ':slug' so "feed" is not taken for a slug.
  @Get('feed')
  feed(@Viewer() viewer: number, @Query() query: PaginationQueryDto) {
    const { limit, offset } = page(query);
    return this.articles.feed(viewer, limit, offset);
  }

  @Get(':slug')
  @Auth('optional')
  get(@Viewer() viewer: number, @Param('slug') slug: string) {
    return this.articles.get(viewer, slug);
  }

  @Post()
  create(@Viewer() viewer: number, @Body() body: CreateArticleDto) {
    return this.articles.create(viewer, body.article);
  }

  @Put(':slug')
  update(@Viewer() viewer: number, @Param('slug') slug: string, @Body() body: UpdateArticleDto) {
    return this.articles.update(viewer, slug, body.article);
  }

  @Delete(':slug')
  @HttpCode(204)
  async delete(@Viewer() viewer: number, @Param('slug') slug: string) {
    await this.articles.delete(viewer, slug);
  }

  @Post(':slug/favorite')
  @HttpCode(200)
  favorite(@Viewer() viewer: number, @Param('slug') slug: string) {
    return this.articles.favorite(viewer, slug, true);
  }

  @Delete(':slug/favorite')
  unfavorite(@Viewer() viewer: number, @Param('slug') slug: string) {
    return this.articles.favorite(viewer, slug, false);
  }
}
