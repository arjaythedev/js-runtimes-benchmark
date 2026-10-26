import { Injectable, UnauthorizedException, UnprocessableEntityException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import bcrypt from 'bcrypt';
import { DatabaseService } from '../database/database.service.js';
import { isUniqueViolation, user } from '../common/format.js';
import { INSERT_USER, UPDATE_USER, USER_BY_EMAIL, USER_BY_ID } from '../common/sql.js';
import { LoginUserDto, NewUserDto, UpdateUserFieldsDto } from './users.dto.js';

const BCRYPT_COST = 10;

@Injectable()
export class UsersService {
  constructor(
    private readonly db: DatabaseService,
    private readonly jwt: JwtService,
  ) {}

  private sign(id: number): string {
    return this.jwt.sign({ sub: String(id) });
  }

  async register(dto: NewUserDto) {
    const hash = await bcrypt.hash(dto.password, BCRYPT_COST);
    try {
      const row = await this.db.one(INSERT_USER, [dto.username, dto.email, hash]);
      return { user: user(row, this.sign(row.id)) };
    } catch (e) {
      if (isUniqueViolation(e)) throw new UnprocessableEntityException('username or email is already taken');
      throw e;
    }
  }

  async login(dto: LoginUserDto) {
    const row = await this.db.one(USER_BY_EMAIL, [dto.email]);
    if (!row || !(await bcrypt.compare(dto.password, row.password_hash))) {
      throw new UnauthorizedException('invalid email or password');
    }
    return { user: user(row, this.sign(row.id)) };
  }

  async current(viewer: number, token: string) {
    const row = await this.db.one(USER_BY_ID, [viewer]);
    if (!row) throw new UnauthorizedException('unauthorized');
    return { user: user(row, token) };
  }

  async update(viewer: number, token: string, dto: UpdateUserFieldsDto) {
    const hash = dto.password == null ? null : await bcrypt.hash(dto.password, BCRYPT_COST);
    let row;
    try {
      row = await this.db.one(UPDATE_USER, [
        viewer,
        dto.email ?? null,
        dto.username ?? null,
        hash,
        dto.bio ?? null,
        dto.image ?? null,
      ]);
    } catch (e) {
      if (isUniqueViolation(e)) throw new UnprocessableEntityException('username or email is already taken');
      throw e;
    }
    if (!row) throw new UnauthorizedException('unauthorized');
    return { user: user(row, token) };
  }
}
