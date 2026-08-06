import { Hono } from 'hono';
import { jsonError } from '../utils';

/**
 * NOAA SWPC Planetary K-index 代理。
 * 上游：https://services.swpc.noaa.gov/products/noaa-planetary-k-index.json
 * 缓存 3h，避免直连 CORS / 刷屏。
 */
export const swpcRoutes = new Hono();

const UPSTREAM = 'https://services.swpc.noaa.gov/products/noaa-planetary-k-index.json';
const CACHE_TTL_MS = 3 * 60 * 60 * 1000;
const CACHE_CONTROL = 'public, max-age=10800';

type Cache = { fetchedAt: number; body: string; status: number };
let cache: Cache | null = null;

swpcRoutes.get('/kp', async (c) => {
  const now = Date.now();
  if (cache && now - cache.fetchedAt < CACHE_TTL_MS) {
    return new Response(cache.body, {
      status: cache.status,
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': CACHE_CONTROL,
        'X-Content-Type-Options': 'nosniff',
        'X-Cache': 'HIT',
      },
    });
  }

  let upstream: Response;
  try {
    upstream = await fetch(UPSTREAM, {
      headers: { Accept: 'application/json' },
    });
  } catch (err) {
    console.warn('[swpc] upstream fetch failed', err);
    if (cache) {
      return new Response(cache.body, {
        status: cache.status,
        headers: {
          'Content-Type': 'application/json',
          'Cache-Control': CACHE_CONTROL,
          'X-Content-Type-Options': 'nosniff',
          'X-Cache': 'STALE',
        },
      });
    }
    return jsonError(c, 502, 'SWPC upstream unreachable', 'upstream_unreachable');
  }

  const body = await upstream.text();
  if (upstream.ok) {
    cache = { fetchedAt: now, body, status: upstream.status };
  }

  return new Response(body, {
    status: upstream.status,
    headers: {
      'Content-Type': upstream.headers.get('content-type') ?? 'application/json',
      'Cache-Control': CACHE_CONTROL,
      'X-Content-Type-Options': 'nosniff',
      'X-Cache': 'MISS',
    },
  });
});
