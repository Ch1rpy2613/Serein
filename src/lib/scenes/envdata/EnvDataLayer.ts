/**
 * EnvDataLayer —— 分析模式「环境」数据页。
 *
 * 非招牌场景：土壤 / 海洋 / 花粉卡片列表；无数据卡片整体不渲染。
 */
import type { DayData, WeatherLayer } from '../../contracts';

type Quality = 'low' | 'medium' | 'high';

const HOURS = 25;
const DAY_MINUTES = 1440;

const POLLEN_LABELS = [
  { key: 'alder' as const, label: '桤木花粉' },
  { key: 'birch' as const, label: '桦木花粉' },
  { key: 'grass' as const, label: '禾本花粉' },
  { key: 'mugwort' as const, label: '蒿属花粉' },
  { key: 'olive' as const, label: '橄榄花粉' },
  { key: 'ragweed' as const, label: '豚草花粉' },
];

const DPR_CAP: Record<Quality, number> = { high: 2, medium: 1.5, low: 1 };

const LAYER_CSS = `
.serein-envdata-layer {
  position: absolute;
  inset: 0;
  overflow: hidden;
  color: var(--fg-1, rgba(255,255,255,.92));
  font-family: -apple-system, "SF Pro", Inter, "PingFang SC", sans-serif;
  font-variant-numeric: tabular-nums;
  isolation: isolate;
  user-select: none;
  -webkit-user-select: none;
}
.serein-envdata-scroll {
  position: absolute;
  inset: 0;
  z-index: 1;
  overflow-x: hidden;
  overflow-y: auto;
  -webkit-overflow-scrolling: touch;
  overscroll-behavior: contain;
  padding:
    max(56px, calc(env(safe-area-inset-top) + 40px))
    max(16px, env(safe-area-inset-right))
    max(120px, calc(env(safe-area-inset-bottom) + 100px))
    max(16px, env(safe-area-inset-left));
  box-sizing: border-box;
  touch-action: pan-y;
}
.serein-envdata-title {
  margin: 0 0 14px;
  color: var(--fg-2, rgba(255,255,255,.45));
  font-size: 11px;
  font-weight: 520;
  letter-spacing: 0.1em;
}
.serein-envdata-list {
  display: grid;
  gap: 10px;
  margin: 0;
  padding: 0;
  list-style: none;
}
.serein-envdata-card {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(88px, 38%);
  gap: 10px 14px;
  align-items: center;
  margin: 0;
  padding: 12px 14px;
  border: 0;
  border-radius: 0;
  background: transparent;
  box-shadow: none;
}
.serein-envdata-meta {
  display: grid;
  gap: 4px;
  min-width: 0;
}
.serein-envdata-label {
  margin: 0;
  color: var(--fg-2, rgba(255,255,255,.45));
  font-size: 11px;
  font-weight: 500;
  letter-spacing: 0.04em;
}
.serein-envdata-value {
  margin: 0;
  color: var(--fg-1, rgba(255,255,255,.92));
  font-size: 28px;
  font-weight: 380;
  letter-spacing: -0.03em;
  line-height: 1.05;
  font-variant-numeric: tabular-nums;
}
.serein-envdata-value.is-highlight {
  color: var(--accent, #7ec8ff);
}
.serein-envdata-value small {
  margin-left: 6px;
  color: var(--fg-2, rgba(255,255,255,.45));
  font-size: 12px;
  font-weight: 480;
  letter-spacing: 0.02em;
}
.serein-envdata-sub {
  margin: 0;
  color: var(--fg-2, rgba(255,255,255,.45));
  font-size: 11px;
  font-variant-numeric: tabular-nums;
}
.serein-envdata-spark {
  display: block;
  width: 100%;
  height: 44px;
  pointer-events: none;
}
.serein-envdata-empty {
  margin: 48px 0 0;
  color: var(--fg-2, rgba(255,255,255,.45));
  font-size: 13px;
  letter-spacing: 0.04em;
  text-align: center;
}
`;

interface CardDef {
  id: string;
  label: string;
  valueText: string;
  subText?: string;
  series: number[][];
  highlight?: boolean;
  hideSpark?: boolean;
}

function isWinterMonth(dateIso: string): boolean {
  const month = Number(dateIso.slice(5, 7));
  return month === 12 || month === 1 || month === 2;
}

const clamp = (x: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, x));
const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;

