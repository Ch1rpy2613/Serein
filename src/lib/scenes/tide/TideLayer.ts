/**
 * TideLayer —— 潮汐：头顶月球引力演示 + 脚下 24h 潮位曲线。
 *
 * 上半：小地球 + 双凸水圈（沿地月连线形变）+ moonPosition 绕转月球；
 * 下半：潮位平滑曲线（--accent）、半透明海面填充、时间珠、满潮/干潮标注；
 * 数据：和风 Ocean API（`src/lib/data/tide.ts`），与月相共用 `astro/moon`。
 */
import { get } from 'svelte/store';
import type { DayData, WeatherLayer } from '../../contracts';
import { moonPosition } from '../../astro';
import {
  fetchTide,
  fetchTideExtremaRange,
  formatTideClock,
  sampleTideHeight,
  tideStatusAt,
  type TideData,
  type TideDaySummary,
  type TideStatus,
} from '../../data/tide';
import { getPrefersReducedMotion } from '../../motion';
import { currentCity } from '../../stores/app';

type Quality = 'low' | 'medium' | 'high';
type Mode = 'feel' | 'analysis';

interface QualityConfig {
  dpr: number;
  wave: boolean;
}

const DAY_MINUTES = 1440;
const EASE_TAU = 0.1;
/** 水面微浪振幅上限（px） */
const WAVE_AMP_MAX = 2.6;

const QUALITY: Record<Quality, QualityConfig> = {
  high: { dpr: 1.75, wave: true },
  medium: { dpr: 1.35, wave: true },
  low: { dpr: 1, wave: false },
};

