import { Hono } from 'hono';
import { getDb } from '../db';
import { jsonError } from '../utils';

/** Web Push 订阅：upsert / 按 endpoint 删除 */
export const pushRoutes = new Hono();

const ALERT_LEVELS = new Set(['blue', 'yellow', 'orange', 'red']);

type CityBody = {
  name?: unknown;
  lat?: unknown;
  lon?: unknown;
  tz?: unknown;
};

type SubscriptionBody = {
  endpoint?: unknown;
  keys?: {
    p256dh?: unknown;
    auth?: unknown;
  };
  expirationTime?: unknown;
};

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function parseLevels(raw: unknown): string[] | null {
  if (!Array.isArray(raw)) return null;
  const levels = raw
    .filter((l): l is string => typeof l === 'string')
    .map((l) => l.trim().toLowerCase())
    .filter((l) => ALERT_LEVELS.has(l));
  // de-dupe preserve order
  const seen = new Set<string>();
  const out: string[] = [];
  for (const l of levels) {
    if (seen.has(l)) continue;
    seen.add(l);
    out.push(l);
  }
  return out.length > 0 ? out : null;
}

function parseCity(raw: unknown): { name: string; lat: number; lon: number; tz: string } | null {
  if (!raw || typeof raw !== 'object') return null;
  const c = raw as CityBody;
  if (typeof c.name !== 'string' || !c.name.trim()) return null;
  if (!isFiniteNumber(c.lat) || !isFiniteNumber(c.lon)) return null;
  const tz = typeof c.tz === 'string' && c.tz.trim() ? c.tz.trim() : 'Asia/Shanghai';
  return { name: c.name.trim(), lat: c.lat, lon: c.lon, tz };
}

function parseSubscription(raw: unknown): {
  endpoint: string;
  keys: { p256dh: string; auth: string };
} | null {
  if (!raw || typeof raw !== 'object') return null;
  const s = raw as SubscriptionBody;
  if (typeof s.endpoint !== 'string' || !s.endpoint.trim()) return null;
  const endpoint = s.endpoint.trim();
  if (!endpoint.startsWith('https://')) return null;
  const p256dh = s.keys && typeof s.keys.p256dh === 'string' ? s.keys.p256dh.trim() : '';
  const auth = s.keys && typeof s.keys.auth === 'string' ? s.keys.auth.trim() : '';
  if (!p256dh || !auth) return null;
  return { endpoint, keys: { p256dh, auth } };
}

function extractEndpoint(body: unknown): string | null {
  if (!body || typeof body !== 'object') return null;
  const b = body as { endpoint?: unknown; subscription?: unknown };
  if (typeof b.endpoint === 'string' && b.endpoint.trim()) {
    return b.endpoint.trim();
  }
  const sub = parseSubscription(b.subscription);
  return sub?.endpoint ?? null;
}

pushRoutes.post('/subscribe', async (c) => {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return jsonError(c, 400, 'Invalid JSON body', 'bad_json');
  }

  if (!body || typeof body !== 'object') {
    return jsonError(c, 400, 'Invalid body', 'bad_body');
  }

  const obj = body as {
    subscription?: unknown;
    city?: unknown;
    levels?: unknown;
  };

  const subscription = parseSubscription(obj.subscription);
  if (!subscription) {
    return jsonError(
      c,
      400,
      'Invalid subscription (endpoint must be https, keys.p256dh/auth required)',
      'bad_subscription',
    );
  }

  const city = parseCity(obj.city);
  if (!city) {
    return jsonError(c, 400, 'Invalid city (name, lat, lon required)', 'bad_city');
  }

  const levels = parseLevels(obj.levels);
  if (!levels) {
    return jsonError(c, 400, 'Invalid levels (need yellow/orange/red/blue)', 'bad_levels');
  }

  const now = Date.now();
  const keysJson = JSON.stringify(subscription.keys);
  const cityJson = JSON.stringify(city);
  const levelsJson = JSON.stringify(levels);

  const db = getDb();
  db.prepare(
    `
    INSERT INTO push_subscriptions (endpoint, keys_json, city, levels, created_at, last_seen)
    VALUES (@endpoint, @keys_json, @city, @levels, @now, @now)
    ON CONFLICT(endpoint) DO UPDATE SET
      keys_json = excluded.keys_json,
      city = excluded.city,
      levels = excluded.levels,
      last_seen = excluded.last_seen
    `,
  ).run({
    endpoint: subscription.endpoint,
    keys_json: keysJson,
    city: cityJson,
    levels: levelsJson,
    now,
  });

  return c.json({ ok: true });
});

pushRoutes.post('/unsubscribe', async (c) => {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return jsonError(c, 400, 'Invalid JSON body', 'bad_json');
  }

  const endpoint = extractEndpoint(body);
  if (!endpoint) {
    return jsonError(c, 400, 'endpoint required', 'bad_endpoint');
  }

  const result = getDb()
    .prepare('DELETE FROM push_subscriptions WHERE endpoint = ?')
    .run(endpoint);

  return c.json({ ok: true, deleted: result.changes });
});

pushRoutes.all('/*', (c) => jsonError(c, 404, 'Not found', 'not_found'));
