/**
 * RadarLayer —— RainViewer 降水回波动态图。
 *
 * maplibre-gl 仅在本场景 mount 时 dynamic import，避免进入首屏 bundle。
 * 底图 CARTO dark；雷达瓦片由 weather-maps.json 的 past 帧驱动，默认循环
 * 最近 12 帧并做帧间淡入淡出。拖全局时间轴时跳到最近帧并暂停；点播放恢复。
 */

import { get } from 'svelte/store';
import type { Map as MapLibreMap, StyleSpecification } from 'maplibre-gl';
import type { DayData, WeatherLayer } from '../../contracts';
import { CITY } from '../../contracts';
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

const CARTO_TILES = [
  'https://a.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}.png',
  'https://b.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}.png',
  'https://c.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}.png',
  'https://d.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}.png',
];

const ATTRIBUTION = '© OpenStreetMap © CARTO · Radar © RainViewer';

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
  private styleEl: HTMLStyleElement | null = null;
  private map: MapLibreMap | null = null;
  private marker: InstanceType<MapLibreModule['Marker']> | null = null;
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
  private quality: Quality = 'high';
  private hasReceivedTime = false;
  private mounted = false;
  private generation = 0;
  private fetchAbort: AbortController | null = null;
  private unsubscribePlaying: (() => void) | null = null;

  private tileOk = 0;
  private tileFail = 0;
  private emptyShown = false;

  private readonly onRetry = (): void => {
    void this.reload();
  };

  private readonly onMapError = (event: {
    error?: { message?: string; url?: string; status?: number };
  }): void => {
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

    this.styleEl = document.createElement('style');
    this.styleEl.textContent = LAYER_CSS;
    document.head.appendChild(this.styleEl);

    this.root = document.createElement('div');
    this.root.className = 'serein-radar-layer';
    this.root.dataset.sceneSwipeIgnore = '';
    this.root.setAttribute('data-scene-swipe-ignore', '');

    this.mapHost = document.createElement('div');
    this.mapHost.className = 'serein-radar-map';

    this.creditEl = document.createElement('p');
    this.creditEl.className = 'serein-radar-credit';
    this.creditEl.textContent = ATTRIBUTION;

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

    this.root.append(this.mapHost, this.creditEl, this.emptyEl);
    container.appendChild(this.root);

    this.unsubscribePlaying = isPlaying.subscribe((playing) => {
      if (!this.mounted || generation !== this.generation) return;
      if (playing) this.resumeLoop();
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

    this.teardownMap();

    this.emptyEl?.querySelector('button')?.removeEventListener('click', this.onRetry);
    this.root?.remove();
    this.root = null;
    this.mapHost = null;
    this.creditEl = null;
    this.emptyEl = null;
    this.styleEl?.remove();
    this.styleEl = null;

    this.frames = [];
    this.host = '';
    this.frameIndex = 0;
    this.looping = true;
    this.hasReceivedTime = false;
    this.tileOk = 0;
    this.tileFail = 0;
    this.emptyShown = false;
  }

  setTime(minutes: number): void {
    const prev = this.time;
    this.time = clamp(minutes, 0, 1440);

    if (!this.hasReceivedTime) {
      this.hasReceivedTime = true;
      return;
    }

    // 拖时间轴时 isPlaying 为 false：跳到最近帧并暂停循环
    if (!get(isPlaying) && this.time !== prev) {
      this.pauseLoopAndSeek();
    }
  }

  setData(data: DayData): void {
    this.date = data.date;
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

  private async bootstrap(generation: number): Promise<void> {
    try {
      await this.ensureMapLibre();
      if (!this.mounted || generation !== this.generation) return;
      const payload = await this.fetchWeatherMaps();
      if (!this.mounted || generation !== this.generation) return;
      this.applyPayload(payload);
      await this.createMap();
      if (!this.mounted || generation !== this.generation) return;
      if (this.looping) this.startAnimation();
      else this.showFrame(this.frameIndex);
    } catch (error) {
      if (!this.mounted || generation !== this.generation) return;
      console.warn('[radar] 雷达数据不可用', error);
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
    try {
      await this.ensureMapLibre();
      if (!this.mounted || generation !== this.generation) return;
      const payload = await this.fetchWeatherMaps();
      if (!this.mounted || generation !== this.generation) return;
      this.applyPayload(payload);
      await this.createMap();
      if (!this.mounted || generation !== this.generation) return;
      this.startAnimation();
    } catch (error) {
      if (!this.mounted || generation !== this.generation) return;
      console.warn('[radar] 重试失败', error);
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

  private async createMap(): Promise<void> {
    if (!this.mapHost || !this.maplibre) return;
    const { Map, Marker } = this.maplibre;

    this.mapHost.replaceChildren();
    const map = new Map({
      container: this.mapHost,
      style: baseStyle(),
      center: [CITY.lon, CITY.lat],
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
    this.addRadarLayers(map);
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
      });
    }
  }

  private addCityMarker(MarkerCtor: MapLibreModule['Marker']): void {
    if (!this.map) return;
    this.marker?.remove();
    const el = document.createElement('div');
    el.className = 'serein-radar-marker';
    el.innerHTML = `<span class="serein-radar-dot" aria-hidden="true"></span><span class="serein-radar-label">${CITY.name}</span>`;
    this.marker = new MarkerCtor({ element: el, anchor: 'left', offset: [0, 0] })
      .setLngLat([CITY.lon, CITY.lat])
      .addTo(this.map);
  }

  private teardownMap(): void {
    if (this.map) {
      this.map.off('error', this.onMapError);
      this.map.off('data', this.onMapData);
      try {
        this.marker?.remove();
      } catch {
        // ignore
      }
      this.marker = null;
      try {
        this.map.remove();
      } catch {
        // ignore
      }
      this.map = null;
    }
    this.mapHost?.replaceChildren();
  }

  private resumeLoop(): void {
    if (!this.map || this.frames.length === 0 || this.emptyShown) return;
    this.looping = true;
    this.startAnimation();
  }

  private pauseLoopAndSeek(): void {
    this.looping = false;
    this.stopAnimation();
    if (!this.map || this.frames.length === 0 || this.emptyShown) return;
    const date = this.date || new Date().toISOString().slice(0, 10);
    const unix = cityDateMinutesToUnix(date, this.time);
    const index = nearestFrameIndex(this.frames, unix);
    this.showFrame(index);
  }

  private startAnimation(): void {
    if (!this.map || this.frames.length === 0 || this.emptyShown) return;
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
    if (!this.looping || !this.map || this.frames.length === 0 || this.emptyShown) return;

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
    const total = this.tileOk + this.tileFail;
    if (total < TILE_SAMPLE_MIN || this.emptyShown) return;
    if (this.tileFail / total > TILE_FAIL_RATIO) {
      console.warn(
        `[radar] 瓦片失败率 ${(this.tileFail / total) * 100}% > ${TILE_FAIL_RATIO * 100}%`,
      );
      this.showEmpty();
    }
  }

  private showEmpty(): void {
    this.emptyShown = true;
    this.stopAnimation();
    this.teardownMap();
    if (this.emptyEl) this.emptyEl.dataset.visible = 'true';
  }

  private hideEmpty(): void {
    this.emptyShown = false;
    if (this.emptyEl) this.emptyEl.dataset.visible = 'false';
  }
}
