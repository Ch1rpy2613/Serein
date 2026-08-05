/**
 * SoundingLayer —— 分析模式旗舰场景「探空」。
 *
 * Canvas2D Skew-T / T-lnP：五族底图 + T/Td 廓线 + 风羽 + 气块路径 + 指数盒。
 * 绘制正确性优先；仅分析模式经由场景切换器进入。
 */

import type { AtmosProfile, DayData, ProfilePoint, WeatherLayer } from '../../contracts';
import { fetchProfile } from '../../data/openmeteo';
import { getPrefersReducedMotion, subscribeReducedMotion } from '../../motion';
import {
  computeSoundingIndices,
  dewPointFromRh,
  dryAdiabatTemperatureC,
  moistAdiabatTemperatureC,
  parcelPath,
  temperatureAtMixingRatio,
  type ParcelPoint,
  type SoundingIndices,
} from './indices';

type Quality = 'low' | 'medium' | 'high';

const DAY_MINUTES = 1440;
/** ≈300ms 指数缓动时间常数 */
const DATA_EASE_TAU = 0.1;
const P_TOP = 100;
const P_BOTTOM = 1050;
const T_MIN = -80;
const T_MAX = 40;
const ACCENT_FALLBACK = '#7ec8ff';
const TEMP_COLOR = '#ff5a4e';
const DEW_COLOR = '#4ade80';

const ISOBAR_LABELS = new Set([1000, 850, 700, 500, 300, 200]);
const MIXING_RATIOS_GKG = [0.4, 1, 2, 3, 5, 8, 12, 16, 20];
const DRY_THETAS = [240, 250, 260, 270, 280, 290, 300, 310, 320, 330, 340, 350];
const MOIST_THETAS = [0, 4, 8, 12, 16, 20, 24, 28];

const DPR_CAP: Record<Quality, number> = { high: 2, medium: 1.5, low: 1 };

const LAYER_CSS = `
.serein-sounding-layer {
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
.serein-sounding-canvas {
  position: absolute;
  inset: 0;
  z-index: 0;
  display: block;
  width: 100%;
  height: 100%;
}
.serein-sounding-indices {
  position: absolute;
  top: max(20px, env(safe-area-inset-top));
  left: max(16px, env(safe-area-inset-left));
  z-index: 2;
  margin: 0;
  padding: 8px 10px;
  border: 1px solid var(--line, rgba(255,255,255,.22));
  background: rgba(5, 7, 10, 0.55);
  color: var(--fg-1, rgba(255,255,255,.92));
  font-size: 11px;
  font-variant-numeric: tabular-nums;
  line-height: 1.45;
  letter-spacing: 0.02em;
  pointer-events: none;
  white-space: pre;
}
.serein-sounding-hover {
  position: absolute;
  z-index: 3;
  margin: 0;
  padding: 6px 8px;
  border: 1px solid var(--line, rgba(255,255,255,.22));
  background: rgba(5, 7, 10, 0.72);
  color: var(--fg-1, rgba(255,255,255,.92));
  font-size: 11px;
  font-variant-numeric: tabular-nums;
  line-height: 1.4;
  pointer-events: none;
  white-space: pre;
  opacity: 0;
  transform: translate(-50%, -120%);
  transition: opacity 80ms linear;
}
.serein-sounding-hover.is-visible {
  opacity: 1;
}
.serein-sounding-title {
  position: absolute;
  top: max(20px, env(safe-area-inset-top));
  right: max(16px, env(safe-area-inset-right));
  z-index: 2;
  margin: 0;
  color: var(--fg-2, rgba(255,255,255,.45));
  font-size: 11px;
  font-weight: 500;
  letter-spacing: 0.08em;
  pointer-events: none;
}
`;

const clamp = (x: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, x));
const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;

interface DisplayLevel {
  pressure: number;
  heightM: number;
  temperature: number;
  dewPoint: number;
  windSpeed: number;
  windDirection: number;
  rh: number;
}

interface PlotRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

interface HoverInfo {
  cssX: number;
  cssY: number;
  text: string;
}

function emptyIndices(): SoundingIndices {
  return { cape: 0, cin: 0, lclM: 0, li: 0, pw: 0 };
}

