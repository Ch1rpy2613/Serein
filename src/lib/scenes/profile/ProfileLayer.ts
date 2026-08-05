/**
 * ProfileLayer —— 垂直大气剖面模式。
 *
 * 全局模式（非场景切换器条目）：从任意场景上滑进入，沿高度爬升穿过
 * 对流层，下滑穿过地面后退出。Canvas2D 绘制温度廓线、0°C 层、云带、
 * 风羽与对流层顶标注；天空色随高度做简化 Rayleigh 光学深度近似。
 */

import type { AtmosProfile, DayData, ProfilePoint, WeatherLayer } from '../../contracts';
import { get } from 'svelte/store';
import { fetchProfile } from '../../data/openmeteo';
import { currentCity } from '../../stores/app';
import { getPrefersReducedMotion, subscribeReducedMotion } from '../../motion';

type Quality = 'low' | 'medium' | 'high';
type Rgb = readonly [number, number, number];

const MAX_HEIGHT_M = 12_000;
const DAY_MINUTES = 1440;
const DATA_EASE_TAU = 0.1; // ≈300ms 收敛
/** 拖动手感：约 28 m / css-px */
const METERS_PER_PX = 28;
/** 下滑越过地面约 35px 后触发退出 */
const EXIT_BELOW_M = -1000;
const NIGHT: Rgb = [5 / 255, 7 / 255, 10 / 255];
const ACCENT_FALLBACK = '#7ec8ff';

const CLOUD_BANDS = [
  { key: 'low' as const, minM: 0, maxM: 2000 },
  { key: 'mid' as const, minM: 2000, maxM: 6000 },
  { key: 'high' as const, minM: 6000, maxM: 12_000 },
];

const DPR_CAP: Record<Quality, number> = { high: 2, medium: 1.5, low: 1 };

const LAYER_CSS = `
.serein-profile-layer {
  position: absolute;
  inset: 0;
  overflow: hidden;
  color: var(--fg-1, rgba(255,255,255,.92));
  font-family: -apple-system, "SF Pro", Inter, "PingFang SC", sans-serif;
  font-variant-numeric: tabular-nums;
  isolation: isolate;
  touch-action: none;
  user-select: none;
  -webkit-user-select: none;
}
.serein-profile-canvas {
  position: absolute;
  inset: 0;
  z-index: 0;
  display: block;
  width: 100%;
  height: 100%;
  pointer-events: none;
}
.serein-profile-hud {
  position: absolute;
  top: max(28px, env(safe-area-inset-top));
  left: max(28px, env(safe-area-inset-left));
  z-index: 2;
  display: grid;
  gap: 6px;
  pointer-events: none;
}
.serein-profile-hud h2,
.serein-profile-altitude,
.serein-profile-hint {
  margin: 0;
}
.serein-profile-hud h2 {
  font-size: 17px;
  font-weight: 560;
  letter-spacing: .02em;
}
.serein-profile-altitude {
  color: var(--fg-1, rgba(255,255,255,.92));
  font-size: clamp(42px, 11vw, 64px);
  font-weight: 340;
  letter-spacing: -.055em;
  line-height: .9;
  text-shadow: 0 0 28px rgba(0,0,0,.35);
}
.serein-profile-hint {
  color: var(--fg-2, rgba(255,255,255,.45));
  font-size: 11px;
  font-weight: 500;
  letter-spacing: .08em;
}
`;

const clamp = (x: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, x));
const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;
const easeOutCubic = (t: number): number => 1 - (1 - t) ** 3;

function sampleHourly(values: number[] | undefined, minutes: number): number {
  if (!values || values.length < 2) return 0;
  const h = clamp(minutes / 60, 0, 24);
  const i = Math.min(values.length - 2, Math.floor(h));
  const f = h - i;
  return lerp(values[i] ?? 0, values[i + 1] ?? values[i] ?? 0, f);
}

function formatAltitude(meters: number): string {
  const rounded = Math.max(0, Math.round(meters / 10) * 10);
  return `${rounded.toLocaleString('en-US')} m`;
}

function formatTemp(celsius: number): string {
  const rounded = Math.round(celsius * 10) / 10;
  const sign = rounded > 0 ? '+' : '';
  return `${sign}${rounded.toFixed(1)}°`;
}

