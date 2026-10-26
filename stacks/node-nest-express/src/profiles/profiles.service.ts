import { Injectable, NotFoundException } from '@nestjs/common';
import { DatabaseService } from '../database/database.service.js';
import { profile } from '../common/format.js';
import { FOLLOW, PROFILE, UNFOLLOW, USER_BY_USERNAME } from '../common/sql.js';

@Injectable()
export class ProfilesService {
  constructor(private readonly db: DatabaseService) {}

  async get(viewer: number, username: string) {
    const row = await this.db.one(PROFILE, [viewer, username]);
    if (!row) throw new NotFoundException('profile not found');
    return { profile: profile(row) };
  }

  async follow(viewer: number, username: string, follow: boolean) {
    const row = await this.db.one(USER_BY_USERNAME, [username]);
    if (!row) throw new NotFoundException('profile not found');
    await this.db.query(follow ? FOLLOW : UNFOLLOW, [viewer, row.id]);
    return { profile: profile(row, follow) };
  }
}
