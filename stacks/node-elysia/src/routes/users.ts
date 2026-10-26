import { Elysia, t } from 'elysia';
import bcrypt from 'bcrypt';
import { isUniqueViolation, one } from '../db.js';
import { HttpError } from '../errors.js';
import { user } from '../format.js';
import { setup, signToken } from '../setup.js';
import { INSERT_USER, UPDATE_USER, USER_BY_EMAIL, USER_BY_ID } from '../sql.js';

const BCRYPT_COST = 10;
const NonEmpty = t.String({ minLength: 1 });
const OptionalNonEmpty = t.Optional(t.Nullable(NonEmpty));
const OptionalString = t.Optional(t.Nullable(t.String()));

// bcrypt only looks at the first 72 bytes, so longer passwords are rejected rather than silently truncated.
const checkPassword = (pw: string | null | undefined) => {
  if (pw != null && Buffer.byteLength(pw) > 72) throw new HttpError(422, 'password is longer than 72 bytes');
};

const unique = (e: unknown): never => {
  if (isUniqueViolation(e)) throw new HttpError(422, 'username or email is already taken');
  throw e;
};

export const users = new Elysia()
  .use(setup)
  .post(
    '/api/users',
    async ({ body: { user: u }, db, jwt, set }) => {
      checkPassword(u.password);
      const hash = await bcrypt.hash(u.password, BCRYPT_COST);
      const row = await one(db, INSERT_USER, [u.username, u.email, hash]).catch(unique);
      set.status = 201;
      return { user: user(row, await signToken(jwt, row.id)) };
    },
    { body: t.Object({ user: t.Object({ username: NonEmpty, email: NonEmpty, password: NonEmpty }) }) },
  )
  .post(
    '/api/users/login',
    async ({ body: { user: u }, db, jwt }) => {
      const row = await one(db, USER_BY_EMAIL, [u.email]);
      if (!row || !(await bcrypt.compare(u.password, row.password_hash))) {
        throw new HttpError(401, 'invalid email or password');
      }
      return { user: user(row, await signToken(jwt, row.id)) };
    },
    { body: t.Object({ user: t.Object({ email: NonEmpty, password: NonEmpty }) }) },
  )
  .get(
    '/api/user',
    async ({ db, viewer, token }) => {
      const row = await one(db, USER_BY_ID, [viewer]);
      if (!row) throw new HttpError(401, 'unauthorized');
      return { user: user(row, token) };
    },
    { auth: 'required' },
  )
  .put(
    '/api/user',
    async ({ body: { user: u }, db, viewer, token }) => {
      checkPassword(u.password);
      const hash = u.password == null ? null : await bcrypt.hash(u.password, BCRYPT_COST);
      const row = await one(db, UPDATE_USER, [
        viewer,
        u.email ?? null,
        u.username ?? null,
        hash,
        u.bio ?? null,
        u.image ?? null,
      ]).catch(unique);
      if (!row) throw new HttpError(401, 'unauthorized');
      return { user: user(row, token) };
    },
    {
      auth: 'required',
      body: t.Object({
        user: t.Object({
          email: OptionalNonEmpty,
          username: OptionalNonEmpty,
          password: OptionalNonEmpty,
          bio: OptionalString,
          image: OptionalString,
        }),
      }),
    },
  );