function parseCssColor(value: string, probe: CanvasRenderingContext2D): Rgb | null {
  if (!value) return null;
  try {
    probe.save();
    probe.clearRect(0, 0, 1, 1);
    probe.fillStyle = '#010203';
    const sentinel = probe.fillStyle;
    probe.fillStyle = value;
    if (probe.fillStyle === sentinel && value.trim().toLowerCase() !== sentinel) {
      probe.restore();
      return null;
    }
    probe.fillRect(0, 0, 1, 1);
    const pixel = probe.getImageData(0, 0, 1, 1).data;
    probe.restore();
    return [pixel[0] / 255, pixel[1] / 255, pixel[2] / 255];
  } catch {
    return null;
  }
}

/** 0°C 层 / 对流层顶计算只依赖温度与高度（不要求 ProfilePoint.rh） */
type TempHeightLevel = Pick<ProfilePoint, 'temperature' | 'heightM'>;

/** 温度折线与 0°C 的交点高度（线性插值）；无交点返回 null */
export function zeroDegreeHeight(levels: readonly TempHeightLevel[]): number | null {
  if (levels.length < 2) return null;
  for (let i = 0; i < levels.length - 1; i += 1) {
    const a = levels[i];
    const b = levels[i + 1];
    if (a.temperature === 0) return a.heightM;
    if (b.temperature === 0) return b.heightM;
    if ((a.temperature < 0 && b.temperature > 0) || (a.temperature > 0 && b.temperature < 0)) {
      const t = a.temperature / (a.temperature - b.temperature);
      return lerp(a.heightM, b.heightM, t);
    }
  }
  return null;
}

/**
 * 对流层顶：温度止跌回升的拐点（廓线内最低温之后开始升温的位置）。
 * 找不到则回落到 12 km。
 */
export function tropopauseHeight(levels: readonly TempHeightLevel[]): number {
  if (levels.length < 3) return MAX_HEIGHT_M;
  let minIndex = 0;
  for (let i = 1; i < levels.length; i += 1) {
    if (levels[i].temperature < levels[minIndex].temperature) minIndex = i;
  }
  // 最低温不在顶端且其后有升温段，才视为拐点
  if (minIndex > 0 && minIndex < levels.length - 1) {
    const after = levels[minIndex + 1];
    if (after.temperature > levels[minIndex].temperature) {
      return clamp(levels[minIndex].heightM, 0, MAX_HEIGHT_M);
    }
  }
  // 顶端仍在降温：拐点在数据之上
  if (minIndex === levels.length - 1) {
    const prev = levels[minIndex - 1];
    const last = levels[minIndex];
    if (last.temperature < prev.temperature) return MAX_HEIGHT_M;
  }
  return MAX_HEIGHT_M;
}

/** 简化光学深度：地面色 → 高空渐深 → 近对流层顶近黑 */
export function skyColorAtHeight(base: Rgb, heightM: number): Rgb {
  const h = clamp(heightM / MAX_HEIGHT_M, 0, 1);
  // Rayleigh 光学深度随高度近似 e^{-h/H}，H≈8km；再叠一层去饱和压暗
  const optical = Math.exp(-heightM / 8000);
  const deep = 1 - optical;
  const nearBlack = smoothstep(0.55, 1, h);
  const r = lerp(base[0], NIGHT[0], deep * 0.85 + nearBlack * 0.15);
  const g = lerp(base[1], NIGHT[1], deep * 0.88 + nearBlack * 0.12);
  const b = lerp(base[2], NIGHT[2], deep * 0.72 + nearBlack * 0.28);
  // 中高空略偏深蓝
  const blueLift = smoothstep(0.15, 0.55, h) * (1 - nearBlack) * 0.08;
  return [
    clamp(r * (1 - nearBlack * 0.35), 0, 1),
    clamp(g * (1 - nearBlack * 0.25) + blueLift * 0.2, 0, 1),
    clamp(b * (1 - nearBlack * 0.1) + blueLift, 0, 1),
  ];
}

function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = clamp((x - edge0) / (edge1 - edge0), 0, 1);
  return t * t * (3 - 2 * t);
}

function rgbCss(c: Rgb, alpha = 1): string {
  const r = Math.round(c[0] * 255);
  const g = Math.round(c[1] * 255);
  const b = Math.round(c[2] * 255);
  return alpha >= 1 ? `rgb(${r},${g},${b})` : `rgba(${r},${g},${b},${alpha})`;
}

interface DisplayLevel {
  pressure: number;
  heightM: number;
  temperature: number;
  windSpeed: number;
  windDirection: number;
}

export class ProfileLayer implements WeatherLayer {
  readonly id = 'profile';
  readonly name = '剖面';
  readonly preferredSkyDim = 0.3;
  readonly capturesVerticalPan = true;

