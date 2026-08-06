/**
 * XSectionLayer —— 分析模式「空间剖面」。
 *
 * 沿任意两点大圆取 7 点气压面廓线，Canvas2D 绘制距离 × 高度填色剖面。
 * 入口：雷达地图「切剖面」选点 / 快捷城市对；关闭返回地图。
 */

import { get } from 'svelte/store';
import type { City, DayData, WeatherLayer } from '../../contracts';
import { fetchProfile } from '../../data/openmeteo';
import { haversineKm, sampleGreatCircle } from '../../geo/greatCircle';
import { currentCity } from '../../stores/app';
import {
  requestCloseXSection,
  xsectionEndpoints,
  type XSectionEndpoints,
} from '../../stores/xsection';
import {
  buildXSectionGrid,
  HEIGHT_MAX_M,
  SAMPLE_COUNT,
  type XSectionColumn,
  type XSectionGrid,
  type XSectionVariable,
} from './grid';

type Quality = 'low' | 'medium' | 'high';

const DAY_MINUTES = 1440;
const DEBOUNCE_MS = 500;
const DPR_CAP: Record<Quality, number> = { high: 2, medium: 1.5, low: 1 };

const VARS: { id: XSectionVariable; label: string }[] = [
  { id: 'temperature', label: '温度' },
  { id: 'humidity', label: '湿度' },
  { id: 'wind', label: '风速' },
];

const LAYER_CSS = `
.serein-xsection-layer {
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
.serein-xsection-canvas {
  position: absolute;
  inset: 0;
  z-index: 0;
  display: block;
  width: 100%;
  height: 100%;
}
.serein-xsection-header {
  position: absolute;
  top: max(12px, env(safe-area-inset-top));
  left: max(12px, env(safe-area-inset-left));
  right: max(12px, env(safe-area-inset-right));
  z-index: 2;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  pointer-events: none;
}
.serein-xsection-title {
  margin: 0;
  font-size: 17px;
  font-weight: 560;
  letter-spacing: .02em;
}
.serein-xsection-sub {
  margin: 2px 0 0;
  color: var(--fg-2, rgba(255,255,255,.45));
  font-size: 11px;
  letter-spacing: .04em;
}
.serein-xsection-close {
  pointer-events: auto;
  min-height: 34px;
  padding: 0 12px;
  border: 1px solid var(--line, rgba(255,255,255,.22));
  background: color-mix(in srgb, var(--bg) 55%, transparent);
  color: var(--fg-1, rgba(255,255,255,.92));
  font: inherit;
  font-size: 11px;
  letter-spacing: .04em;
  cursor: pointer;
}
.serein-xsection-close:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
}
.serein-xsection-tabs {
  position: absolute;
  top: max(56px, calc(env(safe-area-inset-top) + 44px));
  left: 50%;
  z-index: 2;
  display: inline-flex;
  transform: translateX(-50%);
  pointer-events: auto;
  border: 1px solid var(--line, rgba(255,255,255,.22));
  background: color-mix(in srgb, var(--bg) 55%, transparent);
}
.serein-xsection-tabs button {
  margin: 0;
  padding: 5px 12px;
  border: 0;
  background: transparent;
  color: var(--fg-2, rgba(255,255,255,.45));
  font: inherit;
  font-size: 11px;
  font-weight: 520;
  letter-spacing: .04em;
  cursor: pointer;
}
.serein-xsection-tabs button[aria-pressed='true'] {
  color: var(--fg-1, rgba(255,255,255,.92));
}
.serein-xsection-skeleton {
  position: absolute;
  inset: 18% 10% 14%;
  z-index: 1;
  display: none;
  border: 1px solid color-mix(in srgb, var(--line, rgba(255,255,255,.22)) 70%, transparent);
  background:
    linear-gradient(90deg,
      transparent,
      color-mix(in srgb, var(--fg-2, rgba(255,255,255,.45)) 12%, transparent),
      transparent);
  background-size: 40% 100%;
  animation: serein-xsection-shimmer 1.2s ease-in-out infinite;
  pointer-events: none;
}
.serein-xsection-skeleton[data-visible='true'] {
  display: block;
}
@keyframes serein-xsection-shimmer {
  0% { background-position: -40% 0; }
  100% { background-position: 140% 0; }
}
@media (prefers-reduced-motion: reduce) {
  .serein-xsection-skeleton { animation: none; }
}
`;

const clamp = (x: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, x));

function nearestHourMinutes(minutes: number): number {
  const hour = Math.min(24, Math.max(0, Math.round(clamp(minutes, 0, DAY_MINUTES) / 60)));
  return hour * 60;
}

