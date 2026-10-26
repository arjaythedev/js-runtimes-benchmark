import { Elysia } from 'elysia';
import { all, one } from '../db.js';
import { HttpError } from '../errors.js';
import { profile } from '../format.js';
import { setup } from '../setup.js';
import { FOLLOW, PROFILE, UNFOLLOW, USER_BY_USERNAME } from '../sql.js';

export const profiles = new Elysia({ prefix: '/api/profiles' })
  .use(setup)
  .get(
    '/:username',
    async ({ db, viewer, params }) => {
      const row = await one(db, PROFILE, [viewer, params.username]);
      if (!row) throw new HttpError(404, 'profile not found');
      return { profile: profile(row) };
    },
    { auth: 'optional' },
  )
  .post('/:username/follow', async ({ db, viewer, params }) => {
    const row = await one(db, USER_BY_USERNAME, [params.username]);
    if (!row) throw new HttpError(404, 'profile not found');
    await all(db, FOLLOW, [viewer, row.id]);
    return { profile: profile(row, true) };
  }, { auth: 'required' })
  .delete('/:username/follow', async ({ db, viewer, params }) => {
    const row = await one(db, USER_BY_USERNAME, [params.username]);
    if (!row) throw new HttpError(404, 'profile not found');
    await all(db, UNFOLLOW, [viewer, row.id]);
    return { profile: profile(row, false) };
  }, { auth: 'required' });
