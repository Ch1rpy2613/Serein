/**
 * NASA GIBS WMTS —— 真彩色卫星底图（免费、无 key、CORS 开放）。
 *
 * 层选自 GetCapabilities（epsg3857/best）：
 *   VIIRS_SNPP_CorrectedReflectance_TrueColor
 *   TileMatrixSet = GoogleMapsCompatible_Level9（max z = 9）
 *   Format = image/jpeg → 扩展名 .jpeg
 *
 * REST 模板（GoogleMapsCompatible；TileRow/TileCol = MapLibre {y}/{x}）：
 *   …/{Layer}/default/{YYYY-MM-DD}/{TileMatrixSet}/{z}/{y}/{x}.jpeg
 *
 * TODO: FY-4 / Himawari 实时云图公开源 CORS 不友好，留接口位
 * （见 `attachRealtimeCloudLayer`）。勿在此硬接需代理的国内源。
 */

export const GIBS_CAPABILITIES_URL =
  'https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/wmts.cgi?SERVICE=WMTS&REQUEST=GetCapabilities';

/** capabilities 选定的 CorrectedReflectance 真彩色层 */
export const GIBS_LAYER_ID = 'VIIRS_SNPP_CorrectedReflectance_TrueColor';

export const GIBS_TILE_MATRIX_SET = 'GoogleMapsCompatible_Level9';

export const GIBS_MAX_ZOOM = 9;

export const GIBS_FORMAT_EXT = 'jpeg';

export const GIBS_ATTRIBUTION =
  '卫星真彩色 · 延迟数小时，非实时云图 · 影像 © NASA GIBS';

export interface GibsTimePeriod {
  start: string; // YYYY-MM-DD
  end: string;
}

export interface GibsLayerMeta {
  layerId: string;
  defaultDate: string;
  periods: GibsTimePeriod[];
}

export interface ResolvedGibsDate {
  /** 实际请求瓦片的日期 */
  date: string;
  /** 相对用户请求日是否降级（未来 / 缺口） */
  degraded: boolean;
  /** 用户请求日 */
  requested: string;
}

const DAY_MS = 86_400_000;

function parseIsoDay(iso: string): number {
  const [y, m, d] = iso.split('-').map(Number);
  return Date.UTC(y, m - 1, d);
}

function formatIsoDay(utcMs: number): string {
  return new Date(utcMs).toISOString().slice(0, 10);
}

function addDays(iso: string, delta: number): string {
  return formatIsoDay(parseIsoDay(iso) + delta * DAY_MS);
}

/** 解析 Dimension `<Value>`：`YYYY-MM-DD/YYYY-MM-DD/P1D` */
export function parseGibsPeriodValue(value: string): GibsTimePeriod | null {
  const parts = value.split('/');
  if (parts.length < 2) return null;
  const start = parts[0];
  const end = parts[1];
  if (!/^\d{4}-\d{2}-\d{2}$/.test(start) || !/^\d{4}-\d{2}-\d{2}$/.test(end)) {
    return null;
  }
  return { start, end };
}

export function dateInPeriods(date: string, periods: readonly GibsTimePeriod[]): boolean {
  const t = parseIsoDay(date);
  for (const p of periods) {
    if (t >= parseIsoDay(p.start) && t <= parseIsoDay(p.end)) return true;
  }
  return false;
}

/** 不晚于 `date` 的最近可用日；无则 null */
export function nearestAvailableOnOrBefore(
  date: string,
  periods: readonly GibsTimePeriod[],
): string | null {
  if (periods.length === 0) return null;
  if (dateInPeriods(date, periods)) return date;

  let best: string | null = null;
  let bestT = -Infinity;
  const target = parseIsoDay(date);
  for (const p of periods) {
    const endT = parseIsoDay(p.end);
    const startT = parseIsoDay(p.start);
    if (endT <= target) {
      if (endT > bestT) {
        bestT = endT;
        best = p.end;
      }
    } else if (startT <= target && target <= endT) {
      return date;
    }
  }
  return best;
}

