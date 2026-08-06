/**
 * MoonLayer —— 月相：真实 terminator + 观星指数。
 *
 * Canvas2D：程序化月面纹理（离屏缓存）+ 相位精确明暗界线；
 * 星野视差随月球方位；银河带随银心方位/高度；观星指数加权常量表。
 */
import { get } from 'svelte/store';
import type { DayData, WeatherLayer } from '../../contracts';
import {
  galacticCenterPosition,
  galacticWindow,
  moonIllumination,
  moonPhase,
  moonPosition,
  nextGalacticWindowDate,
  solarPosition,
} from '../../astro';
import { currentCity } from '../../stores/app';

type Quality = 'low' | 'medium' | 'high';
type Mode = 'feel' | 'analysis';

interface QualityConfig {
  dpr: number;
  starCount: number;
  mwParticles: number;
  glow: boolean;
}

interface Star {
  x: number;
  y: number;
  r: number;
  a: number;
}

/** 观星指数权重（常量表，合计 1） */
export const STARGATE_WEIGHTS = {
  cloud: 0.5,
  moon: 0.3,
  twilight: 0.2,
} as const;

/** 月相八分段名：以各相位点为中心（±1/16） */
export const PHASE_NAMES = [
  '新月',
  '娥眉月',
  '上弦',
  '盈凸',
  '满月',
  '亏凸',
  '下弦',
  '残月',
] as const;

const HOURS = 25;
const DAY_MINUTES = 1440;
const DEG = Math.PI / 180;
/** ≈300ms 达 95%：1 − e^(−t/τ) */
const EASE_TAU = 0.1;
const MOON_TEXTURE_SIZE = 256;
const NEXT_WINDOW_SEARCH_DAYS = 90;
const WEEK_DAYS = 7;
/** 月球纹理：模块级一次性生成，setData / remount 不得重建。 */
let sharedMoonTexture: HTMLCanvasElement | null = null;

const QUALITY: Record<Quality, QualityConfig> = {
  high: { dpr: 1.75, starCount: 220, mwParticles: 140, glow: true },
  medium: { dpr: 1.35, starCount: 140, mwParticles: 90, glow: true },
  low: { dpr: 1, starCount: 80, mwParticles: 48, glow: false },
};

const LAYER_CSS = `
.serein-moon-layer {
  position: absolute;
  inset: 0;
  overflow: hidden;
  color: var(--fg-1, rgba(255,255,255,.92));
  font-family: -apple-system, "SF Pro", Inter, "PingFang SC", sans-serif;
  font-variant-numeric: tabular-nums;
  isolation: isolate;
  pointer-events: none;
  user-select: none;
  -webkit-user-select: none;
}
.serein-moon-canvas {
  position: absolute;
  inset: 0;
  z-index: 0;
  display: block;
  width: 100%;
  height: 100%;
  pointer-events: none;
}
.serein-moon-header {
  position: absolute;
  top: max(28px, env(safe-area-inset-top));
  left: max(28px, env(safe-area-inset-left));
  z-index: 2;
  display: grid;
  gap: 10px;
  max-width: min(72vw, 22rem);
  text-shadow: 0 1px 18px rgba(5,7,10,.4);
  pointer-events: none;
  transition: opacity 400ms ease;
}
.serein-moon-heading {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 10px 12px;
}
.serein-moon-heading h2,
.serein-moon-phase,
.serein-moon-illum,
.serein-moon-readout,
.serein-moon-verdict,
.serein-moon-window {
  margin: 0;
}
.serein-moon-heading h2 {
  font-size: 17px;
  font-weight: 560;
  letter-spacing: .02em;
}
.serein-moon-phase {
  color: var(--fg-1, rgba(255,255,255,.92));
  font-size: 13px;
  font-weight: 520;
  letter-spacing: .06em;
}
.serein-moon-illum {
  color: var(--fg-2, rgba(255,255,255,.45));
  font-size: 11px;
  font-weight: 500;
  letter-spacing: .04em;
}
.serein-moon-current {
  display: flex;
  align-items: baseline;
  gap: 12px;
}
.serein-moon-readout {
  color: var(--fg-1, rgba(255,255,255,.92));
  font: inherit;
  font-size: 56px;
  font-weight: 340;
  letter-spacing: -.055em;
  line-height: .9;
  font-variant-numeric: tabular-nums;
}
.serein-moon-verdict {
  color: var(--fg-2, rgba(255,255,255,.45));
  font-size: 13px;
  font-weight: 520;
  letter-spacing: .04em;
}
.serein-moon-window {
  color: var(--fg-2, rgba(255,255,255,.45));
  font-size: 11px;
  font-weight: 500;
  letter-spacing: .04em;
}
.serein-moon-window[hidden] {
  display: none;
}
.serein-moon-kp {
  margin: 0;
  max-width: 16rem;
  padding: 7px 10px;
  border: 1px solid color-mix(in srgb, var(--accent, #7ec8ff) 28%, transparent);
  border-radius: 8px;
  background: color-mix(in srgb, var(--accent, #7ec8ff) 10%, rgba(5,7,10,.35));
  color: var(--fg-2, rgba(255,255,255,.45));
  font-size: 11px;
  font-weight: 500;
  font-variant-numeric: tabular-nums;
  letter-spacing: .02em;
  line-height: 1.35;
}
.serein-moon-kp[hidden] {
  display: none;
}
.serein-moon-layer[data-mode="analysis"] .serein-moon-header {
  opacity: 0.42;
}
.serein-moon-analysis {
  position: absolute;
  top: max(28px, env(safe-area-inset-top));
  right: max(28px, env(safe-area-inset-right));
  z-index: 2;
  display: grid;
  gap: 10px;
  min-width: 9.5rem;
  padding: 12px 14px;
  color: var(--fg-1, rgba(255,255,255,.92));
  text-shadow: 0 1px 14px rgba(5,7,10,.35);
  opacity: 0;
  visibility: hidden;
  pointer-events: none;
  transition: opacity 400ms ease, visibility 400ms step-end;
}
.serein-moon-layer[data-mode="analysis"] .serein-moon-analysis {
  opacity: 1;
  visibility: visible;
  transition: opacity 400ms ease, visibility 0ms step-start;
}
.serein-moon-analysis-label {
  margin: 0;
  color: var(--fg-2, rgba(255,255,255,.45));
  font-size: 9px;
  font-weight: 520;
  letter-spacing: .08em;
}
.serein-moon-analysis-value {
  margin: 0;
  font-size: 18px;
  font-weight: 420;
  letter-spacing: -.02em;
  font-variant-numeric: tabular-nums;
  line-height: 1.05;
}
.serein-moon-analysis-row {
  display: grid;
  gap: 2px;
}
.serein-moon-week {
  display: grid;
  gap: 6px;
  margin-top: 4px;
  padding-top: 10px;
  border-top: 1px solid rgba(255,255,255,.12);
}
.serein-moon-week-label {
  margin: 0;
  color: var(--fg-2, rgba(255,255,255,.45));
  font-size: 9px;
  font-weight: 520;
  letter-spacing: .08em;
}
.serein-moon-week-canvas {
  display: block;
  width: 100%;
  height: 52px;
}
@media (max-width: 420px) {
  .serein-moon-header {
    top: max(22px, env(safe-area-inset-top));
    left: max(18px, env(safe-area-inset-left));
    gap: 8px;
  }
  .serein-moon-readout {
    font-size: 46px;
  }
  .serein-moon-analysis {
    top: auto;
    right: max(18px, env(safe-area-inset-right));
    bottom: max(120px, calc(env(safe-area-inset-bottom) + 100px));
    min-width: min(14rem, calc(100vw - 36px));
    padding: 10px 12px;
  }
}
`;

