/**
 * RadarLayer —— RainViewer 降水回波 + NASA GIBS 真彩色卫星。
 *
 * maplibre-gl 仅在本场景 mount 时 dynamic import，避免进入首屏 bundle。
 * 底图 CARTO dark；雷达瓦片由 weather-maps.json 的 past 帧驱动；
 * 卫星层为 GIBS WMTS CorrectedReflectance（见 `lib/data/gibs.ts`）。
 *
 * TODO: FY-4 / Himawari 实时云图公开源 CORS 不友好，留接口位
 * （`attachRealtimeCloudLayer`）。
 */

import { get } from 'svelte/store';
import type {
  GeoJSONSource,
  Map as MapLibreMap,
  MapMouseEvent,
  Marker,
  RasterTileSource,
  StyleSpecification,
} from 'maplibre-gl';
import type { City, DayData, WeatherLayer } from '../../contracts';
import {
  fallbackGibsMeta,
  GIBS_ATTRIBUTION,
  GIBS_MAX_ZOOM,
  gibsTileTemplate,
  loadGibsLayerMeta,
  resolveGibsDate,
  type GibsLayerMeta,
  type ResolvedGibsDate,
} from '../../data/gibs';
// TODO: FY-4 / Himawari — 接入时调用 attachRealtimeCloudLayer（CORS 不友好，需代理）
import { todayInCity } from '../../data/openmeteo';
import { interpolateGreatCircle } from '../../geo/greatCircle';
import { readRadarMapOverlay, writeRadarMapOverlay, type RadarMapOverlay } from '../../prefs';
import { currentCity, savedCities, sameCity } from '../../stores/app';
import { openXSection, type XSectionPoint } from '../../stores/xsection';
import { isPlaying } from '../../stores/time';

type Quality = 'low' | 'medium' | 'high';
type MapLibreModule = typeof import('maplibre-gl');

interface RadarFrame {
  time: number;
  path: string;
}

interface WeatherMapsResponse {
  host: string;
  radar?: {
    past?: RadarFrame[];
  };
}

const API_URL = 'https://api.rainviewer.com/public/weather-maps.json';
const API_TIMEOUT_MS = 8_000;
const FRAME_COUNT = 12;
const FRAME_MS = 500;
const CROSSFADE_MS = 200;
const RADAR_OPACITY = 0.85;
const DEFAULT_ZOOM = 7;
const TILE_FAIL_RATIO = 0.3;
const TILE_SAMPLE_MIN = 10;
const SOURCE_BASE = 'serein-carto';
const LAYER_BASE = 'serein-carto';
const SOURCE_RADAR = (i: number) => `serein-radar-${i}`;
const LAYER_RADAR = (i: number) => `serein-radar-${i}`;
const SOURCE_SAT = 'serein-gibs';
const LAYER_SAT = 'serein-gibs';
const SOURCE_TRANSECT = 'serein-transect';
const LAYER_TRANSECT = 'serein-transect';

const CARTO_TILES = [
  'https://a.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}.png',
  'https://b.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}.png',
  'https://c.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}.png',
  'https://d.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}.png',
];

const RADAR_ATTRIBUTION = '© OpenStreetMap © CARTO · Radar © RainViewer';