/**
 * 将用户日期映射到 GIBS 可用日。
 * 未来 / 缺口 → 最近可用日；`degraded` 标注给 UI。
 */
export function resolveGibsDate(
  requested: string,
  meta: Pick<GibsLayerMeta, 'defaultDate' | 'periods'>,
): ResolvedGibsDate {
  const latest = meta.defaultDate || meta.periods.at(-1)?.end || requested;
  let candidate = requested > latest ? latest : requested;
  const available = nearestAvailableOnOrBefore(candidate, meta.periods);
  const date = available ?? latest;
  return {
    date,
    requested,
    degraded: date !== requested,
  };
}

/** MapLibre raster `tiles` 模板（勿加 cache-bust query，以便浏览器缓存） */
export function gibsTileTemplate(dateIso: string): string {
  return (
    `https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/${GIBS_LAYER_ID}` +
    `/default/${dateIso}/${GIBS_TILE_MATRIX_SET}/{z}/{y}/{x}.${GIBS_FORMAT_EXT}`
  );
}

/** 从 GetCapabilities XML 抽取本层时间维 */
export function parseGibsLayerMeta(xml: string, layerId = GIBS_LAYER_ID): GibsLayerMeta | null {
  const needle = `<ows:Identifier>${layerId}</ows:Identifier>`;
  const idx = xml.indexOf(needle);
  if (idx < 0) return null;
  // 取 Identifier 后到下一顶层 Layer 标识之前的片段（足够覆盖 Dimension）
  const chunk = xml.slice(idx, idx + 12_000);
  const defaultMatch = chunk.match(/<Default>(\d{4}-\d{2}-\d{2})<\/Default>/);
  const periods: GibsTimePeriod[] = [];
  for (const match of chunk.matchAll(/<Value>([^<]+)<\/Value>/g)) {
    const period = parseGibsPeriodValue(match[1]);
    if (period) periods.push(period);
  }
  if (!defaultMatch && periods.length === 0) return null;
  const defaultDate = defaultMatch?.[1] ?? periods[periods.length - 1]!.end;
  periods.sort((a, b) => (a.start < b.start ? -1 : 1));
  return { layerId, defaultDate, periods };
}

let cachedMeta: GibsLayerMeta | null = null;
let metaPromise: Promise<GibsLayerMeta> | null = null;

/** 离线兜底：capabilities 失败时用「昨天」作最新日 */
export function fallbackGibsMeta(todayIso: string): GibsLayerMeta {
  const end = addDays(todayIso, -1);
  return {
    layerId: GIBS_LAYER_ID,
    defaultDate: end,
    periods: [{ start: '2015-11-24', end }],
  };
}

export async function loadGibsLayerMeta(
  fetchImpl: typeof fetch = fetch,
): Promise<GibsLayerMeta> {
  if (cachedMeta) return cachedMeta;
  if (metaPromise) return metaPromise;
  metaPromise = (async () => {
    const response = await fetchImpl(GIBS_CAPABILITIES_URL, {
      credentials: 'omit',
      // 不强制 no-cache：capabilities 可走浏览器缓存
    });
    if (!response.ok) {
      throw new Error(`GIBS capabilities HTTP ${response.status}`);
    }
    const xml = await response.text();
    const meta = parseGibsLayerMeta(xml);
    if (!meta) {
      throw new Error(`GIBS capabilities 未找到层 ${GIBS_LAYER_ID}`);
    }
    cachedMeta = meta;
    return meta;
  })();
  try {
    return await metaPromise;
  } finally {
    metaPromise = null;
  }
}

/**
 * TODO: FY-4B / Himawari-8/9 实时云图公开瓦片 CORS 多不可用；
 * 若日后有同源代理，在此挂 raster source，勿直接改 GIBS 路径。
 */
export function attachRealtimeCloudLayer(_map: unknown): void {
  // reserved interface
}
