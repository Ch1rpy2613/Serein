/**
 * TyphoonLayer —— 活跃台风列表 + 路径动画。
 *
 * 与雷达场景共用 `import('maplibre-gl')`（Vite manualChunks → 同一 maplibre-gl chunk）。
 * 回放使用场景内独立 mini 时间轴，不读写全局 currentTime。
 */

import type {
  GeoJSONSource,
  Map as MapLibreMap,
  Marker,
  StyleSpecification,
} from 'maplibre-gl';
import type { DayData, WeatherLayer } from '../../contracts';
import {
  colorForLevel,
  fetchActiveTyphoons,
  type TrackPoint,
  type Typhoon,
  type WindQuadrants,
} from '../../data/typhoon';

type Quality = 'low' | 'medium' | 'high';
type MapLibreModule = typeof import('maplibre-gl');

const SOURCE_BASE = 'serein-ty-carto';
const LAYER_BASE = 'serein-ty-carto';
const SOURCE_CONE = 'serein-ty-cone';
const SOURCE_PAST = 'serein-ty-past';
const SOURCE_FORECAST = 'serein-ty-forecast';
const SOURCE_POINTS = 'serein-ty-points';
const SOURCE_WIND = 'serein-ty-wind';
const LAYER_CONE = 'serein-ty-cone-fill';
const LAYER_PAST = 'serein-ty-past-line';
const LAYER_FORECAST = 'serein-ty-forecast-line';
const LAYER_POINTS = 'serein-ty-points-circle';
const LAYER_WIND_7 = 'serein-ty-wind-7';
const LAYER_WIND_10 = 'serein-ty-wind-10';

const DEFAULT_ZOOM = 4.2;
const NW_PACIFIC_CENTER: [number, number] = [135, 22];
/** 回放：4 倍速 = 4 小时路径时间 / 1 秒墙钟 */
const PLAY_HOURS_PER_SEC = 4;
const ATTRIBUTION = '© OpenStreetMap © CARTO · Typhoon data';

const CARTO_TILES = [
  'https://a.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}.png',
  'https://b.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}.png',
  'https://c.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}.png',
  'https://d.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}.png',
];

