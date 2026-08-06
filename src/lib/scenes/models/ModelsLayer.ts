/**
 * ModelsLayer —— 分析模式场景「对比」。
 *
 * 三家数值预报（ECMWF / GFS / ICON）同图：温度折线或降水细柱 + 分歧包络。
 * 仅分析模式经由场景切换器进入；历史日期显示占位。
 */

import { get } from 'svelte/store';
import type { DayData, MultiModelData, WeatherLayer } from '../../contracts';
import { fetchMultiModel, todayInCity } from '../../data/openmeteo';
import { currentCity } from '../../stores/app';

type Quality = 'low' | 'medium' | 'high';
type Variable = 'temperature' | 'precipitation';

const HOURS = 25;
const DAY_MINUTES = 1440;

/** 模式分歧解读阈值（温度 °C；降水同用数值作 mm） */
const SPREAD_AGREE = 1;
const SPREAD_DIVERGE = 4;

const MODEL_META = [
  { key: 'ecmwf_ifs025', label: 'ECMWF', color: '#a8d4e8' },
  { key: 'gfs_global', label: 'GFS', color: '#ffb03a' },
  { key: 'icon_global', label: 'ICON', color: '#c084fc' },
] as const;

const DPR_CAP: Record<Quality, number> = { high: 2, medium: 1.5, low: 1 };

const ENVELOPE_FILL = 'rgba(255,255,255,0.08)';
const BEAD_COLOR = 'rgba(255,255,255,0.92)';
const HISTORICAL_PLACEHOLDER = '历史日期无多模式预报';

interface PlotRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

const LAYER_CSS = `
.serein-models-layer {
  position: absolute;
  inset: 0;
  overflow: hidden;
  color: var(--fg-1, rgba(255,255,255,.92));
  font-family: Outfit, "PingFang SC", "Hiragino Sans GB", sans-serif;
  font-variant-numeric: tabular-nums;
  isolation: isolate;
  touch-action: none;
  user-select: none;
  -webkit-user-select: none;
}
.serein-models-canvas {
  position: absolute;
  inset: 0;
  z-index: 0;
  display: block;
  width: 100%;
  height: 100%;
}
.serein-models-tabs {
  position: absolute;
  top: max(16px, env(safe-area-inset-top));
  left: 50%;
  z-index: 2;
  display: flex;
  gap: 16px;
  transform: translateX(-50%);
  pointer-events: auto;
}
.serein-models-tab {
  margin: 0;
  padding: 0 0 3px;
  border: 0;
  border-bottom: 1px solid transparent;
  background: transparent;
  color: var(--fg-2, rgba(255,255,255,.45));
  font: inherit;
  font-size: 11px;
  letter-spacing: 0.06em;
  cursor: pointer;
}
.serein-models-tab[aria-selected="true"] {
  color: var(--fg-1, rgba(255,255,255,.92));
  border-bottom-color: var(--accent);
}
.serein-models-readout {
  position: absolute;
  top: max(44px, calc(env(safe-area-inset-top) + 28px));
  left: max(16px, env(safe-area-inset-left));
  right: max(16px, env(safe-area-inset-right));
  z-index: 2;
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 8px 14px;
  margin: 0;
  pointer-events: none;
  font-size: 11px;
  font-variant-numeric: tabular-nums;
  line-height: 1.35;
}
.serein-models-readout-model {
  color: var(--fg-1, rgba(255,255,255,.92));
}
.serein-models-readout-model[data-hidden="true"] {
  opacity: 0.35;
}
.serein-models-readout-spread {
  color: var(--fg-2, rgba(255,255,255,.45));
}
.serein-models-legend {
  position: absolute;
  top: max(44px, calc(env(safe-area-inset-top) + 28px));
  right: max(16px, env(safe-area-inset-right));
  z-index: 2;
  display: flex;
  flex-direction: column;
  gap: 6px;
  align-items: flex-end;
  pointer-events: auto;
}
.serein-models-legend-item {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  margin: 0;
  padding: 0;
  border: 0;
  background: transparent;
  color: var(--fg-2, rgba(255,255,255,.45));
  font: inherit;
  font-size: 11px;
  cursor: pointer;
}
.serein-models-legend-item[aria-pressed="false"] {
  opacity: 0.38;
}
.serein-models-legend-swatch {
  width: 12px;
  height: 2px;
  border-radius: 1px;
  background: currentColor;
}
.serein-models-hint {
  position: absolute;
  left: 50%;
  bottom: max(88px, calc(env(safe-area-inset-bottom) + 72px));
  z-index: 2;
  margin: 0;
  color: var(--fg-2, rgba(255,255,255,.45));
  font-size: 11px;
  letter-spacing: 0.02em;
  text-align: center;
  transform: translateX(-50%);
  pointer-events: none;
  white-space: nowrap;
}
.serein-models-hint:empty {
  display: none;
}
.serein-models-placeholder {
  position: absolute;
  inset: 0;
  z-index: 3;
  display: none;
  place-items: center;
  margin: 0;
  color: var(--fg-2, rgba(255,255,255,.45));
  font-size: 13px;
  letter-spacing: 0.04em;
  pointer-events: none;
  background: rgba(8, 14, 22, 0.35);
}
.serein-models-layer.is-historical .serein-models-placeholder {
  display: grid;
}
.serein-models-layer.is-historical .serein-models-tabs,
.serein-models-layer.is-historical .serein-models-readout,
.serein-models-layer.is-historical .serein-models-legend,
.serein-models-layer.is-historical .serein-models-hint {
  visibility: hidden;
}
`;