  private container: HTMLElement | null = null;
  private root: HTMLElement | null = null;
  private canvas: HTMLCanvasElement | null = null;
  private ctx: CanvasRenderingContext2D | null = null;
  private altitudeEl: HTMLElement | null = null;
  private styleEl: HTMLStyleElement | null = null;
  private colorProbe: CanvasRenderingContext2D | null = null;

  private abortController: AbortController | null = null;
  private resizeObserver: ResizeObserver | null = null;
  private raf = 0;
  private lastTs = 0;
  private quality: Quality = 'high';
  private reducedMotion = getPrefersReducedMotion();
  private unsubscribeReducedMotion: (() => void) | null = null;

  private data: DayData | null = null;
  private dataCity = '';
  private timeMinutes = 480;
  private profileHour = -1;
  private profileFetchGen = 0;

  private levelsCur: DisplayLevel[] = [];
  private levelsTgt: DisplayLevel[] = [];
  private cloudLowCur = 0;
  private cloudMidCur = 0;
  private cloudHighCur = 0;
  private cloudLowTgt = 0;
  private cloudMidTgt = 0;
  private cloudHighTgt = 0;

  private heightCur = 0;
  private heightTgt = 0;
  private skyBase: Rgb = [0.35, 0.55, 0.78];
  private accent = ACCENT_FALLBACK;

  private pointerId: number | null = null;
  private pointerStartY = 0;
  private pointerStartHeight = 0;
  private dragging = false;

  private exitHandler: (() => void) | null = null;
  private exitRequested = false;

  /** 0 = 转场起点（地面感），1 = 剖面完全展开 */
  private reveal = 1;

  mount(container: HTMLElement): void {
    if (this.root) return;
    this.container = container;
    this.abortController = new AbortController();
    this.exitRequested = false;
    this.heightCur = 0;
    this.heightTgt = 0;
    this.reveal = 0;

    const style = document.createElement('style');
    style.textContent = LAYER_CSS;
    document.head.appendChild(style);
    this.styleEl = style;

    const root = document.createElement('div');
    root.className = 'serein-profile-layer';
    root.setAttribute('role', 'img');
    root.setAttribute('aria-label', '大气垂直剖面');

    const canvas = document.createElement('canvas');
    canvas.className = 'serein-profile-canvas';
    canvas.setAttribute('aria-hidden', 'true');
    root.appendChild(canvas);

    const hud = document.createElement('div');
    hud.className = 'serein-profile-hud';
    hud.innerHTML = `
      <h2>剖面</h2>
      <p class="serein-profile-altitude">0 m</p>
      <p class="serein-profile-hint">上滑爬升 · 下滑穿过地面退出</p>
    `;
    root.appendChild(hud);

    container.appendChild(root);
    this.root = root;
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d', { alpha: false });
    this.altitudeEl = hud.querySelector('.serein-profile-altitude');

    const probe = document.createElement('canvas');
    probe.width = 1;
    probe.height = 1;
    this.colorProbe = probe.getContext('2d', { willReadFrequently: true });

    this.readAccent();
    this.sampleSkyBase();

    const signal = this.abortController.signal;
    root.addEventListener('pointerdown', this.onPointerDown, { signal });
    root.addEventListener('pointermove', this.onPointerMove, { signal });
    root.addEventListener('pointerup', this.onPointerUp, { signal });
    root.addEventListener('pointercancel', this.onPointerUp, { signal });
    document.addEventListener('visibilitychange', this.onVisibility, { signal });

    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(container);
    this.unsubscribeReducedMotion = subscribeReducedMotion((reduced) => {
      this.reducedMotion = reduced;
    });

    this.resize();
    this.refreshCloudTargets();
    void this.loadProfile(this.timeMinutes, true);
    this.start();
  }

  unmount(): void {
    this.stop();
    this.profileFetchGen += 1;
    this.abortController?.abort();
    this.abortController = null;
    this.unsubscribeReducedMotion?.();
    this.unsubscribeReducedMotion = null;
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    this.root?.remove();
    this.styleEl?.remove();
    this.root = null;
    this.styleEl = null;
    this.canvas = null;
    this.ctx = null;
    this.altitudeEl = null;
    this.colorProbe = null;
    this.container = null;
    this.pointerId = null;
    this.dragging = false;
    this.exitRequested = false;
    this.levelsCur = [];
    this.levelsTgt = [];
  }

