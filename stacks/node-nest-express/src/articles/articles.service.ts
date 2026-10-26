import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { DatabaseService } from '../database/database.service.js';
import { article } from '../common/format.js';
import * as sql from '../common/sql.js';
import { NewArticleFieldsDto, UpdateArticleFieldsDto } from './articles.dto.js';

export interface ListFilter {
  tag?: string;
  author?: string;
  favorited?: string;
}

@Injectable()
export class ArticlesService {
  constructor(private readonly db: DatabaseService) {}

  private async page(list: string, count: string, listArgs: unknown[], countArgs: unknown[]) {
    const rows = await this.db.query(list, listArgs);
    const [{ count: n }] = await this.db.query(count, countArgs);
    return { articles: rows.map((r) => article(r, false)), articlesCount: n };
  }

  // The first non-empty filter in the order tag, author, favorited applies.
  list(viewer: number, limit: number, offset: number, f: ListFilter) {
    if (f.tag) return this.page(sql.LIST_BY_TAG, sql.COUNT_BY_TAG, [viewer, limit, offset, f.tag], [f.tag]);
    if (f.author) return this.page(sql.LIST_BY_AUTHOR, sql.COUNT_BY_AUTHOR, [viewer, limit, offset, f.author], [f.author]);
    if (f.favorited) {
      return this.page(sql.LIST_BY_FAVORITED, sql.COUNT_BY_FAVORITED, [viewer, limit, offset, f.favorited], [f.favorited]);
    }
    return this.page(sql.LIST_ALL, sql.COUNT_ALL, [viewer, limit, offset], []);
  }

  feed(viewer: number, limit: number, offset: number) {
    return this.page(sql.LIST_FEED, sql.COUNT_FEED, [viewer, limit, offset], [viewer]);
  }

  async fullArticle(viewer: number, query: string, key: string | number) {
    const row = await this.db.one(query, [viewer, key]);
    if (!row) throw new NotFoundException('article not found');
    return { article: article(row, true) };
  }

  get(viewer: number, slug: string) {
    return this.fullArticle(viewer, sql.ARTICLE_BY_SLUG, slug);
  }

  async create(viewer: number, dto: NewArticleFieldsDto) {
    const tags = dto.tagList ?? [];
    const id = await this.db.transaction(async (client) => {
      const { rows } = await client.query(sql.INSERT_ARTICLE, [viewer, dto.title, dto.description, dto.body]);
      const id: number = rows[0].id;
      if (tags.length > 0) {
        await client.query(sql.INSERT_TAGS, [tags]);
        await client.query(sql.INSERT_ARTICLE_TAGS, [id, tags]);
      }
      return id;
    });
    return this.fullArticle(viewer, sql.ARTICLE_BY_ID, id);
  }

  // 404 if the slug is unknown, 403 if the viewer is not the author.
  private async owned(viewer: number, slug: string): Promise<number> {
    const row = await this.db.one(sql.ARTICLE_OWNER, [slug]);
    if (!row) throw new NotFoundException('article not found');
    if (row.author_id !== viewer) throw new ForbiddenException('not the author');
    return row.id;
  }

  async update(viewer: number, slug: string, dto: UpdateArticleFieldsDto) {
    const id = await this.owned(viewer, slug);
    await this.db.query(sql.UPDATE_ARTICLE, [id, dto.title ?? null, dto.description ?? null, dto.body ?? null]);
    return this.fullArticle(viewer, sql.ARTICLE_BY_ID, id);
  }

  async delete(viewer: number, slug: string) {
    const id = await this.owned(viewer, slug);
    await this.db.query(sql.DELETE_ARTICLE, [id]);
  }

  async articleId(slug: string): Promise<number> {
    const row = await this.db.one(sql.ARTICLE_ID_BY_SLUG, [slug]);
    if (!row) throw new NotFoundException('article not found');
    return row.id;
  }

  async favorite(viewer: number, slug: string, favorite: boolean) {
    const id = await this.articleId(slug);
    await this.db.query(favorite ? sql.FAVORITE : sql.UNFAVORITE, [viewer, id]);
    return this.fullArticle(viewer, sql.ARTICLE_BY_ID, id);
  }
}
