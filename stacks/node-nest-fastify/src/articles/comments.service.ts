import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { DatabaseService } from '../database/database.service.js';
import { comment } from '../common/format.js';
import { COMMENT_OWNER, DELETE_COMMENT, INSERT_COMMENT, LIST_COMMENTS } from '../common/sql.js';
import { ArticlesService } from './articles.service.js';

@Injectable()
export class CommentsService {
  constructor(
    private readonly db: DatabaseService,
    private readonly articles: ArticlesService,
  ) {}

  async list(viewer: number, slug: string) {
    const id = await this.articles.articleId(slug);
    const rows = await this.db.query(LIST_COMMENTS, [viewer, id]);
    return { comments: rows.map((r) => comment(r)) };
  }

  async create(viewer: number, slug: string, body: string) {
    const id = await this.articles.articleId(slug);
    const row = await this.db.one(INSERT_COMMENT, [id, viewer, body]);
    return { comment: comment(row, false) };
  }

  async delete(viewer: number, slug: string, id: number) {
    const row = await this.db.one(COMMENT_OWNER, [id, slug]);
    if (!row) throw new NotFoundException('comment not found');
    if (row.author_id !== viewer) throw new ForbiddenException('not the author');
    await this.db.query(DELETE_COMMENT, [id]);
  }
}
