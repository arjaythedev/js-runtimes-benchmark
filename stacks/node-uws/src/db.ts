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

export const createPool = (max: number) =>
  new pg.Pool({ Client: poolClient, connectionString: process.env.DATABASE_URL, max, options: '-c TimeZone=UTC' });

export type Pool = pg.Pool;

export const one = async (pool: pg.Pool | pg.PoolClient, text: string, values?: unknown[]): Promise<any> =>
  (await pool.query(text, values)).rows[0];

export const all = async (pool: pg.Pool | pg.PoolClient, text: string, values?: unknown[]): Promise<any[]> =>
  (await pool.query(text, values)).rows;

export const isUniqueViolation = (e: unknown) => (e as { code?: string })?.code === '23505';