const LAYER_CSS = `
.serein-tide-layer {
  position: absolute;
  inset: 0;
  overflow: hidden;
  color: var(--fg-1, rgba(255,255,255,.92));
  font-family: Outfit, "PingFang SC", "Hiragino Sans GB", sans-serif;
  font-variant-numeric: tabular-nums;
  isolation: isolate;
  pointer-events: none;
  user-select: none;
  -webkit-user-select: none;
}
.serein-tide-canvas {
  position: absolute;
  inset: 0;
  z-index: 0;
  display: block;
  width: 100%;
  height: 100%;
  pointer-events: none;
}
.serein-tide-header {
  position: absolute;
  top: max(28px, env(safe-area-inset-top));
  left: max(28px, env(safe-area-inset-left));
  z-index: 2;
  display: grid;
  gap: 10px;
  max-width: min(72vw, 22rem);
  text-shadow: 0 1px 18px rgba(8,14,22,.4);
  pointer-events: none;
  transition: opacity 400ms ease;
}
.serein-tide-heading {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 10px 12px;
}
.serein-tide-heading h2,
.serein-tide-status,
.serein-tide-readout,
.serein-tide-unit {
  margin: 0;
}
.serein-tide-heading h2 {
  font-size: 17px;
  font-weight: 560;
  letter-spacing: .02em;
}
.serein-tide-status {
  color: var(--fg-2, rgba(255,255,255,.45));
  font-size: 13px;
  font-weight: 520;
  letter-spacing: .04em;
}
.serein-tide-current {
  display: flex;
  align-items: baseline;
  gap: 8px;
}
.serein-tide-readout {
  color: var(--fg-1, rgba(255,255,255,.92));
  font: inherit;
  font-size: 56px;
  font-weight: 340;
  letter-spacing: -.055em;
  line-height: .9;
  font-variant-numeric: tabular-nums;
}
.serein-tide-unit {
  color: var(--fg-2, rgba(255,255,255,.45));
  font-size: 15px;
  font-weight: 500;
  letter-spacing: .04em;
}
.serein-tide-layer[data-mode="analysis"] .serein-tide-header {
  opacity: 0.42;
}
.serein-tide-empty {
  position: absolute;
  inset: 0;
  z-index: 3;
  display: grid;
  place-content: center;
  gap: 8px;
  padding: 24px;
  text-align: center;
  opacity: 0;
  visibility: hidden;
  pointer-events: none;
  transition: opacity 280ms ease, visibility 280ms step-end;
}
.serein-tide-layer[data-empty="1"] .serein-tide-empty {
  opacity: 1;
  visibility: visible;
  transition: opacity 280ms ease, visibility 0ms step-start;
}
.serein-tide-layer[data-empty="1"] .serein-tide-header,
.serein-tide-layer[data-empty="1"] .serein-tide-analysis {
  opacity: 0;
  visibility: hidden;
}
.serein-tide-empty p {
  margin: 0;
  color: var(--fg-2, rgba(255,255,255,.45));
  font-size: 14px;
  font-weight: 500;
  letter-spacing: .04em;
  text-shadow: 0 1px 16px rgba(8,14,22,.45);
}
.serein-tide-empty-title {
  color: var(--fg-1, rgba(255,255,255,.72)) !important;
  font-size: 17px !important;
  font-weight: 560 !important;
}
.serein-tide-analysis {
  position: absolute;
  top: max(28px, env(safe-area-inset-top));
  right: max(28px, env(safe-area-inset-right));
  z-index: 2;
  display: grid;
  gap: 8px;
  min-width: 11rem;
  max-width: min(16rem, calc(100vw - 56px));
  padding: 12px 14px;
  color: var(--fg-1, rgba(255,255,255,.92));
  text-shadow: 0 1px 14px rgba(8,14,22,.35);
  opacity: 0;
  visibility: hidden;
  pointer-events: none;
  transition: opacity 400ms ease, visibility 400ms step-end;
}
.serein-tide-layer[data-mode="analysis"] .serein-tide-analysis {
  opacity: 1;
  visibility: visible;
  transition: opacity 400ms ease, visibility 0ms step-start;
}
.serein-tide-analysis-label {
  margin: 0;
  color: var(--fg-2, rgba(255,255,255,.45));
  font-size: 9px;
  font-weight: 520;
  letter-spacing: .08em;
}
.serein-tide-analysis-list {
  margin: 0;
  padding: 0;
  list-style: none;
  display: grid;
  gap: 6px;
}
.serein-tide-analysis-list li {
  display: grid;
  gap: 2px;
}
.serein-tide-analysis-date {
  color: var(--fg-2, rgba(255,255,255,.45));
  font-size: 9px;
  font-weight: 520;
  letter-spacing: .06em;
}
.serein-tide-analysis-row {
  color: var(--fg-1, rgba(255,255,255,.88));
  font-size: 11px;
  font-weight: 500;
  letter-spacing: .02em;
  line-height: 1.35;
}
.serein-tide-analysis-empty {
  margin: 0;
  color: var(--fg-2, rgba(255,255,255,.45));
  font-size: 11px;
}
@media (max-width: 420px) {
  .serein-tide-header {
    top: max(22px, env(safe-area-inset-top));
    left: max(18px, env(safe-area-inset-left));
    gap: 8px;
  }
  .serein-tide-readout {
    font-size: 46px;
  }
  .serein-tide-analysis {
    top: auto;
    bottom: max(120px, calc(env(safe-area-inset-bottom) + 100px));
    right: max(18px, env(safe-area-inset-right));
    left: max(18px, env(safe-area-inset-left));
    max-width: none;
    min-width: 0;
  }
}
`;

export class TideLayer implements WeatherLayer {
  readonly id = 'tide';
  readonly name = '潮汐';
  readonly preferredSkyDim = 0.3;

  private container: HTMLElement | null = null;
  private root: HTMLElement | null = null;
  private canvas: HTMLCanvasElement | null = null;
  private context: CanvasRenderingContext2D | null = null;
  private readoutEl: HTMLOutputElement | null = null;
  private statusEl: HTMLElement | null = null;
  private unitEl: HTMLElement | null = null;
  private analysisList: HTMLElement | null = null;
  private analysisEmpty: HTMLElement | null = null;

  private abortController: AbortController | null = null;
  private resizeObserver: ResizeObserver | null = null;
  private raf = 0;
  private lastTimestamp = 0;
  private elapsed = 0;
  private generation = 0;

  private quality: Quality = 'high';
  private mode: Mode = 'feel';
  private cssWidth = 1;
  private cssHeight = 1;
  private pixelRatio = 1;
  private accent = '#a8d4e8';

  private date = '';
  private timeMinutes = 480;
  private tide: TideData | null = null;
  private empty = false;

  private heightCurrent = 0;
  private heightTarget = 0;
  private statusText: TideStatus = '涨潮中';
  private lastReadout = '';
  private lastStatus = '';

  private forecast: TideDaySummary[] = [];
  private lastForecastKey = '';