  setTime(minutes: number): void {
    this.timeMinutes = clamp(Number.isFinite(minutes) ? minutes : 0, 0, DAY_MINUTES);
    this.refreshCloudTargets();
    const hour = Math.min(24, Math.max(0, Math.round(this.timeMinutes / 60)));
    if (hour !== this.profileHour) {
      void this.loadProfile(this.timeMinutes, false);
    }
  }

  setData(data: DayData): void {
    const prev = this.data?.date;
    const prevCity = this.dataCity;
    const city = get(currentCity).name;
    this.data = data;
    this.dataCity = city;
    this.refreshCloudTargets();
    if (data.date !== prev || city !== prevCity) void this.loadProfile(this.timeMinutes, true);
  }

  setQuality(q: Quality): void {
    if (q === this.quality) return;
    this.quality = q;
    this.resize();
  }

  /** App 转场进度：0→1 进入，1→0 退出 */
  setReveal(progress: number): void {
    this.reveal = clamp(progress, 0, 1);
  }

  /** 地面天空色（取自天空引擎采样） */
  setSkyBaseColor(r: number, g: number, b: number): void {
    this.skyBase = [clamp(r, 0, 1), clamp(g, 0, 1), clamp(b, 0, 1)];
  }

  getHeight(): number {
    return this.heightCur;
  }

  onRequestExit(handler: (() => void) | null): void {
    this.exitHandler = handler;
  }

  /** 进入时重置到地面 */
  resetToGround(): void {
    this.heightCur = 0;
    this.heightTgt = 0;
    this.exitRequested = false;
    this.updateAltitudeHud(true);
  }

  // ------------------------------------------------------------------ 数据

  private refreshCloudTargets(): void {
    if (!this.data) return;
    this.cloudLowTgt = clamp(sampleHourly(this.data.cloudCoverLow, this.timeMinutes), 0, 1);
    this.cloudMidTgt = clamp(sampleHourly(this.data.cloudCoverMid, this.timeMinutes), 0, 1);
    this.cloudHighTgt = clamp(sampleHourly(this.data.cloudCoverHigh, this.timeMinutes), 0, 1);
  }

  private async loadProfile(minutes: number, immediate: boolean): Promise<void> {
    const hour = Math.min(24, Math.max(0, Math.round(minutes / 60)));
    const gen = ++this.profileFetchGen;
    this.profileHour = hour;
    try {
      const date = this.data?.date;
      const profile = await fetchProfile(minutes, date, get(currentCity));
      if (gen !== this.profileFetchGen) return;
      this.applyProfile(profile, immediate);
    } catch (error) {
      console.warn('[ProfileLayer] fetchProfile 失败', error);
    }
  }

  private applyProfile(profile: AtmosProfile, immediate: boolean): void {
    const next = profile.levels.map((level) => ({
      pressure: level.pressure,
      heightM: level.heightM,
      temperature: level.temperature,
      windSpeed: level.windSpeed,
      windDirection: level.windDirection,
    }));
    this.levelsTgt = next;
    if (immediate || this.levelsCur.length !== next.length) {
      this.levelsCur = next.map((level) => ({ ...level }));
    }
  }

  private readAccent(): void {
    const probe = this.colorProbe;
    if (!probe) return;
    const raw = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim();
    const parsed = parseCssColor(raw || ACCENT_FALLBACK, probe);
    if (parsed) {
      this.accent = rgbCss(parsed);
    }
  }

  private sampleSkyBase(): void {
    const probe = this.colorProbe;
    if (!probe) return;

    const cssHint =
      getComputedStyle(document.documentElement).getPropertyValue('--sky-average-color').trim() ||
      document.documentElement.dataset.skyAverageColor ||
      '';
    const fromCss = parseCssColor(cssHint, probe);
    if (fromCss) {
      this.skyBase = fromCss;
      return;
    }

    const skyCanvas = document.querySelector('.sky-layer canvas') as HTMLCanvasElement | null;
    if (!skyCanvas || skyCanvas.width < 2 || skyCanvas.height < 2) return;
    try {
      const w = 8;
      const h = 8;
      const tmp = document.createElement('canvas');
      tmp.width = w;
      tmp.height = h;
      const tctx = tmp.getContext('2d', { willReadFrequently: true });
      if (!tctx) return;
      // 取中上部天空，避开地平线杂色
      tctx.drawImage(
        skyCanvas,
        skyCanvas.width * 0.25,
        skyCanvas.height * 0.15,
        skyCanvas.width * 0.5,
        skyCanvas.height * 0.35,
        0,
        0,
        w,
        h,
      );
      const pixels = tctx.getImageData(0, 0, w, h).data;
      let r = 0;
      let g = 0;
      let b = 0;
      let n = 0;
      for (let i = 0; i < pixels.length; i += 4) {
        r += pixels[i];
        g += pixels[i + 1];
        b += pixels[i + 2];
        n += 1;
      }
      if (n > 0) this.skyBase = [r / n / 255, g / n / 255, b / n / 255];
    } catch {
      // cross-origin / lost context — keep previous base
    }
  }

