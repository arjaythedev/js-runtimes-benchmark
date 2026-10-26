import type { HttpRequest, HttpResponse, TemplatedApp } from 'uWebSockets.js';

// A small layer over uWS's own router: copy what the handler needs out of the request synchronously
// (uWS's HttpRequest is only valid until the first await), then run an async handler and write the reply corked.

export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

export interface Ctx {
  params: string[];
  query: URLSearchParams;
  authorization: string;
  body: string;
}

export interface Reply {
  status: number;
  body?: unknown;
}

export type Handler = (ctx: Ctx) => Promise<Reply>;

const STATUS: Record<number, string> = {
  200: '200 OK',
  201: '201 Created',
  204: '204 No Content',
  401: '401 Unauthorized',
  403: '403 Forbidden',
  404: '404 Not Found',
  422: '422 Unprocessable Entity',
  500: '500 Internal Server Error',
};

const MAX_BODY = 1 << 20;

export const errorBody = (message: string) => ({ errors: { body: [message] } });

function send(res: HttpResponse, r: Reply) {
  res.cork(() => {
    res.writeStatus(STATUS[r.status] ?? String(r.status));
    if (r.body === undefined) {
      res.end();
    } else {
      res.writeHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(r.body));
    }
  });
}

function decodeParam(s: string): string | null {
  try {
    return decodeURIComponent(s);
  } catch {
    return null;
  }
}

type Method = 'get' | 'post' | 'put' | 'del';

export function route(app: TemplatedApp, method: Method, pattern: string, handler: Handler) {
  const nParams = pattern.split('/').filter((p) => p.startsWith(':')).length;
  const readBody = method === 'post' || method === 'put';
  app[method](pattern, (res: HttpResponse, req: HttpRequest) => {
    const params: string[] = [];
    for (let i = 0; i < nParams; i++) {
      const p = decodeParam(req.getParameter(i) ?? '');
      if (p === null) return send(res, { status: 404, body: errorBody('not found') });
      params.push(p);
    }
    const ctx: Ctx = {
      params,
      query: new URLSearchParams(req.getQuery() ?? ''),
      authorization: req.getHeader('authorization'),
      body: '',
    };
    let aborted = false;
    res.onAborted(() => {
      aborted = true;
    });
    const run = () => {
      handler(ctx).then(
        (r) => aborted || send(res, r),
        (e) => {
          if (aborted) return;
          if (e instanceof HttpError) return send(res, { status: e.status, body: errorBody(e.message) });
          console.error(e);
          send(res, { status: 500, body: errorBody('internal error') });
        },
      );
    };
    if (readBody) {
      res.collectBody(MAX_BODY, (body) => {
        ctx.body = body ? Buffer.from(body).toString('utf8') : '\u0000';
        run();
      });
    } else {
      run();
    }
  });
}

export function notFound(app: TemplatedApp) {
  app.any('/*', (res) => send(res, { status: 404, body: errorBody('not found') }));
}
