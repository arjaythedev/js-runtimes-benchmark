import { Injectable, OnApplicationShutdown } from '@nestjs/common';
import pg from 'pg';
import { poolClient } from './pg-prepared.js';

// bigint (count(*), ids) -> number; timestamptz -> RFC 3339 with 3 fractional digits, truncated.
pg.types.setTypeParser(pg.types.builtins.INT8, (v) => Number(v));
pg.types.setTypeParser(pg.types.builtins.TIMESTAMPTZ, (v) => {
  // The session runs in UTC, so Postgres sends "2025-04-01 12:00:00.123456+00".
  const m = /^(\d{4}-\d\d-\d\d) (\d\d:\d\d:\d\d)(?:\.(\d+))?\+00$/.exec(v);
  if (!m) return new Date(v).toISOString();
  return `${m[1]}T${m[2]}.${((m[3] ?? '') + '000').slice(0, 3)}Z`;
});

@Injectable()
export class DatabaseService implements OnApplicationShutdown {
  readonly pool: pg.Pool;

  constructor() {
    this.pool = new pg.Pool({ Client: poolClient,
      connectionString: process.env.DATABASE_URL,
      max: Number(process.env.DB_POOL_MAX ?? 10),
      options: '-c TimeZone=UTC',
    });
  }

  async query<R extends pg.QueryResultRow = any>(text: string, values?: unknown[]): Promise<R[]> {
    return (await this.pool.query<R>(text, values)).rows;
  }

  async one<R extends pg.QueryResultRow = any>(text: string, values?: unknown[]): Promise<R | undefined> {
    return (await this.pool.query<R>(text, values)).rows[0];
  }

  async transaction<T>(fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {});
      throw e;
    } finally {
      client.release();
    }
  }

  async onApplicationShutdown() {
    await this.pool.end();
  }
}