function formatIndices(ix: SoundingIndices): string {
  const cin = ix.cin === 0 ? '0.0' : ix.cin.toFixed(1);
  return [
    `CAPE  ${ix.cape.toFixed(1)} J/kg`,
    `CIN   ${cin} J/kg`,
    `LCL   ${ix.lclM.toFixed(1)} m`,
    `LI    ${ix.li.toFixed(1)} °C`,
    `PW    ${ix.pw.toFixed(1)} mm`,
  ].join('\n');
}

export class SoundingLayer implements WeatherLayer {
  readonly id = 'sounding';
  readonly name = '探空';
  readonly preferredSkyDim = 0.9;

  private container: HTMLElement | null = null;
  private root: HTMLElement | null = null;
  private canvas: HTMLCanvasElement | null = null;
  private ctx: CanvasRenderingContext2D | null = null;
  private indicesEl: HTMLElement | null = null;
  private hoverEl: HTMLElement | null = null;
  private styleEl: HTMLStyleElement | null = null;

  private abortController: AbortController | null = null;
  private resizeObserver: ResizeObserver | null = null;
  private raf = 0;
  private lastTs = 0;
  private quality: Quality = 'high';
  private reducedMotion = getPrefersReducedMotion();
  private unsubscribeReducedMotion: (() => void) | null = null;

  private data: DayData | null = null;
  private timeMinutes = 480;
  private profileHour = -1;
  private profileFetchGen = 0;

  private levelsCur: DisplayLevel[] = [];
  private levelsTgt: DisplayLevel[] = [];
  private parcelCur: ParcelPoint[] = [];
  private parcelTgt: ParcelPoint[] = [];
  private indicesCur = emptyIndices();
  private indicesTgt = emptyIndices();

  private accent = ACCENT_FALLBACK;
  private fg2 = 'rgba(255,255,255,0.45)';
  private line = 'rgba(255,255,255,0.22)';
  private cssW = 1;
  private cssH = 1;
  private dpr = 1;
  private plot: PlotRect = { x: 0, y: 0, w: 1, h: 1 };
  private windX = 0;

  private hover: HoverInfo | null = null;
  private pointerInside = false;

  mount(container: HTMLElement): void {
    if (this.root) return;
    this.container = container;
    this.abortController = new AbortController();

    const style = document.createElement('style');
    style.textContent = LAYER_CSS;
    document.head.appendChild(style);
    this.styleEl = style;

    const root = document.createElement('div');
    root.className = 'serein-sounding-layer';
    root.setAttribute('role', 'img');
    root.setAttribute('aria-label', 'Skew-T 探空图');

    const canvas = document.createElement('canvas');
    canvas.className = 'serein-sounding-canvas';
    root.appendChild(canvas);

    const indices = document.createElement('pre');
    indices.className = 'serein-sounding-indices';
    indices.textContent = formatIndices(emptyIndices());
    root.appendChild(indices);

    const title = document.createElement('p');
    title.className = 'serein-sounding-title';
    title.textContent = '探空 · Skew-T';
    root.appendChild(title);

    const hover = document.createElement('pre');
    hover.className = 'serein-sounding-hover';
    root.appendChild(hover);

    container.appendChild(root);
    this.root = root;
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d', { alpha: false });
    this.indicesEl = indices;
    this.hoverEl = hover;

    this.readTokens();

    const signal = this.abortController.signal;
    root.addEventListener('pointermove', this.onPointerMove, { signal });
    root.addEventListener('pointerleave', this.onPointerLeave, { signal });
    root.addEventListener('pointerdown', this.onPointerMove, { signal });
    document.addEventListener('visibilitychange', this.onVisibility, { signal });

    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(container);
    this.unsubscribeReducedMotion = subscribeReducedMotion((reduced) => {
      this.reducedMotion = reduced;
    });

    this.resize();
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
    this.indicesEl = null;
    this.hoverEl = null;
    this.container = null;
    this.levelsCur = [];
    this.levelsTgt = [];
    this.parcelCur = [];
    this.parcelTgt = [];
    this.hover = null;
    this.pointerInside = false;
  }

  setTime(minutes: number): void {
    this.timeMinutes = clamp(Number.isFinite(minutes) ? minutes : 0, 0, DAY_MINUTES);
    const hour = Math.min(24, Math.max(0, Math.round(this.timeMinutes / 60)));
    if (hour !== this.profileHour) {
      void this.loadProfile(this.timeMinutes, false);
    }
  }

  setData(data: DayData): void {
    const prev = this.data?.date;
    this.data = data;
    if (data.date !== prev) void this.loadProfile(this.timeMinutes, true);
  }