  // ------------------------------------------------------------------ 手势

  private onPointerDown = (event: PointerEvent): void => {
    if (!event.isPrimary || this.pointerId !== null) return;
    if (event.pointerType === 'mouse' && event.button !== 0) return;
    this.pointerId = event.pointerId;
    this.pointerStartY = event.clientY;
    this.pointerStartHeight = this.heightTgt;
    this.dragging = true;
    try {
      this.root?.setPointerCapture(event.pointerId);
    } catch {
      // optional
    }
    event.preventDefault();
    event.stopPropagation();
  };

  private onPointerMove = (event: PointerEvent): void => {
    if (event.pointerId !== this.pointerId || !this.dragging) return;
    const dy = event.clientY - this.pointerStartY;
    // 上滑（dy < 0）→ 爬升
    const next = this.pointerStartHeight - dy * METERS_PER_PX;
    this.heightTgt = next;
    if (next < EXIT_BELOW_M && !this.exitRequested) {
      this.exitRequested = true;
      this.exitHandler?.();
    }
    event.preventDefault();
    event.stopPropagation();
  };

  private onPointerUp = (event: PointerEvent): void => {
    if (event.pointerId !== this.pointerId) return;
    this.pointerId = null;
    this.dragging = false;
    if (this.heightTgt < 0 && this.heightTgt > EXIT_BELOW_M) {
      this.heightTgt = 0;
    }
    event.stopPropagation();
  };

  // ------------------------------------------------------------------ 帧循环

  private start(): void {
    if (this.raf || document.hidden) return;
    this.lastTs = performance.now();
    this.raf = requestAnimationFrame(this.frame);
  }

  private stop(): void {
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
  }

  private onVisibility = (): void => {
    if (document.hidden) this.stop();
    else this.start();
  };

  private frame = (ts: number): void => {
    this.raf = requestAnimationFrame(this.frame);
    const dt = Math.min(0.1, Math.max(0, (ts - this.lastTs) / 1000));
    this.lastTs = ts;

    const k = this.reducedMotion ? 1 : 1 - Math.exp(-dt / DATA_EASE_TAU);
    this.heightCur += (clamp(this.heightTgt, EXIT_BELOW_M, MAX_HEIGHT_M) - this.heightCur) * k;
    if (!this.dragging && this.heightTgt >= 0) {
      this.heightTgt = clamp(this.heightTgt, 0, MAX_HEIGHT_M);
    }

    this.cloudLowCur += (this.cloudLowTgt - this.cloudLowCur) * k;
    this.cloudMidCur += (this.cloudMidTgt - this.cloudMidCur) * k;
    this.cloudHighCur += (this.cloudHighTgt - this.cloudHighCur) * k;
    this.easeLevels(k);

    this.updateAltitudeHud(false);
    this.draw();
  };

  private easeLevels(k: number): void {
    const tgt = this.levelsTgt;
    if (tgt.length === 0) return;
    if (this.levelsCur.length !== tgt.length) {
      this.levelsCur = tgt.map((level) => ({ ...level }));
      return;
    }
    for (let i = 0; i < tgt.length; i += 1) {
      const cur = this.levelsCur[i];
      const next = tgt[i];
      cur.heightM += (next.heightM - cur.heightM) * k;
      cur.temperature += (next.temperature - cur.temperature) * k;
      cur.windSpeed += (next.windSpeed - cur.windSpeed) * k;
      // 风向最短角插值
      let d = next.windDirection - cur.windDirection;
      d = ((((d + 180) % 360) + 360) % 360) - 180;
      cur.windDirection = (cur.windDirection + d * k + 360) % 360;
      cur.pressure = next.pressure;
    }
  }

  private updateAltitudeHud(force: boolean): void {
    if (!this.altitudeEl) return;
    const shown = Math.max(0, this.heightCur);
    const label = formatAltitude(shown);
    if (force || this.altitudeEl.textContent !== label) {
      this.altitudeEl.textContent = label;
    }
  }