export class MoonLayer implements WeatherLayer {
  readonly id = 'moon';
  readonly name = '月相';
  readonly preferredSkyDim = 0;

  private container: HTMLElement | null = null;
  private root: HTMLElement | null = null;
  private canvas: HTMLCanvasElement | null = null;
  private context: CanvasRenderingContext2D | null = null;

  private phaseEl: HTMLElement | null = null;
  private illumEl: HTMLElement | null = null;
  private readoutEl: HTMLOutputElement | null = null;
  private verdictEl: HTMLElement | null = null;
  private windowEl: HTMLElement | null = null;
  private kpEl: HTMLElement | null = null;
  private kpIndex: number | null = null;
  private analysisRise: HTMLElement | null = null;
  private analysisSet: HTMLElement | null = null;
  private analysisMw: HTMLElement | null = null;
  private weekCanvas: HTMLCanvasElement | null = null;
  private lastWeekKey = '';

  private abortController: AbortController | null = null;
  private resizeObserver: ResizeObserver | null = null;
  private raf = 0;
  private lastTimestamp = 0;
  private elapsed = 0;

  private quality: Quality = 'high';
  private mode: Mode = 'feel';
  private cssWidth = 1;
  private cssHeight = 1;
  private pixelRatio = 1;

  private date = todayIso();
  private cloudCover = new Float32Array(HOURS).fill(0.3);
  private moonrise: number | null = null;
  private moonset: number | null = null;
  private hasData = false;
  private timeMinutes = 480;

  /** 目标 / 当前缓动态 */
  private phaseTarget = 0;
  private phaseCurrent = 0;
  private illumTarget = 0;
  private illumCurrent = 0;
  private moonAzTarget = 180;
  private moonAzCurrent = 180;
  private moonElTarget = 45;
  private moonElCurrent = 45;
  private cloudTarget = 0.3;
  private cloudCurrent = 0.3;
  private nightTarget = 0;
  private nightCurrent = 0;
  private mwVisTarget = 0;
  private mwVisCurrent = 0;
  private gcAzTarget = 180;
  private gcAzCurrent = 180;
  private gcElTarget = 0;
  private gcElCurrent = 0;

  private moonTexture: HTMLCanvasElement | null = null;
  private stars: Star[] = [];
  private starsSeed = 0;

  private lastPhaseText = '';
  private lastIllumText = '';
  private lastIndexText = '';
  private lastVerdictText = '';
  private lastWindowText = '';
  private lastWindowHidden: boolean | null = null;
  private lastKpText = '';
  private lastKpHidden: boolean | null = null;
  private lastAnalysisRise = '';
  private lastAnalysisSet = '';
  private lastAnalysisMw = '';
  private cachedWindowLabel = '';
  private cachedWindowKey = '';
  /** date → 下一窗口 ISO 或 ''（已搜尽） */
  private nextWindowCache = new Map<string, string>();

  mount(container: HTMLElement): void {
    if (this.root) return;

    this.container = container;
    this.abortController = new AbortController();
    this.elapsed = 0;

    this.ensureMoonTexture();
    this.createDom();
    this.attachEvents();

    this.resizeObserver = new ResizeObserver(this.resize);
    this.resizeObserver.observe(container);
    this.resize();
    this.retargetAstro();
    this.snapAstro();
    this.updateHud(true);
    this.start();
  }

  unmount(): void {
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
    this.phaseEl = null;
    this.illumEl = null;
    this.readoutEl = null;
    this.verdictEl = null;
    this.kpEl = null;
    this.windowEl = null;
    this.analysisRise = null;
    this.analysisSet = null;
    this.analysisMw = null;
    this.weekCanvas = null;
    this.lastWeekKey = '';
    this.mode = 'feel';
    this.stars = [];
  }