  setQuality(q: Quality): void {
    if (q === this.quality) return;
    this.quality = q;
    this.resize();
  }

  // ------------------------------------------------------------------ 数据

  private async loadProfile(minutes: number, immediate: boolean): Promise<void> {
    const hour = Math.min(24, Math.max(0, Math.round(minutes / 60)));
    const gen = ++this.profileFetchGen;
    this.profileHour = hour;
    try {
      const date = this.data?.date;
      const profile = await fetchProfile(minutes, date);
      if (gen !== this.profileFetchGen) return;
      this.applyProfile(profile, immediate);
    } catch (error) {
      console.warn('[SoundingLayer] fetchProfile 失败', error);
    }
  }

  private applyProfile(profile: AtmosProfile, immediate: boolean): void {
    const next = profile.levels.map((level) => {
      const dewPoint = Math.min(
        dewPointFromRh(level.temperature, level.rh),
        level.temperature,
      );
      return {
        pressure: level.pressure,
        heightM: level.heightM,
        temperature: level.temperature,
        dewPoint,
        windSpeed: level.windSpeed,
        windDirection: level.windDirection,
        rh: level.rh,
      };
    });
    next.sort((a, b) => a.heightM - b.heightM);

    const points: ProfilePoint[] = next.map((l) => ({
      pressure: l.pressure,
      heightM: l.heightM,
      temperature: l.temperature,
      windSpeed: l.windSpeed,
      windDirection: l.windDirection,
      rh: l.rh,
    }));

    this.levelsTgt = next;
    this.parcelTgt = parcelPath(points);
    this.indicesTgt = computeSoundingIndices(points);

    if (immediate || this.levelsCur.length !== next.length) {
      this.levelsCur = next.map((l) => ({ ...l }));
      this.parcelCur = this.parcelTgt.map((p) => ({ ...p }));
      this.indicesCur = { ...this.indicesTgt };
      this.syncIndicesHud();
    }
  }

  private readTokens(): void {
    const root = document.documentElement;
    const accent = getComputedStyle(root).getPropertyValue('--accent').trim();
    const fg2 = getComputedStyle(root).getPropertyValue('--fg-2').trim();
    const line = getComputedStyle(root).getPropertyValue('--line').trim();
    if (accent) this.accent = accent;
    else this.accent = ACCENT_FALLBACK;
    if (fg2) this.fg2 = fg2;
    if (line) this.line = line;
  }

  // ------------------------------------------------------------------ 坐标

  /** 气压 → 规范化 y（0=底 1050hPa，1=顶 100hPa） */
  private pToYNorm(p: number): number {
    const lnP = Math.log(clamp(p, P_TOP, P_BOTTOM));
    const lnBot = Math.log(P_BOTTOM);
    const lnTop = Math.log(P_TOP);
    return (lnP - lnBot) / (lnTop - lnBot);
  }

  /**
   * Skew-T：等温线 45°。
   * screenX = plot.x + (T − T_min)·sx + yNorm·plot.h
   * （dy 与 dT·sx 等量时斜率为 1 → 45°）
   */
  private tempScaleX(): number {
    // 预留右侧风羽带与左侧边距后，使 −80…40 落在图内
    const usable = this.plot.w - this.plot.h * 0.15;
    return usable / (T_MAX - T_MIN);
  }

  private toXY(tC: number, pHpa: number): { x: number; y: number } {
    const yNorm = this.pToYNorm(pHpa);
    const y = this.plot.y + this.plot.h * (1 - yNorm);
    const skew = this.plot.h * yNorm;
    const x = this.plot.x + (tC - T_MIN) * this.tempScaleX() + skew;
    return { x, y };
  }

  /** 悬停：由屏幕 y 反查气压，再找最近层 */
  private pressureAtCssY(cssY: number): number {
    const yNorm = 1 - (cssY - this.plot.y) / Math.max(this.plot.h, 1);
    const lnBot = Math.log(P_BOTTOM);
    const lnTop = Math.log(P_TOP);
    return Math.exp(lnBot + clamp(yNorm, 0, 1) * (lnTop - lnBot));
  }

  // ------------------------------------------------------------------ 循环

