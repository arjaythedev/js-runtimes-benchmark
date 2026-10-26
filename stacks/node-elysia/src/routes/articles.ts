import { Elysia, t } from 'elysia';
import { all, one, type Pool } from '../db.js';
import { HttpError } from '../errors.js';
import { article, comment } from '../format.js';
import { setup } from '../setup.js';
import * as sql from '../sql.js';

const NonEmpty = t.String({ minLength: 1 });
const OptionalNonEmpty = t.Optional(t.Nullable(NonEmpty));

// Query strings stay strings; the patterns reject signs, spaces, decimals and out-of-range values.
const Page = {
  limit: t.Optional(t.String({ pattern: '^0*([1-9]|[1-9][0-9]|100)$' })),
  offset: t.Optional(t.String({ pattern: '^0*[0-9]{1,15}$' })),
};
const page = (q: { limit?: string; offset?: string }) => ({
  limit: q.limit === undefined ? 20 : Number(q.limit),
  offset: q.offset === undefined ? 0 : Number(q.offset),
});

async function list(db: Pool, list: string, count: string, listArgs: unknown[], countArgs: unknown[]) {
  const rows = await all(db, list, listArgs);
  const [{ count: n }] = await all(db, count, countArgs);
  return { articles: rows.map((r) => article(r, false)), articlesCount: n };
}

async function fullArticle(db: Pool, viewer: number, query: string, key: string | number) {
  const row = await one(db, query, [viewer, key]);
  if (!row) throw new HttpError(404, 'article not found');
  return { article: article(row, true) };
}

// 404 if the slug is unknown, 403 if the viewer is not the author.
async function owned(db: Pool, viewer: number, slug: string): Promise<number> {
  const row = await one(db, sql.ARTICLE_OWNER, [slug]);
  if (!row) throw new HttpError(404, 'article not found');
  if (row.author_id !== viewer) throw new HttpError(403, 'not the author');
  return row.id;
}

async function articleId(db: Pool, slug: string): Promise<number> {
  const row = await one(db, sql.ARTICLE_ID_BY_SLUG, [slug]);
  if (!row) throw new HttpError(404, 'article not found');
  return row.id;
}

export const articles = new Elysia({ prefix: '/api/articles' })
  .use(setup)
  .get(
    '',
    ({ db, viewer, query: q }) => {
      const { limit, offset } = page(q);
      // The first non-empty filter in the order tag, author, favorited applies.
      if (q.tag) return list(db, sql.LIST_BY_TAG, sql.COUNT_BY_TAG, [viewer, limit, offset, q.tag], [q.tag]);
      if (q.author) return list(db, sql.LIST_BY_AUTHOR, sql.COUNT_BY_AUTHOR, [viewer, limit, offset, q.author], [q.author]);
      if (q.favorited) {
        return list(db, sql.LIST_BY_FAVORITED, sql.COUNT_BY_FAVORITED, [viewer, limit, offset, q.favorited], [q.favorited]);
      }
      return list(db, sql.LIST_ALL, sql.COUNT_ALL, [viewer, limit, offset], []);
    },
    {
      auth: 'optional',
      query: t.Object({ ...Page, tag: t.Optional(t.String()), author: t.Optional(t.String()), favorited: t.Optional(t.String()) }),
    },
  )
  .get(
    '/feed',
    ({ db, viewer, query }) => {
      const { limit, offset } = page(query);
      return list(db, sql.LIST_FEED, sql.COUNT_FEED, [viewer, limit, offset], [viewer]);
    },
    { auth: 'required', query: t.Object(Page) },
  )
  .get('/:slug', ({ db, viewer, params }) => fullArticle(db, viewer, sql.ARTICLE_BY_SLUG, params.slug), { auth: 'optional' })
  .post(
    '',
    async ({ db, viewer, body: { article: a }, set }) => {
      const tags = a.tagList ?? [];
      const client = await db.connect();
      let id: number;
      try {
        await client.query('BEGIN');
        id = (await one(client, sql.INSERT_ARTICLE, [viewer, a.title, a.description, a.body])).id;
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
      set.status = 201;
      return fullArticle(db, viewer, sql.ARTICLE_BY_ID, id);
    },
    {
      auth: 'required',
      body: t.Object({
        article: t.Object({
          title: NonEmpty,
          description: NonEmpty,
          body: NonEmpty,
          tagList: t.Optional(t.Nullable(t.Array(NonEmpty))),
        }),
      }),
    },
  )
  .put(
    '/:slug',
    async ({ db, viewer, params, body: { article: a } }) => {
      const id = await owned(db, viewer, params.slug);
      await all(db, sql.UPDATE_ARTICLE, [id, a.title ?? null, a.description ?? null, a.body ?? null]);
      return fullArticle(db, viewer, sql.ARTICLE_BY_ID, id);
    },
    {
      auth: 'required',
      body: t.Object({ article: t.Object({ title: OptionalNonEmpty, description: OptionalNonEmpty, body: OptionalNonEmpty }) }),
    },
  )
  .delete(
    '/:slug',
    async ({ db, viewer, params, set }) => {
      const id = await owned(db, viewer, params.slug);
      await all(db, sql.DELETE_ARTICLE, [id]);
      set.status = 204;
    },
    { auth: 'required' },
  )
  .post(
    '/:slug/favorite',
    async ({ db, viewer, params }) => {
      const id = await articleId(db, params.slug);
      await all(db, sql.FAVORITE, [viewer, id]);
      return fullArticle(db, viewer, sql.ARTICLE_BY_ID, id);
    },
    { auth: 'required' },
  )
  .delete(
    '/:slug/favorite',
    async ({ db, viewer, params }) => {
      const id = await articleId(db, params.slug);
      await all(db, sql.UNFAVORITE, [viewer, id]);
      return fullArticle(db, viewer, sql.ARTICLE_BY_ID, id);
    },
    { auth: 'required' },
  )
  .get(
    '/:slug/comments',
    async ({ db, viewer, params }) => {
      const id = await articleId(db, params.slug);
      const rows = await all(db, sql.LIST_COMMENTS, [viewer, id]);
      return { comments: rows.map((r) => comment(r)) };
    },
    { auth: 'optional' },
  )
  .post(
    '/:slug/comments',
    async ({ db, viewer, params, body, set }) => {
      const id = await articleId(db, params.slug);
      const row = await one(db, sql.INSERT_COMMENT, [id, viewer, body.comment.body]);
      set.status = 201;
      return { comment: comment(row, false) };
    },
    { auth: 'required', body: t.Object({ comment: t.Object({ body: NonEmpty }) }) },
  )
  .delete(
    '/:slug/comments/:id',
    async ({ db, viewer, params, set }) => {
      // A non-integer id can't name a comment: 404.
      if (!/^[0-9]{1,18}$/.test(params.id)) throw new HttpError(404, 'comment not found');
      const row = await one(db, sql.COMMENT_OWNER, [params.id, params.slug]);
      if (!row) throw new HttpError(404, 'comment not found');
      if (row.author_id !== viewer) throw new HttpError(403, 'not the author');
      await all(db, sql.DELETE_COMMENT, [params.id]);
      set.status = 204;
    },
    { auth: 'required' },
  );