  setTime(minutes: number): void {
    this.timeMinutes = clamp(Number.isFinite(minutes) ? minutes : 0, 0, DAY_MINUTES);
    this.retargetAstro();
    this.updateHud(false);
  }

  setData(data: DayData): void {
    this.date = typeof data.date === 'string' && data.date ? data.date : todayIso();
    copySeries(data.cloudCover, this.cloudCover, 0.3, 0, 1);
    this.kpIndex =
      data.kpIndex != null && Number.isFinite(data.kpIndex) ? data.kpIndex : null;

    if (data.astro) {
      this.moonrise =
        data.astro.moonrise === null || data.astro.moonrise === undefined
          ? null
          : clamp(data.astro.moonrise, 0, DAY_MINUTES);
      this.moonset =
        data.astro.moonset === null || data.astro.moonset === undefined
          ? null
          : clamp(data.astro.moonset, 0, DAY_MINUTES);
    }

    this.cachedWindowKey = '';
    this.lastWeekKey = '';
    // 日期大跨度切换时清掉过期的下一窗口缓存，避免内存涨
    if (this.nextWindowCache.size > 120) this.nextWindowCache.clear();
    const first = !this.hasData;
    this.hasData = true;
    this.retargetAstro();
    if (first) this.snapAstro();
    this.updateHud(true);
    if (this.mode === 'analysis') this.drawWeekPhases(true);
  }

  setMode(mode: Mode): void {
    if (this.mode === mode) return;
    this.mode = mode;
    if (this.root) this.root.dataset.mode = mode;
    this.updateHud(true);
    if (mode === 'analysis') this.drawWeekPhases(true);
  }

  setQuality(quality: Quality): void {
    if (quality === this.quality) return;
    this.quality = quality;
    this.root?.setAttribute('data-quality', quality);
    this.rebuildStars();
    this.resize();
    if (this.mode === 'analysis') this.drawWeekPhases(true);
  }

  private createDom(): void {
    const root = document.createElement('section');
    root.className = 'serein-moon-layer';
    root.setAttribute('aria-label', '月相与观星指数');
    root.setAttribute('data-quality', this.quality);
    root.dataset.mode = this.mode;

    root.innerHTML = `
      <style>${LAYER_CSS}</style>
      <canvas class="serein-moon-canvas" aria-hidden="true"></canvas>
      <header class="serein-moon-header">
        <div class="serein-moon-heading">
          <h2>月相</h2>
          <p class="serein-moon-phase">新月</p>
          <p class="serein-moon-illum">照亮 0%</p>
        </div>
        <div class="serein-moon-current">
          <output class="serein-moon-readout" aria-label="观星指数">0</output>
          <p class="serein-moon-verdict">不建议</p>
        </div>
        <p class="serein-moon-kp" hidden></p>
        <p class="serein-moon-window" hidden></p>
      </header>
      <aside class="serein-moon-analysis" aria-hidden="true">
        <div class="serein-moon-analysis-row">
          <p class="serein-moon-analysis-label">月出</p>
          <p class="serein-moon-analysis-value" data-analysis="rise">--:--</p>
        </div>
        <div class="serein-moon-analysis-row">
          <p class="serein-moon-analysis-label">月落</p>
          <p class="serein-moon-analysis-value" data-analysis="set">--:--</p>
        </div>
        <div class="serein-moon-analysis-row">
          <p class="serein-moon-analysis-label">银河可见度</p>
          <p class="serein-moon-analysis-value" data-analysis="mw">0%</p>
        </div>
        <div class="serein-moon-week">
          <p class="serein-moon-week-label">未来 7 天月相</p>
          <canvas class="serein-moon-week-canvas" aria-hidden="true"></canvas>
        </div>
      </aside>
    `;

    this.container?.appendChild(root);
    this.root = root;
    this.canvas = root.querySelector<HTMLCanvasElement>('.serein-moon-canvas');
    this.context = this.canvas?.getContext('2d') ?? null;
    this.phaseEl = root.querySelector<HTMLElement>('.serein-moon-phase');
    this.illumEl = root.querySelector<HTMLElement>('.serein-moon-illum');
    this.readoutEl = root.querySelector<HTMLOutputElement>('.serein-moon-readout');
    this.verdictEl = root.querySelector<HTMLElement>('.serein-moon-verdict');
    this.kpEl = root.querySelector<HTMLElement>('.serein-moon-kp');
    this.windowEl = root.querySelector<HTMLElement>('.serein-moon-window');
    this.analysisRise = root.querySelector<HTMLElement>('[data-analysis="rise"]');
    this.analysisSet = root.querySelector<HTMLElement>('[data-analysis="set"]');
    this.analysisMw = root.querySelector<HTMLElement>('[data-analysis="mw"]');
    this.weekCanvas = root.querySelector<HTMLCanvasElement>('.serein-moon-week-canvas');
  }

  private attachEvents(): void {
    const signal = this.abortController?.signal;
    if (!signal) return;
    document.addEventListener('visibilitychange', this.onVisibility, { signal });
  }

  private readonly onVisibility = (): void => {
    if (document.hidden) this.stop();
    else this.start();
  };

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

    this.stepAstro(deltaSeconds);
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

