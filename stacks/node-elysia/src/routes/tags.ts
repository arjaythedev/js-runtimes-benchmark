import { Elysia } from 'elysia';
import { all } from '../db.js';
import { setup } from '../setup.js';
import { TAGS } from '../sql.js';

export const tags = new Elysia()
  .use(setup)
  .get('/api/tags', async ({ db }) => ({ tags: (await all(db, TAGS)).map((r) => r.name) }));