const LAYER_CSS = `
.serein-radar-layer {
  position: absolute;
  inset: 0;
  overflow: hidden;
  background: var(--bg, #05070a);
  color: var(--fg-1, rgba(255,255,255,.92));
  font-family: -apple-system, "SF Pro", Inter, "PingFang SC", sans-serif;
  font-variant-numeric: tabular-nums;
  isolation: isolate;
  touch-action: none;
  user-select: none;
  -webkit-user-select: none;
}
.serein-radar-map {
  position: absolute;
  inset: 0;
  z-index: 0;
}
.serein-radar-map .maplibregl-canvas,
.serein-radar-map .maplibregl-canvas-container {
  outline: none;
}
.serein-radar-switch {
  position: absolute;
  top: max(12px, env(safe-area-inset-top, 0px));
  left: max(12px, env(safe-area-inset-left, 0px));
  z-index: 3;
  display: inline-flex;
  align-items: center;
  gap: 0;
  margin: 0;
  padding: 2px;
  border: 1px solid var(--line, rgba(255,255,255,.22));
  background: color-mix(in srgb, var(--bg, #05070a) 62%, transparent);
  pointer-events: auto;
}
.serein-radar-switch button {
  margin: 0;
  padding: 5px 10px;
  border: 0;
  background: transparent;
  color: var(--fg-2, rgba(255,255,255,.45));
  font: inherit;
  font-size: 11px;
  font-weight: 520;
  letter-spacing: .04em;
  line-height: 1.2;
  cursor: pointer;
}
.serein-radar-switch button[aria-pressed='true'] {
  color: var(--fg-1, rgba(255,255,255,.92));
}
.serein-radar-switch button:focus-visible {
  outline: 2px solid var(--accent, #7ec8ff);
  outline-offset: 2px;
}
.serein-radar-credit {
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
  max-width: min(92vw, 420px);
  text-align: right;
  pointer-events: none;
  text-shadow: 0 1px 2px rgba(0,0,0,.65);
}
.serein-radar-marker {
  display: flex;
  align-items: center;
  gap: 6px;
  pointer-events: none;
}
.serein-radar-dot {
  width: 4px;
  height: 4px;
  border-radius: 50%;
  background: var(--accent, #7ec8ff);
  box-shadow: 0 0 0 1px rgba(0,0,0,.35);
  flex: 0 0 auto;
}
.serein-radar-label {
  color: var(--fg-1, rgba(255,255,255,.92));
  font-size: 11px;
  font-weight: 520;
  letter-spacing: .04em;
  text-shadow: 0 1px 3px rgba(0,0,0,.75);
  white-space: nowrap;
}
.serein-radar-empty {
  position: absolute;
  inset: 0;
  z-index: 3;
  display: none;
  place-content: center;
  place-items: center;
  gap: 12px;
  background: var(--bg, #05070a);
  text-align: center;
}
.serein-radar-empty[data-visible='true'] {
  display: grid;
}
.serein-radar-empty p {
  margin: 0;
  color: var(--fg-2, rgba(255,255,255,.45));
  font-size: 13px;
  letter-spacing: .06em;
}
.serein-radar-empty button {
  min-height: 34px;
  padding: 0 16px;
  border: 1px solid color-mix(in srgb, var(--accent, #7ec8ff) 55%, transparent);
  border-radius: 8px;
  background: color-mix(in srgb, var(--accent, #7ec8ff) 12%, transparent);
  color: var(--fg-1, rgba(255,255,255,.92));
  font: inherit;
  font-size: 12px;
  cursor: pointer;
}
.serein-radar-empty button:focus-visible {
  outline: 2px solid var(--accent, #7ec8ff);
  outline-offset: 2px;
}
.serein-radar-notice {
  position: absolute;
  top: max(12px, env(safe-area-inset-top, 0px));
  left: 50%;
  z-index: 2;
  display: none;
  margin: 0;
  padding: 6px 12px;
  border-radius: 8px;
  background: color-mix(in srgb, var(--bg, #05070a) 55%, transparent);
  color: color-mix(in srgb, var(--accent, #7ec8ff) 70%, var(--fg-2, rgba(255,255,255,.45)));
  font-size: 11px;
  font-weight: 500;
  letter-spacing: .04em;
  line-height: 1.35;
  white-space: nowrap;
  pointer-events: none;
  transform: translateX(-50%);
  text-shadow: 0 1px 2px rgba(0,0,0,.55);
}
.serein-radar-notice[data-visible='true'] {
  display: block;
}
.serein-radar-cut {
  position: absolute;
  top: max(12px, env(safe-area-inset-top, 0px));
  right: max(12px, env(safe-area-inset-right, 0px));
  z-index: 3;
  display: none;
  flex-direction: column;
  align-items: flex-end;
  gap: 6px;
  pointer-events: auto;
}
.serein-radar-layer[data-mode='analysis'] .serein-radar-cut {
  display: flex;
}
.serein-radar-cut-btn {
  min-height: 34px;
  padding: 0 12px;
  border: 1px solid var(--line, rgba(255,255,255,.22));
  background: color-mix(in srgb, var(--bg, #05070a) 62%, transparent);
  color: var(--fg-1, rgba(255,255,255,.92));
  font: inherit;
  font-size: 11px;
  font-weight: 520;
  letter-spacing: .04em;
  cursor: pointer;
}
.serein-radar-cut-btn[aria-pressed='true'] {
  color: var(--accent, #7ec8ff);
  border-color: color-mix(in srgb, var(--accent, #7ec8ff) 55%, transparent);
}
.serein-radar-cut-btn:focus-visible {
  outline: 2px solid var(--accent, #7ec8ff);
  outline-offset: 2px;
}
.serein-radar-cut-panel {
  display: none;
  flex-direction: column;
  gap: 4px;
  padding: 8px 10px;
  border: 1px solid var(--line, rgba(255,255,255,.22));
  background: color-mix(in srgb, var(--bg, #05070a) 72%, transparent);
  max-width: min(72vw, 220px);
}
.serein-radar-cut-panel[data-visible='true'] {
  display: flex;
}
.serein-radar-cut-hint {
  margin: 0;
  color: var(--fg-2, rgba(255,255,255,.45));
  font-size: 11px;
  letter-spacing: .03em;
  line-height: 1.35;
}
.serein-radar-cut-shortcuts {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
}
.serein-radar-cut-shortcuts button {
  margin: 0;
  padding: 4px 8px;
  border: 1px solid var(--line, rgba(255,255,255,.22));
  background: transparent;
  color: var(--fg-2, rgba(255,255,255,.45));
  font: inherit;
  font-size: 11px;
  cursor: pointer;
}
.serein-radar-cut-shortcuts button:hover {
  color: var(--fg-1, rgba(255,255,255,.92));
}
`;

const clamp = (x: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, x));

/** 将城市本地日 + 分钟转为 Unix 秒（Asia/Shanghai，无夏令时） */
function cityDateMinutesToUnix(dateIso: string, minutes: number): number {
  const total = clamp(minutes, 0, 1440);
  let day = dateIso;
  let hour = Math.floor(total / 60);
  let minute = Math.round(total % 60);
  if (minute === 60) {
    minute = 0;
    hour += 1;
  }
  if (hour >= 24) {
    const [y, mo, d] = dateIso.split('-').map(Number);
    const next = new Date(Date.UTC(y, mo - 1, d + 1));
    day = next.toISOString().slice(0, 10);
    hour = 0;
  }
  const pad = (n: number) => String(n).padStart(2, '0');
  return Math.floor(new Date(`${day}T${pad(hour)}:${pad(minute)}:00+08:00`).getTime() / 1000);
}

