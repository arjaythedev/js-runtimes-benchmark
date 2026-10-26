import { Injectable } from '@nestjs/common';
import { DatabaseService } from '../database/database.service.js';
import { TAGS } from '../common/sql.js';

@Injectable()
export class TagsService {
  constructor(private readonly db: DatabaseService) {}

  async list() {
    const rows = await this.db.query<{ name: string }>(TAGS);
    return { tags: rows.map((r) => r.name) };
  }
}