  mount(container: HTMLElement): void {
    if (this.root) return;
    this.container = container;
    this.abortController = new AbortController();
    this.elapsed = 0;
    this.accent = readAccent();

    this.createDom();
    this.attachEvents();

    this.resizeObserver = new ResizeObserver(this.resize);
    this.resizeObserver.observe(container);
    this.resize();
    this.updateHud(true);
    this.start();

    if (this.date) void this.reloadTide();
  }

  unmount(): void {
    this.generation += 1;
    this.stop();
    this.abortController?.abort();
    this.abortController = null;
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    this.root?.remove();
    this.container = null;
    this.root = null;
    this.canvas = null;
    this.context = null;
    this.readoutEl = null;
    this.statusEl = null;
    this.unitEl = null;
    this.analysisList = null;
    this.analysisEmpty = null;
    this.tide = null;
    this.forecast = [];
    this.lastForecastKey = '';
    this.mode = 'feel';
    this.empty = false;
  }

  setTime(minutes: number): void {
    this.timeMinutes = clamp(Number.isFinite(minutes) ? minutes : 0, 0, DAY_MINUTES);
    this.retargetHeight();
    this.updateHud(false);
  }

  setData(data: DayData): void {
    const nextDate = typeof data.date === 'string' && data.date ? data.date : '';
    const dateChanged = nextDate !== this.date;
    this.date = nextDate;
    if (dateChanged || !this.tide) {
      void this.reloadTide();
    } else {
      this.retargetHeight();
      this.updateHud(true);
    }
  }

  setMode(mode: Mode): void {
    if (this.mode === mode) return;
    this.mode = mode;
    if (this.root) this.root.dataset.mode = mode;
    if (this.analysisList) {
      this.analysisList.parentElement?.setAttribute(
        'aria-hidden',
        mode === 'analysis' ? 'false' : 'true',
      );
    }
    if (mode === 'analysis') void this.reloadForecast();
    this.updateHud(true);
  }

  setQuality(quality: Quality): void {
    if (quality === this.quality) return;
    this.quality = quality;
    this.root?.setAttribute('data-quality', quality);
    this.resize();
  }

  private createDom(): void {
    const root = document.createElement('section');
    root.className = 'serein-tide-layer';
    root.setAttribute('aria-label', '潮汐');
    root.setAttribute('data-quality', this.quality);
    root.dataset.mode = this.mode;
    root.dataset.empty = '0';

    root.innerHTML = `
      <style>${LAYER_CSS}</style>
      <canvas class="serein-tide-canvas" aria-hidden="true"></canvas>
      <header class="serein-tide-header">
        <div class="serein-tide-heading">
          <h2>潮汐</h2>
          <p class="serein-tide-status">涨潮中</p>
        </div>
        <div class="serein-tide-current">
          <output class="serein-tide-readout" aria-label="当前潮高">—</output>
          <p class="serein-tide-unit">m</p>
        </div>
      </header>
      <div class="serein-tide-empty" role="status">
        <p class="serein-tide-empty-title">该城市无潮汐数据</p>
        <p>仅近海港口提供潮位预报</p>
      </div>
      <aside class="serein-tide-analysis" aria-hidden="true">
        <p class="serein-tide-analysis-label">未来 3 天潮汐表</p>
        <ul class="serein-tide-analysis-list"></ul>
        <p class="serein-tide-analysis-empty" hidden>暂无预报</p>
      </aside>
    `;

    this.root = root;
    this.canvas = root.querySelector('canvas');
    this.context = this.canvas?.getContext('2d') ?? null;
    this.readoutEl = root.querySelector('.serein-tide-readout');
    this.statusEl = root.querySelector('.serein-tide-status');
    this.unitEl = root.querySelector('.serein-tide-unit');
    this.analysisList = root.querySelector('.serein-tide-analysis-list');
    this.analysisEmpty = root.querySelector('.serein-tide-analysis-empty');
    this.container?.appendChild(root);
  }

  private attachEvents(): void {
    const signal = this.abortController?.signal;
    if (!signal || typeof document === 'undefined') return;
    document.addEventListener(
      'visibilitychange',
      () => {
        if (document.hidden) this.stop();
        else this.start();
      },
      { signal },
    );
  }

