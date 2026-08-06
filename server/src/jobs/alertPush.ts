import webpush, { type PushSubscription, WebPushError } from 'web-push';
import { getDb } from '../db';

const INTERVAL_MS = 15 * 60 * 1000;
const FIRST_DELAY_MS = 30_000;
const FETCH_TIMEOUT_MS = 8_000;
const BODY_MAX = 80;

export type AlertLevel = 'blue' | 'yellow' | 'orange' | 'red';

export interface NormalizedAlert {
  id: string;
  title: string;
  type: string;
  level: AlertLevel;
  text: string;
  pubTime: number;
}

type SubRow = {
  endpoint: string;
  keys_json: string;
  city: string;
  levels: string;
};

type CityRef = {
  name: string;
  lat: number;
  lon: number;
  tz: string;
  key: string;
};

let consecutiveAllFail = 0;
let firstTimer: ReturnType<typeof setTimeout> | null = null;
let intervalTimer: ReturnType<typeof setInterval> | null = null;
let roundInFlight = false;
let vapidConfigured = false;

function qweatherCredentials():
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

/** Configure web-push VAPID once; returns false if keys missing. */
export function configureVapid(): boolean {
  const publicKey = String(process.env.VAPID_PUBLIC_KEY ?? '').trim();
  const privateKey = String(process.env.VAPID_PRIVATE_KEY ?? '').trim();
  const subject = String(process.env.VAPID_SUBJECT ?? '').trim() || 'mailto:atmos@localhost';
  if (!publicKey || !privateKey) {
    vapidConfigured = false;
    return false;
  }
  webpush.setVapidDetails(subject, publicKey, privateKey);
  vapidConfigured = true;
  return true;
}

function parseAlertLevel(title: string): AlertLevel {
  if (/红/.test(title)) return 'red';
  if (/橙/.test(title)) return 'orange';
  if (/黄/.test(title)) return 'yellow';
  if (/蓝/.test(title)) return 'blue';
  return 'yellow';
}

function parseAlertType(title: string, fallback = '预警'): string {
  const m = title.match(
    /(暴雨|暴雪|寒潮|大风|沙尘暴|陆地大风|雷电|冰雹|霜冻|大雾|霾|道路结冰|干旱|高温|森林火险|雷雨大风|台风|龙卷风)/,
  );
  return m?.[1] ?? fallback;
}

function toEpochSec(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value > 1e12 ? Math.round(value / 1000) : Math.round(value);
  }
  if (typeof value === 'string' && value.length > 0) {
    const ms = Date.parse(value);
    if (Number.isFinite(ms)) return Math.round(ms / 1000);
  }
  return Math.round(Date.now() / 1000);
}

type QwWarningRaw = {
  id?: string;
  title?: string;
  typeName?: string;
  type?: string;
  text?: string;
  pubTime?: string | number;
};

function mapQweatherWarning(raw: QwWarningRaw, index: number): NormalizedAlert | null {
  const title = typeof raw.title === 'string' ? raw.title.trim() : '';
  if (!title) return null;
  const id =
    typeof raw.id === 'string' && raw.id.length > 0
      ? raw.id
      : `qw-${index}-${title.slice(0, 24)}`;
  const typeName =
    typeof raw.typeName === 'string' && raw.typeName.length > 0
      ? raw.typeName
      : parseAlertType(title);
  return {
    id,
    title,
    type: typeName,
    level: parseAlertLevel(title),
    text: typeof raw.text === 'string' ? raw.text : '',
    pubTime: toEpochSec(raw.pubTime),
  };
}

/** Mock alerts for local acceptance when ALERT_PUSH_MOCK=1 */
function mockAlertsForCity(city: CityRef): NormalizedAlert[] {
  return [
    {
      id: `mock-push-${city.key}`,
      title: `${city.name}气象台发布暴雨橙色预警`,
      type: '暴雨',
      level: 'orange',
      text:
        '预计未来 6 小时本市部分地区降雨量将达 50 毫米以上，局地可超过 80 毫米，并伴有雷电。请注意防范城市内涝与交通影响。',
      pubTime: Math.round(Date.now() / 1000),
    },
  ];
}