const LAYER_CSS = `
.serein-ty-layer {
  position: absolute;
  inset: 0;
  overflow: hidden;
  background: var(--bg);
  color: var(--fg-1, rgba(255,255,255,.92));
  font-family: Outfit, "PingFang SC", "Hiragino Sans GB", sans-serif;
  font-variant-numeric: tabular-nums;
  isolation: isolate;
  touch-action: none;
  user-select: none;
  -webkit-user-select: none;
}
.serein-ty-map {
  position: absolute;
  inset: 0;
  z-index: 0;
}
.serein-ty-map .maplibregl-canvas,
.serein-ty-map .maplibregl-canvas-container {
  outline: none;
}
.serein-ty-credit {
  position: absolute;
  right: max(8px, env(safe-area-inset-right, 0px));
  bottom: max(8px, env(safe-area-inset-bottom, 0px));
  z-index: 2;
  margin: 0;
  color: var(--fg-2, rgba(255,255,255,.45));
  font-size: 9px;
  font-weight: 450;
  letter-spacing: .02em;
  line-height: 1.3;
  pointer-events: none;
  text-shadow: 0 1px 2px rgba(0,0,0,.65);
}
.serein-ty-empty {
  position: absolute;
  inset: 0;
  z-index: 3;
  display: none;
  place-content: center;
  place-items: center;
  background: var(--bg);
  text-align: center;
}
.serein-ty-empty[data-visible='true'] {
  display: grid;
}
.serein-ty-empty p {
  margin: 0;
  color: var(--fg-2, rgba(255,255,255,.45));
  font-size: 14px;
  letter-spacing: .06em;
}
.serein-ty-list {
  position: absolute;
  top: max(12px, env(safe-area-inset-top, 0px));
  left: 50%;
  z-index: 4;
  display: flex;
  gap: 6px;
  max-width: min(92vw, 420px);
  padding: 0 8px;
  overflow-x: auto;
  transform: translateX(-50%);
  scrollbar-width: none;
  pointer-events: auto;
}
.serein-ty-list::-webkit-scrollbar { display: none; }
.serein-ty-list button {
  flex: 0 0 auto;
  min-height: 30px;
  padding: 0 12px;
  border: 1px solid color-mix(in srgb, var(--line, rgba(255,255,255,.22)) 80%, transparent);
  border-radius: 999px;
  background: color-mix(in srgb, var(--bg) 55%, transparent);
  color: var(--fg-2, rgba(255,255,255,.45));
  font: inherit;
  font-size: 12px;
  letter-spacing: .04em;
  cursor: pointer;
  white-space: nowrap;
}
.serein-ty-list button[data-active='true'] {
  border-color: color-mix(in srgb, var(--accent) 55%, transparent);
  color: var(--fg-1, rgba(255,255,255,.92));
  background: color-mix(in srgb, var(--accent) 14%, transparent);
}
.serein-ty-marker {
  display: grid;
  justify-items: center;
  gap: 4px;
  pointer-events: none;
  transform: translateY(-4px);
}
.serein-ty-symbol {
  width: 36px;
  height: 36px;
  animation: serein-ty-spin 6s linear infinite;
}
.serein-ty-symbol svg {
  display: block;
  width: 100%;
  height: 100%;
  filter: drop-shadow(0 1px 3px rgba(0,0,0,.55));
}
@keyframes serein-ty-spin {
  to { transform: rotate(360deg); }
}
@media (prefers-reduced-motion: reduce) {
  .serein-ty-symbol { animation: none; }
}
.serein-ty-label {
  padding: 2px 8px;
  border-radius: 6px;
  background: color-mix(in srgb, var(--bg) 62%, transparent);
  color: var(--fg-1, rgba(255,255,255,.92));
  font-size: 11px;
  font-weight: 520;
  letter-spacing: .04em;
  white-space: nowrap;
  text-shadow: 0 1px 2px rgba(0,0,0,.65);
}
.serein-ty-scrub {
  position: absolute;
  left: 50%;
  bottom: max(36px, calc(28px + env(safe-area-inset-bottom, 0px)));
  z-index: 4;
  display: none;
  align-items: center;
  gap: 10px;
  width: min(92vw, 360px);
  padding: 8px 12px;
  border: 1px solid color-mix(in srgb, var(--line, rgba(255,255,255,.22)) 70%, transparent);
  border-radius: 12px;
  background: color-mix(in srgb, var(--bg) 72%, transparent);
  transform: translateX(-50%);
  pointer-events: auto;
}
.serein-ty-scrub[data-visible='true'] {
  display: flex;
}
.serein-ty-scrub button {
  flex: 0 0 auto;
  width: 32px;
  height: 32px;
  padding: 0;
  border: 1px solid color-mix(in srgb, var(--accent) 45%, transparent);
  border-radius: 8px;
  background: color-mix(in srgb, var(--accent) 12%, transparent);
  color: var(--fg-1, rgba(255,255,255,.92));
  font: inherit;
  cursor: pointer;
  display: grid;
  place-items: center;
}
.serein-ty-scrub button svg {
  width: 14px;
  height: 14px;
  fill: currentColor;
}
.serein-ty-scrub input[type='range'] {
  flex: 1 1 auto;
  min-width: 0;
  accent-color: var(--accent);
  cursor: pointer;
}
.serein-ty-scrub-meta {
  flex: 0 0 auto;
  min-width: 72px;
  color: var(--fg-2, rgba(255,255,255,.45));
  font-size: 11px;
  text-align: right;
  letter-spacing: .02em;
}
.serein-ty-readout {
  position: absolute;
  top: max(52px, calc(40px + env(safe-area-inset-top, 0px)));
  left: max(12px, env(safe-area-inset-left, 0px));
  z-index: 3;
  display: none;
  margin: 0;
  padding: 8px 10px;
  border-radius: 10px;
  background: color-mix(in srgb, var(--bg) 55%, transparent);
  color: var(--fg-1, rgba(255,255,255,.92));
  font-size: 12px;
  line-height: 1.45;
  letter-spacing: .03em;
  pointer-events: none;
  text-shadow: 0 1px 2px rgba(0,0,0,.55);
}
.serein-ty-readout[data-visible='true'] {
  display: block;
}
.serein-ty-readout strong {
  font-weight: 600;
  color: var(--accent);
}
`;

const clamp = (x: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, x));

function baseStyle(): StyleSpecification {
  return {
    version: 8,
    sources: {
      [SOURCE_BASE]: {
        type: 'raster',
        tiles: CARTO_TILES,
        tileSize: 256,
        attribution: '',
      },
    },
    layers: [
      {
        id: 'serein-ty-bg',
        type: 'background',
        paint: { 'background-color': '#0a121c' },
      },
      {
        id: LAYER_BASE,
        type: 'raster',
        source: SOURCE_BASE,
        paint: {
          'raster-opacity': 1,
          'raster-fade-duration': 0,
        },
      },
    ],
  };
}