  private async reloadTide(): Promise<void> {
    if (!this.date) return;
    const generation = ++this.generation;
    const city = get(currentCity);
    const data = await fetchTide(city, this.date);
    if (generation !== this.generation) return;
    this.tide = data;
    this.empty = data == null;
    if (this.root) this.root.dataset.empty = this.empty ? '1' : '0';
    this.retargetHeight();
    this.heightCurrent = this.heightTarget;
    this.updateHud(true);
    if (this.mode === 'analysis') void this.reloadForecast();
  }

  private async reloadForecast(): Promise<void> {
    if (!this.date || this.empty) {
      this.forecast = [];
      this.renderForecast();
      return;
    }
    const key = `${get(currentCity).name}:${this.date}`;
    if (key === this.lastForecastKey && this.forecast.length > 0) {
      this.renderForecast();
      return;
    }
    const generation = this.generation;
    const city = get(currentCity);
    // 从「明天」起 3 天；若当日也要可含今天——规格写「未来 3 天」
    const start = addDaysLocal(this.date, 1);
    const rows = await fetchTideExtremaRange(city, start, 3);
    if (generation !== this.generation) return;
    this.forecast = rows;
    this.lastForecastKey = key;
    this.renderForecast();
  }

  private renderForecast(): void {
    const list = this.analysisList;
    const empty = this.analysisEmpty;
    if (!list || !empty) return;
    list.replaceChildren();
    if (this.forecast.length === 0) {
      empty.hidden = false;
      return;
    }
    empty.hidden = true;
    for (const day of this.forecast) {
      const li = document.createElement('li');
      const dateEl = document.createElement('div');
      dateEl.className = 'serein-tide-analysis-date';
      dateEl.textContent = formatShortDate(day.date);
      li.appendChild(dateEl);
      for (const ex of day.extrema) {
        const row = document.createElement('div');
        row.className = 'serein-tide-analysis-row';
        const mark = ex.type === 'high' ? '▲满潮' : '▼干潮';
        row.textContent = `${mark} ${formatTideClock(ex.minutes)} ${ex.heightM.toFixed(1)}m`;
        li.appendChild(row);
      }
      list.appendChild(li);
    }
  }

  private retargetHeight(): void {
    if (!this.tide) {
      this.heightTarget = 0;
      this.statusText = '涨潮中';
      return;
    }
    const h = sampleTideHeight(this.tide, this.timeMinutes);
    this.heightTarget = Number.isFinite(h) ? h : 0;
    this.statusText = tideStatusAt(this.tide, this.timeMinutes);
  }

  private start(): void {
    if (this.raf || document.hidden) return;
    this.lastTimestamp = 0;
    this.raf = requestAnimationFrame(this.frame);
  }

  private stop(): void {
    if (!this.raf) return;
    cancelAnimationFrame(this.raf);
    this.raf = 0;
    this.lastTimestamp = 0;
  }

  private readonly frame = (timestamp: number): void => {
    this.raf = requestAnimationFrame(this.frame);
    const previous = this.lastTimestamp || timestamp;
    const deltaSeconds = clamp((timestamp - previous) / 1000, 0, 0.05);
    this.lastTimestamp = timestamp;
    this.elapsed += deltaSeconds;

    const blend = 1 - Math.exp(-deltaSeconds / EASE_TAU);
    this.heightCurrent += (this.heightTarget - this.heightCurrent) * blend;
    this.draw();
    this.updateHud(false);
  };

  private readonly resize = (): void => {
    const container = this.container;
    const canvas = this.canvas;
    if (!container || !canvas) return;

    const rect = container.getBoundingClientRect();
    const width = Math.max(1, Math.floor(rect.width));
    const height = Math.max(1, Math.floor(rect.height));
    const dpr = Math.min(
      typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1,
      QUALITY[this.quality].dpr,
    );

    this.cssWidth = width;
    this.cssHeight = height;
    this.pixelRatio = dpr;

    const pixelW = Math.max(1, Math.floor(width * dpr));
    const pixelH = Math.max(1, Math.floor(height * dpr));
    if (canvas.width !== pixelW || canvas.height !== pixelH) {
      canvas.width = pixelW;
      canvas.height = pixelH;
    }
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;
    this.accent = readAccent();
  };