  private start(): void {
    if (this.raf) return;
    this.lastTs = performance.now();
    const tick = (ts: number) => {
      this.raf = requestAnimationFrame(tick);
      if (document.hidden) return;
      const dt = Math.min(0.05, Math.max(0, (ts - this.lastTs) / 1000));
      this.lastTs = ts;
      this.ease(dt);
      this.draw();
      this.syncHoverHud();
    };
    this.raf = requestAnimationFrame(tick);
  }

  private stop(): void {
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
  }

  private onVisibility = (): void => {
    if (!document.hidden) this.lastTs = performance.now();
  };

  private ease(dt: number): void {
    const k = this.reducedMotion ? 1 : 1 - Math.exp(-dt / DATA_EASE_TAU);
    const n = this.levelsTgt.length;
    if (n === 0) return;

    if (this.levelsCur.length !== n) {
      this.levelsCur = this.levelsTgt.map((l) => ({ ...l }));
      this.parcelCur = this.parcelTgt.map((p) => ({ ...p }));
      this.indicesCur = { ...this.indicesTgt };
      this.syncIndicesHud();
      return;
    }

    for (let i = 0; i < n; i += 1) {
      const cur = this.levelsCur[i];
      const tgt = this.levelsTgt[i];
      cur.pressure = lerp(cur.pressure, tgt.pressure, k);
      cur.heightM = lerp(cur.heightM, tgt.heightM, k);
      cur.temperature = lerp(cur.temperature, tgt.temperature, k);
      cur.dewPoint = lerp(cur.dewPoint, tgt.dewPoint, k);
      cur.rh = lerp(cur.rh, tgt.rh, k);
      cur.windSpeed = lerp(cur.windSpeed, tgt.windSpeed, k);
      let d = tgt.windDirection - cur.windDirection;
      if (d > 180) d -= 360;
      if (d < -180) d += 360;
      cur.windDirection = (cur.windDirection + d * k + 360) % 360;
    }

    // 气块路径按索引缓动（长度变化时直接跳）
    if (this.parcelCur.length === this.parcelTgt.length) {
      for (let i = 0; i < this.parcelCur.length; i += 1) {
        const c = this.parcelCur[i];
        const t = this.parcelTgt[i];
        c.pressure = lerp(c.pressure, t.pressure, k);
        c.temperature = lerp(c.temperature, t.temperature, k);
        c.heightM = lerp(c.heightM, t.heightM, k);
        c.stage = t.stage;
      }
    } else {
      this.parcelCur = this.parcelTgt.map((p) => ({ ...p }));
    }

    const ic = this.indicesCur;
    const it = this.indicesTgt;
    ic.cape = lerp(ic.cape, it.cape, k);
    ic.cin = lerp(ic.cin, it.cin, k);
    ic.lclM = lerp(ic.lclM, it.lclM, k);
    ic.li = lerp(ic.li, it.li, k);
    ic.pw = lerp(ic.pw, it.pw, k);
    this.syncIndicesHud();
  }

  private syncIndicesHud(): void {
    if (!this.indicesEl) return;
    // 显示缓动中的一位小数，避免跳变感
    const shown: SoundingIndices = {
      cape: Math.round(this.indicesCur.cape * 10) / 10,
      cin: Math.round(this.indicesCur.cin * 10) / 10,
      lclM: Math.round(this.indicesCur.lclM * 10) / 10,
      li: Math.round(this.indicesCur.li * 10) / 10,
      pw: Math.round(this.indicesCur.pw * 10) / 10,
    };
    this.indicesEl.textContent = formatIndices(shown);
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
    const padR = 56;
    const padT = 28;
    const padB = 36;
    this.plot = {
      x: padL,
      y: padT,
      w: Math.max(40, this.cssW - padL - padR),
      h: Math.max(40, this.cssH - padT - padB),
    };
    this.windX = this.plot.x + this.plot.w + 18;
    this.readTokens();
  }

  // ------------------------------------------------------------------ 交互

  private onPointerMove = (event: PointerEvent): void => {
    if (!this.root) return;
    const rect = this.root.getBoundingClientRect();
    const cssX = event.clientX - rect.left;
    const cssY = event.clientY - rect.top;
    this.pointerInside = true;
    this.updateHover(cssX, cssY);
  };

  private onPointerLeave = (): void => {
    this.pointerInside = false;
    this.hover = null;
  };

