import { randomInt } from 'node:crypto';
import { Hono } from 'hono';
import { getDb } from '../db';
import { allowRequest, clientIp, jsonError } from '../utils';

/** 跨端同步：8 位码即凭证，乐观锁 version */
export const syncRoutes = new Hono();

const CODE_ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
const CODE_LENGTH = 8;
const MAX_PAYLOAD_BYTES = 64 * 1024;
const SYNC_RATE_LIMIT = 30;
const CREATE_RETRIES = 8;

type SyncRow = {
  code: string;
  payload: string;
  version: number;
  updated_at: number;
};

function noStore(c: { header: (name: string, value: string) => void }): void {
  c.header('Cache-Control', 'no-store');
}

/** sync 专用：同 IP 每分钟 30 次（与全局 /api 限流独立计数） */
syncRoutes.use('*', async (c, next) => {
  const gate = allowRequest(`sync:${clientIp(c)}`, SYNC_RATE_LIMIT);
  if (!gate.ok) {
    noStore(c);
    c.header('Retry-After', String(gate.retryAfterSec));
    return jsonError(c, 429, 'Too many requests', 'rate_limited');
  }
  await next();
  noStore(c);
});

function generateCode(): string {
  let out = '';
  for (let i = 0; i < CODE_LENGTH; i += 1) {
    out += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)]!;
  }
  return out;
}

function normalizeCode(raw: string): string | null {
  const code = raw.trim().toUpperCase().replace(/[^0-9A-Z]/g, '');
  if (code.length !== CODE_LENGTH) return null;
  for (const ch of code) {
    if (!CODE_ALPHABET.includes(ch)) return null;
  }
  return code;
}

/** 校验 payload：须为合法 JSON，序列化后 < 64KB；不解析字段语义 */
function validatePayload(raw: unknown):
  | { ok: true; json: string }
  | { ok: false; reason: 'bad_json' | 'too_large' } {
  let json: string;
  if (typeof raw === 'string') {
    try {
      JSON.parse(raw);
    } catch {
      return { ok: false, reason: 'bad_json' };
    }
    json = raw;
  } else {
    try {
      json = JSON.stringify(raw ?? {});
    } catch {
      return { ok: false, reason: 'bad_json' };
    }
    // round-trip to ensure it re-parses
    try {
      JSON.parse(json);
    } catch {
      return { ok: false, reason: 'bad_json' };
    }
  }
  if (Buffer.byteLength(json, 'utf8') >= MAX_PAYLOAD_BYTES) {
    return { ok: false, reason: 'too_large' };
  }
  return { ok: true, json };
}

function getRow(code: string): SyncRow | undefined {
  return getDb()
    .prepare('SELECT code, payload, version, updated_at FROM sync_states WHERE code = ?')
    .get(code) as SyncRow | undefined;
}

syncRoutes.post('/create', async (c) => {
  let body: unknown = {};
  const contentType = c.req.header('content-type') ?? '';
  if (contentType.includes('application/json')) {
    try {
      body = await c.req.json();
    } catch {
      return jsonError(c, 400, 'Invalid JSON body', 'bad_json');
    }
  }

  const payloadRaw =
    body && typeof body === 'object' && 'payload' in body
      ? (body as { payload: unknown }).payload
      : body && typeof body === 'object' && Object.keys(body as object).length > 0
        ? body
        : {};

  const checked = validatePayload(payloadRaw ?? {});
  if (!checked.ok) {
    if (checked.reason === 'too_large') {
      return jsonError(c, 400, 'Payload too large (max 64KB)', 'payload_too_large');
    }
    return jsonError(c, 400, 'Invalid JSON payload', 'bad_json');
  }

  const db = getDb();
  const insert = db.prepare(
    `
    INSERT INTO sync_states (code, payload, version, updated_at)
    VALUES (@code, @payload, @version, @updated_at)
    `,
  );

  const now = Date.now();
  let code: string | null = null;
  for (let attempt = 0; attempt < CREATE_RETRIES; attempt += 1) {
    const candidate = generateCode();
    try {
      insert.run({
        code: candidate,
        payload: checked.json,
        version: 1,
        updated_at: now,
      });
      code = candidate;
      break;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (/UNIQUE/i.test(msg)) continue;
      throw err;
    }
  }

  if (!code) {
    return jsonError(c, 500, 'Failed to allocate sync code', 'code_alloc_failed');
  }

  return c.json({ code, version: 1 });
});

syncRoutes.get('/:code', (c) => {
  const code = normalizeCode(c.req.param('code'));
  if (!code) {
    return jsonError(c, 404, 'Sync code not found', 'not_found');
  }

  const row = getRow(code);
  if (!row) {
    return jsonError(c, 404, 'Sync code not found', 'not_found');
  }

  let payload: unknown;
  try {
    payload = JSON.parse(row.payload);
  } catch {
    payload = {};
  }

  return c.json({ payload, version: row.version });
});

syncRoutes.put('/:code', async (c) => {
  const code = normalizeCode(c.req.param('code'));
  if (!code) {
    return jsonError(c, 404, 'Sync code not found', 'not_found');
  }

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return jsonError(c, 400, 'Invalid JSON body', 'bad_json');
  }

  if (!body || typeof body !== 'object') {
    return jsonError(c, 400, 'Invalid body', 'bad_body');
  }

  const obj = body as { payload?: unknown; version?: unknown };
  if (typeof obj.version !== 'number' || !Number.isInteger(obj.version) || obj.version < 1) {
    return jsonError(c, 400, 'version must be a positive integer', 'bad_version');
  }

  const checked = validatePayload(obj.payload ?? {});
  if (!checked.ok) {
    if (checked.reason === 'too_large') {
      return jsonError(c, 400, 'Payload too large (max 64KB)', 'payload_too_large');
    }
    return jsonError(c, 400, 'Invalid JSON payload', 'bad_json');
  }

  const row = getRow(code);
  if (!row) {
    return jsonError(c, 404, 'Sync code not found', 'not_found');
  }

  if (row.version !== obj.version) {
    return c.json(
      {
        error: 'Version conflict',
        code: 'version_conflict',
        version: row.version,
      },
      409,
    );
  }

  const nextVersion = row.version + 1;
  const now = Date.now();
  const result = getDb()
    .prepare(
      `
      UPDATE sync_states
      SET payload = @payload, version = @version, updated_at = @updated_at
      WHERE code = @code AND version = @expected
      `,
    )
    .run({
      payload: checked.json,
      version: nextVersion,
      updated_at: now,
      code,
      expected: obj.version,
    });

  if (result.changes === 0) {
    const latest = getRow(code);
    return c.json(
      {
        error: 'Version conflict',
        code: 'version_conflict',
        version: latest?.version ?? row.version,
      },
      409,
    );
  }

  return c.json({ version: nextVersion });
});

syncRoutes.all('/*', (c) => jsonError(c, 404, 'Not found', 'not_found'));