  private updateHud(force: boolean): void {
    if (this.empty) return;
    const readout = this.readoutEl;
    const status = this.statusEl;
    if (!readout || !status) return;

    const text = Number.isFinite(this.heightCurrent)
      ? this.heightCurrent.toFixed(1)
      : '—';
    if (force || text !== this.lastReadout) {
      readout.textContent = text;
      this.lastReadout = text;
    }
    if (force || this.statusText !== this.lastStatus) {
      status.textContent = this.statusText;
      this.lastStatus = this.statusText;
    }
    if (this.unitEl) this.unitEl.hidden = !Number.isFinite(this.heightCurrent);
  }

  private draw(): void {
    const ctx = this.context;
    const canvas = this.canvas;
    if (!ctx || !canvas) return;

    const w = this.cssWidth;
    const h = this.cssHeight;
    const dpr = this.pixelRatio;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    if (this.empty) {
      this.drawEmptyHint(ctx, w, h);
      return;
    }

    this.drawGravityDemo(ctx, w, h);
    if (this.tide) this.drawTideCurve(ctx, w, h, this.tide);
  }

  private drawEmptyHint(ctx: CanvasRenderingContext2D, w: number, h: number): void {
    // 轻量占位：淡化地球轮廓，避免空屏
    const cx = w * 0.5;
    const cy = h * 0.42;
    const r = Math.min(w, h) * 0.09;
    ctx.strokeStyle = 'rgba(255,255,255,0.14)';
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.stroke();
    ctx.strokeStyle = 'rgba(126,200,255,0.18)';
    ctx.beginPath();
    ctx.ellipse(cx, cy, r * 1.35, r * 1.05, 0, 0, Math.PI * 2);
    ctx.stroke();
  }