  private updateHover(cssX: number, cssY: number): void {
    if (
      cssX < this.plot.x ||
      cssX > this.plot.x + this.plot.w + 40 ||
      cssY < this.plot.y ||
      cssY > this.plot.y + this.plot.h
    ) {
      this.hover = null;
      return;
    }
    const levels = this.levelsCur;
    if (levels.length === 0) {
      this.hover = null;
      return;
    }
    const p = this.pressureAtCssY(cssY);
    let best = levels[0];
    let bestDist = Math.abs(Math.log(best.pressure) - Math.log(p));
    for (let i = 1; i < levels.length; i += 1) {
      const d = Math.abs(Math.log(levels[i].pressure) - Math.log(p));
      if (d < bestDist) {
        bestDist = d;
        best = levels[i];
      }
    }
    const knots = best.windSpeed * 1.94384;
    const text = [
      `${best.pressure.toFixed(0)} hPa · ${Math.round(best.heightM)} m`,
      `T   ${best.temperature.toFixed(1)} °C`,
      `Td  ${best.dewPoint.toFixed(1)} °C`,
      `风  ${best.windDirection.toFixed(0)}° / ${knots.toFixed(0)} kt`,
    ].join('\n');
    const anchor = this.toXY(best.temperature, best.pressure);
    this.hover = { cssX: anchor.x, cssY: anchor.y, text };
  }

  private syncHoverHud(): void {
    const el = this.hoverEl;
    if (!el) return;
    if (!this.hover || !this.pointerInside) {
      el.classList.remove('is-visible');
      return;
    }
    el.textContent = this.hover.text;
    el.style.left = `${this.hover.cssX}px`;
    el.style.top = `${this.hover.cssY}px`;
    el.classList.add('is-visible');
  }

  // ------------------------------------------------------------------ 绘制

  private draw(): void {
    const ctx = this.ctx;
    const canvas = this.canvas;
    if (!ctx || !canvas) return;

    const dpr = this.dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = '#05070a';
    ctx.fillRect(0, 0, this.cssW, this.cssH);

    this.drawBackground(ctx);
    this.drawProfiles(ctx);
    this.drawParcel(ctx);
    this.drawWindBarbs(ctx);
    this.drawLegend(ctx);
  }

  private strokeIsoFamily(
    ctx: CanvasRenderingContext2D,
    color: string,
    width: number,
    dash: number[] | null,
    alpha: number,
    sample: (p: number) => number | null,
  ): void {
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.strokeStyle = color;
    ctx.lineWidth = width;
    if (dash) ctx.setLineDash(dash);
    else ctx.setLineDash([]);
    ctx.beginPath();
    let started = false;
    const steps = 64;
    for (let i = 0; i <= steps; i += 1) {
      const yNorm = i / steps;
      const lnP = Math.log(P_BOTTOM) + yNorm * (Math.log(P_TOP) - Math.log(P_BOTTOM));
      const p = Math.exp(lnP);
      const t = sample(p);
      if (t === null || !Number.isFinite(t)) {
        started = false;
        continue;
      }
      const { x, y } = this.toXY(t, p);
      if (
        x < this.plot.x - 20 ||
        x > this.plot.x + this.plot.w + 40 ||
        y < this.plot.y - 4 ||
        y > this.plot.y + this.plot.h + 4
      ) {
        started = false;
        continue;
      }
      if (!started) {
        ctx.moveTo(x, y);
        started = true;
      } else {
        ctx.lineTo(x, y);
      }
    }
    ctx.stroke();
    ctx.restore();
  }

