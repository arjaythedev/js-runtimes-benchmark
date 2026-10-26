import { Elysia } from 'elysia';
import { node } from '@elysiajs/node';
import { errors } from './errors.js';
import { articles } from './routes/articles.js';
import { profiles } from './routes/profiles.js';
import { tags } from './routes/tags.js';
import { users } from './routes/users.js';

export const app = new Elysia({ adapter: node() })
  .use(errors)
  .use(users)
  .use(profiles)
  .use(articles)
  .use(tags);