/** 四象限风圈 → 多边形环（lon/lat），半径单位 km */
export function windCirclePolygon(
  lon: number,
  lat: number,
  q: WindQuadrants,
  stepsPerQuad = 12,
): [number, number][] {
  const kmToDegLat = 1 / 111.32;
  const cosLat = Math.max(0.2, Math.cos((lat * Math.PI) / 180));
  const kmToDegLon = 1 / (111.32 * cosLat);
  const ring: [number, number][] = [];
  const quads: Array<{ start: number; end: number; r: number }> = [
    { start: 0, end: 90, r: q.ne },
    { start: 90, end: 180, r: q.se },
    { start: 180, end: 270, r: q.sw },
    { start: 270, end: 360, r: q.nw },
  ];
  for (const quad of quads) {
    if (quad.r <= 0) continue;
    for (let i = 0; i <= stepsPerQuad; i += 1) {
      const deg = quad.start + ((quad.end - quad.start) * i) / stepsPerQuad;
      // 气象方位：0=北，顺时针
      const rad = (deg * Math.PI) / 180;
      const dLat = quad.r * kmToDegLat * Math.cos(rad);
      const dLon = quad.r * kmToDegLon * Math.sin(rad);
      ring.push([lon + dLon, lat + dLat]);
    }
  }
  if (ring.length > 0) {
    const first = ring[0]!;
    ring.push([first[0], first[1]]);
  }
  return ring;
}

function interpolateAlongTrack(
  past: TrackPoint[],
  tSec: number,
): { lat: number; lon: number; windKts: number; pressure: number; levelZh: string } {
  if (past.length === 0) {
    return { lat: 0, lon: 0, windKts: 0, pressure: 1010, levelZh: '热带低压' };
  }
  if (past.length === 1 || tSec <= past[0]!.time) {
    const p = past[0]!;
    return {
      lat: p.lat,
      lon: p.lon,
      windKts: p.windKts,
      pressure: p.pressure,
      levelZh: p.levelZh,
    };
  }
  const last = past[past.length - 1]!;
  if (tSec >= last.time) {
    return {
      lat: last.lat,
      lon: last.lon,
      windKts: last.windKts,
      pressure: last.pressure,
      levelZh: last.levelZh,
    };
  }
  let i = 0;
  while (i < past.length - 1 && past[i + 1]!.time < tSec) i += 1;
  const a = past[i]!;
  const b = past[i + 1]!;
  const span = Math.max(1, b.time - a.time);
  const u = clamp((tSec - a.time) / span, 0, 1);
  return {
    lat: a.lat + (b.lat - a.lat) * u,
    lon: a.lon + (b.lon - a.lon) * u,
    windKts: Math.round(a.windKts + (b.windKts - a.windKts) * u),
    pressure: Math.round(a.pressure + (b.pressure - a.pressure) * u),
    levelZh: u < 0.5 ? a.levelZh : b.levelZh,
  };
}

