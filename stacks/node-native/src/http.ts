// The small amount of plumbing a framework would otherwise provide: a router, JSON in/out, errors.
import type { IncomingMessage, ServerResponse } from "node:http";

export class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export type Auth = "none" | "optional" | "required";
export type Ctx = {
  req: IncomingMessage;
  params: Record<string, string>;
  query: URLSearchParams;
  viewer: string; // "0" when anonymous
  token: string;
};
export type Result = { status: number; body?: unknown };
type Handler = (ctx: Ctx) => Promise<Result>;
type Route = { method: string; parts: string[]; auth: Auth; handler: Handler };

export class Router {
  #routes: Route[] = [];

  add(method: string, path: string, auth: Auth, handler: Handler) {
    this.#routes.push({ method, parts: path.split("/").slice(1), auth, handler });
  }

  // Segments starting with ":" capture (percent-decoded); everything else must match exactly.
  match(method: string, pathname: string): { route: Route; params: Record<string, string> } | null {
    const segs = pathname.split("/").slice(1);
    outer: for (const route of this.#routes) {
      if (route.method !== method || route.parts.length !== segs.length) continue;
      const params: Record<string, string> = {};
      for (let i = 0; i < segs.length; i++) {
        const p = route.parts[i];
        if (p[0] === ":") {
          try {
            params[p.slice(1)] = decodeURIComponent(segs[i]);
          } catch {
            continue outer;
          }
        } else if (p !== segs[i]) continue outer;
      }
      return { route, params };
    }
    return null;
  }
}

// Reads the request body and parses it as JSON; anything unreadable is a 422 (validation failure).
export async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const text = Buffer.concat(chunks).toString("utf8");
  try {
    return JSON.parse(text);
  } catch {
    throw new HttpError(422, "malformed JSON body");
  }
}

export function send(res: ServerResponse, status: number, body?: unknown) {
  if (body === undefined) {
    res.writeHead(status).end();
    return;
  }
  const json = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(json) }).end(json);
}