  private drawBackground(ctx: CanvasRenderingContext2D): void {
    const { x, y, w, h } = this.plot;

    // 裁剪绘图区（略放宽以容纳斜线）
    ctx.save();
    ctx.beginPath();
    ctx.rect(x - 2, y - 2, w + 44, h + 4);
    ctx.clip();

    // 1) 等压线（水平，对数间距）
    const isobars: number[] = [];
    for (let p = 1050; p >= 100; p -= 50) isobars.push(p);
    // 确保标注层在列
    for (const p of ISOBAR_LABELS) {
      if (!isobars.includes(p)) isobars.push(p);
    }
    isobars.sort((a, b) => b - a);

    ctx.save();
    ctx.strokeStyle = this.line;
    ctx.fillStyle = this.fg2;
    ctx.font = '11px -apple-system, "SF Pro", Inter, "PingFang SC", sans-serif';
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    for (const p of isobars) {
      if (p < P_TOP || p > P_BOTTOM) continue;
      const yNorm = this.pToYNorm(p);
      const py = y + h * (1 - yNorm);
      const major = ISOBAR_LABELS.has(p);
      ctx.globalAlpha = major ? 0.85 : 0.35;
      ctx.lineWidth = major ? 1 : 0.6;
      ctx.beginPath();
      ctx.moveTo(x, py);
      ctx.lineTo(x + w, py);
      ctx.stroke();
      if (major) {
        ctx.globalAlpha = 1;
        ctx.fillText(String(p), x - 6, py);
      }
    }
    ctx.restore();

    // 2) 等温线（45°，每 10°C）
    ctx.save();
    ctx.font = '11px -apple-system, "SF Pro", Inter, "PingFang SC", sans-serif';
    ctx.fillStyle = this.fg2;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    for (let t = T_MIN; t <= T_MAX; t += 10) {
      const zero = t === 0;
      this.strokeIsoFamily(
        ctx,
        zero ? 'rgba(255,255,255,0.55)' : this.line,
        zero ? 1.25 : 0.7,
        null,
        zero ? 0.9 : 0.45,
        () => t,
      );
      // 底边标注
      const { x: tx } = this.toXY(t, P_BOTTOM);
      if (tx >= x && tx <= x + w) {
        ctx.globalAlpha = 1;
        ctx.fillText(`${t}`, tx, y + h + 6);
      }
    }
    ctx.restore();

    // 3) 干绝热线（位温 K）
    for (const theta of DRY_THETAS) {
      this.strokeIsoFamily(ctx, this.fg2, 0.7, [3, 3], 0.32, (p) =>
        dryAdiabatTemperatureC(theta, p),
      );
    }

    // 4) 湿绝热线（从 1000 hPa、θw≈tw 出发）
    for (const tw of MOIST_THETAS) {
      this.strokeIsoFamily(ctx, this.fg2, 0.65, [2, 4], 0.28, (p) =>
        moistAdiabatTemperatureC(tw, 1000, p),
      );
    }

    // 5) 等饱和混合比线
    for (const w of MIXING_RATIOS_GKG) {
      this.strokeIsoFamily(ctx, this.fg2, 0.6, [1, 3], 0.35, (p) =>
        temperatureAtMixingRatio(w, p),
      );
    }

    ctx.restore();

    // 图框
    ctx.save();
    ctx.strokeStyle = this.line;
    ctx.lineWidth = 1;
    ctx.globalAlpha = 0.8;
    ctx.strokeRect(x, y, w, h);
    ctx.restore();

    // 轴标签
    ctx.save();
    ctx.fillStyle = this.fg2;
    ctx.font = '11px -apple-system, "SF Pro", Inter, "PingFang SC", sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('°C', x + w / 2, this.cssH - 8);
    ctx.save();
    ctx.translate(12, y + h / 2);
    ctx.rotate(-Math.PI / 2);
    ctx.fillText('hPa', 0, 0);
    ctx.restore();
    ctx.restore();
  }

