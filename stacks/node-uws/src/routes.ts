import type { TemplatedApp } from 'uWebSockets.js';
import bcrypt from 'bcrypt';
import { auth, sign } from './auth.js';
import { all, isUniqueViolation, one, type Pool } from './db.js';
import { article, comment, profile, user } from './format.js';
import { HttpError, notFound, route } from './http.js';
import * as sql from './sql.js';
import { optString, page, password, reqString, tagList, wrapper } from './validate.js';

const BCRYPT_COST = 10;

const unique = (e: unknown): never => {
  if (isUniqueViolation(e)) throw new HttpError(422, 'username or email is already taken');
  throw e;
};

export function routes(app: TemplatedApp, db: Pool) {
  async function list(listQ: string, countQ: string, listArgs: unknown[], countArgs: unknown[]) {
    const rows = await all(db, listQ, listArgs);
    const [{ count }] = await all(db, countQ, countArgs);
    return { status: 200, body: { articles: rows.map((r) => article(r, false)), articlesCount: count } };
  }

  async function fullArticle(status: number, viewer: number, query: string, key: string | number) {
    const row = await one(db, query, [viewer, key]);
    if (!row) throw new HttpError(404, 'article not found');
    return { status, body: { article: article(row, true) } };
  }

  // 404 if the slug is unknown, 403 if the viewer is not the author.
  async function owned(viewer: number, slug: string): Promise<number> {
    const row = await one(db, sql.ARTICLE_OWNER, [slug]);
    if (!row) throw new HttpError(404, 'article not found');
    if (row.author_id !== viewer) throw new HttpError(403, 'not the author');
    return row.id;
  }

  async function articleId(slug: string): Promise<number> {
    const row = await one(db, sql.ARTICLE_ID_BY_SLUG, [slug]);
    if (!row) throw new HttpError(404, 'article not found');
    return row.id;
  }

  // ---------- users ----------

  route(app, 'post', '/api/users', async (ctx) => {
    const m = wrapper(ctx.body, 'user');
    const username = reqString(m, 'username');
    const email = reqString(m, 'email');
    const pw = password(reqString(m, 'password'));
    const hash = await bcrypt.hash(pw, BCRYPT_COST);
    const row = await one(db, sql.INSERT_USER, [username, email, hash]).catch(unique);
    return { status: 201, body: { user: user(row, await sign(row.id)) } };
  });

  route(app, 'post', '/api/users/login', async (ctx) => {
    const m = wrapper(ctx.body, 'user');
    const email = reqString(m, 'email');
    const pw = reqString(m, 'password');
    const row = await one(db, sql.USER_BY_EMAIL, [email]);
    if (!row || !(await bcrypt.compare(pw, row.password_hash))) throw new HttpError(401, 'invalid email or password');
    return { status: 200, body: { user: user(row, await sign(row.id)) } };
  });

  route(app, 'get', '/api/user', async (ctx) => {
    const { viewer, token } = await auth(ctx, 'required');
    const row = await one(db, sql.USER_BY_ID, [viewer]);
    if (!row) throw new HttpError(401, 'unauthorized');
    return { status: 200, body: { user: user(row, token) } };
  });

  route(app, 'put', '/api/user', async (ctx) => {
    const { viewer, token } = await auth(ctx, 'required');
    const m = wrapper(ctx.body, 'user');
    const email = optString(m, 'email', true);
    const username = optString(m, 'username', true);
    const pw = password(optString(m, 'password', true));
    const bio = optString(m, 'bio', false);
    const image = optString(m, 'image', false);
    const hash = pw === null ? null : await bcrypt.hash(pw, BCRYPT_COST);
    const row = await one(db, sql.UPDATE_USER, [viewer, email, username, hash, bio, image]).catch(unique);
    if (!row) throw new HttpError(401, 'unauthorized');
    return { status: 200, body: { user: user(row, token) } };
  });

  // ---------- profiles ----------

  route(app, 'get', '/api/profiles/:username', async (ctx) => {
    const { viewer } = await auth(ctx, 'optional');
    const row = await one(db, sql.PROFILE, [viewer, ctx.params[0]]);
    if (!row) throw new HttpError(404, 'profile not found');
    return { status: 200, body: { profile: profile(row) } };
  });

  const follow = (on: boolean) => async (ctx: Parameters<Parameters<typeof route>[3]>[0]) => {
    const { viewer } = await auth(ctx, 'required');
    const row = await one(db, sql.USER_BY_USERNAME, [ctx.params[0]]);
    if (!row) throw new HttpError(404, 'profile not found');
    await all(db, on ? sql.FOLLOW : sql.UNFOLLOW, [viewer, row.id]);
    return { status: 200, body: { profile: profile(row, on) } };
  };
  route(app, 'post', '/api/profiles/:username/follow', follow(true));
  route(app, 'del', '/api/profiles/:username/follow', follow(false));

  // ---------- articles ----------

  route(app, 'get', '/api/articles', async (ctx) => {
    const { viewer } = await auth(ctx, 'optional');
    const { limit, offset } = page(ctx.query);
    const q = ctx.query;
    // The first non-empty filter in the order tag, author, favorited applies.
    const tag = q.get('tag');
    const author = q.get('author');
    const favorited = q.get('favorited');
    if (tag) return list(sql.LIST_BY_TAG, sql.COUNT_BY_TAG, [viewer, limit, offset, tag], [tag]);
    if (author) return list(sql.LIST_BY_AUTHOR, sql.COUNT_BY_AUTHOR, [viewer, limit, offset, author], [author]);
    if (favorited) return list(sql.LIST_BY_FAVORITED, sql.COUNT_BY_FAVORITED, [viewer, limit, offset, favorited], [favorited]);
    return list(sql.LIST_ALL, sql.COUNT_ALL, [viewer, limit, offset], []);
  });

  route(app, 'get', '/api/articles/feed', async (ctx) => {
    const { viewer } = await auth(ctx, 'required');
    const { limit, offset } = page(ctx.query);
    return list(sql.LIST_FEED, sql.COUNT_FEED, [viewer, limit, offset], [viewer]);
  });

  route(app, 'get', '/api/articles/:slug', async (ctx) => {
    const { viewer } = await auth(ctx, 'optional');
    return fullArticle(200, viewer, sql.ARTICLE_BY_SLUG, ctx.params[0]);
  });

  route(app, 'post', '/api/articles', async (ctx) => {
    const { viewer } = await auth(ctx, 'required');
    const m = wrapper(ctx.body, 'article');
    const title = reqString(m, 'title');
    const description = reqString(m, 'description');
    const body = reqString(m, 'body');
    const tags = tagList(m);
    const client = await db.connect();
    let id: number;
    try {
      await client.query('BEGIN');
      id = (await one(client, sql.INSERT_ARTICLE, [viewer, title, description, body])).id;
      if (tags.length > 0) {
        await client.query(sql.INSERT_TAGS, [tags]);
        await client.query(sql.INSERT_ARTICLE_TAGS, [id, tags]);
      }
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {});
      throw e;
    } finally {
      client.release();
    }
    return fullArticle(201, viewer, sql.ARTICLE_BY_ID, id);
  });

  route(app, 'put', '/api/articles/:slug', async (ctx) => {
    const { viewer } = await auth(ctx, 'required');
    const m = wrapper(ctx.body, 'article');
    const title = optString(m, 'title', true);
    const description = optString(m, 'description', true);
    const body = optString(m, 'body', true);
    const id = await owned(viewer, ctx.params[0]);
    await all(db, sql.UPDATE_ARTICLE, [id, title, description, body]);
    return fullArticle(200, viewer, sql.ARTICLE_BY_ID, id);
  });

  route(app, 'del', '/api/articles/:slug', async (ctx) => {
    const { viewer } = await auth(ctx, 'required');
    const id = await owned(viewer, ctx.params[0]);
    await all(db, sql.DELETE_ARTICLE, [id]);
    return { status: 204 };
  });

  const favorite = (on: boolean) => async (ctx: Parameters<Parameters<typeof route>[3]>[0]) => {
    const { viewer } = await auth(ctx, 'required');
    const id = await articleId(ctx.params[0]);
    await all(db, on ? sql.FAVORITE : sql.UNFAVORITE, [viewer, id]);
    return fullArticle(200, viewer, sql.ARTICLE_BY_ID, id);
  };
  route(app, 'post', '/api/articles/:slug/favorite', favorite(true));
  route(app, 'del', '/api/articles/:slug/favorite', favorite(false));

  // ---------- comments ----------

  route(app, 'get', '/api/articles/:slug/comments', async (ctx) => {
    const { viewer } = await auth(ctx, 'optional');
    const id = await articleId(ctx.params[0]);
    const rows = await all(db, sql.LIST_COMMENTS, [viewer, id]);
    return { status: 200, body: { comments: rows.map((r) => comment(r)) } };
  });

  route(app, 'post', '/api/articles/:slug/comments', async (ctx) => {
    const { viewer } = await auth(ctx, 'required');
    const body = reqString(wrapper(ctx.body, 'comment'), 'body');
    const id = await articleId(ctx.params[0]);
    const row = await one(db, sql.INSERT_COMMENT, [id, viewer, body]);
    return { status: 201, body: { comment: comment(row, false) } };
  });

  route(app, 'del', '/api/articles/:slug/comments/:id', async (ctx) => {
    const { viewer } = await auth(ctx, 'required');
    const [slug, cid] = ctx.params;
    // A non-integer id can't name a comment: 404.
    if (!/^[0-9]{1,18}$/.test(cid)) throw new HttpError(404, 'comment not found');
    const row = await one(db, sql.COMMENT_OWNER, [cid, slug]);
    if (!row) throw new HttpError(404, 'comment not found');
    if (row.author_id !== viewer) throw new HttpError(403, 'not the author');
    await all(db, sql.DELETE_COMMENT, [cid]);
    return { status: 204 };
  });

  // ---------- tags ----------

  route(app, 'get', '/api/tags', async () => ({ status: 200, body: { tags: (await all(db, sql.TAGS)).map((r) => r.name) } }));

  notFound(app);
}