async function fetchCityAlerts(city: CityRef): Promise<NormalizedAlert[]> {
  if (String(process.env.ALERT_PUSH_MOCK ?? '').trim() === '1') {
    return mockAlertsForCity(city);
  }

  const creds = qweatherCredentials();
  if (!creds.ok) {
    throw new Error('qweather_unconfigured');
  }

  const url = new URL(`https://${creds.host}/v7/warning/now`);
  url.searchParams.set('location', `${city.lon},${city.lat}`);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: 'GET',
      headers: {
        Accept: 'application/json',
        'X-QW-Api-Key': creds.key,
      },
      signal: controller.signal,
    });
    if (!res.ok) {
      throw new Error(`qweather_http_${res.status}`);
    }
    const json = (await res.json()) as {
      code?: string;
      warning?: QwWarningRaw[] | null;
    };
    if (json.code !== '200') {
      // 204 = no content / no warning — treat as empty success
      if (json.code === '204') return [];
      throw new Error(`qweather_code_${json.code ?? 'unknown'}`);
    }
    const list = Array.isArray(json.warning) ? json.warning : [];
    const out: NormalizedAlert[] = [];
    list.forEach((raw, i) => {
      const mapped = mapQweatherWarning(raw, i);
      if (mapped) out.push(mapped);
    });
    return out;
  } finally {
    clearTimeout(timer);
  }
}

function parseCityJson(raw: string): CityRef | null {
  try {
    const parsed = JSON.parse(raw) as {
      name?: unknown;
      lat?: unknown;
      lon?: unknown;
      tz?: unknown;
    };
    if (typeof parsed.name !== 'string' || !parsed.name.trim()) return null;
    if (typeof parsed.lat !== 'number' || !Number.isFinite(parsed.lat)) return null;
    if (typeof parsed.lon !== 'number' || !Number.isFinite(parsed.lon)) return null;
    const name = parsed.name.trim();
    const lat = parsed.lat;
    const lon = parsed.lon;
    const tz =
      typeof parsed.tz === 'string' && parsed.tz.trim() ? parsed.tz.trim() : 'Asia/Shanghai';
    // Dedup key: rounded coords so identical cities collapse
    const key = `${name}|${lon.toFixed(4)},${lat.toFixed(4)}`;
    return { name, lat, lon, tz, key };
  } catch {
    return null;
  }
}

function parseLevelsJson(raw: string): Set<AlertLevel> {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return new Set();
    const out = new Set<AlertLevel>();
    for (const item of parsed) {
      if (item === 'blue' || item === 'yellow' || item === 'orange' || item === 'red') {
        out.add(item);
      }
    }
    return out;
  } catch {
    return new Set();
  }
}

function parseKeysJson(raw: string): { p256dh: string; auth: string } | null {
  try {
    const parsed = JSON.parse(raw) as { p256dh?: unknown; auth?: unknown };
    if (typeof parsed.p256dh !== 'string' || typeof parsed.auth !== 'string') return null;
    if (!parsed.p256dh || !parsed.auth) return null;
    return { p256dh: parsed.p256dh, auth: parsed.auth };
  } catch {
    return null;
  }
}

function truncateBody(text: string): string {
  const t = text.replace(/\s+/g, ' ').trim();
  if (t.length <= BODY_MAX) return t;
  return `${t.slice(0, BODY_MAX)}…`;
}

function alreadyPushed(alertId: string): boolean {
  const row = getDb()
    .prepare('SELECT 1 AS ok FROM pushed_alerts WHERE alert_id = ?')
    .get(alertId) as { ok: number } | undefined;
  return Boolean(row);
}

function markPushed(alertId: string): void {
  getDb()
    .prepare(
      `
      INSERT INTO pushed_alerts (alert_id, pushed_at)
      VALUES (?, ?)
      ON CONFLICT(alert_id) DO NOTHING
      `,
    )
    .run(alertId, Date.now());
}

function deleteSubscription(endpoint: string): void {
  getDb().prepare('DELETE FROM push_subscriptions WHERE endpoint = ?').run(endpoint);
}

async function sendToSubscription(
  row: SubRow,
  alert: NormalizedAlert,
): Promise<'sent' | 'gone' | 'failed'> {
  const keys = parseKeysJson(row.keys_json);
  if (!keys) {
    deleteSubscription(row.endpoint);
    return 'gone';
  }

  const subscription: PushSubscription = {
    endpoint: row.endpoint,
    keys,
  };

  const payload = JSON.stringify({
    title: alert.title,
    body: truncateBody(alert.text),
    icon: '/atmos-icon-192.png',
    url: `/?alert=${encodeURIComponent(alert.id)}`,
  });

  try {
    await webpush.sendNotification(subscription, payload);
    return 'sent';
  } catch (err) {
    const status =
      err instanceof WebPushError
        ? err.statusCode
        : typeof err === 'object' &&
            err &&
            'statusCode' in err &&
            typeof (err as { statusCode: unknown }).statusCode === 'number'
          ? (err as { statusCode: number }).statusCode
          : undefined;
    if (status === 404 || status === 410) {
      deleteSubscription(row.endpoint);
      return 'gone';
    }
    console.warn('[alertPush] send failed', row.endpoint.slice(0, 48), err);
    return 'failed';
  }
}

