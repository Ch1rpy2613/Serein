/**
 * Cloudflare Pages Function：台风非官方上游代理。
 *
 * GET /api/typhoon/TyhoonActivity
 * GET /api/typhoon/TyphoonInfo/{tfid}
 *
 * 上游常量与客户端 `UNOFFICIAL_TYPHOON_UPSTREAM` 保持一致；失效时只改此处与 data/typhoon.ts。
 */

const UPSTREAM = 'https://typhoon.slt.zj.gov.cn/Api';
const CACHE_CONTROL = 'public, s-maxage=300';

const CORS_HEADERS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Accept, Content-Type',
  'Access-Control-Max-Age': '86400',
};

function joinPath(path: string | string[] | undefined): string {
  if (path == null) return '';
  if (Array.isArray(path)) return path.filter(Boolean).join('/');
  return String(path).replace(/^\/+/, '');
}

function jsonResponse(body: unknown, status = 200, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': CACHE_CONTROL,
      ...CORS_HEADERS,
      ...extra,
    },
  });
}

export async function onRequest(context: {
  request: Request;
  params: { path?: string | string[] };
}): Promise<Response> {
  const { request, params } = context;

  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }

  if (request.method !== 'GET') {
    return jsonResponse({ error: 'method not allowed' }, 405);
  }

  const suffix = joinPath(params.path);
  if (!suffix || suffix.includes('..')) {
    return jsonResponse({ error: 'bad path' }, 400);
  }

  // 仅放行已知列表 / 详情路径，避免开放代理
  const allowed =
    suffix === 'TyhoonActivity' ||
    /^TyphoonInfo\/[A-Za-z0-9_-]+$/.test(suffix) ||
    /^TyphoonList\/\d{4}$/.test(suffix);
  if (!allowed) {
    return jsonResponse({ error: 'path not allowed' }, 404);
  }

  const upstreamUrl = `${UPSTREAM}/${suffix}`;
  try {
    const upstream = await fetch(upstreamUrl, {
      headers: {
        Accept: 'application/json, text/plain, */*',
        'User-Agent': 'SereinTyphoonProxy/1.0',
      },
      cf: { cacheTtl: 300, cacheEverything: true },
    } as RequestInit);

    const text = await upstream.text();
    const contentType = upstream.headers.get('Content-Type') ?? 'application/json; charset=utf-8';

    return new Response(text, {
      status: upstream.status,
      headers: {
        'Content-Type': contentType.includes('json')
          ? 'application/json; charset=utf-8'
          : contentType,
        'Cache-Control': CACHE_CONTROL,
        ...CORS_HEADERS,
      },
    });
  } catch {
    return jsonResponse({ error: 'upstream unavailable' }, 502);
  }
}