function sampleCity(lat: number, lon: number, name: string, tz: string): City {
  return { name, lat, lon, tz };
}

/** 蓝(冷)→红(暖)连续色标 */
function valueToRgb(
  value: number,
  min: number,
  max: number,
  variable: XSectionVariable,
): [number, number, number] {
  const t = clamp((value - min) / (max - min || 1), 0, 1);
  if (variable === 'humidity') {
    // 干燥灰蓝 → 湿润青绿
    const r = Math.round(40 + 40 * (1 - t));
    const g = Math.round(80 + 140 * t);
    const b = Math.round(120 + 80 * t);
    return [r, g, b];
  }
  if (variable === 'wind') {
    // 静风暗 → 大风亮琥珀
    const r = Math.round(40 + 200 * t);
    const g = Math.round(50 + 120 * t);
    const b = Math.round(70 + 20 * (1 - t));
    return [r, g, b];
  }
  // 温度：HSL 240→0
  const hue = 240 * (1 - t);
  return hslToRgb(hue, 0.72, 0.48);
}

function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const hp = h / 60;
  const x = c * (1 - Math.abs((hp % 2) - 1));
  let r = 0;
  let g = 0;
  let b = 0;
  if (hp >= 0 && hp < 1) [r, g, b] = [c, x, 0];
  else if (hp < 2) [r, g, b] = [x, c, 0];
  else if (hp < 3) [r, g, b] = [0, c, x];
  else if (hp < 4) [r, g, b] = [0, x, c];
  else if (hp < 5) [r, g, b] = [x, 0, c];
  else [r, g, b] = [c, 0, x];
  const m = l - c / 2;
  return [
    Math.round((r + m) * 255),
    Math.round((g + m) * 255),
    Math.round((b + m) * 255),
  ];
}

export class XSectionLayer implements WeatherLayer {
  readonly id = 'xsection';
  readonly name = '空间剖面';
  readonly preferredSkyDim = 0.9;

  private root: HTMLElement | null = null;
  private canvas: HTMLCanvasElement | null = null;
  private ctx: CanvasRenderingContext2D | null = null;
  private skeletonEl: HTMLElement | null = null;
  private titleEl: HTMLElement | null = null;
  private subEl: HTMLElement | null = null;
  private tabsEl: HTMLElement | null = null;
  private styleEl: HTMLStyleElement | null = null;

  private quality: Quality = 'high';
  private timeMinutes = 480;
  private date = '';
  private variable: XSectionVariable = 'temperature';
  private endpoints: XSectionEndpoints | null = null;
  private columns: XSectionColumn[] = [];
  private grid: XSectionGrid | null = null;
  private loading = false;
  private accent = '#a8d4e8';
  private fg2 = 'rgba(255,255,255,0.45)';
  private line = 'rgba(255,255,255,0.22)';

  private debounceTimer = 0;
  private fetchGen = 0;
  private resizeObserver: ResizeObserver | null = null;
  private unsubEndpoints: (() => void) | null = null;
  private cssW = 1;
  private cssH = 1;