function sampleAtMinutes(values: number[], minutes: number): number {
  if (!values.length) return 0;
  const t = clamp(minutes, 0, DAY_MINUTES) / 60;
  const i0 = Math.min(HOURS - 1, Math.floor(t));
  const i1 = Math.min(HOURS - 1, i0 + 1);
  const f = t - i0;
  return lerp(values[i0] ?? 0, values[i1] ?? values[i0] ?? 0, f);
}

function formatTemp(v: number): string {
  return `${v.toFixed(1)}`;
}

function formatPct(v: number): string {
  return `${Math.round(v)}`;
}

function formatWave(v: number): string {
  return v >= 10 ? v.toFixed(0) : v.toFixed(2);
}

function formatPollen(v: number): string {
  return v >= 10 ? v.toFixed(0) : v.toFixed(1);
}

export class EnvDataLayer implements WeatherLayer {
  readonly id = 'envdata';
  readonly name = '环境';
  readonly preferredSkyDim = 0.8;

  private container: HTMLElement | null = null;
  private root: HTMLElement | null = null;
  private scrollEl: HTMLElement | null = null;
  private listEl: HTMLElement | null = null;
  private emptyEl: HTMLElement | null = null;
  private styleEl: HTMLStyleElement | null = null;

  private abortController: AbortController | null = null;
  private resizeObserver: ResizeObserver | null = null;
  private raf = 0;
  private quality: Quality = 'high';
  private data: DayData | null = null;
  private timeMinutes = 480;
  private accent = 'rgba(126,200,255,0.6)';
  private accentDim = 'rgba(126,200,255,0.28)';
  private cards: CardDef[] = [];
  private sparkCanvases = new Map<string, HTMLCanvasElement>();

  mount(container: HTMLElement): void {
    if (this.root) return;
    this.container = container;
    this.abortController = new AbortController();

    const style = document.createElement('style');
    style.textContent = LAYER_CSS;
    document.head.appendChild(style);
    this.styleEl = style;

    const root = document.createElement('div');
    root.className = 'serein-envdata-layer';
    root.setAttribute('role', 'region');
    root.setAttribute('aria-label', '环境数据');

    const scroll = document.createElement('div');
    scroll.className = 'serein-envdata-scroll';
    scroll.setAttribute('data-scene-swipe-ignore', '');

    const title = document.createElement('h2');
    title.className = 'serein-envdata-title';
    title.textContent = '环境';
    scroll.appendChild(title);

    const list = document.createElement('ul');
    list.className = 'serein-envdata-list';
    scroll.appendChild(list);

    const empty = document.createElement('p');
    empty.className = 'serein-envdata-empty';
    empty.hidden = true;
    empty.textContent = '当前城市暂无环境扩展数据';
    scroll.appendChild(empty);

    root.appendChild(scroll);
    container.appendChild(root);

    this.root = root;
    this.scrollEl = scroll;
    this.listEl = list;
    this.emptyEl = empty;

    this.readTokens();
    this.resizeObserver = new ResizeObserver(() => this.scheduleDraw());
    this.resizeObserver.observe(scroll);

    this.rebuildCards();
    this.scheduleDraw();
  }

  unmount(): void {
    this.abortController?.abort();
    this.abortController = null;
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    this.root?.remove();
    this.styleEl?.remove();
    this.root = null;
    this.scrollEl = null;
    this.listEl = null;
    this.emptyEl = null;
    this.styleEl = null;
    this.container = null;
    this.sparkCanvases.clear();
    this.cards = [];
  }

  setTime(minutes: number): void {
    this.timeMinutes = clamp(minutes, 0, DAY_MINUTES);
    this.updateReadouts();
    this.scheduleDraw();
  }

  setData(data: DayData): void {
    this.data = data;
    this.rebuildCards();
    this.scheduleDraw();
  }

  setQuality(q: 'low' | 'medium' | 'high'): void {
    this.quality = q;
    this.scheduleDraw();
  }

  setMode(_mode: 'feel' | 'analysis'): void {
    // 本场景仅分析模式入口；无额外密度叠加
  }

  private readTokens(): void {
    if (typeof getComputedStyle === 'undefined' || !this.root) return;
    const styles = getComputedStyle(this.root);
    const accent = styles.getPropertyValue('--accent').trim() || '#7ec8ff';
    this.accent = this.withAlpha(accent, 0.6);
    this.accentDim = this.withAlpha(accent, 0.28);
  }