const clamp = (x: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, x));
const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;

function formatHourLabel(hour: number): string {
  const h = Math.min(24, Math.max(0, hour));
  return `${String(h).padStart(2, '0')}:00`;
}

function sampleAtMinutes(values: number[], minutes: number): number {
  if (values.length === 0) return 0;
  const t = clamp(minutes, 0, DAY_MINUTES) / 60;
  const i0 = Math.min(HOURS - 1, Math.floor(t));
  const i1 = Math.min(HOURS - 1, i0 + 1);
  const f = t - i0;
  const a = values[i0] ?? 0;
  const b = values[i1] ?? a;
  return lerp(a, b, f);
}

function emptySeries(): MultiModelData {
  return {
    variable: 'temperature',
    unit: '°C',
    series: MODEL_META.map((m) => ({
      model: m.key,
      label: m.label,
      values: Array.from({ length: HOURS }, () => 0),
    })),
  };
}

export class ModelsLayer implements WeatherLayer {
  readonly id = 'models';
  readonly name = '对比';
  readonly preferredSkyDim = 0.75;

  private container: HTMLElement | null = null;
  private root: HTMLElement | null = null;
  private canvas: HTMLCanvasElement | null = null;
  private ctx: CanvasRenderingContext2D | null = null;
  private styleEl: HTMLStyleElement | null = null;
  private tabsEl: HTMLElement | null = null;
  private readoutEl: HTMLElement | null = null;
  private legendEl: HTMLElement | null = null;
  private hintEl: HTMLElement | null = null;
  private placeholderEl: HTMLElement | null = null;

  private abortController: AbortController | null = null;
  private resizeObserver: ResizeObserver | null = null;
  private raf = 0;
  private quality: Quality = 'high';

  private dataDate = '';
  private dataCity = '';
  private historical = false;
  private timeMinutes = 480;
  private variable: Variable = 'temperature';
  private tempData: MultiModelData | null = null;
  private precipData: MultiModelData | null = null;
  private fetchGen = 0;
  private loading = false;

  private visible: Record<string, boolean> = {
    ecmwf_ifs025: true,
    gfs_global: true,
    icon_global: true,
  };

  private cssW = 1;
  private cssH = 1;
  private dpr = 1;
  private plot: PlotRect = { x: 0, y: 0, w: 1, h: 1 };
  private yMin = 0;
  private yMax = 1;
  private line = 'rgba(255,255,255,0.22)';
  private fg2 = 'rgba(255,255,255,0.45)';

  mount(container: HTMLElement): void {
    if (this.root) return;
    this.container = container;
    this.abortController = new AbortController();

    const style = document.createElement('style');
    style.textContent = LAYER_CSS;
    document.head.appendChild(style);
    this.styleEl = style;

    const root = document.createElement('div');
    root.className = 'serein-models-layer';
    root.setAttribute('role', 'img');
    root.setAttribute('aria-label', '多模式数值预报对比');

    const canvas = document.createElement('canvas');
    canvas.className = 'serein-models-canvas';
    root.appendChild(canvas);

    const tabs = document.createElement('div');
    tabs.className = 'serein-models-tabs';
    tabs.setAttribute('role', 'tablist');
    tabs.setAttribute('aria-label', '对比变量');
    tabs.setAttribute('data-scene-swipe-ignore', '');
    for (const [id, label] of [
      ['temperature', '温度'],
      ['precipitation', '降水'],
    ] as const) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'serein-models-tab';
      btn.dataset.variable = id;
      btn.setAttribute('role', 'tab');
      btn.setAttribute('aria-selected', String(id === this.variable));
      btn.textContent = label;
      tabs.appendChild(btn);
    }
    root.appendChild(tabs);

