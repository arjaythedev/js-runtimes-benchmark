import { Elysia } from 'elysia';
import { jwt } from '@elysiajs/jwt';
import { createPool } from './db.js';
import { HttpError } from './errors.js';

const workers = Number(process.env.WORKERS ?? 1);

// Shared decorations: the Postgres pool and the JWT helper; plus an `auth` macro.
export const setup = new Elysia({ name: 'setup' })
  // Total Postgres connections across all workers stay <= 90.
  .decorate('db', createPool(Math.floor(90 / workers)))
  .use(jwt({ name: 'jwt', secret: process.env.JWT_SECRET!, alg: 'HS256', exp: '30d' }))
  .macro({
    // auth: 'required' -> 401 without a valid token; 'optional' -> viewer 0 without a header, 401 if invalid.
    auth: (mode: 'required' | 'optional') => ({
      async resolve({ headers, jwt }) {
        const header = headers.authorization;
        if (header === undefined) {
          if (mode === 'optional') return { viewer: 0, token: '' };
          throw new HttpError(401, 'missing token');
        }
        // RealWorld's scheme is "Token <jwt>", not "Bearer".
        const [scheme, token] = header.split(' ');
        const payload = scheme === 'Token' && token ? await jwt.verify(token, { algorithms: ['HS256'] }) : false;
        if (!payload || typeof payload.exp !== 'number' || typeof payload.sub !== 'string' || !/^[1-9][0-9]*$/.test(payload.sub)) {
          throw new HttpError(401, 'invalid token');
        }
        return { viewer: Number(payload.sub), token };
      },
    }),
  });

export const signToken = (j: { sign(v: Record<string, unknown>): Promise<string> }, id: number) => j.sign({ sub: String(id) });
