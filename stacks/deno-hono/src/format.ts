// Row -> JSON shapes from SPEC.md, plus the small parsing rules every framework shares.
// deno-lint-ignore-file no-explicit-any

// RFC 3339 UTC with exactly 3 fractional digits. postgres.js parses timestamptz into a Date, and V8's Date
// keeps milliseconds by truncating the microseconds, so toISOString() is already the truncated form.
const ts = (d: Date) => d.toISOString();

export const profileOf = (r: any, following: boolean) => ({
  username: r.username, bio: r.bio, image: r.image, following,
});

export const userOf = (r: any, token: string) => ({
  email: r.email, token, username: r.username, bio: r.bio, image: r.image,
});

export const articleOf = (r: any) => {
  const a: Record<string, unknown> = {
    slug: r.slug, title: r.title, description: r.description,
    tagList: r.tag_list, createdAt: ts(r.created_at), updatedAt: ts(r.updated_at),
    favorited: r.favorited, favoritesCount: r.favorites_count,
    author: profileOf(r, r.following),
  };
  if (r.body !== undefined) a.body = r.body;
  return a;
};

export const commentOf = (r: any, following: boolean) => ({
  id: r.id, createdAt: ts(r.created_at), updatedAt: ts(r.updated_at), body: r.body,
  author: profileOf(r, following),
});

export const errorBody = (msg: string) => ({ errors: { body: [msg] } });

const INT64_MAX = 9223372036854775807n;

// Only ASCII digits that fit an int64 (no sign, no spaces, no decimals).
export function parseUint(s: string | null | undefined): number | null {
  if (s == null || !/^[0-9]+$/.test(s) || BigInt(s) > INT64_MAX) return null;
  return Number(s);
}

// limit (default 20, 1..100) and offset (default 0, >= 0). A parameter that is present (even empty) must be valid.
export function pageOf(limitRaw: string | null | undefined, offsetRaw: string | null | undefined) {
  let limit = 20, offset = 0;
  if (limitRaw != null) {
    const n = parseUint(limitRaw);
    if (n == null || n < 1 || n > 100) return null;
    limit = n;
  }
  if (offsetRaw != null) {
    const n = parseUint(offsetRaw);
    if (n == null) return null;
    offset = n;
  }
  return { limit, offset };
}

// bcrypt only looks at the first 72 bytes; longer passwords are rejected (422), as the Go reference does.
export const bcryptOk = (pw: string) => new TextEncoder().encode(pw).length <= 72;

export const BCRYPT_COST = 10;
export const TOKEN_TTL = 30 * 24 * 3600;
