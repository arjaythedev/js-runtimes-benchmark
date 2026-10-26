import { HttpError } from './http.js';

// Hand-written request validation (uWS has no validator): the same rules the reference Go example applies.

type Obj = Record<string, unknown>;
const isObject = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const invalid = (msg: string) => new HttpError(422, msg);

// Parses the body as a JSON object and returns the object under `key`.
export function wrapper(body: string, key: string): Obj {
  let top: unknown;
  try {
    top = JSON.parse(body);
  } catch {
    throw invalid('malformed JSON');
  }
  if (!isObject(top) || !isObject(top[key])) throw invalid(`body must be {"${key}": {...}}`);
  return top[key] as Obj;
}

// Absent or null -> null; otherwise must be a string (non-empty if asked).
export function optString(m: Obj, k: string, nonEmpty: boolean): string | null {
  const v = m[k];
  if (v === undefined || v === null) return null;
  if (typeof v !== 'string' || (nonEmpty && v === '')) throw invalid(`${k} must be a ${nonEmpty ? 'non-empty ' : ''}string`);
  return v;
}

export function reqString(m: Obj, k: string): string {
  const v = optString(m, k, true);
  if (v === null) throw invalid(`${k} is required`);
  return v;
}

// bcrypt only looks at the first 72 bytes, so longer passwords are rejected rather than silently truncated.
export function password<T extends string | null>(v: T): T {
  if (v !== null && Buffer.byteLength(v) > 72) throw invalid('password is longer than 72 bytes');
  return v;
}

export function tagList(m: Obj): string[] {
  const v = m.tagList;
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v) || !v.every((t) => typeof t === 'string' && t !== '')) {
    throw invalid('tagList must be an array of non-empty strings');
  }
  return v;
}

// limit (default 20, 1..100) and offset (default 0, >= 0): digits only when present.
export function page(q: URLSearchParams): { limit: number; offset: number } {
  const l = q.get('limit');
  const o = q.get('offset');
  if (l !== null && !/^0*([1-9]|[1-9][0-9]|100)$/.test(l)) throw invalid('limit must be an integer from 1 to 100');
  if (o !== null && !/^0*[0-9]{1,15}$/.test(o)) throw invalid('offset must be a non-negative integer');
  return { limit: l === null ? 20 : Number(l), offset: o === null ? 0 : Number(o) };
}
