import pg from "pg";
import { poolClient } from "./pg-prepared.ts";

export function createPool(max: number): pg.Pool {
  return new pg.Pool({ Client: poolClient, connectionString: process.env.DATABASE_URL, max });
}

// Reference SQL, verbatim from SPEC.md.
const ARTICLE_LIST_SELECT = `SELECT a.id, a.slug, a.title, a.description, a.created_at, a.updated_at,
       ARRAY(SELECT t.name FROM article_tags at JOIN tags t ON t.id = at.tag_id
              WHERE at.article_id = a.id ORDER BY t.name) AS tag_list,
       (SELECT count(*) FROM favorites f WHERE f.article_id = a.id) AS favorites_count,
       EXISTS (SELECT 1 FROM favorites f WHERE f.article_id = a.id AND f.user_id = $1) AS favorited,
       u.username, u.bio, u.image,
       EXISTS (SELECT 1 FROM follows fo WHERE fo.follower_id = $1 AND fo.followee_id = a.author_id) AS following
  FROM articles a
  JOIN users u ON u.id = a.author_id`;

const ARTICLE_FULL_SELECT = `SELECT a.id, a.slug, a.title, a.description, a.body, a.created_at, a.updated_at,
       ARRAY(SELECT t.name FROM article_tags at JOIN tags t ON t.id = at.tag_id
              WHERE at.article_id = a.id ORDER BY t.name) AS tag_list,
       (SELECT count(*) FROM favorites f WHERE f.article_id = a.id) AS favorites_count,
       EXISTS (SELECT 1 FROM favorites f WHERE f.article_id = a.id AND f.user_id = $1) AS favorited,
       u.username, u.bio, u.image,
       EXISTS (SELECT 1 FROM follows fo WHERE fo.follower_id = $1 AND fo.followee_id = a.author_id) AS following
  FROM articles a
  JOIN users u ON u.id = a.author_id`;

const ORDER_PAGE = ` ORDER BY a.id DESC LIMIT $2 OFFSET $3`;
const SLUGIFY = (x: string) => `trim(both '-' from lower(regexp_replace(${x}, '[^A-Za-z0-9]+', '-', 'g')))`;

