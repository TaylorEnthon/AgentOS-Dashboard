import Fastify from 'fastify';
import cors from '@fastify/cors';
import fastifyStatic from '@fastify/static';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Db } from './db.js';
import { SettingsStore } from './settings.js';
import { Scheduler } from './scheduler.js';
import { registerRoutes } from './routes.js';
import { seedAgents } from './seed.js';
import { setHealthHistoryDb } from './health-history.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..', '..');
const PORT = Number(process.env.PORT ?? 3000);
const HOST = process.env.HOST ?? '127.0.0.1';

const DATA_DIR = process.env.AGENTOS_DATA_DIR ?? path.join(ROOT, 'data');
const DB_FILE = process.env.AGENTOS_DB ?? path.join(DATA_DIR, 'agentos.db');
const SETTINGS_FILE = process.env.AGENTOS_SETTINGS ?? path.join(DATA_DIR, 'settings.json');
const FRONTEND_DIST = path.join(ROOT, 'packages', 'frontend', 'dist');

async function main(): Promise<void> {
  const app = Fastify({
    logger: { level: process.env.LOG_LEVEL ?? 'info' },
    disableRequestLogging: true,
  });

  await app.register(cors, {
    origin: true,
    credentials: true,
  });

  const db = new Db(DB_FILE);
  const settings = new SettingsStore(db, SETTINGS_FILE);
  const scheduler = new Scheduler(db, settings);

  // Bind SQLite persistence for health snapshot history + attention
  // lifecycle history (v1.5). Without this call the stores fall back
  // to in-memory ring buffers (v1.4 behavior).
  setHealthHistoryDb(db);

  await seedAgents(db);

  // Trigger initial settings load so pricing overrides are live
  const loaded = await settings.load();
  settings.setLivePricingOverrides(loaded.pricingOverrides);

  registerRoutes(app, db, scheduler, settings);

  // Serve frontend build artifacts if present
  if (fs.existsSync(FRONTEND_DIST)) {
    await app.register(fastifyStatic, {
      root: FRONTEND_DIST,
      prefix: '/',
      index: ['index.html'],
    });
    // SPA fallback for non-/api routes
    app.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith('/api')) {
        return reply.code(404).send({ error: 'not found', path: req.url });
      }
      const fallback = path.join(FRONTEND_DIST, 'index.html');
      if (fs.existsSync(fallback)) {
        return reply.type('text/html').send(fs.readFileSync(fallback));
      }
      return reply.code(404).send({ error: 'frontend not built' });
    });
  } else {
    app.log.warn(`Frontend dist not found at ${FRONTEND_DIST} — run "npm run build:frontend"`);
  }

  // Start scheduler
  await scheduler.start();

  // Graceful shutdown
  const shutdown = async (sig: string) => {
    app.log.info(`Received ${sig}, shutting down...`);
    scheduler.stop();
    db.close();
    await app.close();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  await app.listen({ port: PORT, host: HOST });
  app.log.info(`AgentOS Dashboard ready at http://${HOST}:${PORT}`);
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});