  private drawGravityDemo(ctx: CanvasRenderingContext2D, w: number, h: number): void {
    const city = get(currentCity);
    const moon = moonPosition(this.date || '2026-08-06', this.timeMinutes, city.lat, city.lon);

    // 示意俯视：方位角 0=北 → 画布上方；90=东 → 右
    const azRad = ((moon.azimuth - 90) * Math.PI) / 180;
    const elevFactor = clamp((moon.elevation + 20) / 70, 0.35, 1);

    const cx = w * 0.5;
    const cy = h * 0.28;
    const earthR = Math.min(w, h) * 0.085;
    const orbitR = earthR * 2.55;
    const moonR = earthR * 0.28;

    const moonX = cx + Math.cos(azRad) * orbitR;
    const moonY = cy + Math.sin(azRad) * orbitR;

    // 轨道虚线
    ctx.strokeStyle = 'rgba(255,255,255,0.12)';
    ctx.lineWidth = 1;
    ctx.setLineDash([3, 5]);
    ctx.beginPath();
    ctx.arc(cx, cy, orbitR, 0, Math.PI * 2);
    ctx.stroke();
    ctx.setLineDash([]);

    // 地月连线
    ctx.strokeStyle = 'rgba(126,200,255,0.22)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.lineTo(moonX, moonY);
    ctx.stroke();

    // 水圈：沿地月连线双凸椭球（长轴 ∝ 潮汐振幅示意）
    const stretch = 1.22 + 0.08 * elevFactor;
    const major = earthR * stretch;
    const minor = earthR * (2.05 - stretch);
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(azRad);
    const waterGrad = ctx.createRadialGradient(0, 0, earthR * 0.2, 0, 0, major);
    waterGrad.addColorStop(0, 'rgba(126,200,255,0.28)');
    waterGrad.addColorStop(0.7, 'rgba(126,200,255,0.14)');
    waterGrad.addColorStop(1, 'rgba(126,200,255,0.02)');
    ctx.fillStyle = waterGrad;
    ctx.beginPath();
    ctx.ellipse(0, 0, major, minor, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = 'rgba(126,200,255,0.55)';
    ctx.lineWidth = 1.5;
    ctx.stroke();
    ctx.restore();

    // 地球
    const earthGrad = ctx.createRadialGradient(
      cx - earthR * 0.35,
      cy - earthR * 0.35,
      earthR * 0.1,
      cx,
      cy,
      earthR,
    );
    earthGrad.addColorStop(0, 'rgba(160,200,230,0.95)');
    earthGrad.addColorStop(0.55, 'rgba(70,120,160,0.95)');
    earthGrad.addColorStop(1, 'rgba(28,52,78,0.98)');
    ctx.fillStyle = earthGrad;
    ctx.beginPath();
    ctx.arc(cx, cy, earthR * 0.92, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = 'rgba(255,255,255,0.2)';
    ctx.lineWidth = 1;
    ctx.stroke();

    // 月球
    const moonGrad = ctx.createRadialGradient(
      moonX - moonR * 0.3,
      moonY - moonR * 0.3,
      moonR * 0.15,
      moonX,
      moonY,
      moonR,
    );
    moonGrad.addColorStop(0, 'rgba(245,245,240,0.95)');
    moonGrad.addColorStop(1, 'rgba(160,160,150,0.9)');
    ctx.globalAlpha = 0.55 + 0.45 * elevFactor;
    ctx.fillStyle = moonGrad;
    ctx.beginPath();
    ctx.arc(moonX, moonY, moonR, 0, Math.PI * 2);
    ctx.fill();
    ctx.globalAlpha = 1;

    // 标签
    ctx.fillStyle = 'rgba(255,255,255,0.35)';
    ctx.font = '500 10px Outfit, "PingFang SC", "Hiragino Sans GB", sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    ctx.fillText('引力示意 · 双凸潮', cx, cy + earthR * 1.55);
  }

  private drawTideCurve(
    ctx: CanvasRenderingContext2D,
    w: number,
    h: number,
    data: TideData,
  ): void {
    const padL = Math.max(28, w * 0.06);
    const padR = Math.max(20, w * 0.05);
    const padB = Math.max(88, h * 0.12);
    const chartTop = h * 0.48;
    const chartBottom = h - padB;
    const plotW = w - padL - padR;
    const plotH = chartBottom - chartTop;
    if (plotW < 40 || plotH < 40) return;

    let minH = Infinity;
    let maxH = -Infinity;
    for (const p of data.hourly) {
      if (p.heightM < minH) minH = p.heightM;
      if (p.heightM > maxH) maxH = p.heightM;
    }
    for (const e of data.extrema) {
      if (e.heightM < minH) minH = e.heightM;
      if (e.heightM > maxH) maxH = e.heightM;
    }
    if (!Number.isFinite(minH) || !Number.isFinite(maxH)) {
      minH = 0;
      maxH = 3;
    }
    const span = Math.max(0.4, maxH - minH);
    minH -= span * 0.12;
    maxH += span * 0.18;
    const range = maxH - minH;

    const xAt = (minutes: number) => padL + (clamp(minutes, 0, DAY_MINUTES) / DAY_MINUTES) * plotW;
    const yAt = (heightM: number) => chartTop + plotH - ((heightM - minH) / range) * plotH;

    // 轴
    ctx.strokeStyle = 'rgba(255,255,255,0.22)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(padL, chartBottom);
    ctx.lineTo(padL + plotW, chartBottom);
    ctx.stroke();

    ctx.fillStyle = 'rgba(255,255,255,0.45)';
    ctx.font = '500 11px Outfit, "PingFang SC", "Hiragino Sans GB", sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    for (let hour = 0; hour <= 24; hour += 2) {
      const x = xAt(hour * 60);
      ctx.fillText(`${String(hour).padStart(2, '0')}:00`, x, chartBottom + 6);
      if (hour > 0 && hour < 24) {
        ctx.strokeStyle = 'rgba(255,255,255,0.08)';
        ctx.beginPath();
        ctx.moveTo(x, chartTop);
        ctx.lineTo(x, chartBottom);
        ctx.stroke();
      }
    }

    // 采样平滑曲线点
    const samples: { x: number; y: number; m: number }[] = [];
    const step = this.quality === 'low' ? 12 : 6;
    for (let m = 0; m <= DAY_MINUTES; m += step) {
      const height = sampleTideHeight(data, m);
      if (!Number.isFinite(height)) continue;
      samples.push({ x: xAt(m), y: yAt(height), m });
    }
    if (samples.length < 2) return;

    const reduced = getPrefersReducedMotion();
    const waveOn = QUALITY[this.quality].wave && !reduced;
    const wavePhase = this.elapsed * 1.1;

    // 填充（带微浪）
    ctx.beginPath();
    ctx.moveTo(samples[0]!.x, chartBottom);
    for (let i = 0; i < samples.length; i += 1) {
      const s = samples[i]!;
      let y = s.y;
      if (waveOn) {
        const amp =
          WAVE_AMP_MAX *
          (0.55 + 0.45 * Math.sin(s.m * 0.01 + wavePhase * 0.7));
        y += Math.sin(s.x * 0.045 + wavePhase) * amp * 0.55;
        y += Math.sin(s.x * 0.09 + wavePhase * 1.7) * amp * 0.35;
      }
      if (i === 0) ctx.lineTo(s.x, y);
      else ctx.lineTo(s.x, y);
    }
    ctx.lineTo(samples[samples.length - 1]!.x, chartBottom);
    ctx.closePath();
    const fill = ctx.createLinearGradient(0, chartTop, 0, chartBottom);
    fill.addColorStop(0, 'rgba(126,200,255,0.28)');
    fill.addColorStop(0.55, 'rgba(126,200,255,0.12)');
    fill.addColorStop(1, 'rgba(126,200,255,0.03)');
    ctx.fillStyle = fill;
    ctx.fill();

    // 曲线描边
    ctx.beginPath();
    for (let i = 0; i < samples.length; i += 1) {
      const s = samples[i]!;
      let y = s.y;
      if (waveOn) {
        const amp =
          WAVE_AMP_MAX *
          (0.55 + 0.45 * Math.sin(s.m * 0.01 + wavePhase * 0.7));
        y += Math.sin(s.x * 0.045 + wavePhase) * amp * 0.55;
        y += Math.sin(s.x * 0.09 + wavePhase * 1.7) * amp * 0.35;
      }
      if (i === 0) ctx.moveTo(s.x, y);
      else ctx.lineTo(s.x, y);
    }
    ctx.strokeStyle = this.accent;
    ctx.lineWidth = 1.5;
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.stroke();

    // 极值标注
    ctx.font = '500 11px Outfit, "PingFang SC", "Hiragino Sans GB", sans-serif';
    for (const ex of data.extrema) {
      const x = xAt(ex.minutes);
      const y = yAt(ex.heightM);
      ctx.fillStyle = this.accent;
      ctx.beginPath();
      ctx.arc(x, y, 2.2, 0, Math.PI * 2);
      ctx.fill();

      const mark = ex.type === 'high' ? '▲满潮' : '▼干潮';
      const label = `${mark} ${formatTideClock(ex.minutes)} ${ex.heightM.toFixed(1)}m`;
      ctx.fillStyle = 'rgba(255,255,255,0.72)';
      ctx.textAlign = 'center';
      if (ex.type === 'high') {
        ctx.textBaseline = 'bottom';
        ctx.fillText(label, x, y - 8);
      } else {
        ctx.textBaseline = 'top';
        ctx.fillText(label, x, y + 8);
      }
    }

    // 当前时间珠
    const curH = sampleTideHeight(data, this.timeMinutes);
    if (Number.isFinite(curH)) {
      const cx = xAt(this.timeMinutes);
      let cy = yAt(curH);
      if (waveOn) {
        const amp =
          WAVE_AMP_MAX *
          (0.55 + 0.45 * Math.sin(this.timeMinutes * 0.01 + wavePhase * 0.7));
        cy += Math.sin(cx * 0.045 + wavePhase) * amp * 0.55;
        cy += Math.sin(cx * 0.09 + wavePhase * 1.7) * amp * 0.35;
      }
      ctx.strokeStyle = 'rgba(255,255,255,0.35)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(cx, chartTop);
      ctx.lineTo(cx, chartBottom);
      ctx.stroke();

      ctx.fillStyle = this.accent;
      ctx.beginPath();
      ctx.arc(cx, cy, 4.2, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = 'rgba(8,14,22,0.55)';
      ctx.lineWidth = 1.5;
      ctx.stroke();
    }
  }
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

function readAccent(): string {
  if (typeof getComputedStyle === 'undefined' || typeof document === 'undefined') {
    return '#a8d4e8';
  }
  const v = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim();
  return v || '#a8d4e8';
}

function addDaysLocal(iso: string, days: number): string {
  const [y, m, d] = iso.split('-').map(Number);
  if (!y || !m || !d) return iso;
  const dt = new Date(Date.UTC(y, m - 1, d + days));
  return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, '0')}-${String(dt.getUTCDate()).padStart(2, '0')}`;
}

function formatShortDate(iso: string): string {
  const parts = iso.split('-');
  if (parts.length !== 3) return iso;
  return `${Number(parts[1])}月${Number(parts[2])}日`;
}