  private rebuildCards(): void {
    this.cards = this.data ? this.buildCardDefs(this.data, this.timeMinutes) : [];
    this.renderList();
  }

  private renderList(): void {
    const list = this.listEl;
    const empty = this.emptyEl;
    if (!list || !empty) return;

    list.replaceChildren();
    this.sparkCanvases.clear();

    if (this.cards.length === 0) {
      empty.hidden = false;
      return;
    }
    empty.hidden = true;

    for (const card of this.cards) {
      const li = document.createElement('li');
      li.className = 'serein-envdata-card';
      li.dataset.cardId = card.id;

      const meta = document.createElement('div');
      meta.className = 'serein-envdata-meta';

      const label = document.createElement('p');
      label.className = 'serein-envdata-label';
      label.textContent = card.label;

      const value = document.createElement('p');
      value.className = 'serein-envdata-value';
      value.dataset.role = 'value';
      value.textContent = card.valueText;
      value.classList.toggle('is-highlight', Boolean(card.highlight));

      meta.appendChild(label);
      meta.appendChild(value);
      if (card.subText) {
        const sub = document.createElement('p');
        sub.className = 'serein-envdata-sub';
        sub.dataset.role = 'sub';
        sub.textContent = card.subText;
        meta.appendChild(sub);
      }

      li.appendChild(meta);
      if (card.hideSpark) {
        li.style.gridTemplateColumns = '1fr';
      } else {
        const canvas = document.createElement('canvas');
        canvas.className = 'serein-envdata-spark';
        canvas.setAttribute('aria-hidden', 'true');
        li.appendChild(canvas);
        this.sparkCanvases.set(card.id, canvas);
      }
      list.appendChild(li);
    }
  }

  private updateReadouts(): void {
    if (!this.listEl || !this.data) return;
    // 重建数值文案，保留 DOM；避免每帧重建列表
    const next = this.buildCardDefs(this.data, this.timeMinutes);
    const ids = next.map((c) => c.id).join('|');
    const prevIds = this.cards.map((c) => c.id).join('|');
    if (ids !== prevIds) {
      this.cards = next;
      this.renderList();
      return;
    }
    for (const card of next) {
      const li = this.listEl.querySelector<HTMLElement>(`[data-card-id="${card.id}"]`);
      if (!li) continue;
      const value = li.querySelector<HTMLElement>('[data-role="value"]');
      if (value) {
        value.textContent = card.valueText;
        value.classList.toggle('is-highlight', Boolean(card.highlight));
      }
      const sub = li.querySelector<HTMLElement>('[data-role="sub"]');
      if (sub && card.subText) sub.textContent = card.subText;
    }
    this.cards = next;
  }

  private buildCardDefs(data: DayData, minutes: number): CardDef[] {
    const cards: CardDef[] = [];
    const soil = data.soil ?? null;
    if (soil) {
      const t0 = sampleAtMinutes(soil.temp0_1, minutes);
      const t1 = sampleAtMinutes(soil.temp1_3, minutes);
      cards.push({
        id: 'soil-temp',
        label: '土壤温度',
        valueText: `${formatTemp(t0)}°C`,
        subText: `0–1cm ${formatTemp(t0)}° · 1–3cm ${formatTemp(t1)}°`,
        series: [soil.temp0_1, soil.temp1_3],
      });
      const m0 = sampleAtMinutes(soil.moisture0_1, minutes);
      const m1 = sampleAtMinutes(soil.moisture1_3, minutes);
      cards.push({
        id: 'soil-moisture',
        label: '土壤湿度',
        valueText: `${formatPct(m0)}%`,
        subText: `0–1cm ${formatPct(m0)}% · 1–3cm ${formatPct(m1)}%`,
        series: [soil.moisture0_1, soil.moisture1_3],
      });
    }
    const marine = data.marine ?? null;
    if (marine) {
      cards.push({
        id: 'marine-sst',
        label: '海面温度',
        valueText: `${formatTemp(sampleAtMinutes(marine.sst, minutes))}°C`,
        series: [marine.sst],
      });
      cards.push({
        id: 'marine-wave',
        label: '浪高',
        valueText: `${formatWave(sampleAtMinutes(marine.waveHeight, minutes))} m`,
        series: [marine.waveHeight],
      });
    }
    const pollen = data.pollen ?? null;
    if (pollen) {
      for (const item of POLLEN_LABELS) {
        const series = pollen[item.key];
        cards.push({
          id: `pollen-${item.key}`,
          label: item.label,
          valueText: `${formatPollen(sampleAtMinutes(series, minutes))} 粒/m³`,
          series: [series],
        });
      }
    }

    const snow = sampleAtMinutes(data.snowDepth, minutes);
    const snowCm = Math.max(0, snow);
    cards.push({
      id: 'snow-depth',
      label: '积雪深度',
      valueText: `${snowCm.toFixed(1)} cm`,
      series: [data.snowDepth],
      highlight: isWinterMonth(data.date) && snowCm > 0,
    });

    if (data.kpIndex != null && Number.isFinite(data.kpIndex)) {
      cards.push({
        id: 'kp-index',
        label: 'KP 指数',
        valueText: data.kpIndex.toFixed(1),
        series: [],
        hideSpark: true,
      });
    }

    return cards;
  }

