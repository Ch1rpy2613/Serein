import { serve } from '@hono/node-server';
import { config as loadEnv } from 'dotenv';
import { Hono } from 'hono';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { closeDb, dbPath, openDb } from './db';
import { startAlertPushJob } from './jobs/alertPush';
import { qweatherRoutes } from './routes/qweather';
import { pushRoutes } from './routes/push';
import { syncRoutes } from './routes/sync';
import { typhoonRoutes } from './routes/typhoon';
import { allowRequest, clientIp, jsonError } from './utils';

const __dirname = dirname(fileURLToPath(import.meta.url));
loadEnv({ path: join(__dirname, '../.env') });

const HOST = process.env.ATMOS_HOST?.trim() || '127.0.0.1';
const PORT = Number(process.env.ATMOS_PORT || process.env.PORT || 8787) || 8787;

openDb();
console.info(`[db] open ${dbPath()}`);

const stopAlertPushJob = startAlertPushJob();

const app = new Hono();

/** /api 全响应：nosniff；显式不写 CORS；内存 rate limit */
app.use('/api/*', async (c, next) => {
  const ip = clientIp(c);
  const gate = allowRequest(ip);
  if (!gate.ok) {
    c.header('Retry-After', String(gate.retryAfterSec));
    c.header('X-Content-Type-Options', 'nosniff');
    return jsonError(c, 429, 'Too many requests', 'rate_limited');
  }
  await next();
  c.header('X-Content-Type-Options', 'nosniff');
});

app.get('/healthz', (c) => c.json({ ok: true }));

app.route('/api/qweather', qweatherRoutes);
app.route('/api/push', pushRoutes);
app.route('/api/sync', syncRoutes);
app.route('/api/typhoon', typhoonRoutes);

app.notFound((c) => {
  if (c.req.path.startsWith('/api/')) {
    c.header('X-Content-Type-Options', 'nosniff');
    return jsonError(c, 404, 'Not found', 'not_found');
  }
  return c.text('Not Found', 404);
});

const server = serve({ fetch: app.fetch, hostname: HOST, port: PORT }, (info) => {
  console.info(`[atmos-server] http://${info.address}:${info.port}`);
});

let shuttingDown = false;
function shutdown(signal: string): void {
  if (shuttingDown) return;
  shuttingDown = true;
  console.info(`[atmos-server] ${signal} — shutting down`);
  stopAlertPushJob();
  server.close((err) => {
    if (err) console.warn('[atmos-server] server.close error', err);
    closeDb();
    process.exit(err ? 1 : 0);
  });
  // 若 close 卡住，强制退出
  setTimeout(() => {
    closeDb();
    process.exit(1);
  }, 5_000).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
