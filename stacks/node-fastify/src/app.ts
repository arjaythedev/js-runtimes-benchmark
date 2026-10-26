import Fastify, { type FastifyReply, type FastifyRequest } from "fastify";
import fastifyJwt from "@fastify/jwt";
import type { Pool } from "pg";
import { routes } from "./routes.ts";

declare module "@fastify/jwt" {
  interface FastifyJWT {
    payload: { sub: string };
    user: { sub: string; iat: number; exp: number };
  }
}

const VALIDATION_CODES = new Set(["FST_ERR_CTP_INVALID_JSON_BODY", "FST_ERR_CTP_EMPTY_JSON_BODY"]);

export function buildApp(pool: Pool, secret: string) {
  const app = Fastify({
    // H2C=1 (the HTTP/2 side test): Fastify's documented `http2: true`, cleartext HTTP/2 with prior knowledge.
    ...((process.env.H2C === "1" ? { http2: true, http2SessionTimeout: 75_000 } : {}) as {}),
    logger: false,
    // Users idle up to ~70 s between pages on one keep-alive connection (Fastify's default is 72 s).
    keepAliveTimeout: 75_000,
    http: { headersTimeout: 76_000 },
    ajv: {
      // Fastify's default coerceTypes: 'array' would turn {"username": 123} into "123"; the API must reject it.
      customOptions: { coerceTypes: false },
    },
  });

  app.register(fastifyJwt, {
    secret,
    sign: { algorithm: "HS256", expiresIn: "30d" },
    verify: {
      algorithms: ["HS256"],
      requiredClaims: ["exp"],
      // RealWorld uses "Authorization: Token <jwt>", not Bearer.
      extractToken: (req: FastifyRequest) => {
        const h = req.headers.authorization;
        return h?.startsWith("Token ") ? h.slice(6) : undefined;
      },
    },
  });

  app.register(routes, { pool });

  app.setNotFoundHandler((_req, reply) => {
    reply.code(404).send({ errors: { body: ["not found"] } });
  });

  app.setErrorHandler((err: Error & { statusCode?: number; code?: string; validation?: unknown }, _req, reply: FastifyReply) => {
    let status = err.statusCode ?? 500;
    let message = err.message;
    // Schema validation failures and unparseable JSON bodies are 422 in this API (Fastify's default is 400).
    if (err.validation || (err.code && VALIDATION_CODES.has(err.code))) status = 422;
    if (status >= 500) {
      console.error(err);
      message = "internal error";
    }
    reply.code(status).send({ errors: { body: [message] } });
  });

  return app;
}
