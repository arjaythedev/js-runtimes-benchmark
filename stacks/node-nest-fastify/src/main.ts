import 'reflect-metadata';
import cluster from 'node:cluster';
import os from 'node:os';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import type { Server } from 'node:http';
import { AppModule } from './app.module.js';

const workers = os.availableParallelism();

async function bootstrap() {
  // Total Postgres connections across all workers stay <= 90.
  process.env.DB_POOL_MAX = String(Math.floor(90 / workers));
  // Fastify's own default keep-alive is 72 s; clients idle up to ~70 s between pages.
  const adapter = new FastifyAdapter({ keepAliveTimeout: 75_000 });
  const app = await NestFactory.create<NestFastifyApplication>(AppModule, adapter, { logger: ['error', 'warn'] });
  app.setGlobalPrefix('api');
  app.enableShutdownHooks();
  const server: Server = app.getHttpServer();
  server.headersTimeout = 76_000;
  await app.listen(Number(process.env.PORT ?? 3000), process.env.HOST ?? '0.0.0.0');
}

if (cluster.isPrimary) {
  console.log(`primary ${process.pid}: forking ${workers} workers`);
  for (let i = 0; i < workers; i++) cluster.fork();
  // No restart: a worker that dies stays dead.
  cluster.on('exit', (w, code, signal) => console.error(`worker ${w.process.pid} exited (${signal ?? code})`));
} else {
  await bootstrap();
  console.log(`worker ${process.pid} listening`);
}
