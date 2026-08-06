import { Hono } from 'hono';
import { jsonError } from '../utils';

/**
 * 自托管等价于 Cloudflare Pages Function `functions/api/typhoon/[[path]].ts`：
 * 浙江水利公开源代理（无 CORS；同源由 Caddy 反代）。
 */
export const typhoonRoutes = new Hono();

const UPSTREAM = 'https://typhoon.slt.zj.gov.cn/Api';
const CACHE_CONTROL = 'public, max-age=300';

function joinPath(rawPath: string): string {
  const stripped = rawPath.includes('/api/typhoon/')
    ? rawPath.slice(rawPath.indexOf('/api/typhoon/') + '/api/typhoon/'.length)
    : rawPath.replace(/^\/+/, '');
  return stripped.replace(/^\/+/, '');
}

function allowed(suffix: string): boolean {
  return (
    suffix === 'TyhoonActivity' ||
    /^TyphoonInfo\/[A-Za-z0-9_-]+$/.test(suffix) ||
    /^TyphoonList\/\d{4}$/.test(suffix)
  );
}

typhoonRoutes.get('/*', async (c) => {
  const suffix = joinPath(c.req.path);
  if (!suffix || suffix.includes('..')) {
    return jsonError(c, 400, 'Invalid path', 'bad_path');
  }
  if (!allowed(suffix)) {
    return jsonError(c, 404, 'path not allowed', 'not_found');
  }

  const upstreamUrl = `${UPSTREAM}/${suffix}`;
  let upstream: Response;
  try {
    upstream = await fetch(upstreamUrl, {
      method: 'GET',
      headers: {
        Accept: 'application/json, text/plain, */*',
        'User-Agent': 'SereinTyphoonProxy/1.0',
      },
    });
  } catch (err) {
    console.warn('[typhoon] upstream fetch failed', err);
    return jsonError(c, 502, 'Upstream request failed', 'upstream_unreachable');
  }

  const headers = new Headers();
  const contentType = upstream.headers.get('content-type');
  if (contentType) {
    headers.set(
      'Content-Type',
      contentType.includes('json') ? 'application/json; charset=utf-8' : contentType,
    );
  } else {
    headers.set('Content-Type', 'application/json; charset=utf-8');
  }
  headers.set('Cache-Control', CACHE_CONTROL);
  headers.set('X-Content-Type-Options', 'nosniff');

  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers,
  });
});

typhoonRoutes.all('/*', (c) => jsonError(c, 404, 'Not found', 'not_found'));