  mount(container: HTMLElement): void {
    if (this.root) return;

    this.styleEl = document.createElement('style');
    this.styleEl.textContent = LAYER_CSS;
    document.head.appendChild(this.styleEl);

    const root = document.createElement('div');
    root.className = 'serein-xsection-layer';
    root.setAttribute('role', 'region');
    root.setAttribute('aria-label', '大气空间剖面');

    root.innerHTML = `
      <canvas class="serein-xsection-canvas" aria-hidden="true"></canvas>
      <div class="serein-xsection-skeleton" aria-hidden="true"></div>
      <header class="serein-xsection-header">
        <div>
          <h2 class="serein-xsection-title">空间剖面</h2>
          <p class="serein-xsection-sub">选取两端点</p>
        </div>
        <button type="button" class="serein-xsection-close">关闭</button>
      </header>
      <div class="serein-xsection-tabs" role="tablist" aria-label="剖面变量">
        ${VARS.map(
          (v) =>
            `<button type="button" role="tab" data-var="${v.id}" aria-pressed="${
              v.id === this.variable ? 'true' : 'false'
            }">${v.label}</button>`,
        ).join('')}
      </div>
    `;

    container.appendChild(root);
    this.root = root;
    this.canvas = root.querySelector('canvas');
    this.ctx = this.canvas?.getContext('2d') ?? null;
    this.skeletonEl = root.querySelector('.serein-xsection-skeleton');
    this.titleEl = root.querySelector('.serein-xsection-title');
    this.subEl = root.querySelector('.serein-xsection-sub');
    this.tabsEl = root.querySelector('.serein-xsection-tabs');

    root.querySelector('.serein-xsection-close')?.addEventListener('click', () => {
      requestCloseXSection();
    });
    this.tabsEl?.addEventListener('click', this.onTabClick);

    this.unsubEndpoints = xsectionEndpoints.subscribe((ep) => {
      this.endpoints = ep;
      this.updateLabels();
      this.scheduleSample(true);
    });

    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(container);
    this.readTokens();
    this.resize();
    this.scheduleSample(true);
  }

  unmount(): void {
    this.fetchGen += 1;
    if (this.debounceTimer) window.clearTimeout(this.debounceTimer);
    this.debounceTimer = 0;
    this.unsubEndpoints?.();
    this.unsubEndpoints = null;
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    this.tabsEl?.removeEventListener('click', this.onTabClick);
    this.root?.remove();
    this.styleEl?.remove();
    this.root = null;
    this.canvas = null;
    this.ctx = null;
    this.skeletonEl = null;
    this.titleEl = null;
    this.subEl = null;
    this.tabsEl = null;
    this.styleEl = null;
    this.columns = [];
    this.grid = null;
  }

  setTime(minutes: number): void {
    const next = clamp(minutes, 0, DAY_MINUTES);
    if (nearestHourMinutes(next) === nearestHourMinutes(this.timeMinutes)) {
      this.timeMinutes = next;
      return;
    }
    this.timeMinutes = next;
    this.scheduleSample(false);
  }

  setData(data: DayData): void {
    if (data.date === this.date) return;
    this.date = data.date;
    this.scheduleSample(false);
  }

  setQuality(q: Quality): void {
    this.quality = q;
    this.resize();
    this.draw();
  }

  setMode(_mode: 'feel' | 'analysis'): void {
    // 仅分析模式入口
  }

  private readonly onTabClick = (event: Event): void => {
    const target = event.target;
    if (!(target instanceof HTMLButtonElement)) return;
    const id = target.dataset.var as XSectionVariable | undefined;
    if (!id || id === this.variable) return;
    this.variable = id;
    for (const btn of this.tabsEl?.querySelectorAll('button') ?? []) {
      if (!(btn instanceof HTMLButtonElement)) continue;
      btn.setAttribute('aria-pressed', btn.dataset.var === id ? 'true' : 'false');
    }
    if (this.columns.length) {
      this.grid = buildXSectionGrid(this.columns, this.variable);
      this.draw();
    }
  };

  private scheduleSample(immediate: boolean): void {
    if (this.debounceTimer) window.clearTimeout(this.debounceTimer);
    if (immediate) {
      void this.sampleProfiles();
      return;
    }
    this.debounceTimer = window.setTimeout(() => {
      this.debounceTimer = 0;
      void this.sampleProfiles();
    }, DEBOUNCE_MS);
  }

  private updateLabels(): void {
    const ep = this.endpoints ?? get(xsectionEndpoints);
    if (!ep) {
      if (this.subEl) this.subEl.textContent = '请从地图选取两端点';
      return;
    }
    const km = haversineKm(ep.a, ep.b);
    if (this.subEl) {
      this.subEl.textContent = `${ep.a.name} → ${ep.b.name} · ${km.toFixed(0)} km`;
    }
  }

  private setLoading(loading: boolean): void {
    this.loading = loading;
    if (this.skeletonEl) this.skeletonEl.dataset.visible = loading ? 'true' : 'false';
  }

  private async sampleProfiles(): Promise<void> {
    const ep = this.endpoints ?? get(xsectionEndpoints);
    if (!ep) {
      this.columns = [];
      this.grid = null;
      this.draw();
      return;
    }

    const gen = ++this.fetchGen;
    this.setLoading(true);
    const hourMinutes = nearestHourMinutes(this.timeMinutes);
    const date = this.date || new Date().toISOString().slice(0, 10);
    const tz = get(currentCity).tz || 'Asia/Shanghai';
    const samples = sampleGreatCircle(ep.a, ep.b, SAMPLE_COUNT);
    const totalKm = haversineKm(ep.a, ep.b);

    const tasks = samples.map(async (pt, index) => {
      const distanceKm = totalKm * (index / (SAMPLE_COUNT - 1));
      const name =
        index === 0
          ? ep.a.name
          : index === SAMPLE_COUNT - 1
            ? ep.b.name
            : `${pt.lat.toFixed(2)},${pt.lon.toFixed(2)}`;
      const city = sampleCity(pt.lat, pt.lon, name, tz);
      try {
        const profile = await fetchProfile(hourMinutes, date, city, {
          errorMode: 'throw',
        });
        return {
          lat: pt.lat,
          lon: pt.lon,
          distanceKm,
          profile,
          failed: false,
        } satisfies XSectionColumn;
      } catch (error) {
        console.warn('[xsection] 采样点失败', name, error);
        return {
          lat: pt.lat,
          lon: pt.lon,
          distanceKm,
          profile: null,
          failed: true,
        } satisfies XSectionColumn;
      }
    });

    // ≤ 7 并发：一次 Promise.all 即可
    const columns = await Promise.all(tasks);
    if (gen !== this.fetchGen) return;

    this.columns = columns;
    this.grid = buildXSectionGrid(columns, this.variable);
    this.setLoading(false);
    this.updateLabels();
    this.draw();
  }

  private readTokens(): void {
    if (!this.root || typeof getComputedStyle === 'undefined') return;
    const styles = getComputedStyle(this.root);
    this.accent = styles.getPropertyValue('--accent').trim() || '#a8d4e8';
    this.fg2 = styles.getPropertyValue('--fg-2').trim() || 'rgba(255,255,255,0.45)';
    this.line = styles.getPropertyValue('--line').trim() || 'rgba(255,255,255,0.22)';
  }

  private resize(): void {
    const canvas = this.canvas;
    const ctx = this.ctx;
    const root = this.root;
    if (!canvas || !ctx || !root) return;
    const rect = root.getBoundingClientRect();
    this.cssW = Math.max(1, rect.width);
    this.cssH = Math.max(1, rect.height);
    const dpr = Math.min(window.devicePixelRatio || 1, DPR_CAP[this.quality]);
    canvas.width = Math.round(this.cssW * dpr);
    canvas.height = Math.round(this.cssH * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.readTokens();
    this.draw();
  }

  private draw(): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const w = this.cssW;
    const h = this.cssH;
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = '#0a121c';
    ctx.fillRect(0, 0, w, h);

    const grid = this.grid;
    const ep = this.endpoints ?? get(xsectionEndpoints);
    if (!grid || !ep || grid.cols < 2) {
      ctx.fillStyle = this.fg2;
      ctx.font = '500 12px Outfit, "PingFang SC", "Hiragino Sans GB", sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('等待剖面数据…', w / 2, h / 2);
      return;
    }

    const padL = 52;
    const padR = 24;
    const padT = 110;
    const padB = 56;
    const plotW = Math.max(40, w - padL - padR);
    const plotH = Math.max(40, h - padT - padB);
    const plotX = padL;
    const plotY = padT;
    const totalKm = Math.max(grid.distancesKm[grid.cols - 1], 0.01);

    const xAt = (distKm: number) => plotX + (distKm / totalKm) * plotW;
    const yAt = (heightM: number) =>
      plotY + plotH - (clamp(heightM, 0, HEIGHT_MAX_M) / HEIGHT_MAX_M) * plotH;

    // 填色
    for (let c = 0; c < grid.cols - 1; c += 1) {
      for (let r = 0; r < grid.rows - 1; r += 1) {
        const v00 = grid.values[r * grid.cols + c];
        const v10 = grid.values[r * grid.cols + c + 1];
        const v01 = grid.values[(r + 1) * grid.cols + c];
        const v11 = grid.values[(r + 1) * grid.cols + c + 1];
        const samples = [v00, v10, v01, v11].filter(Number.isFinite);
        if (!samples.length) continue;
        const avg = samples.reduce((a, b) => a + b, 0) / samples.length;
        const [cr, cg, cb] = valueToRgb(avg, grid.min, grid.max, grid.variable);
        const x0 = xAt(grid.distancesKm[c]);
        const x1 = xAt(grid.distancesKm[c + 1]);
        const y0 = yAt(grid.heightsM[r]);
        const y1 = yAt(grid.heightsM[r + 1]);
        ctx.fillStyle = `rgb(${cr},${cg},${cb})`;
        ctx.fillRect(
          Math.min(x0, x1),
          Math.min(y0, y1),
          Math.max(1, Math.abs(x1 - x0) + 0.5),
          Math.max(1, Math.abs(y1 - y0) + 0.5),
        );
      }
    }

    // 等值线
    if (grid.variable === 'temperature') {
      const lo = Math.ceil(grid.min / 2) * 2;
      const hi = Math.floor(grid.max / 2) * 2;
      for (let iso = lo; iso <= hi; iso += 2) {
        this.drawIsoline(ctx, grid, iso, xAt, yAt, iso === 0);
      }
    } else if (grid.variable === 'humidity') {
      for (let iso = 20; iso <= 100; iso += 20) {
        if (iso < grid.min || iso > grid.max) continue;
        this.drawIsoline(ctx, grid, iso, xAt, yAt, false);
      }
    } else {
      const step = grid.max > 30 ? 5 : 2;
      const lo = Math.ceil(grid.min / step) * step;
      const hi = Math.floor(grid.max / step) * step;
      for (let iso = lo; iso <= hi; iso += step) {
        this.drawIsoline(ctx, grid, iso, xAt, yAt, false);
      }
    }

    // 坐标轴
    ctx.strokeStyle = this.line;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(plotX, plotY);
    ctx.lineTo(plotX, plotY + plotH);
    ctx.lineTo(plotX + plotW, plotY + plotH);
    ctx.stroke();

    ctx.fillStyle = this.fg2;
    ctx.font = '500 11px Outfit, "PingFang SC", "Hiragino Sans GB", sans-serif';
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    for (let kmH = 0; kmH <= 12; kmH += 2) {
      const y = yAt(kmH * 1000);
      ctx.fillText(`${kmH}`, plotX - 8, y);
      ctx.strokeStyle = this.line;
      ctx.globalAlpha = 0.35;
      ctx.beginPath();
      ctx.moveTo(plotX, y);
      ctx.lineTo(plotX + plotW, y);
      ctx.stroke();
      ctx.globalAlpha = 1;
    }
    ctx.textAlign = 'left';
    ctx.fillText('km', plotX - 8, plotY - 10);

    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    ctx.fillText(ep.a.name, plotX, plotY + plotH + 8);
    ctx.fillText(ep.b.name, plotX + plotW, plotY + plotH + 8);
    ctx.fillText(`${totalKm.toFixed(0)} km`, plotX + plotW / 2, plotY + plotH + 8);

    // 色标
    this.drawColorBar(ctx, grid, plotX + plotW - 8, plotY, 8, plotH);
  }

  private drawIsoline(
    ctx: CanvasRenderingContext2D,
    grid: XSectionGrid,
    target: number,
    xAt: (d: number) => number,
    yAt: (h: number) => number,
    zeroLine: boolean,
  ): void {
    const points: { x: number; y: number }[] = [];
    for (let c = 0; c < grid.cols; c += 1) {
      for (let r = 0; r < grid.rows - 1; r += 1) {
        const v0 = grid.values[r * grid.cols + c];
        const v1 = grid.values[(r + 1) * grid.cols + c];
        if (!Number.isFinite(v0) || !Number.isFinite(v1)) continue;
        if ((v0 - target) * (v1 - target) > 0) continue;
        const t = v0 === v1 ? 0 : (target - v0) / (v1 - v0);
        const h = grid.heightsM[r] + (grid.heightsM[r + 1] - grid.heightsM[r]) * t;
        points.push({ x: xAt(grid.distancesKm[c]), y: yAt(h) });
        break;
      }
    }
    if (points.length < 2) return;
    ctx.beginPath();
    ctx.moveTo(points[0].x, points[0].y);
    for (let i = 1; i < points.length; i += 1) ctx.lineTo(points[i].x, points[i].y);
    if (zeroLine) {
      ctx.strokeStyle = this.accent;
      ctx.lineWidth = 2;
      ctx.globalAlpha = 1;
    } else {
      ctx.strokeStyle = 'rgba(255,255,255,0.92)';
      ctx.lineWidth = 1;
      ctx.globalAlpha = 0.3;
    }
    ctx.stroke();
    ctx.globalAlpha = 1;
  }

  private drawColorBar(
    ctx: CanvasRenderingContext2D,
    grid: XSectionGrid,
    x: number,
    y: number,
    w: number,
    h: number,
  ): void {
    for (let i = 0; i < h; i += 1) {
      const t = 1 - i / h;
      const value = grid.min + (grid.max - grid.min) * t;
      const [r, g, b] = valueToRgb(value, grid.min, grid.max, grid.variable);
      ctx.fillStyle = `rgb(${r},${g},${b})`;
      ctx.fillRect(x, y + i, w, 1);
    }
    ctx.strokeStyle = this.line;
    ctx.strokeRect(x, y, w, h);
    ctx.fillStyle = this.fg2;
    ctx.font = '500 9px Outfit, "PingFang SC", "Hiragino Sans GB", sans-serif';
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    const unit =
      grid.variable === 'temperature' ? '°C' : grid.variable === 'humidity' ? '%' : 'm/s';
    ctx.fillText(`${grid.max.toFixed(0)}${unit}`, x - 4, y + 4);
    ctx.fillText(`${grid.min.toFixed(0)}${unit}`, x - 4, y + h - 4);
  }
}