    if (this.stars.length === 0 || this.starsSeed !== QUALITY[this.quality].starCount) {
      this.rebuildStars();
    }
    if (this.mode === 'analysis') this.drawWeekPhases(true);
  };

  /** 分析模式：未来 7 天月相图标横排（仅日期变化时重绘） */
  private drawWeekPhases(force = false): void {
    const canvas = this.weekCanvas;
    if (!canvas || this.mode !== 'analysis') return;

    const key = this.date;
    if (!force && key === this.lastWeekKey && canvas.width > 0) return;
    this.lastWeekKey = key;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const cssWidth = Math.max(1, canvas.clientWidth || 220);
    const cssHeight = Math.max(1, canvas.clientHeight || 52);
    const dpr = Math.min(
      typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1,
      2,
    );
    const pixelW = Math.max(1, Math.round(cssWidth * dpr));
    const pixelH = Math.max(1, Math.round(cssHeight * dpr));
    if (canvas.width !== pixelW) canvas.width = pixelW;
    if (canvas.height !== pixelH) canvas.height = pixelH;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cssWidth, cssHeight);

    this.ensureMoonTexture();
    const texture = this.moonTexture;
    const cellW = cssWidth / WEEK_DAYS;
    const moonR = Math.min(11, cellW * 0.32);
    const cy = cssHeight * 0.38;

    ctx.font = '500 9px -apple-system, "SF Pro", Inter, "PingFang SC", sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';

    for (let day = 0; day < WEEK_DAYS; day += 1) {
      const iso = addDaysIso(this.date, day);
      const phase = moonPhase(iso);
      const cx = cellW * (day + 0.5);

      if (texture) {
        ctx.save();
        ctx.beginPath();
        ctx.arc(cx, cy, moonR, 0, Math.PI * 2);
        ctx.clip();
        ctx.drawImage(texture, cx - moonR, cy - moonR, moonR * 2, moonR * 2);
        ctx.restore();
        paintTerminatorShadow(ctx, cx, cy, moonR, phase);
        ctx.strokeStyle = 'rgba(255,255,255,0.22)';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.arc(cx, cy, moonR, 0, Math.PI * 2);
        ctx.stroke();
      }

      ctx.fillStyle = day === 0 ? 'rgba(255,255,255,0.78)' : 'rgba(255,255,255,0.45)';
      ctx.fillText(iso.slice(5), cx, cy + moonR + 4);
    }
  }

  private retargetAstro(): void {
    const city = get(currentCity);
    const hourUTC = this.timeMinutes / 60 - 8;
    const phase = moonPhase(this.date, hourUTC);
    const illum = moonIllumination(this.date, hourUTC);
    const moon = moonPosition(this.date, this.timeMinutes, city.lat, city.lon);
    const gc = galacticCenterPosition(this.date, this.timeMinutes, city.lat, city.lon);
    const cloud = clamp(sampleSeries(this.cloudCover, this.timeMinutes), 0, 1);
    const sun = solarPosition(this.date, this.timeMinutes, city.lat, city.lon);
    const night = astronomicalDarkFactor(sun.elevation);
    const mwVis = milkyWayVisibility(illum, cloud, night);

    this.phaseTarget = phase;
    this.illumTarget = illum;
    this.moonAzTarget = moon.azimuth;
    this.moonElTarget = moon.elevation;
    this.cloudTarget = cloud;
    this.nightTarget = night;
    this.mwVisTarget = mwVis;
    this.gcAzTarget = gc.azimuth;
    this.gcElTarget = gc.elevation;
  }

  private snapAstro(): void {
    this.phaseCurrent = this.phaseTarget;
    this.illumCurrent = this.illumTarget;
    this.moonAzCurrent = this.moonAzTarget;
    this.moonElCurrent = this.moonElTarget;
    this.cloudCurrent = this.cloudTarget;
    this.nightCurrent = this.nightTarget;
    this.mwVisCurrent = this.mwVisTarget;
    this.gcAzCurrent = this.gcAzTarget;
    this.gcElCurrent = this.gcElTarget;
  }

  private stepAstro(deltaSeconds: number): void {
    const blend = 1 - Math.exp(-deltaSeconds / EASE_TAU);
    this.phaseCurrent = lerpAngle01(this.phaseCurrent, this.phaseTarget, blend);
    this.illumCurrent += (this.illumTarget - this.illumCurrent) * blend;
    this.moonAzCurrent = lerpAngleDeg(this.moonAzCurrent, this.moonAzTarget, blend);
    this.moonElCurrent += (this.moonElTarget - this.moonElCurrent) * blend;
    this.cloudCurrent += (this.cloudTarget - this.cloudCurrent) * blend;
    this.nightCurrent += (this.nightTarget - this.nightCurrent) * blend;
    this.mwVisCurrent += (this.mwVisTarget - this.mwVisCurrent) * blend;
    this.gcAzCurrent = lerpAngleDeg(this.gcAzCurrent, this.gcAzTarget, blend);
    this.gcElCurrent += (this.gcElTarget - this.gcElCurrent) * blend;
  }

  private updateHud(force: boolean): void {
    const phaseText = phaseName(this.phaseCurrent);
    if (force || phaseText !== this.lastPhaseText) {
      this.lastPhaseText = phaseText;
      if (this.phaseEl) this.phaseEl.textContent = phaseText;
    }

    const illumText = `照亮 ${Math.round(this.illumCurrent * 100)}%`;
    if (force || illumText !== this.lastIllumText) {
      this.lastIllumText = illumText;
      if (this.illumEl) this.illumEl.textContent = illumText;
    }

    const index = stargazingIndex(this.cloudCurrent, this.illumCurrent, this.nightCurrent);
    const indexText = String(Math.round(index));
    if (force || indexText !== this.lastIndexText) {
      this.lastIndexText = indexText;
      if (this.readoutEl) this.readoutEl.textContent = indexText;
    }

    const verdictText = stargazingVerdict(index);
    if (force || verdictText !== this.lastVerdictText) {
      this.lastVerdictText = verdictText;
      if (this.verdictEl) this.verdictEl.textContent = verdictText;
    }

    const windowText = this.resolveWindowLabel();
    const windowHidden = windowText.length === 0;
    if (force || windowText !== this.lastWindowText) {
      this.lastWindowText = windowText;
      if (this.windowEl) this.windowEl.textContent = windowText;
    }
    if (force || windowHidden !== this.lastWindowHidden) {
      this.lastWindowHidden = windowHidden;
      if (this.windowEl) this.windowEl.hidden = windowHidden;
    }

    const kp = this.kpIndex;
    const showKp = kp != null && kp >= 5;
    const kpText = showKp
      ? `极光指数 KP ${kp.toFixed(kp % 1 === 0 ? 0 : 1)} · 高纬度地区可见`
      : '';
    if (force || kpText !== this.lastKpText) {
      this.lastKpText = kpText;
      if (this.kpEl) this.kpEl.textContent = kpText;
    }
    const kpHidden = !showKp;
    if (force || kpHidden !== this.lastKpHidden) {
      this.lastKpHidden = kpHidden;
      if (this.kpEl) this.kpEl.hidden = kpHidden;
    }

    const riseText = this.moonrise === null ? '—' : formatClock(this.moonrise);
    if (force || riseText !== this.lastAnalysisRise) {
      this.lastAnalysisRise = riseText;
      if (this.analysisRise) this.analysisRise.textContent = riseText;
    }

    const setText = this.moonset === null ? '—' : formatClock(this.moonset);
    if (force || setText !== this.lastAnalysisSet) {
      this.lastAnalysisSet = setText;
      if (this.analysisSet) this.analysisSet.textContent = setText;
    }

    const mwText = `${Math.round(this.mwVisCurrent * 100)}%`;
    if (force || mwText !== this.lastAnalysisMw) {
      this.lastAnalysisMw = mwText;
      if (this.analysisMw) this.analysisMw.textContent = mwText;
    }
  }

  private resolveWindowLabel(): string {
    const city = get(currentCity);
    const key = `${city.name}|${this.date}|${this.illumTarget.toFixed(3)}`;
    if (key === this.cachedWindowKey) return this.cachedWindowLabel;

    const win = galacticWindow(this.date, city.lat, city.lon, this.illumTarget);
    let label = '';
    if (win) {
      label = `银河窗口 ${formatClock(win.start)}–${formatClock(win.end)}`;
    } else {
      const cachePrefix = `${city.name}|`;
      let next = this.nextWindowCache.get(cachePrefix + this.date);
      if (next === undefined) {
        next =
          nextGalacticWindowDate(
            this.date,
            city.lat,
            city.lon,
            NEXT_WINDOW_SEARCH_DAYS,
          ) ?? '';
        this.nextWindowCache.set(cachePrefix + this.date, next);
        // 回填中间日期，减少连续拖日重复扫描
        if (next) {
          const [y, m, d] = this.date.split('-').map(Number);
          const cursor = new Date(Date.UTC(y, m - 1, d));
          for (let i = 0; i < NEXT_WINDOW_SEARCH_DAYS; i += 1) {
            cursor.setUTCDate(cursor.getUTCDate() + 1);
            const iso = `${cursor.getUTCFullYear()}-${String(cursor.getUTCMonth() + 1).padStart(2, '0')}-${String(cursor.getUTCDate()).padStart(2, '0')}`;
            if (iso >= next) break;
            const key = cachePrefix + iso;
            if (!this.nextWindowCache.has(key)) this.nextWindowCache.set(key, next);
          }
        }
      }
      if (next) label = `下一窗口 ${next.slice(5)}`;
    }

    this.cachedWindowKey = key;
    this.cachedWindowLabel = label;
    return label;
  }

  private draw(): void {
    const context = this.context;
    const canvas = this.canvas;
    if (!context || !canvas) return;

    const width = this.cssWidth;
    const height = this.cssHeight;
    const dpr = this.pixelRatio;

    context.setTransform(dpr, 0, 0, dpr, 0, 0);
    context.clearRect(0, 0, width, height);

    // 星野视差：月球固定居中，背景随方位/高度反向平移
    const parallaxX = ((180 - this.moonAzCurrent) / 360) * width * 0.55;
    const parallaxY = ((45 - this.moonElCurrent) / 90) * height * 0.22;

    this.drawStars(context, width, height, parallaxX, parallaxY);
    this.drawMilkyWay(context, width, height, parallaxX, parallaxY);

    const moonCx = width * 0.5;
    const moonCy = height * 0.38;
    const moonR = Math.min(width, height) * 0.16;
    this.drawMoon(context, moonCx, moonCy, moonR);

    this.drawTimeArc(context, width, height);
  }

  private drawStars(
    context: CanvasRenderingContext2D,
    width: number,
    height: number,
    ox: number,
    oy: number,
  ): void {
    const nightFade = 0.25 + 0.75 * this.nightCurrent;
    const cloudFade = 1 - this.cloudCurrent * 0.85;
    const moonWash = 1 - this.illumCurrent * 0.55 * Math.max(0, this.moonElCurrent / 60);
    const alphaScale = nightFade * cloudFade * moonWash;

    context.save();
    for (const star of this.stars) {
      let x = (((star.x + ox) % width) + width) % width;
      let y = (((star.y + oy) % height) + height) % height;
      // 避免画到月球正中心过密
      const a = star.a * alphaScale;
      if (a < 0.02) continue;
      context.fillStyle = `rgba(230,235,245,${a.toFixed(3)})`;
      context.beginPath();
      context.arc(x, y, star.r, 0, Math.PI * 2);
      context.fill();
    }
    context.restore();
  }

  private drawMilkyWay(
    context: CanvasRenderingContext2D,
    width: number,
    height: number,
    ox: number,
    oy: number,
  ): void {
    const vis = this.mwVisCurrent;
    if (vis < 0.02) return;

    // 银心方位 → 带状中线；高度角 → 纵向偏移
    const bandY =
      height * (0.55 - clamp(this.gcElCurrent, -20, 70) / 140) + oy * 0.35;
    const tilt = ((this.gcAzCurrent - 180) / 90) * 0.35;
    const bandW = Math.hypot(width, height) * 1.2;
    const bandH = Math.min(width, height) * (0.14 + 0.06 * vis);

    context.save();
    context.translate(width * 0.5 + ox * 0.2, bandY);
    context.rotate(tilt);

    const gradient = context.createLinearGradient(0, -bandH, 0, bandH);
    gradient.addColorStop(0, `rgba(180,190,220,0)`);
    gradient.addColorStop(0.35, `rgba(200,210,235,${(0.05 * vis).toFixed(3)})`);
    gradient.addColorStop(0.5, `rgba(220,225,245,${(0.12 * vis).toFixed(3)})`);
    gradient.addColorStop(0.65, `rgba(200,210,235,${(0.05 * vis).toFixed(3)})`);
    gradient.addColorStop(1, `rgba(180,190,220,0)`);
    context.fillStyle = gradient;
    context.fillRect(-bandW * 0.5, -bandH, bandW, bandH * 2);

    // 淡星粒子沿带分布
    const count = QUALITY[this.quality].mwParticles;
    for (let i = 0; i < count; i += 1) {
      const t = i / count;
      const px = (t - 0.5) * bandW * 0.92;
      const py = Math.sin(i * 12.9898) * bandH * 0.55 * (0.3 + hash01(i + 3) * 0.7);
      const a = (0.08 + hash01(i + 7) * 0.35) * vis;
      const r = 0.4 + hash01(i + 11) * 1.1;
      context.fillStyle = `rgba(225,230,245,${a.toFixed(3)})`;
      context.beginPath();
      context.arc(px, py, r, 0, Math.PI * 2);
      context.fill();
    }
    context.restore();
  }

  private drawMoon(
    context: CanvasRenderingContext2D,
    cx: number,
    cy: number,
    r: number,
  ): void {
    const texture = this.moonTexture;
    if (!texture) return;

    const elevFade = moonElevationFade(this.moonElCurrent);
    const belowHorizon = this.moonElCurrent < -2;

    context.save();

    if (QUALITY[this.quality].glow && elevFade > 0.15) {
      const glow = context.createRadialGradient(cx, cy, r * 0.6, cx, cy, r * 2.2);
      const ga = (0.12 + this.illumCurrent * 0.18) * elevFade * (1 - this.cloudCurrent * 0.5);
      glow.addColorStop(0, `rgba(220,220,210,${ga.toFixed(3)})`);
      glow.addColorStop(1, 'rgba(220,220,210,0)');
      context.fillStyle = glow;
      context.beginPath();
      context.arc(cx, cy, r * 2.2, 0, Math.PI * 2);
      context.fill();
    }

    context.globalAlpha = belowHorizon ? 0.22 : elevFade;
    context.beginPath();
    context.arc(cx, cy, r, 0, Math.PI * 2);
    context.clip();

    // 月面纹理
    context.drawImage(texture, cx - r, cy - r, r * 2, r * 2);

    // Terminator 阴影（按相位精确几何）
    paintTerminatorShadow(context, cx, cy, r, this.phaseCurrent);

    // 边缘微暗
    const rim = context.createRadialGradient(cx, cy, r * 0.72, cx, cy, r);
    rim.addColorStop(0, 'rgba(5,7,10,0)');
    rim.addColorStop(1, 'rgba(5,7,10,0.35)');
    context.fillStyle = rim;
    context.fillRect(cx - r, cy - r, r * 2, r * 2);

    context.restore();

    // 外轮廓
    context.save();
    context.globalAlpha = belowHorizon ? 0.25 : 0.55 * elevFade + 0.2;
    context.strokeStyle = 'rgba(220,220,210,0.28)';
    context.lineWidth = 1;
    context.beginPath();
    context.arc(cx, cy, r, 0, Math.PI * 2);
    context.stroke();
    context.restore();
  }

  private drawTimeArc(
    context: CanvasRenderingContext2D,
    width: number,
    height: number,
  ): void {
    const cx = width * 0.5;
    const cy = height - Math.max(56, height * 0.08);
    const radius = Math.min(width * 0.42, 220);
    const startAngle = Math.PI * 1.05;
    const endAngle = Math.PI * 1.95;

    context.save();
    context.strokeStyle = 'rgba(255,255,255,0.22)';
    context.lineWidth = 1;
    context.beginPath();
    context.arc(cx, cy, radius, startAngle, endAngle, false);
    context.stroke();

    // 当前时刻刻度
    const t = this.timeMinutes / DAY_MINUTES;
    const nowAngle = startAngle + (endAngle - startAngle) * t;
    const nx = cx + Math.cos(nowAngle) * radius;
    const ny = cy + Math.sin(nowAngle) * radius;
    context.fillStyle = 'var(--accent, #7ec8ff)';
    context.fillStyle = 'rgba(126,200,255,0.92)';
    context.beginPath();
    context.arc(nx, ny, 3.2, 0, Math.PI * 2);
    context.fill();

    context.fillStyle = 'rgba(255,255,255,0.45)';
    context.font = '11px -apple-system, "SF Pro", Inter, "PingFang SC", sans-serif';
    context.textAlign = 'center';
    context.textBaseline = 'top';

    if (this.moonrise !== null) {
      const a = startAngle + (endAngle - startAngle) * (this.moonrise / DAY_MINUTES);
      const x = cx + Math.cos(a) * radius;
      const y = cy + Math.sin(a) * radius;
      context.fillStyle = 'rgba(255,255,255,0.72)';
      context.beginPath();
      context.arc(x, y, 2.4, 0, Math.PI * 2);
      context.fill();
      context.fillStyle = 'rgba(255,255,255,0.45)';
      context.fillText(`月出 ${formatClock(this.moonrise)}`, x, y + 8);
    }

    if (this.moonset !== null) {
      const a = startAngle + (endAngle - startAngle) * (this.moonset / DAY_MINUTES);
      const x = cx + Math.cos(a) * radius;
      const y = cy + Math.sin(a) * radius;
      context.fillStyle = 'rgba(255,255,255,0.72)';
      context.beginPath();
      context.arc(x, y, 2.4, 0, Math.PI * 2);
      context.fill();
      context.fillStyle = 'rgba(255,255,255,0.45)';
      context.fillText(`月落 ${formatClock(this.moonset)}`, x, y + 8);
    }

    context.restore();
  }

  private ensureMoonTexture(): void {
    if (!sharedMoonTexture) {
      sharedMoonTexture = createMoonTexture(MOON_TEXTURE_SIZE);
    }
    this.moonTexture = sharedMoonTexture;
  }

  private rebuildStars(): void {
    const count = QUALITY[this.quality].starCount;
    this.starsSeed = count;
    const stars: Star[] = [];
    for (let i = 0; i < count; i += 1) {
      stars.push({
        x: hash01(i * 3 + 1) * 2000,
        y: hash01(i * 3 + 2) * 2000,
        r: 0.35 + hash01(i * 3 + 3) * 1.25,
        a: 0.15 + hash01(i * 3 + 4) * 0.7,
      });
    }
    this.stars = stars;
  }
}

