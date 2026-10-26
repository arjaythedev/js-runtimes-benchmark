// Hand-written request validation (no framework, no schema library).
import { HttpError } from "./http.ts";

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const bad = (msg: string): never => {
  throw new HttpError(422, msg);
};

// {"<key>": {...}}: the wrapper object must be present and an object.
export function wrapper(body: unknown, key: string): Obj {
  if (!isObj(body) || !isObj(body[key])) bad(`body must be {"${key}": {...}}`);
  return (body as Obj)[key] as Obj;
}

export function required(o: Obj, k: string): string {
  const v = o[k];
  if (typeof v !== "string" || v === "") bad(`${k} must be a non-empty string`);
  return v as string;
}

// Absent or null gives null; otherwise a string (non-empty when nonEmpty).
export function optional(o: Obj, k: string, nonEmpty: boolean): string | null {
  const v = o[k];
  if (v === undefined || v === null) return null;
  if (typeof v !== "string" || (nonEmpty && v === "")) bad(`${k} must be a${nonEmpty ? " non-empty" : ""} string`);
  return v as string;
}

export function password(p: string | null): string | null {
  if (p !== null && Buffer.byteLength(p) > 72) bad("password is longer than 72 bytes");
  return p;
}

export function tagList(o: Obj): string[] {
  const v = o.tagList;
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v) || !v.every((t) => typeof t === "string" && t !== "")) bad("tagList must be an array of non-empty strings");
  return v as string[];
}

const MAX_BIGINT = 9223372036854775807n;

// limit 1..100 (default 20), offset >= 0 within bigint (default 0); digits only. A present-but-empty value is invalid.
export function page(q: URLSearchParams): { limit: number; offset: string } {
  const l = q.get("limit");
  const o = q.get("offset");
  let limit = 20;
  let offset = "0";
  if (l !== null) {
    if (!/^\d+$/.test(l) || Number(l) < 1 || Number(l) > 100) bad("limit must be 1-100");
    limit = Number(l);
  }
  if (o !== null) {
    if (!/^\d+$/.test(o) || BigInt(o) > MAX_BIGINT) bad("offset must be >= 0");
    offset = BigInt(o).toString();
  }
  return { limit, offset };
}