export const SQL = {
  insertUser: `INSERT INTO users (username, email, password_hash) VALUES ($1, $2, $3)
RETURNING id, username, email, bio, image`,
  userByEmail: `SELECT id, username, email, bio, image, password_hash FROM users WHERE email = $1`,
  userById: `SELECT id, username, email, bio, image FROM users WHERE id = $1`,
  updateUser: `UPDATE users SET email = COALESCE($2, email), username = COALESCE($3, username),
                 password_hash = COALESCE($4, password_hash), bio = COALESCE($5, bio), image = COALESCE($6, image)
 WHERE id = $1
RETURNING id, username, email, bio, image`,

  profile: `SELECT u.id, u.username, u.bio, u.image,
       EXISTS (SELECT 1 FROM follows fo WHERE fo.follower_id = $1 AND fo.followee_id = u.id) AS following
  FROM users u WHERE u.username = $2`,
  userByUsername: `SELECT id, username, bio, image FROM users WHERE username = $1`,
  follow: `INSERT INTO follows (follower_id, followee_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
  unfollow: `DELETE FROM follows WHERE follower_id = $1 AND followee_id = $2`,

  listAll: ARTICLE_LIST_SELECT + ORDER_PAGE,
  countAll: `SELECT count(*) FROM (SELECT 1 FROM articles a LIMIT 1000) s`,
  listByTag: ARTICLE_LIST_SELECT + ` WHERE a.id IN (SELECT at.article_id FROM article_tags at WHERE at.tag_id = (SELECT t.id FROM tags t WHERE t.name = $4) ORDER BY at.article_id DESC LIMIT $2 OFFSET $3) ORDER BY a.id DESC`,
  countByTag: `SELECT count(*) FROM (SELECT 1 FROM article_tags at WHERE at.tag_id = (SELECT t.id FROM tags t WHERE t.name = $1) LIMIT 1000) s`,
  listByAuthor: ARTICLE_LIST_SELECT + ` WHERE a.author_id = (SELECT au.id FROM users au WHERE au.username = $4)` + ORDER_PAGE,
  countByAuthor: `SELECT count(*) FROM (SELECT 1 FROM articles a WHERE a.author_id = (SELECT u.id FROM users u WHERE u.username = $1) LIMIT 1000) s`,
  listByFavorited: ARTICLE_LIST_SELECT + ` WHERE a.id IN (SELECT f.article_id FROM favorites f WHERE f.user_id = (SELECT fu.id FROM users fu WHERE fu.username = $4) ORDER BY f.article_id DESC LIMIT $2 OFFSET $3) ORDER BY a.id DESC`,
  countByFavorited: `SELECT count(*) FROM (SELECT 1 FROM favorites f WHERE f.user_id = (SELECT fu.id FROM users fu WHERE fu.username = $1) LIMIT 1000) s`,
  listFeed: ARTICLE_LIST_SELECT + ` WHERE a.id IN (SELECT x.id FROM follows fo CROSS JOIN LATERAL
    (SELECT a2.id FROM articles a2 WHERE a2.author_id = fo.followee_id ORDER BY a2.id DESC LIMIT ($2::int + $3::int)) x
  WHERE fo.follower_id = $1 ORDER BY x.id DESC LIMIT $2 OFFSET $3) ORDER BY a.id DESC`,
  countFeed: `SELECT count(*) FROM (SELECT 1 FROM articles a WHERE a.author_id IN (SELECT fo.followee_id FROM follows fo WHERE fo.follower_id = $1) LIMIT 1000) s`,

  articleBySlug: ARTICLE_FULL_SELECT + ` WHERE a.slug = $2`,
  articleById: ARTICLE_FULL_SELECT + ` WHERE a.id = $2`,
  insertArticle: `INSERT INTO articles (id, slug, author_id, title, description, body)
SELECT n.id, ${SLUGIFY("$2")} || '-' || n.id, $1, $2, $3, $4
  FROM (SELECT nextval(pg_get_serial_sequence('articles', 'id')) AS id) n
RETURNING id`,
  insertTags: `INSERT INTO tags (name) SELECT DISTINCT unnest($1::text[]) ON CONFLICT (name) DO NOTHING`,
  insertArticleTags: `INSERT INTO article_tags (article_id, tag_id) SELECT $1, t.id FROM tags t WHERE t.name = ANY($2::text[])`,
  articleOwner: `SELECT id, author_id FROM articles WHERE slug = $1`,
  updateArticle: `UPDATE articles SET title = COALESCE($2, title), description = COALESCE($3, description), body = COALESCE($4, body),
       slug = CASE WHEN $2::text IS NULL THEN slug ELSE ${SLUGIFY("$2")} || '-' || id END,
       updated_at = now()
 WHERE id = $1`,
  deleteArticle: `DELETE FROM articles WHERE id = $1`,
  articleIdBySlug: `SELECT id FROM articles WHERE slug = $1`,
  favorite: `INSERT INTO favorites (user_id, article_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
  unfavorite: `DELETE FROM favorites WHERE user_id = $1 AND article_id = $2`,

  listComments: `SELECT c.id, c.body, c.created_at, c.updated_at, u.username, u.bio, u.image,
       EXISTS (SELECT 1 FROM follows fo WHERE fo.follower_id = $1 AND fo.followee_id = c.author_id) AS following
  FROM comments c JOIN users u ON u.id = c.author_id
 WHERE c.article_id = $2
 ORDER BY c.created_at DESC, c.id DESC
 LIMIT 100`,
  insertComment: `WITH c AS (INSERT INTO comments (article_id, author_id, body) VALUES ($1, $2, $3)
           RETURNING id, body, created_at, updated_at, author_id)
SELECT c.id, c.body, c.created_at, c.updated_at, u.username, u.bio, u.image
  FROM c JOIN users u ON u.id = c.author_id`,
  commentAuthor: `SELECT c.author_id FROM comments c JOIN articles a ON a.id = c.article_id
 WHERE c.id = $1 AND a.slug = $2`,
  deleteComment: `DELETE FROM comments WHERE id = $1`,

  tags: `SELECT name FROM tags ORDER BY name`,
} as const;

// ---- row -> JSON mapping (pg returns bigint/count as strings, timestamptz as Date) ----

type Row = Record<string, any>;

export const profileJson = (r: Row, following: boolean) => ({
  username: r.username as string,
  bio: r.bio as string | null,
  image: r.image as string | null,
  following,
});

export const userJson = (r: Row, token: string) => ({
  email: r.email as string,
  token,
  username: r.username as string,
  bio: r.bio as string | null,
  image: r.image as string | null,
});

export function articleJson(r: Row) {
  return {
    slug: r.slug as string,
    title: r.title as string,
    description: r.description as string,
    ...(r.body !== undefined && { body: r.body as string }),
    tagList: r.tag_list as string[],
    createdAt: (r.created_at as Date).toISOString(),
    updatedAt: (r.updated_at as Date).toISOString(),
    favorited: r.favorited as boolean,
    favoritesCount: Number(r.favorites_count),
    author: profileJson(r, r.following),
  };
}

export const commentJson = (r: Row) => ({
  id: Number(r.id),
  createdAt: (r.created_at as Date).toISOString(),
  updatedAt: (r.updated_at as Date).toISOString(),
  body: r.body as string,
  author: profileJson(r, r.following ?? false),
});
