import type { Context } from 'hono';

export type ApiErrorBody = {
  error: string;
  code?: string;
};

/** 统一 JSON 错误响应 */
export function jsonError(
  c: Context,
  status: 400 | 401 | 403 | 404 | 409 | 429 | 500 | 501 | 502 | 503,
  message: string,
  code?: string,
): Response {
  const body: ApiErrorBody = { error: message };
  if (code) body.code = code;
  return c.json(body, status);
}

type RateBucket = { count: number; resetAt: number };

const buckets = new Map<string, RateBucket>();

/** 内存 rate limit：同 IP 默认 60 次 / 分钟 */
export function allowRequest(
  ip: string,
  limit = 60,
  windowMs = 60_000,
): { ok: true } | { ok: false; retryAfterSec: number } {
  const now = Date.now();
  let bucket = buckets.get(ip);
  if (!bucket || now >= bucket.resetAt) {
    bucket = { count: 0, resetAt: now + windowMs };
    buckets.set(ip, bucket);
  }
  bucket.count += 1;
  if (bucket.count > limit) {
    return { ok: false, retryAfterSec: Math.max(1, Math.ceil((bucket.resetAt - now) / 1000)) };
  }
  return { ok: true };
}

/** 取客户端 IP（本地直连时多为 127.0.0.1） */
export function clientIp(c: Context): string {
  const xff = c.req.header('x-forwarded-for');
  if (xff) {
    const first = xff.split(',')[0]?.trim();
    if (first) return first;
  }
  const real = c.req.header('x-real-ip')?.trim();
  if (real) return real;
  return '127.0.0.1';
}

/** 测试辅助：清空 rate limit 桶 */
export function resetRateLimitState(): void {
  buckets.clear();
}