/** One check round — exported for tests / manual trigger. */
export async function runAlertPushRound(): Promise<void> {
  if (!vapidConfigured && !configureVapid()) {
    console.warn('[alertPush] skip: VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY not configured');
    return;
  }

  const rows = getDb()
    .prepare(
      'SELECT endpoint, keys_json, city, levels FROM push_subscriptions ORDER BY last_seen DESC',
    )
    .all() as SubRow[];

  if (rows.length === 0) {
    console.info('[alertPush] round: 0 subscriptions — idle');
    consecutiveAllFail = 0;
    return;
  }

  // Dedup cities
  const cityMap = new Map<string, { city: CityRef; subs: SubRow[] }>();
  for (const row of rows) {
    const city = parseCityJson(row.city);
    if (!city) continue;
    let bucket = cityMap.get(city.key);
    if (!bucket) {
      bucket = { city, subs: [] };
      cityMap.set(city.key, bucket);
    }
    bucket.subs.push(row);
  }

  let citiesOk = 0;
  let citiesFail = 0;
  let alertsSeen = 0;
  let alertsNew = 0;
  let sent = 0;
  let gone = 0;
  let sendFail = 0;

  for (const { city, subs } of cityMap.values()) {
    let alerts: NormalizedAlert[];
    try {
      alerts = await fetchCityAlerts(city);
      citiesOk += 1;
    } catch (err) {
      citiesFail += 1;
      console.warn('[alertPush] city fetch failed', city.name, err);
      continue;
    }

    alertsSeen += alerts.length;

    for (const alert of alerts) {
      if (alreadyPushed(alert.id)) continue;
      alertsNew += 1;

      for (const sub of subs) {
        const levels = parseLevelsJson(sub.levels);
        if (!levels.has(alert.level)) continue;
        const result = await sendToSubscription(sub, alert);
        if (result === 'sent') sent += 1;
        else if (result === 'gone') gone += 1;
        else sendFail += 1;
      }

      // 处理完即记入，避免跨轮重复推（级别未命中的也记，防 churn）
      markPushed(alert.id);
    }
  }

  if (cityMap.size > 0 && citiesOk === 0 && citiesFail > 0) {
    consecutiveAllFail += 1;
    if (consecutiveAllFail >= 3) {
      // TODO: 接邮件 / Webhook 告警
      console.error(
        `[alertPush] ALERT: ${consecutiveAllFail} consecutive rounds with all city fetches failed`,
      );
    }
  } else if (citiesOk > 0) {
    consecutiveAllFail = 0;
  }

  console.info(
    `[alertPush] round: cities=${cityMap.size} ok=${citiesOk} fail=${citiesFail}` +
      ` alerts=${alertsSeen} new=${alertsNew} sent=${sent} gone=${gone} sendFail=${sendFail}` +
      ` subs=${rows.length}`,
  );
}

async function safeRound(): Promise<void> {
  if (roundInFlight) {
    console.warn('[alertPush] previous round still running — skip');
    return;
  }
  roundInFlight = true;
  try {
    await runAlertPushRound();
  } catch (err) {
    console.error('[alertPush] round crashed', err);
  } finally {
    roundInFlight = false;
  }
}

/** In-process scheduler: first run after 30s, then every 15 minutes. */
export function startAlertPushJob(): () => void {
  configureVapid();
  if (!vapidConfigured) {
    console.warn(
      '[alertPush] VAPID keys missing — job will no-op until VAPID_PUBLIC_KEY/PRIVATE_KEY set',
    );
  } else {
    console.info('[alertPush] scheduled (first run in 30s, then every 15m)');
  }

  firstTimer = setTimeout(() => {
    void safeRound();
    intervalTimer = setInterval(() => {
      void safeRound();
    }, INTERVAL_MS);
    if (intervalTimer && typeof intervalTimer === 'object' && 'unref' in intervalTimer) {
      intervalTimer.unref();
    }
  }, FIRST_DELAY_MS);
  if (firstTimer && typeof firstTimer === 'object' && 'unref' in firstTimer) {
    firstTimer.unref();
  }

  return () => {
    if (firstTimer) {
      clearTimeout(firstTimer);
      firstTimer = null;
    }
    if (intervalTimer) {
      clearInterval(intervalTimer);
      intervalTimer = null;
    }
  };
}