/** 月相名（八分段，以相位点为中心） */
export function phaseName(phase: number): string {
  const p = ((phase % 1) + 1) % 1;
  const index = Math.floor((p + 1 / 16) * 8) % 8;
  return PHASE_NAMES[index];
}

/**
 * 观星指数 0–100。
 * 云量 50% + 月照 30% + 天文昏影 20%（越高越好：少云、暗月、天文夜）。
 */
export function stargazingIndex(
  cloudCover: number,
  illumination: number,
  nightFactor: number,
): number {
  const cloudScore = 1 - clamp(cloudCover, 0, 1);
  const moonScore = 1 - clamp(illumination, 0, 1);
  const twilightScore = clamp(nightFactor, 0, 1);
  return (
    100 *
    (STARGATE_WEIGHTS.cloud * cloudScore +
      STARGATE_WEIGHTS.moon * moonScore +
      STARGATE_WEIGHTS.twilight * twilightScore)
  );
}

export function stargazingVerdict(index: number): string {
  if (index >= 70) return '今晚适合观星';
  if (index >= 40) return '一般';
  return '不建议';
}

/** 银河可见度 0–1：月照 / 云量 / 天文昏影 */
export function milkyWayVisibility(
  illumination: number,
  cloudCover: number,
  nightFactor: number,
): number {
  const moonFactor = Math.pow(1 - clamp(illumination, 0, 1), 1.35);
  const cloudFactor = Math.pow(1 - clamp(cloudCover, 0, 1), 1.2);
  const night = clamp(nightFactor, 0, 1);
  return clamp(moonFactor * cloudFactor * night, 0, 1);
}