  private scheduleDraw(): void {
    if (this.raf) return;
    this.raf = requestAnimationFrame(() => {
      this.raf = 0;
      this.drawSparklines();
    });
  }

  private drawSparklines(): void {
    this.readTokens();
    const dpr = Math.min(window.devicePixelRatio || 1, DPR_CAP[this.quality]);
    for (const card of this.cards) {
      const canvas = this.sparkCanvases.get(card.id);
      if (!canvas) continue;
      const cssW = Math.max(1, canvas.clientWidth || 120);
      const cssH = Math.max(1, canvas.clientHeight || 44);
      const w = Math.round(cssW * dpr);
      const h = Math.round(cssH * dpr);
      if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w;
        canvas.height = h;
      }
      const ctx = canvas.getContext('2d');
      if (!ctx) continue;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, cssW, cssH);
      this.drawSpark(ctx, cssW, cssH, card.series);
    }
  }

  private drawSpark(
    ctx: CanvasRenderingContext2D,
    width: number,
    height: number,
    seriesList: number[][],
  ): void {
    const padX = 2;
    const padY = 4;
    const plotW = Math.max(1, width - padX * 2);
    const plotH = Math.max(1, height - padY * 2);

    let min = Number.POSITIVE_INFINITY;
    let max = Number.NEGATIVE_INFINITY;
    for (const series of seriesList) {
      for (const v of series) {
        if (!Number.isFinite(v)) continue;
        if (v < min) min = v;
        if (v > max) max = v;
      }
    }
    if (!Number.isFinite(min) || !Number.isFinite(max)) return;
    if (max - min < 1e-6) {
      min -= 1;
      max += 1;
    }

    const colors = [this.accent, this.accentDim];
    seriesList.forEach((series, index) => {
      if (series.length < 2) return;
      ctx.beginPath();
      for (let i = 0; i < series.length; i += 1) {
        const x = padX + (plotW * i) / (HOURS - 1);
        const y = padY + plotH * (1 - (series[i] - min) / (max - min));
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.strokeStyle = colors[Math.min(index, colors.length - 1)];
      ctx.lineWidth = 1;
      ctx.lineJoin = 'round';
      ctx.lineCap = 'round';
      ctx.stroke();
    });

    // 当前时刻竖线微提示
    const t = clamp(this.timeMinutes, 0, DAY_MINUTES) / DAY_MINUTES;
    const cx = padX + plotW * t;
    ctx.beginPath();
    ctx.moveTo(cx, padY);
    ctx.lineTo(cx, padY + plotH);
    ctx.strokeStyle = 'rgba(255,255,255,0.18)';
    ctx.lineWidth = 1;
    ctx.stroke();
  }

  private withAlpha(color: string, alpha: number): string {
    const hex = color.trim();
    if (hex.startsWith('#') && (hex.length === 7 || hex.length === 4)) {
      const full =
        hex.length === 4
          ? `#${hex[1]}${hex[1]}${hex[2]}${hex[2]}${hex[3]}${hex[3]}`
          : hex;
      const r = Number.parseInt(full.slice(1, 3), 16);
      const g = Number.parseInt(full.slice(3, 5), 16);
      const b = Number.parseInt(full.slice(5, 7), 16);
      return `rgba(${r},${g},${b},${alpha})`;
    }
    const match = hex.match(/rgba?\(([^)]+)\)/i);
    if (match) {
      const parts = match[1].split(',').map((p) => p.trim());
      return `rgba(${parts[0]},${parts[1]},${parts[2]},${alpha})`;
    }
    return `rgba(126,200,255,${alpha})`;
  }
}