  private drawProfiles(ctx: CanvasRenderingContext2D): void {
    const levels = this.levelsCur;
    if (levels.length < 2) return;

    const drawLine = (color: string, pick: (l: DisplayLevel) => number) => {
      ctx.save();
      ctx.strokeStyle = color;
      ctx.lineWidth = 2;
      ctx.lineJoin = 'round';
      ctx.lineCap = 'round';
      ctx.beginPath();
      for (let i = 0; i < levels.length; i += 1) {
        const l = levels[i];
        // 露点恒 ≤ 温度
        const t = pick(l);
        const { x, y } = this.toXY(t, l.pressure);
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.stroke();
      ctx.restore();
    };

    drawLine(DEW_COLOR, (l) => Math.min(l.dewPoint, l.temperature));
    drawLine(TEMP_COLOR, (l) => l.temperature);
  }

  private drawParcel(ctx: CanvasRenderingContext2D): void {
    const path = this.parcelCur;
    if (path.length < 2) return;
    ctx.save();
    ctx.strokeStyle = this.accent || ACCENT_FALLBACK;
    ctx.lineWidth = 1.5;
    ctx.setLineDash([5, 4]);
    ctx.globalAlpha = 0.95;
    ctx.beginPath();
    for (let i = 0; i < path.length; i += 1) {
      const p = path[i];
      const { x, y } = this.toXY(p.temperature, p.pressure);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();
    ctx.restore();
  }

  /** 气象风羽：杆指向风来向；短杠 5kt、长杠 10kt、三角 50kt */
  private drawWindBarbs(ctx: CanvasRenderingContext2D): void {
    const levels = this.levelsCur;
    const staff = 22;
    const spacing = 6;
    const x = this.windX;

    for (const level of levels) {
      if (level.pressure < P_TOP || level.pressure > P_BOTTOM) continue;
      const yNorm = this.pToYNorm(level.pressure);
      const y = this.plot.y + this.plot.h * (1 - yNorm);
      const knots = level.windSpeed * 1.94384;
      const fromRad = ((level.windDirection - 90) * Math.PI) / 180;
      const ux = Math.cos(fromRad);
      const uy = Math.sin(fromRad);
      const px = -uy;
      const py = ux;

      ctx.save();
      ctx.strokeStyle = 'rgba(255,255,255,0.72)';
      ctx.fillStyle = 'rgba(255,255,255,0.72)';
      ctx.lineWidth = 1.25;
      ctx.lineCap = 'round';

      const x0 = x;
      const y0 = y;
      const x1 = x0 + ux * staff;
      const y1 = y0 + uy * staff;
      ctx.beginPath();
      ctx.moveTo(x0, y0);
      ctx.lineTo(x1, y1);
      ctx.stroke();

      // 站点小圆
      ctx.beginPath();
      ctx.arc(x0, y0, 1.6, 0, Math.PI * 2);
      ctx.fill();

      let remain = Math.round(knots / 5) * 5;
      let cursor = 0;
      while (remain >= 50) {
        const bx = x1 - ux * cursor;
        const by = y1 - uy * cursor;
        ctx.beginPath();
        ctx.moveTo(bx, by);
        ctx.lineTo(bx - ux * spacing + px * 10, by - uy * spacing + py * 10);
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
        ctx.lineTo(bx + px * 11, by + py * 11);
        ctx.stroke();
        remain -= 10;
        cursor += spacing;
      }
      if (remain >= 5) {
        const bx = x1 - ux * cursor;
        const by = y1 - uy * cursor;
        ctx.beginPath();
        ctx.moveTo(bx, by);
        ctx.lineTo(bx + px * 6, by + py * 6);
        ctx.stroke();
      }
      ctx.restore();
    }
  }

  private drawLegend(ctx: CanvasRenderingContext2D): void {
    const lines = [
      { color: this.line, dash: null as number[] | null, label: '等压 / 等温', alpha: 0.7 },
      { color: this.fg2, dash: [3, 3], label: '干绝热', alpha: 0.55 },
      { color: this.fg2, dash: [2, 4], label: '湿绝热', alpha: 0.45 },
      { color: this.fg2, dash: [1, 3], label: '等饱和比', alpha: 0.5 },
      { color: TEMP_COLOR, dash: null, label: '温度 T', alpha: 1 },
      { color: DEW_COLOR, dash: null, label: '露点 Td', alpha: 1 },
      { color: this.accent, dash: [5, 4], label: '气块路径', alpha: 0.95 },
    ];

    const boxW = 92;
    const rowH = 12;
    const pad = 8;
    const boxH = pad * 2 + lines.length * rowH;
    const bx = this.plot.x + this.plot.w - boxW - 4;
    const by = this.plot.y + this.plot.h - boxH - 4;

    ctx.save();
    ctx.fillStyle = 'rgba(5,7,10,0.55)';
    ctx.strokeStyle = this.line;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.rect(bx, by, boxW, boxH);
    ctx.fill();
    ctx.stroke();

    ctx.font = '9px -apple-system, "SF Pro", Inter, "PingFang SC", sans-serif';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = this.fg2;

    for (let i = 0; i < lines.length; i += 1) {
      const row = lines[i];
      const cy = by + pad + rowH * i + rowH / 2;
      const lx0 = bx + 8;
      const lx1 = bx + 28;
      ctx.save();
      ctx.globalAlpha = row.alpha;
      ctx.strokeStyle = row.color;
      ctx.lineWidth = 1.5;
      if (row.dash) ctx.setLineDash(row.dash);
      else ctx.setLineDash([]);
      ctx.beginPath();
      ctx.moveTo(lx0, cy);
      ctx.lineTo(lx1, cy);
      ctx.stroke();
      ctx.restore();
      ctx.globalAlpha = 0.85;
      ctx.fillText(row.label, lx1 + 6, cy);
    }
    ctx.restore();
  }
}