/**
 * 天文昏暗因子：太阳高度 < −18° → 1；≥ 0° → 0；其间线性。
 */
export function astronomicalDarkFactor(sunElevation: number): number {
  if (sunElevation <= -18) return 1;
  if (sunElevation >= 0) return 0;
  return clamp((-sunElevation) / 18, 0, 1);
}

/**
 * 按 moonPhase 绘制 terminator 阴影。
 * phase 0=新月、0.25=上弦、0.5=满月、0.75=下弦；
 * 先铺满暗幕，再用 destination-out 挖出亮部（半圆 + 椭圆 terminator）。
 */
export function paintTerminatorShadow(
  context: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  r: number,
  phase: number,
): void {
  const p = ((phase % 1) + 1) % 1;
  // 满月附近无需阴影
  if (Math.abs(p - 0.5) < 0.002) return;

  const t = Math.cos(p * Math.PI * 2); // +1 新月 / 0 弦 / −1 满月
  const waxing = p < 0.5;

  context.save();
  context.beginPath();
  context.arc(cx, cy, r, 0, Math.PI * 2);
  context.clip();

  context.fillStyle = 'rgba(5,7,10,0.88)';
  context.fillRect(cx - r - 1, cy - r - 1, r * 2 + 2, r * 2 + 2);

  // 新月：整盘阴影，无需挖亮部
  if (p < 0.002 || p > 0.998) {
    context.restore();
    return;
  }

  context.globalCompositeOperation = 'destination-out';
  context.fillStyle = '#ffffff';
  context.beginPath();

  if (waxing) {
    // 亮部在右：右半圆 + terminator 椭圆
    // t>0 娥眉（椭圆在右半、CCW=false）；t<0 盈凸（椭圆伸入左半、CCW=true）
    context.arc(cx, cy, r, -Math.PI / 2, Math.PI / 2, false);
    context.ellipse(cx, cy, Math.abs(t) * r, r, 0, Math.PI / 2, -Math.PI / 2, t < 0);
  } else {
    // 亮部在左：左半圆 + terminator 椭圆
    // t<0 亏凸（椭圆伸入右半）；t>0 残月（椭圆在左半）
    context.arc(cx, cy, r, Math.PI / 2, -Math.PI / 2, false);
    context.ellipse(cx, cy, Math.abs(t) * r, r, 0, -Math.PI / 2, Math.PI / 2, t > 0);
  }

  context.closePath();
  context.fill();
  context.restore();
}