  private resize(): void {
    const { canvas, container, ctx } = this;
    if (!canvas || !container || !ctx) return;
    const dpr = Math.min(window.devicePixelRatio || 1, DPR_CAP[this.quality]);
    const w = Math.max(1, Math.round(container.clientWidth * dpr));
    const h = Math.max(1, Math.round(container.clientHeight * dpr));
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
    }
  }

  // ------------------------------------------------------------------ 绘制

  private draw(): void {
    const ctx = this.ctx;
    const canvas = this.canvas;
    if (!ctx || !canvas) return;

    const dpr = canvas.width / Math.max(1, this.container?.clientWidth ?? canvas.width);
    const w = canvas.width;
    const h = canvas.height;
    const padL = 56 * dpr;
    const padR = 72 * dpr;
    const padT = 96 * dpr;
    const padB = 100 * dpr;
    const plotW = Math.max(1, w - padL - padR);
    const plotH = Math.max(1, h - padT - padB);

    // 视差：爬升时剖面相对焦点微移，转场时整体上浮
    const focus = clamp(this.heightCur, 0, MAX_HEIGHT_M);
    const parallax = (focus / MAX_HEIGHT_M) * 18 * dpr;
    const revealLift = (1 - easeOutCubic(this.reveal)) * h * 0.12;

    const heightToY = (meters: number): number => {
      const t = clamp(meters / MAX_HEIGHT_M, 0, 1);
      return padT + plotH * (1 - t) + parallax * 0.35 + revealLift;
    };

    const sky = skyColorAtHeight(this.skyBase, Math.max(0, focus));
    ctx.fillStyle = rgbCss(sky);
    ctx.fillRect(0, 0, w, h);

    // 高空微弱垂向渐变，强化高度感
    const grad = ctx.createLinearGradient(0, padT, 0, padT + plotH);
    grad.addColorStop(0, rgbCss(NIGHT, 0.55 * this.reveal));
    grad.addColorStop(0.45, rgbCss(sky, 0));
    grad.addColorStop(1, rgbCss(sky, 0));
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, w, h);

    ctx.save();
    ctx.globalAlpha = 0.35 + 0.65 * this.reveal;

    this.drawCloudBands(ctx, padL, plotW, heightToY, dpr);
    this.drawHeightGrid(ctx, padL, plotW, heightToY, dpr);
    this.drawZeroDegree(ctx, padL, plotW, heightToY, dpr);
    this.drawTemperature(ctx, padL, plotW, heightToY, dpr);
    this.drawTropopause(ctx, padL, plotW, heightToY, dpr);
    this.drawWindBarbs(ctx, padL + plotW, heightToY, dpr);
    this.drawFocusLine(ctx, padL, plotW, heightToY(focus), dpr);

    ctx.restore();
  }

  private drawHeightGrid(
    ctx: CanvasRenderingContext2D,
    padL: number,
    plotW: number,
    heightToY: (m: number) => number,
    dpr: number,
  ): void {
    ctx.strokeStyle = 'rgba(255,255,255,0.22)';
    ctx.fillStyle = 'rgba(255,255,255,0.45)';
    ctx.lineWidth = 1 * dpr;
    ctx.font = `${11 * dpr}px -apple-system, "SF Pro", Inter, "PingFang SC", sans-serif`;
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';

    for (let km = 0; km <= 12; km += 2) {
      const y = heightToY(km * 1000);
      ctx.beginPath();
      ctx.moveTo(padL, y);
      ctx.lineTo(padL + plotW, y);
      ctx.stroke();
      ctx.fillText(`${km} km`, padL - 10 * dpr, y);
    }

    // 左轴
    ctx.beginPath();
    ctx.moveTo(padL, heightToY(MAX_HEIGHT_M));
    ctx.lineTo(padL, heightToY(0));
    ctx.stroke();
  }

  private cloudCover(key: 'low' | 'mid' | 'high'): number {
    if (key === 'low') return this.cloudLowCur;
    if (key === 'mid') return this.cloudMidCur;
    return this.cloudHighCur;
  }

  private drawCloudBands(
    ctx: CanvasRenderingContext2D,
    padL: number,
    plotW: number,
    heightToY: (m: number) => number,
    dpr: number,
  ): void {
    for (const band of CLOUD_BANDS) {
      const cover = clamp(this.cloudCover(band.key), 0, 1);
      if (cover < 0.02) continue;
      const span = band.maxM - band.minM;
      // 厚度 ∝ 云量：以带中心向两侧扩展，满云量铺满高度带
      const half = (span * (0.12 + 0.88 * cover)) / 2;
      const center = (band.minM + band.maxM) / 2;
      const y0 = heightToY(center + half);
      const y1 = heightToY(center - half);
      const top = Math.min(y0, y1);
      const bot = Math.max(y0, y1);
      const alpha = 0.08 + cover * 0.28;
      const gradient = ctx.createLinearGradient(0, top, 0, bot);
      gradient.addColorStop(0, `rgba(220,230,245,0)`);
      gradient.addColorStop(0.5, `rgba(220,230,245,${alpha})`);
      gradient.addColorStop(1, `rgba(220,230,245,0)`);
      ctx.fillStyle = gradient;
      ctx.fillRect(padL, top, plotW, Math.max(1, bot - top));

      ctx.fillStyle = `rgba(255,255,255,${0.2 + cover * 0.25})`;
      ctx.font = `${10 * dpr}px -apple-system, "SF Pro", Inter, "PingFang SC", sans-serif`;
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      const label =
        band.key === 'low' ? '低云' : band.key === 'mid' ? '中云' : '高云';
      ctx.fillText(
        `${label} ${Math.round(cover * 100)}%`,
        padL + 8 * dpr,
        (top + bot) / 2,
      );
    }
  }

  private drawTemperature(
    ctx: CanvasRenderingContext2D,
    padL: number,
    plotW: number,
    heightToY: (m: number) => number,
    dpr: number,
  ): void {
    const levels = this.levelsCur;
    if (levels.length < 2) return;

    let tMin = Infinity;
    let tMax = -Infinity;
    for (const level of levels) {
      tMin = Math.min(tMin, level.temperature);
      tMax = Math.max(tMax, level.temperature);
    }
    const pad = Math.max(4, (tMax - tMin) * 0.15);
    tMin -= pad;
    tMax += pad;
    if (tMax - tMin < 8) {
      const mid = (tMin + tMax) / 2;
      tMin = mid - 4;
      tMax = mid + 4;
    }

    const tempToX = (t: number): number => padL + ((t - tMin) / (tMax - tMin)) * plotW;

    ctx.strokeStyle = this.accent;
    ctx.lineWidth = 1.5 * dpr;
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.beginPath();
    for (let i = 0; i < levels.length; i += 1) {
      const x = tempToX(levels[i].temperature);
      const y = heightToY(levels[i].heightM);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();

    ctx.fillStyle = this.accent;
    ctx.font = `${11 * dpr}px -apple-system, "SF Pro", Inter, "PingFang SC", sans-serif`;
    ctx.textBaseline = 'middle';
    for (const level of levels) {
      if (level.heightM < 0 || level.heightM > MAX_HEIGHT_M) continue;
      const x = tempToX(level.temperature);
      const y = heightToY(level.heightM);
      ctx.beginPath();
      ctx.arc(x, y, 2.4 * dpr, 0, Math.PI * 2);
      ctx.fill();

      const label = `${formatTemp(level.temperature)} · ${level.pressure}`;
      const onRight = level.temperature < (tMin + tMax) / 2;
      ctx.textAlign = onRight ? 'left' : 'right';
      ctx.fillStyle = 'rgba(255,255,255,0.72)';
      ctx.fillText(label + ' hPa', x + (onRight ? 8 : -8) * dpr, y);
      ctx.fillStyle = this.accent;
    }
  }

  private drawZeroDegree(
    ctx: CanvasRenderingContext2D,
    padL: number,
    plotW: number,
    heightToY: (m: number) => number,
    dpr: number,
  ): void {
    const z = zeroDegreeHeight(this.levelsCur);
    if (z === null || z < 0 || z > MAX_HEIGHT_M) return;
    const y = heightToY(z);
    ctx.save();
    ctx.strokeStyle = 'rgba(255,255,255,0.55)';
    ctx.lineWidth = 1 * dpr;
    ctx.setLineDash([5 * dpr, 4 * dpr]);
    ctx.beginPath();
    ctx.moveTo(padL, y);
    ctx.lineTo(padL + plotW, y);
    ctx.stroke();
    ctx.setLineDash([]);

    const label = `0°C 层 · ${Math.round(z).toLocaleString('en-US')} m`;
    ctx.font = `${11 * dpr}px -apple-system, "SF Pro", Inter, "PingFang SC", sans-serif`;
    ctx.fillStyle = 'rgba(255,255,255,0.78)';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'bottom';
    ctx.fillText(label, padL + 8 * dpr, y - 4 * dpr);
    ctx.restore();
  }

  private drawTropopause(
    ctx: CanvasRenderingContext2D,
    padL: number,
    plotW: number,
    heightToY: (m: number) => number,
    dpr: number,
  ): void {
    const tp = tropopauseHeight(this.levelsCur);
    const y = heightToY(tp);
    ctx.save();
    ctx.strokeStyle = 'rgba(126,200,255,0.45)';
    ctx.lineWidth = 1 * dpr;
    ctx.setLineDash([2 * dpr, 5 * dpr]);
    ctx.beginPath();
    ctx.moveTo(padL, y);
    ctx.lineTo(padL + plotW, y);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = 'rgba(126,200,255,0.85)';
    ctx.font = `${11 * dpr}px -apple-system, "SF Pro", Inter, "PingFang SC", sans-serif`;
    ctx.textAlign = 'right';
    ctx.textBaseline = 'bottom';
    ctx.fillText('对流层顶', padL + plotW - 6 * dpr, y - 4 * dpr);
    ctx.restore();
  }

  private drawFocusLine(
    ctx: CanvasRenderingContext2D,
    padL: number,
    plotW: number,
    y: number,
    dpr: number,
  ): void {
    ctx.save();
    ctx.strokeStyle = 'rgba(255,255,255,0.85)';
    ctx.lineWidth = 1.25 * dpr;
    ctx.shadowColor = 'rgba(126,200,255,0.35)';
    ctx.shadowBlur = 8 * dpr;
    ctx.beginPath();
    ctx.moveTo(padL, y);
    ctx.lineTo(padL + plotW, y);
    ctx.stroke();
    ctx.restore();
  }

  /** 气象风羽：杆指向风来向，短羽=5kt，长羽=10kt，三角=50kt */
  private drawWindBarbs(
    ctx: CanvasRenderingContext2D,
    x: number,
    heightToY: (m: number) => number,
    dpr: number,
  ): void {
    const levels = this.levelsCur;
    const staff = 22 * dpr;
    const spacing = 6 * dpr;

    for (const level of levels) {
      if (level.heightM < 0 || level.heightM > MAX_HEIGHT_M) continue;
      const y = heightToY(level.heightM);
      const knots = level.windSpeed * 1.94384;
      // 气象惯例：杆从站点指向风的来向
      const fromRad = ((level.windDirection - 90) * Math.PI) / 180;
      const ux = Math.cos(fromRad);
      const uy = Math.sin(fromRad);
      // 羽沿杆的垂直方向
      const px = -uy;
      const py = ux;

      ctx.save();
      ctx.strokeStyle = 'rgba(255,255,255,0.72)';
      ctx.fillStyle = 'rgba(255,255,255,0.72)';
      ctx.lineWidth = 1.25 * dpr;
      ctx.lineCap = 'round';

      const x0 = x + 10 * dpr;
      const y0 = y;
      const x1 = x0 + ux * staff;
      const y1 = y0 + uy * staff;
      ctx.beginPath();
      ctx.moveTo(x0, y0);
      ctx.lineTo(x1, y1);
      ctx.stroke();

      let remain = Math.round(knots / 5) * 5;
      let cursor = 0;
      while (remain >= 50) {
        const bx = x1 - ux * cursor;
        const by = y1 - uy * cursor;
        ctx.beginPath();
        ctx.moveTo(bx, by);
        ctx.lineTo(bx - ux * spacing + px * 10 * dpr, by - uy * spacing + py * 10 * dpr);
        ctx.lineTo(bx - ux * spacing * 2, by - uy * spacing * 2);
        ctx.closePath();
        ctx.fill();
        remain -= 50;
        cursor += spacing * 2.2;
      }
      while (remain >= 10) {
        const bx = x1 - ux * cursor;
        const by = y1 - uy * cursor;
        ctx.beginPath();
        ctx.moveTo(bx, by);
        ctx.lineTo(bx + px * 11 * dpr, by + py * 11 * dpr);
        ctx.stroke();
        remain -= 10;
        cursor += spacing;
      }
      if (remain >= 5) {
        const bx = x1 - ux * cursor;
        const by = y1 - uy * cursor;
        ctx.beginPath();
        ctx.moveTo(bx, by);
        ctx.lineTo(bx + px * 6 * dpr, by + py * 6 * dpr);
        ctx.stroke();
      }

      ctx.restore();
    }
  }
}