function nearestFrameIndex(frames: RadarFrame[], unix: number): number {
  if (frames.length === 0) return 0;
  let best = 0;
  let bestDist = Infinity;
  for (let i = 0; i < frames.length; i += 1) {
    const dist = Math.abs(frames[i].time - unix);
    if (dist < bestDist) {
      bestDist = dist;
      best = i;
    }
  }
  return best;
}

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
        id: 'serein-radar-bg',
        type: 'background',
        paint: { 'background-color': '#05070a' },
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

export class RadarLayer implements WeatherLayer {
  readonly id = 'radar';
  readonly name = '雷达';
  readonly preferredSkyDim = 1;
  readonly capturesVerticalPan = true;

  private root: HTMLElement | null = null;
  private mapHost: HTMLElement | null = null;
  private creditEl: HTMLElement | null = null;
  private emptyEl: HTMLElement | null = null;
  private noticeEl: HTMLElement | null = null;
  private switchEl: HTMLElement | null = null;
  private cutEl: HTMLElement | null = null;
  private cutBtn: HTMLButtonElement | null = null;
  private cutPanel: HTMLElement | null = null;
  private cutHint: HTMLElement | null = null;
  private cutShortcuts: HTMLElement | null = null;
  private styleEl: HTMLStyleElement | null = null;
  private map: MapLibreMap | null = null;
  private marker: InstanceType<MapLibreModule['Marker']> | null = null;
  private pickMarkers: Marker[] = [];
  private maplibre: MapLibreModule | null = null;

  private frames: RadarFrame[] = [];
  private host = '';
  private frameIndex = 0;
  private looping = true;
  private animRaf = 0;
  private frameStartedAt = 0;
  private fading = false;
  private fadeFrom = 0;
  private fadeTo = 0;
  private fadeStartedAt = 0;

  private time = 480;
  private date = '';
  private historical = false;
  private quality: Quality = 'high';
  private hasReceivedTime = false;
  private mounted = false;
  private generation = 0;
  private fetchAbort: AbortController | null = null;
  private unsubscribePlaying: (() => void) | null = null;
  private unsubscribeCity: (() => void) | null = null;
  private city: City = get(currentCity);

  private tileOk = 0;
  private tileFail = 0;
  private emptyShown = false;
  private radarUnavailable = false;

  private overlay: RadarMapOverlay = 'radar';
  private mode: 'feel' | 'analysis' = 'feel';
  private picking = false;
  private pickPoints: XSectionPoint[] = [];
  private gibsMeta: GibsLayerMeta | null = null;
  private gibsResolved: ResolvedGibsDate | null = null;
  private gibsTileDate = '';
  private unsubSaved: (() => void) | null = null;

  private readonly onRetry = (): void => {
    void this.reload();
  };

  private readonly onOverlayClick = (event: Event): void => {
    const target = event.target;
    if (!(target instanceof HTMLButtonElement)) return;
    const next = target.dataset.overlay as RadarMapOverlay | undefined;
    if (!next || next === this.overlay) return;
    void this.setOverlay(next);
  };

  private readonly onCutToggle = (): void => {
    if (this.picking) this.cancelPick();
    else this.beginPick();
  };