/** 验收用：相位对应的几何照亮比（与 moonIllumination 一致） */
export function illuminatedFractionFromPhase(phase: number): number {
  const p = ((phase % 1) + 1) % 1;
  return (1 - Math.cos(2 * Math.PI * p)) / 2;
}

export function formatClock(minutes: number): string {
  const safe = clamp(Math.round(minutes), 0, DAY_MINUTES);
  const wrapped = safe === DAY_MINUTES ? 0 : safe;
  const h = Math.floor(wrapped / 60);
  const m = wrapped % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

function addDaysIso(date: string, days: number): string {
  const [y, m, d] = date.split('-').map(Number);
  const cursor = new Date(Date.UTC(y, m - 1, d + days));
  return `${cursor.getUTCFullYear()}-${String(cursor.getUTCMonth() + 1).padStart(2, '0')}-${String(cursor.getUTCDate()).padStart(2, '0')}`;
}

export const MOON_CONSTANTS = {
  STARGATE_WEIGHTS,
  PHASE_NAMES,
  EASE_TAU,
} as const;

function createMoonTexture(size: number): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (!ctx) return canvas;

  const image = ctx.createImageData(size, size);
  const data = image.data;
  const cx = size * 0.5;
  const cy = size * 0.5;
  const r = size * 0.5 - 1;

  // 预生成若干环形山
  const craters: { x: number; y: number; r: number; d: number }[] = [];
  for (let i = 0; i < 48; i += 1) {
    const ang = hash01(i * 5 + 1) * Math.PI * 2;
    const rad = Math.sqrt(hash01(i * 5 + 2)) * 0.85;
    craters.push({
      x: Math.cos(ang) * rad,
      y: Math.sin(ang) * rad,
      r: 0.03 + hash01(i * 5 + 3) * 0.12,
      d: 0.08 + hash01(i * 5 + 4) * 0.22,
    });
  }

  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const nx = (x - cx) / r;
      const ny = (y - cy) / r;
      const dist = Math.hypot(nx, ny);
      const i = (y * size + x) * 4;
      if (dist > 1) {
        data[i] = 0;
        data[i + 1] = 0;
        data[i + 2] = 0;
        data[i + 3] = 0;
        continue;
      }

      // 球面明暗 + 噪声
      const limb = Math.sqrt(Math.max(0, 1 - dist * dist));
      let shade = 0.42 + 0.38 * limb;
      shade += (fbm2(nx * 3.2, ny * 3.2) - 0.5) * 0.22;

      // 玛丽亚（暗区）软斑
      const maria =
        softSpot(nx, ny, -0.25, 0.1, 0.45) * 0.18 + softSpot(nx, ny, 0.35, -0.2, 0.32) * 0.12;
      shade -= maria;

      for (const c of craters) {
        const d = Math.hypot(nx - c.x, ny - c.y);
        if (d < c.r) {
          const rim = Math.abs(d - c.r * 0.82) / (c.r * 0.18);
          if (rim < 1) shade += (1 - rim) * c.d * 0.55;
          else shade -= (1 - d / c.r) * c.d;
        }
      }

      shade = clamp(shade, 0.08, 0.95);
      const g = Math.round(shade * 255);
      data[i] = g;
      data[i + 1] = Math.round(g * 0.98);
      data[i + 2] = Math.round(g * 0.92);
      data[i + 3] = 255;
    }
  }

  ctx.putImageData(image, 0, 0);
  return canvas;
}