function formatTrackTime(epochSec: number): string {
  const d = new Date(epochSec * 1000);
  const mo = d.getMonth() + 1;
  const day = d.getDate();
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${mo}/${day} ${hh}:${mm}`;
}

function emptyFeatureCollection(): GeoJSON.FeatureCollection {
  return { type: 'FeatureCollection', features: [] };
}

function cycloneSvg(color: string): string {
  return `<svg viewBox="0 0 64 64" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
  <circle cx="32" cy="32" r="4" fill="${color}"/>
  <path d="M32 28C22 28 14 20 14 12c8 0 16 6 18 16Z" fill="${color}" opacity=".85"/>
  <path d="M36 32c0-10 8-18 16-18 0 8-6 16-16 18Z" fill="${color}" opacity=".7"/>
  <path d="M32 36c10 0 18 8 18 16-8 0-16-6-18-16Z" fill="${color}" opacity=".85"/>
  <path d="M28 32c0 10-8 18-16 18 0-8 6-16 16-18Z" fill="${color}" opacity=".7"/>
</svg>`;
}

export class TyphoonLayer implements WeatherLayer {
  readonly id = 'typhoon';
  readonly name = '台风';
  readonly preferredSkyDim = 1;
  readonly capturesVerticalPan = true;

  private root: HTMLElement | null = null;
  private mapHost: HTMLElement | null = null;
  private creditEl: HTMLElement | null = null;
  private emptyEl: HTMLElement | null = null;
  private listEl: HTMLElement | null = null;
  private scrubEl: HTMLElement | null = null;
  private readoutEl: HTMLElement | null = null;
  private playBtn: HTMLButtonElement | null = null;
  private rangeEl: HTMLInputElement | null = null;
  private scrubMetaEl: HTMLElement | null = null;
  private styleEl: HTMLStyleElement | null = null;
  private map: MapLibreMap | null = null;
  private marker: Marker | null = null;
  private maplibre: MapLibreModule | null = null;

  private typhoons: Typhoon[] = [];
  private selectedId = '';
  private quality: Quality = 'high';
  private mounted = false;
  private generation = 0;
  private emptyShown = false;

  private playing = true;
  private playEpochSec = 0;
  private trackStart = 0;
  private trackEnd = 0;
  private lastWallMs = 0;
  private animRaf = 0;
  private scrubbing = false;

  mount(container: HTMLElement): void {
    if (this.mounted) this.unmount();
    this.mounted = true;
    const generation = ++this.generation;

    this.styleEl = document.createElement('style');
    this.styleEl.textContent = LAYER_CSS;
    document.head.appendChild(this.styleEl);

    this.root = document.createElement('div');
    this.root.className = 'serein-ty-layer';
    this.root.setAttribute('data-scene-swipe-ignore', '');

    this.mapHost = document.createElement('div');
    this.mapHost.className = 'serein-ty-map';

    this.creditEl = document.createElement('p');
    this.creditEl.className = 'serein-ty-credit';
    this.creditEl.textContent = ATTRIBUTION;

    this.emptyEl = document.createElement('div');
    this.emptyEl.className = 'serein-ty-empty';
    this.emptyEl.setAttribute('role', 'status');
    const emptyText = document.createElement('p');
    emptyText.textContent = '当前西北太平洋无活跃台风';
    this.emptyEl.append(emptyText);

    this.listEl = document.createElement('div');
    this.listEl.className = 'serein-ty-list';
    this.listEl.setAttribute('role', 'tablist');
    this.listEl.setAttribute('aria-label', '活跃台风');

    this.readoutEl = document.createElement('p');
    this.readoutEl.className = 'serein-ty-readout';

    this.scrubEl = document.createElement('div');
    this.scrubEl.className = 'serein-ty-scrub';
    this.scrubEl.setAttribute('data-scene-swipe-ignore', '');

    this.playBtn = document.createElement('button');
    this.playBtn.type = 'button';
    this.playBtn.setAttribute('aria-label', '暂停');
    this.playBtn.innerHTML =
      '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 6h3v12H8zm5 0h3v12h-3z"/></svg>';
    this.playBtn.addEventListener('click', this.onTogglePlay);

    this.rangeEl = document.createElement('input');
    this.rangeEl.type = 'range';
    this.rangeEl.min = '0';
    this.rangeEl.max = '1000';
    this.rangeEl.value = '1000';
    this.rangeEl.setAttribute('aria-label', '台风路径回放');
    this.rangeEl.addEventListener('pointerdown', this.onScrubStart);
    this.rangeEl.addEventListener('input', this.onScrubInput);
    this.rangeEl.addEventListener('pointerup', this.onScrubEnd);
    this.rangeEl.addEventListener('change', this.onScrubEnd);

    this.scrubMetaEl = document.createElement('span');
    this.scrubMetaEl.className = 'serein-ty-scrub-meta';
    this.scrubMetaEl.textContent = '4×';

    this.scrubEl.append(this.playBtn, this.rangeEl, this.scrubMetaEl);
    this.root.append(
      this.mapHost,
      this.creditEl,
      this.listEl,
      this.readoutEl,
      this.scrubEl,
      this.emptyEl,
    );
    container.appendChild(this.root);

    void this.bootstrap(generation);
  }

  unmount(): void {
    this.generation += 1;
    this.mounted = false;
    this.stopAnimation();
    this.playBtn?.removeEventListener('click', this.onTogglePlay);
    this.rangeEl?.removeEventListener('pointerdown', this.onScrubStart);
    this.rangeEl?.removeEventListener('input', this.onScrubInput);
    this.rangeEl?.removeEventListener('pointerup', this.onScrubEnd);
    this.rangeEl?.removeEventListener('change', this.onScrubEnd);
    this.teardownMap();
    this.root?.remove();
    this.root = null;
    this.mapHost = null;
    this.creditEl = null;
    this.emptyEl = null;
    this.listEl = null;
    this.scrubEl = null;
    this.readoutEl = null;
    this.playBtn = null;
    this.rangeEl = null;
    this.scrubMetaEl = null;
    this.styleEl?.remove();
    this.styleEl = null;
    this.typhoons = [];
    this.selectedId = '';
    this.emptyShown = false;
    this.playing = true;
    this.scrubbing = false;
  }

  setTime(_minutes: number): void {
    // 场景内独立回放，不占用全局 currentTime
  }

  setData(_data: DayData): void {
    // 台风数据不依赖 DayData
  }

  setQuality(q: Quality): void {
    this.quality = q;
    if (!this.map) return;
    const ratio =
      q === 'high' ? Math.min(window.devicePixelRatio || 1, 2) : q === 'medium' ? 1.25 : 1;
    this.map.setPixelRatio(ratio);
  }

  private async bootstrap(generation: number): Promise<void> {
    try {
      const list = await fetchActiveTyphoons();
      if (!this.mounted || generation !== this.generation) return;
      this.typhoons = list;
      if (list.length === 0) {
        this.showEmpty();
        return;
      }
      this.hideEmpty();
      this.selectedId = list[0]!.id;
      this.renderList();
      await this.ensureMapLibre();
      if (!this.mounted || generation !== this.generation) return;
      await this.createMap();
      if (!this.mounted || generation !== this.generation) return;
      this.applySelected(true);
      this.startAnimation();
    } catch {
      if (!this.mounted || generation !== this.generation) return;
      this.showEmpty();
    }
  }

  private async ensureMapLibre(): Promise<MapLibreModule> {
    if (this.maplibre) return this.maplibre;
    const [mod] = await Promise.all([
      import('maplibre-gl'),
      import('maplibre-gl/dist/maplibre-gl.css'),
    ]);
    this.maplibre = mod;
    return mod;
  }

  private async createMap(): Promise<void> {
    if (!this.mapHost || !this.maplibre) return;
    const { Map } = this.maplibre;
    this.mapHost.replaceChildren();
    const map = new Map({
      container: this.mapHost,
      style: baseStyle(),
      center: NW_PACIFIC_CENTER,
      zoom: DEFAULT_ZOOM,
      attributionControl: false,
      maplibreLogo: false,
      dragRotate: false,
      pitchWithRotate: false,
      touchPitch: false,
      pitch: 0,
      maxPitch: 0,
      fadeDuration: 0,
      canvasContextAttributes: {
        antialias: false,
        preserveDrawingBuffer: true,
        powerPreference: this.quality === 'low' ? 'low-power' : 'high-performance',
        contextType: 'webgl2',
      },
    });
    this.map = map;
    await new Promise<void>((resolve) => {
      map.once('load', () => resolve());
    });
    map.touchZoomRotate.disableRotation();
    this.ensureGeoSources(map);
    map.resize();
  }

  private ensureGeoSources(map: MapLibreMap): void {
    const addEmpty = (id: string) => {
      if (!map.getSource(id)) {
        map.addSource(id, { type: 'geojson', data: emptyFeatureCollection() });
      }
    };
    addEmpty(SOURCE_CONE);
    addEmpty(SOURCE_PAST);
    addEmpty(SOURCE_FORECAST);
    addEmpty(SOURCE_POINTS);
    addEmpty(SOURCE_WIND);

    if (!map.getLayer(LAYER_CONE)) {
      map.addLayer({
        id: LAYER_CONE,
        type: 'fill',
        source: SOURCE_CONE,
        paint: {
          'fill-color': '#a8d4e8',
          'fill-opacity': 0.08,
        },
      });
    }
    if (!map.getLayer(LAYER_WIND_7)) {
      map.addLayer({
        id: LAYER_WIND_7,
        type: 'line',
        source: SOURCE_WIND,
        filter: ['==', ['get', 'kind'], 'r7'],
        paint: {
          'line-color': 'rgba(255,255,255,0.45)',
          'line-width': 1.2,
          'line-opacity': 0.85,
        },
      });
    }
    if (!map.getLayer(LAYER_WIND_10)) {
      map.addLayer({
        id: LAYER_WIND_10,
        type: 'line',
        source: SOURCE_WIND,
        filter: ['==', ['get', 'kind'], 'r10'],
        paint: {
          'line-color': 'rgba(126,200,255,0.85)',
          'line-width': 1.2,
          'line-opacity': 0.95,
        },
      });
    }
    if (!map.getLayer(LAYER_PAST)) {
      map.addLayer({
        id: LAYER_PAST,
        type: 'line',
        source: SOURCE_PAST,
        paint: {
          'line-color': 'rgba(255,255,255,0.6)',
          'line-width': 2.2,
          'line-opacity': 0.9,
        },
      });
    }
    if (!map.getLayer(LAYER_FORECAST)) {
      map.addLayer({
        id: LAYER_FORECAST,
        type: 'line',
        source: SOURCE_FORECAST,
        paint: {
          'line-color': '#a8d4e8',
          'line-width': 2,
          'line-dasharray': [4, 4],
          'line-opacity': 0.95,
        },
      });
    }
    if (!map.getLayer(LAYER_POINTS)) {
      map.addLayer({
        id: LAYER_POINTS,
        type: 'circle',
        source: SOURCE_POINTS,
        paint: {
          'circle-radius': 4,
          'circle-color': ['get', 'color'],
          'circle-stroke-width': 1,
          'circle-stroke-color': 'rgba(0,0,0,0.45)',
        },
      });
    }
  }

  private selected(): Typhoon | null {
    return this.typhoons.find((t) => t.id === this.selectedId) ?? this.typhoons[0] ?? null;
  }

  private renderList(): void {
    if (!this.listEl) return;
    this.listEl.replaceChildren();
    for (const t of this.typhoons) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.textContent = `${t.name} · ${t.current.levelZh}`;
      btn.dataset.active = String(t.id === this.selectedId);
      btn.addEventListener('click', () => {
        if (this.selectedId === t.id) return;
        this.selectedId = t.id;
        this.renderList();
        this.applySelected(true);
      });
      this.listEl.append(btn);
    }
  }

  private applySelected(fit: boolean): void {
    const storm = this.selected();
    if (!storm || !this.map) return;
    const past = storm.track.past;
    this.trackStart = past[0]?.time ?? Math.round(Date.now() / 1000);
    this.trackEnd = past[past.length - 1]?.time ?? this.trackStart;
    this.playEpochSec = this.trackEnd;
    this.playing = true;
    this.updatePlayButton();
    this.setGeoData(storm);
    this.applyPlayback(storm, this.playEpochSec);
    if (fit) this.fitStorm(storm);
    if (this.scrubEl) this.scrubEl.dataset.visible = 'true';
    if (this.readoutEl) this.readoutEl.dataset.visible = 'true';
  }

  private setGeoData(storm: Typhoon): void {
    const map = this.map;
    if (!map) return;

    const pastCoords = storm.track.past.map((p) => [p.lon, p.lat] as [number, number]);
    const forecastCoords = [
      ...(storm.track.past.length > 0
        ? [[storm.track.past[storm.track.past.length - 1]!.lon, storm.track.past[storm.track.past.length - 1]!.lat] as [number, number]]
        : []),
      ...storm.track.forecast.map((p) => [p.lon, p.lat] as [number, number]),
    ];

    const set = (id: string, data: GeoJSON.FeatureCollection) => {
      const src = map.getSource(id) as GeoJSONSource | undefined;
      src?.setData(data);
    };

    set(SOURCE_PAST, {
      type: 'FeatureCollection',
      features:
        pastCoords.length >= 2
          ? [
              {
                type: 'Feature',
                properties: {},
                geometry: { type: 'LineString', coordinates: pastCoords },
              },
            ]
          : [],
    });

    set(SOURCE_FORECAST, {
      type: 'FeatureCollection',
      features:
        forecastCoords.length >= 2
          ? [
              {
                type: 'Feature',
                properties: {},
                geometry: { type: 'LineString', coordinates: forecastCoords },
              },
            ]
          : [],
    });

    const cone = storm.track.cone;
    set(SOURCE_CONE, {
      type: 'FeatureCollection',
      features:
        cone && cone.length >= 3
          ? [
              {
                type: 'Feature',
                properties: {},
                geometry: {
                  type: 'Polygon',
                  coordinates: [[...cone, cone[0]!]],
                },
              },
            ]
          : [],
    });

    const pointFeatures: GeoJSON.Feature[] = [];
    for (const p of [...storm.track.past, ...storm.track.forecast]) {
      pointFeatures.push({
        type: 'Feature',
        properties: {
          color: colorForLevel(p.levelZh),
          level: p.levelZh,
        },
        geometry: { type: 'Point', coordinates: [p.lon, p.lat] },
      });
    }
    set(SOURCE_POINTS, { type: 'FeatureCollection', features: pointFeatures });

    const windFeatures: GeoJSON.Feature[] = [];
    const { lat, lon } = storm.current;
    if (storm.windRadiiKm?.r7) {
      const ring = windCirclePolygon(lon, lat, storm.windRadiiKm.r7);
      if (ring.length >= 4) {
        windFeatures.push({
          type: 'Feature',
          properties: { kind: 'r7' },
          geometry: { type: 'Polygon', coordinates: [ring] },
        });
      }
    }
    if (storm.windRadiiKm?.r10) {
      const ring = windCirclePolygon(lon, lat, storm.windRadiiKm.r10);
      if (ring.length >= 4) {
        windFeatures.push({
          type: 'Feature',
          properties: { kind: 'r10' },
          geometry: { type: 'Polygon', coordinates: [ring] },
        });
      }
    }
    set(SOURCE_WIND, { type: 'FeatureCollection', features: windFeatures });
  }

  private fitStorm(storm: Typhoon): void {
    if (!this.map || !this.maplibre) return;
    const coords: [number, number][] = [
      ...storm.track.past.map((p) => [p.lon, p.lat] as [number, number]),
      ...storm.track.forecast.map((p) => [p.lon, p.lat] as [number, number]),
      ...(storm.track.cone ?? []),
    ];
    if (coords.length === 0) {
      this.map.easeTo({ center: [storm.current.lon, storm.current.lat], zoom: 5, duration: 600 });
      return;
    }
    let minLon = Infinity;
    let minLat = Infinity;
    let maxLon = -Infinity;
    let maxLat = -Infinity;
    for (const [lon, lat] of coords) {
      minLon = Math.min(minLon, lon);
      maxLon = Math.max(maxLon, lon);
      minLat = Math.min(minLat, lat);
      maxLat = Math.max(maxLat, lat);
    }
    this.map.fitBounds(
      [
        [minLon, minLat],
        [maxLon, maxLat],
      ],
      { padding: 64, duration: 700, maxZoom: 6.5 },
    );
  }

  private applyPlayback(storm: Typhoon, epochSec: number): void {
    const sample = interpolateAlongTrack(storm.track.past, epochSec);
    this.updateMarker(sample.lon, sample.lat, storm.name, sample.levelZh);
    this.updateWindAt(sample.lon, sample.lat, storm);
    this.updatePastTrail(storm, epochSec, sample);
    if (this.readoutEl) {
      this.readoutEl.innerHTML = `<strong>${storm.name}</strong> · ${sample.levelZh}<br>${sample.windKts} kt · ${sample.pressure} hPa · ${formatTrackTime(epochSec)}`;
    }
    if (this.rangeEl && this.trackEnd > this.trackStart) {
      const u = (epochSec - this.trackStart) / (this.trackEnd - this.trackStart);
      this.rangeEl.value = String(Math.round(clamp(u, 0, 1) * 1000));
    }
    if (this.scrubMetaEl) {
      this.scrubMetaEl.textContent = `${formatTrackTime(epochSec)} · 4×`;
    }
  }

  /** 回放时过去路径逐点推进到当前时刻 */
  private updatePastTrail(
    storm: Typhoon,
    epochSec: number,
    sample: { lat: number; lon: number },
  ): void {
    const map = this.map;
    if (!map) return;
    const coords: [number, number][] = [];
    for (const p of storm.track.past) {
      if (p.time > epochSec) break;
      coords.push([p.lon, p.lat]);
    }
    const last = coords[coords.length - 1];
    if (!last || last[0] !== sample.lon || last[1] !== sample.lat) {
      coords.push([sample.lon, sample.lat]);
    }
    const src = map.getSource(SOURCE_PAST) as GeoJSONSource | undefined;
    src?.setData({
      type: 'FeatureCollection',
      features:
        coords.length >= 2
          ? [
              {
                type: 'Feature',
                properties: {},
                geometry: { type: 'LineString', coordinates: coords },
              },
            ]
          : [],
    });
  }

  private updateWindAt(lon: number, lat: number, storm: Typhoon): void {
    const map = this.map;
    if (!map) return;
    const windFeatures: GeoJSON.Feature[] = [];
    if (storm.windRadiiKm?.r7) {
      const ring = windCirclePolygon(lon, lat, storm.windRadiiKm.r7);
      if (ring.length >= 4) {
        windFeatures.push({
          type: 'Feature',
          properties: { kind: 'r7' },
          geometry: { type: 'Polygon', coordinates: [ring] },
        });
      }
    }
    if (storm.windRadiiKm?.r10) {
      const ring = windCirclePolygon(lon, lat, storm.windRadiiKm.r10);
      if (ring.length >= 4) {
        windFeatures.push({
          type: 'Feature',
          properties: { kind: 'r10' },
          geometry: { type: 'Polygon', coordinates: [ring] },
        });
      }
    }
    const src = map.getSource(SOURCE_WIND) as GeoJSONSource | undefined;
    src?.setData({ type: 'FeatureCollection', features: windFeatures });
  }

  private updateMarker(lon: number, lat: number, name: string, levelZh: string): void {
    if (!this.map || !this.maplibre) return;
    const color = colorForLevel(levelZh);
    const label = `${name} · ${levelZh}`;
    if (!this.marker) {
      const el = document.createElement('div');
      el.className = 'serein-ty-marker';
      el.innerHTML = `<div class="serein-ty-symbol">${cycloneSvg(color)}</div><div class="serein-ty-label">${label}</div>`;
      this.marker = new this.maplibre.Marker({ element: el, anchor: 'center' })
        .setLngLat([lon, lat])
        .addTo(this.map);
      return;
    }
    this.marker.setLngLat([lon, lat]);
    const el = this.marker.getElement();
    const symbol = el.querySelector('.serein-ty-symbol');
    const labelEl = el.querySelector('.serein-ty-label');
    if (symbol) symbol.innerHTML = cycloneSvg(color);
    if (labelEl) labelEl.textContent = label;
  }

  private startAnimation(): void {
    this.stopAnimation();
    this.lastWallMs = performance.now();
    this.animRaf = requestAnimationFrame(this.tick);
  }

  private stopAnimation(): void {
    if (this.animRaf) cancelAnimationFrame(this.animRaf);
    this.animRaf = 0;
  }

  private readonly tick = (now: number): void => {
    this.animRaf = 0;
    if (!this.mounted || this.emptyShown) return;
    const storm = this.selected();
    if (!storm) return;

    const dt = Math.min(0.1, (now - this.lastWallMs) / 1000);
    this.lastWallMs = now;

    if (this.playing && !this.scrubbing && this.trackEnd > this.trackStart) {
      this.playEpochSec += dt * PLAY_HOURS_PER_SEC * 3600;
      if (this.playEpochSec >= this.trackEnd) {
        this.playEpochSec = this.trackStart;
      }
      this.applyPlayback(storm, this.playEpochSec);
    }

    this.animRaf = requestAnimationFrame(this.tick);
  };

  private updatePlayButton(): void {
    if (!this.playBtn) return;
    if (this.playing) {
      this.playBtn.setAttribute('aria-label', '暂停');
      this.playBtn.innerHTML =
        '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 6h3v12H8zm5 0h3v12h-3z"/></svg>';
    } else {
      this.playBtn.setAttribute('aria-label', '播放');
      this.playBtn.innerHTML =
        '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 6v12l10-6z"/></svg>';
    }
  }

  private readonly onTogglePlay = (): void => {
    this.playing = !this.playing;
    this.updatePlayButton();
    this.lastWallMs = performance.now();
  };

  private readonly onScrubStart = (): void => {
    this.scrubbing = true;
  };

  private readonly onScrubInput = (): void => {
    const storm = this.selected();
    if (!storm || !this.rangeEl) return;
    const u = Number(this.rangeEl.value) / 1000;
    this.playEpochSec = this.trackStart + clamp(u, 0, 1) * (this.trackEnd - this.trackStart);
    this.applyPlayback(storm, this.playEpochSec);
  };

  private readonly onScrubEnd = (): void => {
    this.scrubbing = false;
    this.lastWallMs = performance.now();
  };

  private teardownMap(): void {
    this.stopAnimation();
    try {
      this.marker?.remove();
    } catch {
      // ignore
    }
    this.marker = null;
    if (this.map) {
      try {
        this.map.remove();
      } catch {
        // ignore
      }
      this.map = null;
    }
    this.mapHost?.replaceChildren();
  }

  private showEmpty(): void {
    this.emptyShown = true;
    this.stopAnimation();
    this.teardownMap();
    if (this.emptyEl) this.emptyEl.dataset.visible = 'true';
    if (this.scrubEl) this.scrubEl.dataset.visible = 'false';
    if (this.readoutEl) this.readoutEl.dataset.visible = 'false';
    if (this.listEl) this.listEl.replaceChildren();
  }

  private hideEmpty(): void {
    this.emptyShown = false;
    if (this.emptyEl) this.emptyEl.dataset.visible = 'false';
  }
}