    const readout = document.createElement('div');
    readout.className = 'serein-models-readout';
    readout.setAttribute('aria-live', 'polite');
    root.appendChild(readout);

    const legend = document.createElement('div');
    legend.className = 'serein-models-legend';
    legend.setAttribute('role', 'group');
    legend.setAttribute('aria-label', '模式图例');
    legend.setAttribute('data-scene-swipe-ignore', '');
    for (const meta of MODEL_META) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'serein-models-legend-item';
      btn.dataset.model = meta.key;
      btn.setAttribute('aria-pressed', 'true');
      btn.style.color = meta.color;
      btn.innerHTML = `<span class="serein-models-legend-swatch" aria-hidden="true"></span>${meta.label}`;
      legend.appendChild(btn);
    }
    root.appendChild(legend);

    const hint = document.createElement('p');
    hint.className = 'serein-models-hint';
    root.appendChild(hint);

    const placeholder = document.createElement('p');
    placeholder.className = 'serein-models-placeholder';
    placeholder.setAttribute('role', 'status');
    placeholder.textContent = HISTORICAL_PLACEHOLDER;
    root.appendChild(placeholder);

    container.appendChild(root);
    this.root = root;
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d', { alpha: true });
    this.tabsEl = tabs;
    this.readoutEl = readout;
    this.legendEl = legend;
    this.hintEl = hint;
    this.placeholderEl = placeholder;

    this.readTokens();

    const signal = this.abortController.signal;
    tabs.addEventListener('click', this.onTabClick, { signal });
    legend.addEventListener('click', this.onLegendClick, { signal });
    document.addEventListener('visibilitychange', this.onVisibility, { signal });

    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(container);

    this.resize();
    this.syncHistoricalUi();
    this.updateReadout();
    this.start();
    // 数据由 LayerHost / LazyWeatherLayer 在 mount 后 setData 下发
  }

  unmount(): void {
    this.stop();
    this.fetchGen += 1;
    this.abortController?.abort();
    this.abortController = null;
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    this.root?.remove();
    this.styleEl?.remove();
    this.root = null;
    this.styleEl = null;
    this.canvas = null;
    this.ctx = null;
    this.tabsEl = null;
    this.readoutEl = null;
    this.legendEl = null;
    this.hintEl = null;
    this.placeholderEl = null;
    this.container = null;
  }

  setTime(minutes: number): void {
    this.timeMinutes = clamp(Number.isFinite(minutes) ? minutes : 0, 0, DAY_MINUTES);
    this.updateReadout();
  }

  setData(data: DayData): void {
    const prev = this.dataDate;
    const prevCity = this.dataCity;
    const city = get(currentCity);
    this.dataDate = data.date;
    this.dataCity = city.name;
    this.historical = data.date !== todayInCity(new Date(), city);
    this.syncHistoricalUi();

    if (this.historical) {
      this.fetchGen += 1;
      this.loading = false;
      this.updateReadout();
      return;
    }

    if (data.date !== prev || city.name !== prevCity || !this.tempData || !this.precipData) {
      void this.loadAll();
    }
  }

  setQuality(q: Quality): void {
    if (q === this.quality) return;
    this.quality = q;
    this.resize();
  }

  // ------------------------------------------------------------------ 数据

  private async loadAll(): Promise<void> {
    if (this.historical) return;
    const gen = ++this.fetchGen;
    this.loading = true;
    try {
      const city = get(currentCity);
      const [temp, precip] = await Promise.all([
        fetchMultiModel('temperature', city),
        fetchMultiModel('precipitation', city),
      ]);
      if (gen !== this.fetchGen) return;
      this.tempData = this.normalize(temp, 'temperature');
      this.precipData = this.normalize(precip, 'precipitation');
      this.loading = false;
      this.recomputeYRange();
      this.updateReadout();
    } catch (error) {
      if (gen !== this.fetchGen) return;
      this.loading = false;
      console.warn('[ModelsLayer] fetchMultiModel 失败', error);
      if (!this.tempData) this.tempData = emptySeries();
      if (!this.precipData) {
        this.precipData = { ...emptySeries(), variable: 'precipitation', unit: 'mm' };
      }
      this.recomputeYRange();
      this.updateReadout();
    }
  }

  private normalize(data: MultiModelData, variable: Variable): MultiModelData {
    const byModel = new Map(data.series.map((s) => [s.model, s]));
    const series = MODEL_META.map((meta) => {
      const found = byModel.get(meta.key);
      const values = Array.from({ length: HOURS }, (_, i) => {
        const v = found?.values[i];
        return typeof v === 'number' && Number.isFinite(v) ? v : 0;
      });
      return { model: meta.key, label: meta.label, values };
    });
    return {
      variable,
      unit: variable === 'temperature' ? '°C' : 'mm',
      series,
    };
  }

  private activeData(): MultiModelData {
    const data = this.variable === 'temperature' ? this.tempData : this.precipData;
    return data ?? emptySeries();
  }

  private syncHistoricalUi(): void {
    this.root?.classList.toggle('is-historical', this.historical);
  }

  // ------------------------------------------------------------------ 交互

  private onTabClick = (event: MouseEvent): void => {
    const target = (event.target as HTMLElement | null)?.closest<HTMLButtonElement>(
      '.serein-models-tab',
    );
    if (!target?.dataset.variable) return;
    const next = target.dataset.variable as Variable;
    if (next === this.variable) return;
    this.variable = next;
    for (const btn of this.tabsEl?.querySelectorAll<HTMLButtonElement>('.serein-models-tab') ??
      []) {
      btn.setAttribute('aria-selected', String(btn.dataset.variable === next));
    }
    this.recomputeYRange();
    this.updateReadout();
  };

  private onLegendClick = (event: MouseEvent): void => {
    const target = (event.target as HTMLElement | null)?.closest<HTMLButtonElement>(
      '.serein-models-legend-item',
    );
    if (!target?.dataset.model) return;
    const model = target.dataset.model;
    this.visible[model] = !this.visible[model];
    target.setAttribute('aria-pressed', String(this.visible[model]));
    this.recomputeYRange();
    this.updateReadout();
  };

  private onVisibility = (): void => {
    if (!document.hidden && !this.raf) this.start();
  };

  // ------------------------------------------------------------------ 布局

  private readTokens(): void {
    const root = document.documentElement;
    const line = getComputedStyle(root).getPropertyValue('--line').trim();
    const fg2 = getComputedStyle(root).getPropertyValue('--fg-2').trim();
    if (line) this.line = line;
    if (fg2) this.fg2 = fg2;
  }

  private resize(): void {
    const canvas = this.canvas;
    const ctx = this.ctx;
    const container = this.container;
    if (!canvas || !ctx || !container) return;

    const rect = container.getBoundingClientRect();
    this.cssW = Math.max(1, rect.width);
    this.cssH = Math.max(1, rect.height);
    this.dpr = Math.min(window.devicePixelRatio || 1, DPR_CAP[this.quality]);
    canvas.width = Math.round(this.cssW * this.dpr);
    canvas.height = Math.round(this.cssH * this.dpr);

    const padL = 44;
    const padR = 20;
    const padT = 96;
    const padB = 108;
    this.plot = {
      x: padL,
      y: padT,
      w: Math.max(40, this.cssW - padL - padR),
      h: Math.max(40, this.cssH - padT - padB),
    };
    this.readTokens();
    this.recomputeYRange();
  }

  private recomputeYRange(): void {
    const data = this.activeData();
    let min = Infinity;
    let max = -Infinity;
    for (const series of data.series) {
      for (const v of series.values) {
        if (!Number.isFinite(v)) continue;
        min = Math.min(min, v);
        max = Math.max(max, v);
      }
    }
    if (!Number.isFinite(min) || !Number.isFinite(max)) {
      min = 0;
      max = this.variable === 'precipitation' ? 1 : 10;
    }
    if (this.variable === 'precipitation') {
      min = 0;
      max = Math.max(0.5, max * 1.15);
    } else {
      const pad = Math.max(1, (max - min) * 0.12);
      min -= pad;
      max += pad;
      if (Math.abs(max - min) < 1e-6) {
        min -= 1;
        max += 1;
      }
    }
    this.yMin = min;
    this.yMax = max;
  }

  private xAtHour(hour: number): number {
    return this.plot.x + (hour / (HOURS - 1)) * this.plot.w;
  }

  private xAtMinutes(minutes: number): number {
    return this.plot.x + (clamp(minutes, 0, DAY_MINUTES) / DAY_MINUTES) * this.plot.w;
  }

  private yAtValue(value: number): number {
    const t = (value - this.yMin) / Math.max(1e-6, this.yMax - this.yMin);
    return this.plot.y + this.plot.h * (1 - clamp(t, 0, 1));
  }

  // ------------------------------------------------------------------ HUD

  private updateReadout(): void {
    if (!this.readoutEl || !this.hintEl) return;

    if (this.historical) {
      this.readoutEl.replaceChildren();
      this.hintEl.textContent = '';
      return;
    }

    const data = this.activeData();
    const unit = data.unit;
    const values = MODEL_META.map((meta) => {
      const series = data.series.find((s) => s.model === meta.key);
      const value = series ? sampleAtMinutes(series.values, this.timeMinutes) : 0;
      return { meta, value, hidden: !this.visible[meta.key] };
    });

    // 分歧始终按三模式计算（解读与读数），显隐只影响曲线绘制
    const allVals = values.map((v) => v.value);
    const fullSpread =
      allVals.length >= 2 ? Math.max(...allVals) - Math.min(...allVals) : 0;

    this.readoutEl.replaceChildren();
    for (const item of values) {
      const span = document.createElement('span');
      span.className = 'serein-models-readout-model';
      span.dataset.hidden = String(item.hidden);
      span.style.color = item.meta.color;
      const decimals = this.variable === 'precipitation' ? 1 : 1;
      span.textContent = `${item.meta.label} ${item.value.toFixed(decimals)}${unit}`;
      this.readoutEl.appendChild(span);
    }
    const spreadEl = document.createElement('span');
    spreadEl.className = 'serein-models-readout-spread';
    spreadEl.textContent = `模式分歧 ±${fullSpread.toFixed(1)}${unit}`;
    this.readoutEl.appendChild(spreadEl);

    if (this.loading && !this.tempData) {
      this.hintEl.textContent = '载入多模式预报…';
    } else if (fullSpread < SPREAD_AGREE) {
      this.hintEl.textContent = '模式一致性好，预报可信度高';
    } else if (fullSpread > SPREAD_DIVERGE) {
      this.hintEl.textContent = '模式分歧大，关注临近更新';
    } else {
      this.hintEl.textContent = '';
    }
  }

  // ------------------------------------------------------------------ 循环 / 绘制

  private start(): void {
    if (this.raf) return;
    const tick = () => {
      this.raf = requestAnimationFrame(tick);
      if (document.hidden) return;
      this.draw();
    };
    this.raf = requestAnimationFrame(tick);
  }

  private stop(): void {
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
  }

  private draw(): void {
    const ctx = this.ctx;
    const canvas = this.canvas;
    if (!ctx || !canvas) return;

    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.clearRect(0, 0, this.cssW, this.cssH);

    if (this.historical) {
      this.drawAxes();
      return;
    }

    this.drawAxes();
    this.drawEnvelope();
    if (this.variable === 'precipitation') this.drawPrecipBars();
    else this.drawTempLines();
    this.drawTimeBead();
  }

  private drawAxes(): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const { x, y, w, h } = this.plot;

    ctx.save();
    ctx.strokeStyle = this.line;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x, y + h);
    ctx.lineTo(x + w, y + h);
    ctx.stroke();

    ctx.fillStyle = this.fg2;
    ctx.font = '11px Outfit, "PingFang SC", "Hiragino Sans GB", sans-serif';
    ctx.textBaseline = 'top';

    for (let hour = 0; hour <= 24; hour += 2) {
      const px = this.xAtHour(hour);
      ctx.beginPath();
      ctx.moveTo(px, y + h);
      ctx.lineTo(px, y + h + 5);
      ctx.stroke();
      ctx.textAlign = hour === 0 ? 'left' : hour === 24 ? 'right' : 'center';
      ctx.fillText(formatHourLabel(hour), px, y + h + 8);
    }

    // Y 刻度
    const ticks = 4;
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    for (let i = 0; i <= ticks; i += 1) {
      const value = lerp(this.yMin, this.yMax, i / ticks);
      const py = this.yAtValue(value);
      ctx.beginPath();
      ctx.moveTo(x - 5, py);
      ctx.lineTo(x, py);
      ctx.stroke();
      const label =
        this.variable === 'precipitation'
          ? value.toFixed(value >= 10 ? 0 : 1)
          : value.toFixed(0);
      ctx.fillText(label, x - 8, py);
    }
    ctx.restore();
  }

  private hourExtremes(): { min: number; max: number }[] {
    const data = this.activeData();
    const out: { min: number; max: number }[] = [];
    for (let h = 0; h < HOURS; h += 1) {
      let min = Infinity;
      let max = -Infinity;
      for (const series of data.series) {
        const v = series.values[h];
        if (typeof v !== 'number' || !Number.isFinite(v)) continue;
        min = Math.min(min, v);
        max = Math.max(max, v);
      }
      if (!Number.isFinite(min) || !Number.isFinite(max)) {
        min = 0;
        max = 0;
      }
      out.push({ min, max });
    }
    return out;
  }

  private drawEnvelope(): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const extremes = this.hourExtremes();
    if (extremes.length < 2) return;

    ctx.save();
    ctx.beginPath();
    for (let h = 0; h < HOURS; h += 1) {
      const px = this.xAtHour(h);
      const py = this.yAtValue(extremes[h].max);
      if (h === 0) ctx.moveTo(px, py);
      else ctx.lineTo(px, py);
    }
    for (let h = HOURS - 1; h >= 0; h -= 1) {
      const px = this.xAtHour(h);
      const py = this.yAtValue(extremes[h].min);
      ctx.lineTo(px, py);
    }
    ctx.closePath();
    ctx.fillStyle = ENVELOPE_FILL;
    ctx.fill();
    ctx.restore();
  }

  private drawTempLines(): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const data = this.activeData();

    ctx.save();
    ctx.lineWidth = 2;
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';

    for (const meta of MODEL_META) {
      if (!this.visible[meta.key]) continue;
      const series = data.series.find((s) => s.model === meta.key);
      if (!series) continue;
      ctx.strokeStyle = meta.color;
      ctx.beginPath();
      for (let h = 0; h < HOURS; h += 1) {
        const px = this.xAtHour(h);
        const py = this.yAtValue(series.values[h] ?? 0);
        if (h === 0) ctx.moveTo(px, py);
        else ctx.lineTo(px, py);
      }
      ctx.stroke();
    }
    ctx.restore();
  }

  private drawPrecipBars(): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const data = this.activeData();
    const visibleMetas = MODEL_META.filter((m) => this.visible[m.key]);
    if (visibleMetas.length === 0) return;

    const groupWidth = this.plot.w / (HOURS - 1);
    const barGap = 1;
    const barW = Math.max(1.5, Math.min(4, (groupWidth * 0.55) / visibleMetas.length - barGap));
    const totalW = visibleMetas.length * barW + (visibleMetas.length - 1) * barGap;
    const baseY = this.yAtValue(0);

    ctx.save();
    for (let h = 0; h < HOURS; h += 1) {
      const cx = this.xAtHour(h);
      let bx = cx - totalW / 2;
      for (const meta of visibleMetas) {
        const series = data.series.find((s) => s.model === meta.key);
        const value = Math.max(0, series?.values[h] ?? 0);
        const top = this.yAtValue(value);
        const height = Math.max(0, baseY - top);
        ctx.fillStyle = meta.color;
        ctx.globalAlpha = 0.85;
        ctx.fillRect(bx, top, barW, height);
        bx += barW + barGap;
      }
    }
    ctx.restore();
  }

  private drawTimeBead(): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const px = this.xAtMinutes(this.timeMinutes);
    const data = this.activeData();

    ctx.save();
    ctx.strokeStyle = 'rgba(255,255,255,0.28)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(px, this.plot.y);
    ctx.lineTo(px, this.plot.y + this.plot.h);
    ctx.stroke();

    // 在可见模式均值高度放珠
    const vals: number[] = [];
    for (const meta of MODEL_META) {
      if (!this.visible[meta.key]) continue;
      const series = data.series.find((s) => s.model === meta.key);
      if (series) vals.push(sampleAtMinutes(series.values, this.timeMinutes));
    }
    const beadY =
      vals.length > 0
        ? this.yAtValue(vals.reduce((a, b) => a + b, 0) / vals.length)
        : this.plot.y + this.plot.h / 2;

    ctx.fillStyle = BEAD_COLOR;
    ctx.beginPath();
    ctx.arc(px, beadY, 3.5, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = 'rgba(8,14,22,0.55)';
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.restore();
  }
}