  private readonly onCutShortcut = (event: Event): void => {
    const target = event.target;
    if (!(target instanceof HTMLButtonElement)) return;
    const lat = Number(target.dataset.lat);
    const lon = Number(target.dataset.lon);
    const name = target.dataset.name ?? '';
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || !name) return;
    const a: XSectionPoint = {
      name: this.city.name,
      lat: this.city.lat,
      lon: this.city.lon,
    };
    const b: XSectionPoint = { name, lat, lon };
    this.finishTransect(a, b);
  };

  private readonly onMapPick = (event: MapMouseEvent): void => {
    if (!this.picking || !this.map) return;
    const { lng, lat } = event.lngLat;
    const point: XSectionPoint = {
      name: `${lat.toFixed(2)},${lng.toFixed(2)}`,
      lat,
      lon: lng,
    };
    this.pickPoints.push(point);
    this.syncPickGraphics();
    if (this.pickPoints.length === 1) {
      if (this.cutHint) this.cutHint.textContent = '再点选终点';
      return;
    }
    if (this.pickPoints.length >= 2) {
      const [a, b] = this.pickPoints;
      this.finishTransect(a, b);
    }
  };

  private readonly onMapError = (event: {
    error?: { message?: string; url?: string; status?: number };
  }): void => {
    if (this.overlay === 'satellite') return;
    const url = event.error?.url ?? '';
    const message = event.error?.message ?? '';
    const looksLikeTile =
      /\/\d+\/\d+\/\d+/.test(url) ||
      /tile/i.test(message) ||
      url.includes('rainviewer') ||
      url.includes('cartocdn');
    if (!looksLikeTile) return;
    this.tileFail += 1;
    this.checkTileHealth();
  };

  private readonly onMapData = (event: {
    dataType?: string;
    tile?: unknown;
    sourceId?: string;
  }): void => {
    if (this.overlay === 'satellite') return;
    if (event.dataType !== 'source' || !event.tile) return;
    const id = event.sourceId ?? '';
    if (id !== SOURCE_BASE && !id.startsWith('serein-radar-')) return;
    this.tileOk += 1;
    this.checkTileHealth();
  };

  mount(container: HTMLElement): void {
    if (this.mounted) this.unmount();
    this.mounted = true;
    const generation = ++this.generation;
    this.overlay = readRadarMapOverlay();

    this.styleEl = document.createElement('style');
    this.styleEl.textContent = LAYER_CSS;
    document.head.appendChild(this.styleEl);

    this.root = document.createElement('div');
    this.root.className = 'serein-radar-layer';
    this.root.dataset.sceneSwipeIgnore = '';
    this.root.setAttribute('data-scene-swipe-ignore', '');

    this.mapHost = document.createElement('div');
    this.mapHost.className = 'serein-radar-map';

    this.switchEl = document.createElement('div');
    this.switchEl.className = 'serein-radar-switch';
    this.switchEl.setAttribute('role', 'tablist');
    this.switchEl.setAttribute('aria-label', '地图图层');
    this.switchEl.innerHTML = `
      <button type="button" data-overlay="radar" role="tab">雷达</button>
      <button type="button" data-overlay="satellite" role="tab">卫星</button>
    `;
    this.switchEl.addEventListener('click', this.onOverlayClick);

    this.creditEl = document.createElement('p');
    this.creditEl.className = 'serein-radar-credit';
    this.creditEl.textContent = RADAR_ATTRIBUTION;

    this.emptyEl = document.createElement('div');
    this.emptyEl.className = 'serein-radar-empty';
    this.emptyEl.setAttribute('role', 'status');
    const emptyText = document.createElement('p');
    emptyText.textContent = '雷达暂不可用';
    const retryBtn = document.createElement('button');
    retryBtn.type = 'button';
    retryBtn.textContent = '重试';
    retryBtn.addEventListener('click', this.onRetry);
    this.emptyEl.append(emptyText, retryBtn);

    this.noticeEl = document.createElement('p');
    this.noticeEl.className = 'serein-radar-notice';
    this.noticeEl.setAttribute('role', 'status');

    this.cutEl = document.createElement('div');
    this.cutEl.className = 'serein-radar-cut';
    this.cutEl.innerHTML = `
      <button type="button" class="serein-radar-cut-btn">切剖面</button>
      <div class="serein-radar-cut-panel">
        <p class="serein-radar-cut-hint">点击地图依次选两点</p>
        <div class="serein-radar-cut-shortcuts"></div>
      </div>
    `;
    this.cutBtn = this.cutEl.querySelector('.serein-radar-cut-btn');
    this.cutPanel = this.cutEl.querySelector('.serein-radar-cut-panel');
    this.cutHint = this.cutEl.querySelector('.serein-radar-cut-hint');
    this.cutShortcuts = this.cutEl.querySelector('.serein-radar-cut-shortcuts');
    this.cutBtn?.addEventListener('click', this.onCutToggle);
    this.cutShortcuts?.addEventListener('click', this.onCutShortcut);

    this.root.append(
      this.mapHost,
      this.switchEl,
      this.cutEl,
      this.creditEl,
      this.noticeEl,
      this.emptyEl,
    );
    container.appendChild(this.root);
    this.root.dataset.mode = this.mode;
    this.syncSwitchUi();
    this.syncCredit();
    this.refreshCutShortcuts();

    this.unsubscribePlaying = isPlaying.subscribe((playing) => {
      if (!this.mounted || generation !== this.generation) return;
      if (playing && this.overlay === 'radar') this.resumeLoop();
    });
    this.unsubscribeCity = currentCity.subscribe((city) => {
      if (!this.mounted || generation !== this.generation) return;
      this.applyCity(city);
      this.refreshCutShortcuts();
    });
    this.unsubSaved = savedCities.subscribe(() => {
      if (!this.mounted || generation !== this.generation) return;
      this.refreshCutShortcuts();
    });

    void this.bootstrap(generation);
  }

  unmount(): void {
    this.generation += 1;
    this.mounted = false;
    this.stopAnimation();
    this.fetchAbort?.abort();
    this.fetchAbort = null;
    this.unsubscribePlaying?.();
    this.unsubscribePlaying = null;
    this.unsubscribeCity?.();
    this.unsubscribeCity = null;
    this.unsubSaved?.();
    this.unsubSaved = null;

    this.cancelPick();
    this.teardownMap();

    this.switchEl?.removeEventListener('click', this.onOverlayClick);
    this.cutBtn?.removeEventListener('click', this.onCutToggle);
    this.cutShortcuts?.removeEventListener('click', this.onCutShortcut);
    this.emptyEl?.querySelector('button')?.removeEventListener('click', this.onRetry);
    this.root?.remove();
    this.root = null;
    this.mapHost = null;
    this.creditEl = null;
    this.emptyEl = null;
    this.noticeEl = null;
    this.switchEl = null;
    this.cutEl = null;
    this.cutBtn = null;
    this.cutPanel = null;
    this.cutHint = null;
    this.cutShortcuts = null;
    this.styleEl?.remove();
    this.styleEl = null;

    this.frames = [];
    this.host = '';
    this.frameIndex = 0;
    this.looping = true;
    this.historical = false;
    this.hasReceivedTime = false;
    this.tileOk = 0;
    this.tileFail = 0;
    this.emptyShown = false;
    this.radarUnavailable = false;
    this.gibsResolved = null;
    this.gibsTileDate = '';
  }

  setTime(minutes: number): void {
    const prev = this.time;
    this.time = clamp(minutes, 0, 1440);

    if (!this.hasReceivedTime) {
      this.hasReceivedTime = true;
      return;
    }

    // 拖时间轴时 isPlaying 为 false：跳到最近帧并暂停循环
    if (this.overlay === 'radar' && !get(isPlaying) && this.time !== prev) {
      this.pauseLoopAndSeek();
    }
  }

  setData(data: DayData): void {
    const prevDate = this.date;
    this.date = data.date;
    const historical = data.date !== todayInCity();
    this.historical = historical;

    if (this.overlay === 'satellite') {
      if (prevDate !== data.date) void this.syncSatelliteTiles();
      this.syncNotices();
      return;
    }

    if (historical) {
      this.syncNotices();
      this.pauseLoopAndSeek();
      return;
    }
    this.syncNotices();
    if (get(isPlaying)) {
      this.resumeLoop();
      return;
    }
    if (!this.looping && this.frames.length > 0) {
      this.pauseLoopAndSeek();
    }
  }

  setQuality(q: Quality): void {
    this.quality = q;
    if (!this.map) return;
    const ratio =
      q === 'high' ? Math.min(window.devicePixelRatio || 1, 2) : q === 'medium' ? 1.25 : 1;
    this.map.setPixelRatio(ratio);
  }

  setMode(mode: 'feel' | 'analysis'): void {
    if (this.mode === mode) return;
    this.mode = mode;
    if (this.root) this.root.dataset.mode = mode;
    if (mode !== 'analysis') this.cancelPick();
  }

  private async setOverlay(next: RadarMapOverlay): Promise<void> {
    if (this.overlay === next) return;
    this.overlay = next;
    writeRadarMapOverlay(next);
    this.syncSwitchUi();
    this.syncCredit();

    if (!this.map) {
      this.syncEmptyVisibility();
      this.syncNotices();
      return;
    }

    if (next === 'satellite') {
      this.stopAnimation();
      this.setRadarLayersVisible(false);
      this.hideEmpty();
      await this.ensureSatelliteLayer();
      this.syncNotices();
      return;
    }

    // 切回雷达：去掉卫星层，避免残留（含未来实时云图源）
    this.removeSatelliteLayer();
    this.syncEmptyVisibility();
    if (!this.radarUnavailable && this.frames.length > 0) {
      this.setRadarLayersVisible(true);
      if (this.historical) {
        this.pauseLoopAndSeek();
      } else if (get(isPlaying) || this.looping) {
        this.resumeLoop();
      } else {
        this.showFrame(this.frameIndex);
      }
    }
    this.syncNotices();
  }

  private syncSwitchUi(): void {
    if (!this.switchEl) return;
    for (const button of this.switchEl.querySelectorAll('button[data-overlay]')) {
      if (!(button instanceof HTMLButtonElement)) continue;
      const active = button.dataset.overlay === this.overlay;
      button.setAttribute('aria-pressed', active ? 'true' : 'false');
      button.setAttribute('aria-selected', active ? 'true' : 'false');
    }
  }

  private syncCredit(): void {
    if (!this.creditEl) return;
    // 卫星标注常驻可见，不得删除或弱化
    this.creditEl.textContent =
      this.overlay === 'satellite' ? GIBS_ATTRIBUTION : RADAR_ATTRIBUTION;
  }

  private syncNotices(): void {
    if (!this.noticeEl) return;
    if (this.overlay === 'satellite') {
      if (this.gibsResolved?.degraded) {
        this.noticeEl.textContent = `影像日 ${this.gibsResolved.date} · 请求日暂无数据`;
        this.noticeEl.dataset.visible = 'true';
      } else {
        this.noticeEl.dataset.visible = 'false';
      }
      return;
    }
    if (this.historical && !this.radarUnavailable) {
      this.noticeEl.textContent = '历史回波暂缺 · 已显示最近可用帧';
      this.noticeEl.dataset.visible = 'true';
    } else {
      this.noticeEl.dataset.visible = 'false';
    }
  }

  private syncEmptyVisibility(): void {
    if (this.overlay === 'satellite') {
      this.hideEmpty();
      return;
    }
    if (this.radarUnavailable) this.showEmpty();
    else this.hideEmpty();
  }

  private async bootstrap(generation: number): Promise<void> {
    try {
      await this.ensureMapLibre();
      if (!this.mounted || generation !== this.generation) return;
      await this.createMap();
      if (!this.mounted || generation !== this.generation) return;

      try {
        const payload = await this.fetchWeatherMaps();
        if (!this.mounted || generation !== this.generation) return;
        this.applyPayload(payload);
        if (this.map) this.addRadarLayers(this.map);
        this.radarUnavailable = false;
      } catch (error) {
        console.warn('[radar] 雷达数据不可用', error);
        this.radarUnavailable = true;
        this.frames = [];
      }

      if (this.overlay === 'satellite') {
        this.setRadarLayersVisible(false);
        await this.ensureSatelliteLayer();
      } else if (this.radarUnavailable) {
        this.showEmpty();
      } else if (this.historical) {
        this.syncNotices();
        this.pauseLoopAndSeek();
      } else if (this.looping) {
        this.startAnimation();
      } else {
        this.showFrame(this.frameIndex);
      }
      this.syncCredit();
      this.syncNotices();
      this.syncEmptyVisibility();
    } catch (error) {
      if (!this.mounted || generation !== this.generation) return;
      console.warn('[radar] 地图不可用', error);
      this.radarUnavailable = true;
      this.showEmpty();
    }
  }

  private async reload(): Promise<void> {
    if (!this.mounted || !this.mapHost) return;
    const generation = this.generation;
    this.hideEmpty();
    this.stopAnimation();
    this.teardownMap();
    this.tileOk = 0;
    this.tileFail = 0;
    this.looping = true;
    this.radarUnavailable = false;
    this.gibsTileDate = '';
    try {
      await this.ensureMapLibre();
      if (!this.mounted || generation !== this.generation) return;
      await this.createMap();
      if (!this.mounted || generation !== this.generation) return;
      try {
        const payload = await this.fetchWeatherMaps();
        if (!this.mounted || generation !== this.generation) return;
        this.applyPayload(payload);
        if (this.map) this.addRadarLayers(this.map);
      } catch (error) {
        console.warn('[radar] 重试失败', error);
        this.radarUnavailable = true;
      }
      if (this.overlay === 'satellite') {
        this.setRadarLayersVisible(false);
        await this.ensureSatelliteLayer();
      } else if (this.radarUnavailable) {
        this.showEmpty();
      } else if (this.historical) {
        this.syncNotices();
        this.pauseLoopAndSeek();
      } else {
        this.startAnimation();
      }
      this.syncCredit();
      this.syncNotices();
      this.syncEmptyVisibility();
    } catch (error) {
      if (!this.mounted || generation !== this.generation) return;
      console.warn('[radar] 重试失败', error);
      this.radarUnavailable = true;
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

  private async fetchWeatherMaps(): Promise<WeatherMapsResponse> {
    this.fetchAbort?.abort();
    const abort = new AbortController();
    this.fetchAbort = abort;
    const timer = window.setTimeout(() => abort.abort(), API_TIMEOUT_MS);
    try {
      const response = await fetch(API_URL, {
        signal: abort.signal,
        credentials: 'omit',
      });
      if (!response.ok) {
        throw new Error(`RainViewer HTTP ${response.status}`);
      }
      return (await response.json()) as WeatherMapsResponse;
    } finally {
      window.clearTimeout(timer);
      if (this.fetchAbort === abort) this.fetchAbort = null;
    }
  }

  private applyPayload(payload: WeatherMapsResponse): void {
    const past = payload.radar?.past ?? [];
    if (!payload.host || past.length === 0) {
      throw new Error('RainViewer 无可用雷达帧');
    }
    this.host = payload.host.replace(/\/$/, '');
    this.frames = past.slice(-FRAME_COUNT);
    this.frameIndex = 0;
  }

  private applyCity(city: City): void {
    const changed =
      this.city.name !== city.name ||
      Math.abs(this.city.lat - city.lat) > 1e-5 ||
      Math.abs(this.city.lon - city.lon) > 1e-5;
    this.city = city;
    if (!changed || !this.map || !this.maplibre) return;
    this.map.easeTo({ center: [city.lon, city.lat], zoom: DEFAULT_ZOOM, duration: 600 });
    this.addCityMarker(this.maplibre.Marker);
  }

  private async createMap(): Promise<void> {
    if (!this.mapHost || !this.maplibre) return;
    const { Map, Marker } = this.maplibre;
    this.city = get(currentCity);

    this.mapHost.replaceChildren();
    const map = new Map({
      container: this.mapHost,
      style: baseStyle(),
      center: [this.city.lon, this.city.lat],
      zoom: DEFAULT_ZOOM,
      maxZoom: Math.max(DEFAULT_ZOOM + 4, GIBS_MAX_ZOOM),
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
    map.on('error', this.onMapError);
    map.on('data', this.onMapData);

    await new Promise<void>((resolve, reject) => {
      const onLoad = () => {
        cleanup();
        resolve();
      };
      const onError = (event: { error?: Error }) => {
        // 风格/底图致命错误才 reject；单瓦片错误走 onMapError
        if (event.error?.message?.includes('style')) {
          cleanup();
          reject(event.error);
        }
      };
      const cleanup = () => {
        map.off('load', onLoad);
        map.off('error', onError);
      };
      map.once('load', onLoad);
      map.on('error', onError);
    });

    map.touchZoomRotate.disableRotation();
    this.addCityMarker(Marker);
    map.resize();
  }

  private addRadarLayers(map: MapLibreMap): void {
    for (let i = 0; i < this.frames.length; i += 1) {
      const frame = this.frames[i];
      const sourceId = SOURCE_RADAR(i);
      const layerId = LAYER_RADAR(i);
      if (map.getSource(sourceId)) continue;
      map.addSource(sourceId, {
        type: 'raster',
        tiles: [`${this.host}${frame.path}/256/{z}/{x}/{y}/2/1_1.png`],
        tileSize: 256,
        attribution: '',
      });
      map.addLayer({
        id: layerId,
        type: 'raster',
        source: sourceId,
        paint: {
          'raster-opacity': i === this.frameIndex ? RADAR_OPACITY : 0,
          'raster-fade-duration': 0,
          'raster-opacity-transition': { duration: 0, delay: 0 },
        },
        layout: {
          visibility: this.overlay === 'radar' ? 'visible' : 'none',
        },
      });
    }
  }

  private setRadarLayersVisible(visible: boolean): void {
    const map = this.map;
    if (!map) return;
    for (let i = 0; i < this.frames.length; i += 1) {
      const layerId = LAYER_RADAR(i);
      if (!map.getLayer(layerId)) continue;
      map.setLayoutProperty(layerId, 'visibility', visible ? 'visible' : 'none');
    }
  }

  private async ensureGibsMeta(): Promise<GibsLayerMeta> {
    if (this.gibsMeta) return this.gibsMeta;
    try {
      this.gibsMeta = await loadGibsLayerMeta();
    } catch (error) {
      console.warn('[radar] GIBS capabilities 失败，使用本地降级时间窗', error);
      this.gibsMeta = fallbackGibsMeta(todayInCity());
    }
    return this.gibsMeta;
  }

  private async ensureSatelliteLayer(): Promise<void> {
    const map = this.map;
    if (!map) return;
    await this.ensureGibsMeta();
    await this.syncSatelliteTiles();
  }

  private async syncSatelliteTiles(): Promise<void> {
    const map = this.map;
    if (!map || this.overlay !== 'satellite') return;
    const meta = await this.ensureGibsMeta();
    const requested = this.date || todayInCity();
    const resolved = resolveGibsDate(requested, meta);
    this.gibsResolved = resolved;
    this.syncNotices();

    const template = gibsTileTemplate(resolved.date);
    if (map.getSource(SOURCE_SAT)) {
      if (this.gibsTileDate === resolved.date) {
        if (map.getLayer(LAYER_SAT)) {
          map.setLayoutProperty(LAYER_SAT, 'visibility', 'visible');
        }
        return;
      }
      const source = map.getSource(SOURCE_SAT) as RasterTileSource;
      source.setTiles([template]);
      this.gibsTileDate = resolved.date;
      if (map.getLayer(LAYER_SAT)) {
        map.setLayoutProperty(LAYER_SAT, 'visibility', 'visible');
      }
      return;
    }

    map.addSource(SOURCE_SAT, {
      type: 'raster',
      tiles: [template],
      tileSize: 256,
      maxzoom: GIBS_MAX_ZOOM,
      attribution: '',
    });
    map.addLayer({
      id: LAYER_SAT,
      type: 'raster',
      source: SOURCE_SAT,
      paint: {
        'raster-opacity': 1,
        'raster-fade-duration': 0,
      },
    });
    this.gibsTileDate = resolved.date;
  }

  private removeSatelliteLayer(): void {
    const map = this.map;
    if (!map) return;
    if (map.getLayer(LAYER_SAT)) map.removeLayer(LAYER_SAT);
    if (map.getSource(SOURCE_SAT)) map.removeSource(SOURCE_SAT);
    this.gibsTileDate = '';
    this.gibsResolved = null;
  }

  private beginPick(): void {
    if (!this.map) return;
    this.picking = true;
    this.pickPoints = [];
    this.cutBtn?.setAttribute('aria-pressed', 'true');
    if (this.cutPanel) this.cutPanel.dataset.visible = 'true';
    if (this.cutHint) this.cutHint.textContent = '点击地图选起点';
    this.ensureTransectSource();
    this.clearPickGraphics();
    this.map.getCanvas().style.cursor = 'crosshair';
    this.map.on('click', this.onMapPick);
  }

  private cancelPick(): void {
    if (this.map) {
      this.map.off('click', this.onMapPick);
      this.map.getCanvas().style.cursor = '';
    }
    this.picking = false;
    this.pickPoints = [];
    this.cutBtn?.setAttribute('aria-pressed', 'false');
    if (this.cutPanel) this.cutPanel.dataset.visible = 'false';
    this.clearPickGraphics();
  }

  private finishTransect(a: XSectionPoint, b: XSectionPoint): void {
    if (Math.abs(a.lat - b.lat) < 1e-5 && Math.abs(a.lon - b.lon) < 1e-5) {
      if (this.cutHint) this.cutHint.textContent = '两端点过近，请重选';
      this.pickPoints = [];
      this.clearPickGraphics();
      return;
    }
    openXSection({ a, b, returnSceneId: 'radar' });
    this.cancelPick();
  }

  private refreshCutShortcuts(): void {
    const host = this.cutShortcuts;
    if (!host) return;
    const others = get(savedCities).filter((c) => !sameCity(c, this.city));
    host.replaceChildren();
    if (others.length === 0) {
      const tip = document.createElement('p');
      tip.className = 'serein-radar-cut-hint';
      tip.textContent = '可先收藏另一城市作快捷终点';
      host.appendChild(tip);
      return;
    }
    for (const city of others.slice(0, 4)) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.textContent = `${this.city.name}→${city.name}`;
      btn.dataset.lat = String(city.lat);
      btn.dataset.lon = String(city.lon);
      btn.dataset.name = city.name;
      host.appendChild(btn);
    }
  }

  private ensureTransectSource(): void {
    const map = this.map;
    if (!map || map.getSource(SOURCE_TRANSECT)) return;
    map.addSource(SOURCE_TRANSECT, {
      type: 'geojson',
      data: { type: 'FeatureCollection', features: [] },
    });
    map.addLayer({
      id: LAYER_TRANSECT,
      type: 'line',
      source: SOURCE_TRANSECT,
      paint: {
        'line-color': '#7ec8ff',
        'line-width': 2,
        'line-opacity': 0.85,
      },
    });
  }

  private clearPickGraphics(): void {
    for (const m of this.pickMarkers) {
      try {
        m.remove();
      } catch {
        // ignore
      }
    }
    this.pickMarkers = [];
    const source = this.map?.getSource(SOURCE_TRANSECT) as GeoJSONSource | undefined;
    source?.setData({ type: 'FeatureCollection', features: [] });
  }

  private syncPickGraphics(): void {
    if (!this.map || !this.maplibre) return;
    this.ensureTransectSource();
    this.clearPickGraphics();
    const { Marker } = this.maplibre;
    for (const p of this.pickPoints) {
      const el = document.createElement('div');
      el.className = 'serein-radar-marker';
      el.innerHTML = `<span class="serein-radar-dot" aria-hidden="true"></span><span class="serein-radar-label">${p.name}</span>`;
      const marker = new Marker({ element: el, anchor: 'left' })
        .setLngLat([p.lon, p.lat])
        .addTo(this.map);
      this.pickMarkers.push(marker);
    }
    if (this.pickPoints.length < 2) return;
    const [a, b] = this.pickPoints;
    const coords: [number, number][] = [];
    for (let i = 0; i <= 32; i += 1) {
      const pt = interpolateGreatCircle(a, b, i / 32);
      coords.push([pt.lon, pt.lat]);
    }
    const source = this.map.getSource(SOURCE_TRANSECT) as GeoJSONSource;
    source.setData({
      type: 'Feature',
      properties: {},
      geometry: { type: 'LineString', coordinates: coords },
    });
  }

  private addCityMarker(MarkerCtor: MapLibreModule['Marker']): void {
    if (!this.map) return;
    this.marker?.remove();
    const el = document.createElement('div');
    el.className = 'serein-radar-marker';
    el.innerHTML = `<span class="serein-radar-dot" aria-hidden="true"></span><span class="serein-radar-label">${this.city.name}</span>`;
    this.marker = new MarkerCtor({ element: el, anchor: 'left', offset: [0, 0] })
      .setLngLat([this.city.lon, this.city.lat])
      .addTo(this.map);
  }

  private teardownMap(): void {
    if (this.map) {
      this.map.off('error', this.onMapError);
      this.map.off('data', this.onMapData);
      this.map.off('click', this.onMapPick);
      try {
        this.marker?.remove();
      } catch {
        // ignore
      }
      this.marker = null;
      for (const m of this.pickMarkers) {
        try {
          m.remove();
        } catch {
          // ignore
        }
      }
      this.pickMarkers = [];
      try {
        this.map.remove();
      } catch {
        // ignore
      }
      this.map = null;
    }
    this.mapHost?.replaceChildren();
    this.gibsTileDate = '';
  }

  private resumeLoop(): void {
    if (
      this.overlay !== 'radar' ||
      !this.map ||
      this.frames.length === 0 ||
      this.emptyShown ||
      this.historical
    ) {
      return;
    }
    this.looping = true;
    this.startAnimation();
  }

  private pauseLoopAndSeek(): void {
    this.looping = false;
    this.stopAnimation();
    if (
      this.overlay !== 'radar' ||
      !this.map ||
      this.frames.length === 0 ||
      this.emptyShown
    ) {
      return;
    }
    const date = this.date || new Date().toISOString().slice(0, 10);
    const unix = cityDateMinutesToUnix(date, this.time);
    const index = nearestFrameIndex(this.frames, unix);
    this.showFrame(index);
  }

  private startAnimation(): void {
    if (
      this.overlay !== 'radar' ||
      !this.map ||
      this.frames.length === 0 ||
      this.emptyShown
    ) {
      return;
    }
    this.stopAnimation();
    this.looping = true;
    this.fading = false;
    this.frameStartedAt = performance.now();
    this.showFrame(this.frameIndex);
    this.animRaf = requestAnimationFrame(this.tick);
  }

  private stopAnimation(): void {
    if (this.animRaf) cancelAnimationFrame(this.animRaf);
    this.animRaf = 0;
    this.fading = false;
  }

  private readonly tick = (now: number): void => {
    this.animRaf = 0;
    if (
      this.overlay !== 'radar' ||
      !this.looping ||
      !this.map ||
      this.frames.length === 0 ||
      this.emptyShown
    ) {
      return;
    }

    if (this.fading) {
      const t = clamp((now - this.fadeStartedAt) / CROSSFADE_MS, 0, 1);
      this.setFrameOpacity(this.fadeFrom, RADAR_OPACITY * (1 - t));
      this.setFrameOpacity(this.fadeTo, RADAR_OPACITY * t);
      if (t >= 1) {
        this.setFrameOpacity(this.fadeFrom, 0);
        this.setFrameOpacity(this.fadeTo, RADAR_OPACITY);
        this.frameIndex = this.fadeTo;
        this.fading = false;
        this.frameStartedAt = now;
      }
    } else if (now - this.frameStartedAt >= FRAME_MS) {
      if (this.frames.length === 1) {
        this.frameStartedAt = now;
      } else {
        this.fading = true;
        this.fadeFrom = this.frameIndex;
        this.fadeTo = (this.frameIndex + 1) % this.frames.length;
        this.fadeStartedAt = now;
      }
    }

    this.animRaf = requestAnimationFrame(this.tick);
  };

  private showFrame(index: number): void {
    if (!this.map || this.frames.length === 0) return;
    const safe = ((index % this.frames.length) + this.frames.length) % this.frames.length;
    this.frameIndex = safe;
    for (let i = 0; i < this.frames.length; i += 1) {
      this.setFrameOpacity(i, i === safe ? RADAR_OPACITY : 0);
    }
  }

  private setFrameOpacity(index: number, opacity: number): void {
    const map = this.map;
    if (!map) return;
    const layerId = LAYER_RADAR(index);
    if (!map.getLayer(layerId)) return;
    map.setPaintProperty(layerId, 'raster-opacity', opacity);
  }

  private checkTileHealth(): void {
    if (this.overlay !== 'radar') return;
    const total = this.tileOk + this.tileFail;
    if (total < TILE_SAMPLE_MIN || this.emptyShown) return;
    if (this.tileFail / total > TILE_FAIL_RATIO) {
      console.warn(
        `[radar] 瓦片失败率 ${(this.tileFail / total) * 100}% > ${TILE_FAIL_RATIO * 100}%`,
      );
      this.radarUnavailable = true;
      this.showEmpty();
    }
  }

  private showEmpty(): void {
    if (this.overlay === 'satellite') return;
    this.emptyShown = true;
    this.stopAnimation();
    if (this.emptyEl) this.emptyEl.dataset.visible = 'true';
  }

  private hideEmpty(): void {
    this.emptyShown = false;
    if (this.emptyEl) this.emptyEl.dataset.visible = 'false';
  }
}
