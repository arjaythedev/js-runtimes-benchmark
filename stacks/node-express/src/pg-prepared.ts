import pg from "pg";
import { createHash } from "node:crypto";

// Sends every SQL statement as a named prepared statement (pg's documented `name` query option), so Postgres
// parses and plans each distinct SQL text once per connection instead of on every call. Bun.sql and postgres.js
// do this by default; pg only does it for queries that carry a name. Plugged in with Pool's documented `Client`
// option, so no call site changes. PG_PREPARE=0 restores pg's default (unnamed statements, re-planned every call).
const names = new Map<string, string>();
const control = /^\s*(BEGIN|COMMIT|ROLLBACK|START|SET|RESET|SAVEPOINT|RELEASE)\b/i;

function nameFor(text: string): string | undefined {
  if (control.test(text)) return undefined;
  let n = names.get(text);
  if (n === undefined) {
    n = "q" + createHash("sha1").update(text).digest("hex").slice(0, 16);
    names.set(text, n);
  }
  return n;
}

export class PreparedClient extends pg.Client {}

const baseQuery: any = pg.Client.prototype.query;
(PreparedClient.prototype as any).query = function (this: pg.Client, config: any, values?: any, callback?: any) {
  if (typeof config === "string") {
    const name = nameFor(config);
    if (name !== undefined) {
      if (typeof values === "function") return baseQuery.call(this, { text: config, name } as any, values);
      return baseQuery.call(this, { text: config, values, name } as any, callback);
    }
  } else if (config && typeof config.text === "string" && config.name === undefined && !config.submit) {
    const name = nameFor(config.text);
    if (name !== undefined) config = { ...config, name };
  }
  return baseQuery.call(this, config, values, callback);
};

export const poolClient: typeof pg.Client = process.env.PG_PREPARE === "0" ? pg.Client : PreparedClient;
