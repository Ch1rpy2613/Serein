import { Hono } from 'hono';
import { jsonError } from '../utils';

/** 同源代理：GET /api/qweather/v7/... → https://{HOST}/v7/... + X-QW-Api-Key */
export const qweatherRoutes = new Hono();

const CACHE_CONTROL = 'public, max-age=480'; // 8 分钟（5–10 分钟窗口）

function credentials():
  | { ok: true; host: string; key: string }
  | { ok: false } {
  const key = String(process.env.QWEATHER_KEY ?? '').trim();
  const host = String(process.env.QWEATHER_HOST ?? '')
    .trim()
    .replace(/^https?:\/\//, '')
    .replace(/\/$/, '');
  if (!key || !host) return { ok: false };
  return { ok: true, host, key };
}

qweatherRoutes.get('/*', async (c) => {
  const creds = credentials();
  if (!creds.ok) {
    return jsonError(c, 503, 'QWeather credentials not configured', 'qweather_unconfigured');
  }

  // 挂载后 c.req.path 可能是完整路径或相对路径；统一成 v7/...
  const rawPath = c.req.path;
  const stripped = rawPath.includes('/api/qweather/')
    ? rawPath.slice(rawPath.indexOf('/api/qweather/') + '/api/qweather/'.length)
    : rawPath.replace(/^\/+/, '');
  const subPath = stripped.replace(/^\/+/, '');
  if (!subPath || subPath.includes('..')) {
    return jsonError(c, 400, 'Invalid path', 'bad_path');
  }

  const upstreamUrl = new URL(`https://${creds.host}/${subPath}`);
  const incoming = new URL(c.req.url);
  incoming.searchParams.forEach((value, key) => {
    upstreamUrl.searchParams.set(key, value);
  });

  let upstream: Response;
  try {
    upstream = await fetch(upstreamUrl, {
      method: 'GET',
      headers: {
        Accept: c.req.header('Accept') ?? 'application/json',
        'X-QW-Api-Key': creds.key,
      },
    });
  } catch (err) {
    console.warn('[qweather] upstream fetch failed', err);
    return jsonError(c, 502, 'Upstream request failed', 'upstream_unreachable');
  }

  const headers = new Headers();
  const contentType = upstream.headers.get('content-type');
  if (contentType) headers.set('Content-Type', contentType);
  headers.set('Cache-Control', CACHE_CONTROL);
  headers.set('X-Content-Type-Options', 'nosniff');

  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers,
  });
});