function softSpot(x: number, y: number, cx: number, cy: number, radius: number): number {
  const d = Math.hypot(x - cx, y - cy) / radius;
  if (d >= 1) return 0;
  return (1 - d) * (1 - d);
}

function fbm2(x: number, y: number): number {
  let value = 0;
  let amp = 0.5;
  let fx = x;
  let fy = y;
  for (let i = 0; i < 4; i += 1) {
    value += amp * valueNoise2(fx, fy);
    fx *= 2.1;
    fy *= 2.1;
    amp *= 0.5;
  }
  return value;
}

function valueNoise2(x: number, y: number): number {
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const xf = x - x0;
  const yf = y - y0;
  const u = xf * xf * (3 - 2 * xf);
  const v = yf * yf * (3 - 2 * yf);
  const a = hash2(x0, y0);
  const b = hash2(x0 + 1, y0);
  const c = hash2(x0, y0 + 1);
  const d = hash2(x0 + 1, y0 + 1);
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}

function hash2(x: number, y: number): number {
  return hash01(x * 374761393 + y * 668265263);
}

function hash01(n: number): number {
  const s = Math.sin(n * 127.1) * 43758.5453;
  return s - Math.floor(s);
}

function moonElevationFade(elevation: number): number {
  if (elevation >= 8) return 1;
  if (elevation <= -6) return 0.15;
  return clamp((elevation + 6) / 14, 0.15, 1);
}

function todayIso(): string {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function sampleSeries(values: ArrayLike<number>, minutes: number): number {
  const hour = clamp(minutes / 60, 0, 24);
  const left = Math.min(23, Math.floor(hour));
  const amount = hour - left;
  return values[left] + (values[left + 1] - values[left]) * amount;
}

function copySeries(
  source: ArrayLike<number> | undefined,
  target: Float32Array,
  initialFallback: number,
  minimum: number,
  maximum: number,
): void {
  let fallback = initialFallback;
  for (let index = 0; index < HOURS; index += 1) {
    const candidate = source?.[index];
    if (typeof candidate === 'number' && Number.isFinite(candidate)) {
      fallback = clamp(candidate, minimum, maximum);
    }
    target[index] = fallback;
  }
}

/** 相位 0–1 最短弧插值 */
function lerpAngle01(from: number, to: number, t: number): number {
  let delta = ((((to - from) % 1) + 1.5) % 1) - 0.5;
  return (((from + delta * t) % 1) + 1) % 1;
}

function lerpAngleDeg(from: number, to: number, t: number): number {
  let delta = ((((to - from) % 360) + 540) % 360) - 180;
  return (((from + delta * t) % 360) + 360) % 360;
}
