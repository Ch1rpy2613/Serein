/**
 * PressureLayer —— 头顶的空气海洋。
 *
 * 压力是一种体感，不是数字：右侧玻璃液柱气压计映射海平面气压，
 * 全屏微「下沉 / 上浮」，3 小时变压箭头提示天气转折。
 */
import type { DayData, WeatherLayer } from '../../contracts';

type Quality = 'low' | 'medium' | 'high';
type Mode = 'feel' | 'analysis';

interface QualityConfig {
  dpr: number;
}

interface BodyFeel {
  /** 画面整体平移（正=下沉，负=上浮） */
  shiftY: number;
  /** CSS contrast() 倍率 */
  contrast: number;
}

interface TrendInfo {
  arrow: '↑' | '↓' | '→';
  label: string;
  warn: boolean;
  delta: number;
}

/*
 * ── 气压映射与体感常量表 ─────────────────────────────────────────────
 * 液柱高度线性映射海平面气压；体感幅度刻意克制，避免晕眩。
 */
const PRESSURE_RANGE = {
  min: 950,
  max: 1050,
} as const;

/** 管旁刻度读数（hPa） */
const SCALE_TICKS: readonly number[] = [960, 1000, 1040];

const BODY_FEEL = {
  /** 高于此值画面轻微下沉 */
  highThreshold: 1020,
  /** 低于此值画面轻微上浮 */
  lowThreshold: 990,
  /** 最大平移（px） */
  maxShiftPx: 6,
  /** 对比度增减幅度（相对 1.0） */
  contrastDelta: 0.04,
  /** ≈300ms 达 95% */
  easeTau: 0.1,
} as const;

const TREND = {
  /** 回溯小时数 */
  hours: 3,
  /** 判定平稳的死区（hPa） */
  flatEpsilon: 0.05,
  /** 快速下降阈值：ΔP ≤ 此值（hPa/3h）触发底部警示 */
  rapidDropThreshold: -2,
  warningText: '气压快速下降，天气可能转坏',
} as const;

const SPRING = {
  stiffness: 100,
  damping: 16,
} as const;

/** 液面驻波：振幅合计 < 2px，呼吸感 */
const WAVE = {
  ampA: 1.05,
  freqA: 1.7,
  ampB: 0.55,
  freqB: 2.9,
  phaseB: 1.3,
} as const;

const HOURS = 25;
const DAY_MINUTES = 1440;
const FALLBACK_PRESSURE = 1013.2;

const QUALITY: Record<Quality, QualityConfig> = {
  high: { dpr: 1.75 },
  medium: { dpr: 1.35 },
  low: { dpr: 1 },
};

const LAYER_CSS = `
.serein-pressure-layer {
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
  will-change: transform, filter;
}
.serein-pressure-canvas {
  position: absolute;
  inset: 0;
  z-index: 0;
  display: block;
  width: 100%;
  height: 100%;
  pointer-events: none;
}
.serein-pressure-header {
  position: absolute;
  top: max(28px, env(safe-area-inset-top));
  left: max(28px, env(safe-area-inset-left));
  z-index: 2;
  display: grid;
  gap: 10px;
  text-shadow: 0 1px 18px rgba(5,7,10,.32);
  pointer-events: none;
}
.serein-pressure-heading {
  display: flex;
  align-items: baseline;
  gap: 11px;
}
.serein-pressure-heading h2,
.serein-pressure-heading p,
.serein-pressure-readout,
.serein-pressure-caption {
  margin: 0;
}
.serein-pressure-heading h2 {
  font-size: 17px;
  font-weight: 560;
  letter-spacing: .02em;
}
.serein-pressure-heading p {
  color: var(--fg-2, rgba(255,255,255,.45));
  font-size: 11px;
  font-weight: 500;
  letter-spacing: .08em;
}
.serein-pressure-readout {
  color: var(--fg-1, rgba(255,255,255,.92));
  font: inherit;
  font-size: 56px;
  font-weight: 340;
  letter-spacing: -.055em;
  line-height: .9;
  font-variant-numeric: tabular-nums;
  transition: opacity 400ms ease;
}
.serein-pressure-caption {
  color: var(--fg-2, rgba(255,255,255,.45));
  font-size: 11px;
  font-weight: 500;
  letter-spacing: .04em;
}
.serein-pressure-layer[data-mode="analysis"] .serein-pressure-readout {
  opacity: 0.4;
}
.serein-pressure-analysis {
  position: absolute;
  left: max(20px, env(safe-area-inset-left));
  bottom: max(132px, calc(env(safe-area-inset-bottom) + 112px));
  z-index: 2;
  display: grid;
  gap: 6px;
  width: min(16rem, calc(100% - 2 * max(20px, env(safe-area-inset-left))));
  opacity: 0;
  visibility: hidden;
  pointer-events: none;
  transition: opacity 400ms ease, visibility 400ms step-end;
}
.serein-pressure-layer[data-mode="analysis"] .serein-pressure-analysis {
  opacity: 1;
  visibility: visible;
  transition: opacity 400ms ease, visibility 0ms step-start;
}
.serein-pressure-analysis-label {
  margin: 0;
  color: var(--fg-2, rgba(255,255,255,.45));
  font-size: 9px;
  font-weight: 520;
  letter-spacing: .08em;
  text-shadow: 0 1px 12px rgba(5,7,10,.35);
}
.serein-pressure-analysis-canvas {
  display: block;
  width: 100%;
  height: 72px;
}
.serein-pressure-warning {
  position: absolute;
  left: 50%;
  bottom: max(28px, env(safe-area-inset-bottom));
  z-index: 2;
  margin: 0;
  color: var(--fg-2, rgba(255,255,255,.45));
  font-size: 11px;
  font-weight: 500;
  letter-spacing: .02em;
  text-align: center;
  text-shadow: 0 1px 14px rgba(5,7,10,.4);
  white-space: nowrap;
  transform: translateX(-50%);
  opacity: 0;
  transition: opacity 280ms ease;
  pointer-events: none;
}
.serein-pressure-warning.is-visible {
  opacity: 1;
}
@media (max-width: 420px) {
  .serein-pressure-header {
    top: max(22px, env(safe-area-inset-top));
    left: max(18px, env(safe-area-inset-left));
    gap: 8px;
  }
  .serein-pressure-readout {
    font-size: 46px;
  }
  .serein-pressure-analysis {
    width: calc(100% - 2 * max(16px, env(safe-area-inset-left)));
  }
  .serein-pressure-warning {
    bottom: max(22px, env(safe-area-inset-bottom));
    font-size: 10px;
    white-space: normal;
    max-width: calc(100% - 36px);
  }
}
`;

export class PressureLayer implements WeatherLayer {
  readonly id = 'pressure';
  readonly name = '气压';
  readonly preferredSkyDim = 0.5;

  private container: HTMLElement | null = null;
  private root: HTMLElement | null = null;
  private canvas: HTMLCanvasElement | null = null;
  private context: CanvasRenderingContext2D | null = null;
  private readout: HTMLOutputElement | null = null;
  private warning: HTMLElement | null = null;
  private analysisCanvas: HTMLCanvasElement | null = null;

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

  private pressure = new Float32Array(HOURS).fill(FALLBACK_PRESSURE);
  private hasData = false;
  private timeMinutes = 480;

  private pressureTarget = FALLBACK_PRESSURE;
  private pressureCurrent = FALLBACK_PRESSURE;
  private pressureVelocity = 0;

  private feelShiftCurrent = 0;
  private feelContrastCurrent = 1;

  private lastReadoutText = '';
  private lastWarningVisible: boolean | null = null;
  private accentColor = '#7ec8ff';

  mount(container: HTMLElement): void {
    if (this.root) return;

    this.container = container;
    this.abortController = new AbortController();
    this.elapsed = 0;

    this.createDom();
    this.resolveAccent();
    this.attachEvents();

    this.resizeObserver = new ResizeObserver(this.resize);
    this.resizeObserver.observe(container);
    this.resize();
    this.retargetPressure();
    this.snapPressure();
    this.updateHud(true);
    this.applyBodyFeel(true);
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
    this.readout = null;
    this.warning = null;
    this.analysisCanvas = null;
    this.lastWarningVisible = null;
    this.mode = 'feel';
  }

  setTime(minutes: number): void {
    this.timeMinutes = clamp(Number.isFinite(minutes) ? minutes : 0, 0, DAY_MINUTES);
    this.retargetPressure();
    if (this.mode === 'analysis') this.drawAnalysisChart();
  }

  setData(data: DayData): void {
    copySeries(data.pressure, this.pressure, FALLBACK_PRESSURE, 870, 1085);
    const first = !this.hasData;
    this.hasData = true;
    this.retargetPressure();
    if (first) this.snapPressure();
    this.updateHud(true);
    if (this.mode === 'analysis') this.drawAnalysisChart();
  }

  setMode(mode: Mode): void {
    if (this.mode === mode) return;
    this.mode = mode;
    if (this.root) this.root.dataset.mode = mode;
    if (mode === 'analysis') this.drawAnalysisChart();
  }

  setQuality(quality: Quality): void {
    if (quality === this.quality) return;
    this.quality = quality;
    this.root?.setAttribute('data-quality', quality);
    this.resize();
    if (this.mode === 'analysis') this.drawAnalysisChart();
  }

  private createDom(): HTMLElement {
    const root = document.createElement('section');
    root.className = 'serein-pressure-layer';
    root.setAttribute('aria-label', '逐时海平面气压');
    root.setAttribute('data-quality', this.quality);
    root.dataset.mode = this.mode;

    root.innerHTML = `
      <style>${LAYER_CSS}</style>
      <canvas class="serein-pressure-canvas" aria-hidden="true"></canvas>
      <header class="serein-pressure-header">
        <div class="serein-pressure-heading">
          <h2>气压</h2>
          <p>hPa</p>
        </div>
        <output class="serein-pressure-readout" aria-label="当前海平面气压">${formatPressure(FALLBACK_PRESSURE)}</output>
        <p class="serein-pressure-caption">海平面气压</p>
      </header>
      <aside class="serein-pressure-analysis" aria-hidden="true">
        <p class="serein-pressure-analysis-label">24h 气压</p>
        <canvas class="serein-pressure-analysis-canvas" aria-hidden="true"></canvas>
      </aside>
      <p class="serein-pressure-warning" role="status" aria-live="polite">${TREND.warningText}</p>
    `;

    this.container?.appendChild(root);
    this.root = root;
    this.canvas = root.querySelector<HTMLCanvasElement>('.serein-pressure-canvas');
    this.context = this.canvas?.getContext('2d') ?? null;
    this.readout = root.querySelector<HTMLOutputElement>('.serein-pressure-readout');
    this.warning = root.querySelector<HTMLElement>('.serein-pressure-warning');
    this.analysisCanvas = root.querySelector<HTMLCanvasElement>(
      '.serein-pressure-analysis-canvas',
    );
    return root;
  }

  private resolveAccent(): void {
    const root = this.root;
    if (!root || typeof getComputedStyle === 'undefined') return;
    const value = getComputedStyle(root).getPropertyValue('--accent').trim();
    if (value) this.accentColor = value;
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

    this.stepSpring(deltaSeconds);
    this.stepBodyFeel(deltaSeconds);
    this.draw();
    this.updateHud(false);
    this.applyBodyFeel(false);
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
    if (this.mode === 'analysis') this.drawAnalysisChart();
  };

  private drawAnalysisChart(): void {
    const canvas = this.analysisCanvas;
    if (!canvas || this.mode !== 'analysis') return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const cssWidth = Math.max(1, canvas.clientWidth || 240);
    const cssHeight = Math.max(1, canvas.clientHeight || 72);
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

    let min = Infinity;
    let max = -Infinity;
    for (let i = 0; i < HOURS; i += 1) {
      const v = this.pressure[i];
      if (v < min) min = v;
      if (v > max) max = v;
    }
    if (!Number.isFinite(min) || !Number.isFinite(max)) {
      min = PRESSURE_RANGE.min;
      max = PRESSURE_RANGE.max;
    }
    const span = Math.max(2, max - min);
    min -= span * 0.12;
    max += span * 0.12;
    const range = max - min;

    const padL = 28;
    const padR = 4;
    const padT = 4;
    const padB = 14;
    const plotW = cssWidth - padL - padR;
    const plotH = cssHeight - padT - padB;

    ctx.font = '500 9px -apple-system, "SF Pro", Inter, "PingFang SC", sans-serif';
    ctx.fillStyle = 'rgba(255,255,255,0.45)';
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    const ticks = [min, (min + max) / 2, max];
    for (const tick of ticks) {
      const y = padT + plotH - ((tick - min) / range) * plotH;
      ctx.fillText(tick.toFixed(0), padL - 5, y);
      ctx.strokeStyle = 'rgba(255,255,255,0.14)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(padL, y);
      ctx.lineTo(padL + plotW, y);
      ctx.stroke();
    }

    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    for (let hour = 0; hour <= 24; hour += 6) {
      const x = padL + (hour / 24) * plotW;
      ctx.fillStyle = 'rgba(255,255,255,0.45)';
      ctx.fillText(
        `${String(hour).padStart(2, '0')}:00`,
        x,
        padT + plotH + 2,
      );
    }

    const accent = this.accentColor || '#7ec8ff';
    ctx.strokeStyle = accent;
    ctx.lineWidth = 1.6;
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.beginPath();
    for (let hour = 0; hour < HOURS; hour += 1) {
      const x = padL + (hour / 24) * plotW;
      const y = padT + plotH - ((this.pressure[hour] - min) / range) * plotH;
      if (hour === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();

    const t = clamp(this.timeMinutes / 60, 0, 24);
    const cursorX = padL + (t / 24) * plotW;
    const value = this.pressureCurrent;
    const cursorY = padT + plotH - ((value - min) / range) * plotH;
    ctx.fillStyle = accent;
    ctx.beginPath();
    ctx.arc(cursorX, cursorY, 2.4, 0, Math.PI * 2);
    ctx.fill();
  }

  private retargetPressure(): void {
    this.pressureTarget = clamp(
      sampleSeries(this.pressure, this.timeMinutes),
      PRESSURE_RANGE.min,
      PRESSURE_RANGE.max,
    );
  }

  private snapPressure(): void {
    this.pressureCurrent = this.pressureTarget;
    this.pressureVelocity = 0;
    const feel = bodyFeelFromPressure(this.pressureCurrent);
    this.feelShiftCurrent = feel.shiftY;
    this.feelContrastCurrent = feel.contrast;
  }

  private stepSpring(deltaSeconds: number): void {
    // x'' = −k(x − target) − c·v；半隐式欧拉，接近目标时吸附防抖
    const { stiffness, damping } = SPRING;
    const force =
      -stiffness * (this.pressureCurrent - this.pressureTarget) -
      damping * this.pressureVelocity;
    this.pressureVelocity += force * deltaSeconds;
    this.pressureCurrent += this.pressureVelocity * deltaSeconds;

    if (
      Math.abs(this.pressureCurrent - this.pressureTarget) < 0.0008 &&
      Math.abs(this.pressureVelocity) < 0.02
    ) {
      this.pressureCurrent = this.pressureTarget;
      this.pressureVelocity = 0;
    }
  }

  private stepBodyFeel(deltaSeconds: number): void {
    const target = bodyFeelFromPressure(this.pressureCurrent);
    const blend = 1 - Math.exp(-deltaSeconds / BODY_FEEL.easeTau);
    this.feelShiftCurrent += (target.shiftY - this.feelShiftCurrent) * blend;
    this.feelContrastCurrent += (target.contrast - this.feelContrastCurrent) * blend;
  }

  private applyBodyFeel(force: boolean): void {
    const root = this.root;
    if (!root) return;
    const shift = this.feelShiftCurrent;
    const contrast = this.feelContrastCurrent;
    if (
      !force &&
      Math.abs(shift) < 0.02 &&
      Math.abs(contrast - 1) < 0.001 &&
      root.style.transform === ''
    ) {
      return;
    }
    root.style.transform = `translate3d(0, ${shift.toFixed(2)}px, 0)`;
    root.style.filter = `contrast(${contrast.toFixed(4)})`;
  }

  private updateHud(force: boolean): void {
    const readoutText = formatPressure(this.pressureCurrent);
    if (force || readoutText !== this.lastReadoutText) {
      this.lastReadoutText = readoutText;
      if (this.readout) this.readout.textContent = readoutText;
    }

    const trend = computeTrend(
      this.pressure,
      this.timeMinutes,
      TREND.hours,
      TREND.flatEpsilon,
      TREND.rapidDropThreshold,
    );
    if (force || trend.warn !== this.lastWarningVisible) {
      this.lastWarningVisible = trend.warn;
      this.warning?.classList.toggle('is-visible', trend.warn);
    }
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

    const layout = tubeLayout(width, height);
    const fill = pressureToFillRatio(this.pressureCurrent);
    const wavePx = standingWaveOffset(this.elapsed);

    this.drawTube(context, layout, fill, wavePx);
    this.drawScale(context, layout);
    this.drawAccentMarker(context, layout, fill, wavePx);
    this.drawTrend(context, layout, fill, wavePx);
  }

  private drawTube(
    context: CanvasRenderingContext2D,
    layout: TubeLayout,
    fill: number,
    wavePx: number,
  ): void {
    const { x, top, bottom, width: tubeW, radius } = layout;
    const innerPad = 2.5;
    const innerX = x + innerPad;
    const innerW = tubeW - innerPad * 2;
    const innerTop = top + innerPad;
    const innerBottom = bottom - innerPad;
    const innerH = innerBottom - innerTop;
    const liquidTop = innerBottom - fill * innerH + wavePx;

    // 玻璃管外壳
    context.save();
    roundRectPath(context, x, top, tubeW, bottom - top, radius);
    const glass = context.createLinearGradient(x, top, x + tubeW, top);
    glass.addColorStop(0, 'rgba(255,255,255,0.06)');
    glass.addColorStop(0.35, 'rgba(255,255,255,0.14)');
    glass.addColorStop(0.55, 'rgba(255,255,255,0.05)');
    glass.addColorStop(1, 'rgba(255,255,255,0.1)');
    context.fillStyle = glass;
    context.fill();
    context.strokeStyle = 'rgba(255,255,255,0.28)';
    context.lineWidth = 1;
    context.stroke();

    // 管内暗腔
    context.beginPath();
    roundRectPath(
      context,
      innerX,
      innerTop,
      innerW,
      innerBottom - innerTop,
      Math.max(2, radius - 2),
    );
    context.fillStyle = 'rgba(5,7,10,0.45)';
    context.fill();
    context.clip();

    // 水银柱
    const mercuryTop = Math.min(innerBottom - 1, Math.max(innerTop, liquidTop));
    const mercuryGrad = context.createLinearGradient(innerX, mercuryTop, innerX + innerW, mercuryTop);
    mercuryGrad.addColorStop(0, 'rgba(28,32,38,0.95)');
    mercuryGrad.addColorStop(0.22, 'rgba(58,64,72,0.98)');
    mercuryGrad.addColorStop(0.48, 'rgba(18,20,24,1)');
    mercuryGrad.addColorStop(0.72, 'rgba(72,78,88,0.95)');
    mercuryGrad.addColorStop(1, 'rgba(22,26,32,0.98)');
    context.fillStyle = mercuryGrad;
    context.fillRect(innerX, mercuryTop, innerW, innerBottom - mercuryTop + 1);

    // 纵向微高光（玻璃折射感）
    const sheen = context.createLinearGradient(innerX, 0, innerX + innerW, 0);
    sheen.addColorStop(0, 'rgba(255,255,255,0)');
    sheen.addColorStop(0.28, 'rgba(255,255,255,0.08)');
    sheen.addColorStop(0.42, 'rgba(255,255,255,0)');
    sheen.addColorStop(1, 'rgba(255,255,255,0)');
    context.fillStyle = sheen;
    context.fillRect(innerX, mercuryTop, innerW, innerBottom - mercuryTop);

    // 液面高光弧
    context.beginPath();
    context.ellipse(
      innerX + innerW / 2,
      mercuryTop,
      innerW * 0.48,
      Math.min(3.2, innerW * 0.18),
      0,
      Math.PI,
      0,
      true,
    );
    context.strokeStyle = 'rgba(180,195,210,0.55)';
    context.lineWidth = 1.25;
    context.stroke();

    context.beginPath();
    context.ellipse(
      innerX + innerW / 2,
      mercuryTop + 0.6,
      innerW * 0.38,
      Math.min(2.2, innerW * 0.12),
      0,
      Math.PI,
      0,
      true,
    );
    context.strokeStyle = 'rgba(255,255,255,0.22)';
    context.lineWidth = 0.8;
    context.stroke();

    context.restore();

    // 管顶封闭高光
    context.save();
    context.beginPath();
    context.ellipse(x + tubeW / 2, top + radius * 0.55, tubeW * 0.28, 2.2, 0, 0, Math.PI * 2);
    context.fillStyle = 'rgba(255,255,255,0.12)';
    context.fill();
    context.restore();
  }

  private drawScale(context: CanvasRenderingContext2D, layout: TubeLayout): void {
    const { x, top, bottom, width: tubeW } = layout;
    const tickX = x - 10;
    const labelX = x - 16;

    context.save();
    context.font = '9px -apple-system, "SF Pro", Inter, "PingFang SC", sans-serif';
    context.fillStyle = 'rgba(255,255,255,0.45)';
    context.strokeStyle = 'rgba(255,255,255,0.22)';
    context.lineWidth = 1;
    context.textAlign = 'right';
    context.textBaseline = 'middle';

    for (const tick of SCALE_TICKS) {
      const y = pressureToY(tick, top, bottom);
      context.beginPath();
      context.moveTo(tickX - 5, y + 0.5);
      context.lineTo(tickX + 2, y + 0.5);
      context.stroke();
      context.fillText(String(tick), labelX, y);
    }

    // 管右侧细刻度脊
    context.beginPath();
    context.moveTo(x + tubeW + 6, top + 8);
    context.lineTo(x + tubeW + 6, bottom - 8);
    context.strokeStyle = 'rgba(255,255,255,0.12)';
    context.stroke();
    context.restore();
  }

  private drawAccentMarker(
    context: CanvasRenderingContext2D,
    layout: TubeLayout,
    fill: number,
    wavePx: number,
  ): void {
    const { x, top, bottom, width: tubeW } = layout;
    const y = pressureToY(
      PRESSURE_RANGE.min + fill * (PRESSURE_RANGE.max - PRESSURE_RANGE.min),
      top,
      bottom,
    ) + wavePx;

    context.save();
    context.strokeStyle = this.accentColor;
    context.globalAlpha = 0.92;
    context.lineWidth = 1.5;
    context.beginPath();
    context.moveTo(x - 18, y);
    context.lineTo(x + tubeW + 14, y);
    context.stroke();

    // 端点小圆点
    context.fillStyle = this.accentColor;
    context.beginPath();
    context.arc(x - 18, y, 2.2, 0, Math.PI * 2);
    context.fill();
    context.restore();
  }

  private drawTrend(
    context: CanvasRenderingContext2D,
    layout: TubeLayout,
    fill: number,
    wavePx: number,
  ): void {
    const trend = computeTrend(
      this.pressure,
      this.timeMinutes,
      TREND.hours,
      TREND.flatEpsilon,
      TREND.rapidDropThreshold,
    );
    const { x, top, bottom, width: tubeW } = layout;
    const y =
      pressureToY(
        PRESSURE_RANGE.min + fill * (PRESSURE_RANGE.max - PRESSURE_RANGE.min),
        top,
        bottom,
      ) +
      wavePx;

    const textX = x + tubeW + 18;
    context.save();
    context.font = '11px -apple-system, "SF Pro", Inter, "PingFang SC", sans-serif';
    context.fillStyle = 'rgba(255,255,255,0.72)';
    context.textAlign = 'left';
    context.textBaseline = 'middle';
    context.fillText(trend.arrow, textX, y - 10);

    context.font = '11px -apple-system, "SF Pro", Inter, "PingFang SC", sans-serif';
    context.fillStyle = 'rgba(255,255,255,0.45)';
    context.fillText(trend.label, textX, y + 8);
    context.restore();
  }
}

/* ── 几何 / 映射纯函数（可单测）─────────────────────────────────────── */

interface TubeLayout {
  x: number;
  top: number;
  bottom: number;
  width: number;
  radius: number;
}

function tubeLayout(width: number, height: number): TubeLayout {
  const tubeW = clamp(width * 0.055, 18, 28);
  const tubeH = clamp(height * 0.52, 220, 420);
  const top = height * 0.22;
  const bottom = top + tubeH;
  const x = width - Math.max(72, width * 0.18) - tubeW;
  return { x, top, bottom, width: tubeW, radius: tubeW * 0.45 };
}

/** 气压 → 液柱填充比 0–1（950→0，1050→1） */
export function pressureToFillRatio(pressure: number): number {
  return clamp(
    (pressure - PRESSURE_RANGE.min) / (PRESSURE_RANGE.max - PRESSURE_RANGE.min),
    0,
    1,
  );
}

function pressureToY(pressure: number, top: number, bottom: number): number {
  const fill = pressureToFillRatio(pressure);
  return bottom - fill * (bottom - top);
}

export function formatPressure(pressure: number): string {
  return (Math.round(pressure * 10) / 10).toFixed(1);
}

export function formatTrendDelta(delta: number): string {
  const abs = Math.abs(delta);
  const body = abs.toFixed(1);
  if (delta > 0) return `3h +${body} hPa`;
  if (delta < 0) return `3h −${body} hPa`;
  return `3h 0.0 hPa`;
}

export function computeTrend(
  series: ArrayLike<number>,
  minutes: number,
  hours = TREND.hours,
  flatEpsilon = TREND.flatEpsilon,
  rapidDropThreshold = TREND.rapidDropThreshold,
): TrendInfo {
  const delta = pressureDelta(series, minutes, hours);
  let arrow: TrendInfo['arrow'] = '→';
  if (delta > flatEpsilon) arrow = '↑';
  else if (delta < -flatEpsilon) arrow = '↓';
  return {
    arrow,
    label: formatTrendDelta(delta),
    warn: delta <= rapidDropThreshold,
    delta,
  };
}

export function pressureDelta(
  series: ArrayLike<number>,
  minutes: number,
  hours = TREND.hours,
): number {
  const current = sampleSeries(series, minutes);
  const past = sampleSeries(series, Math.max(0, minutes - hours * 60));
  return current - past;
}

export function bodyFeelFromPressure(pressure: number): BodyFeel {
  const p = clamp(pressure, PRESSURE_RANGE.min, PRESSURE_RANGE.max);
  if (p > BODY_FEEL.highThreshold) {
    const t = clamp(
      (p - BODY_FEEL.highThreshold) / (PRESSURE_RANGE.max - BODY_FEEL.highThreshold),
      0,
      1,
    );
    return {
      shiftY: t * BODY_FEEL.maxShiftPx,
      contrast: 1 + t * BODY_FEEL.contrastDelta,
    };
  }
  if (p < BODY_FEEL.lowThreshold) {
    const t = clamp(
      (BODY_FEEL.lowThreshold - p) / (BODY_FEEL.lowThreshold - PRESSURE_RANGE.min),
      0,
      1,
    );
    return {
      shiftY: -t * BODY_FEEL.maxShiftPx,
      contrast: 1 - t * BODY_FEEL.contrastDelta,
    };
  }
  return { shiftY: 0, contrast: 1 };
}

export function standingWaveOffset(elapsed: number): number {
  const offset =
    Math.sin(elapsed * WAVE.freqA) * WAVE.ampA +
    Math.sin(elapsed * WAVE.freqB + WAVE.phaseB) * WAVE.ampB;
  return clamp(offset, -1.9, 1.9);
}

/** 导出常量表供测试对齐验收阈值 */
export const PRESSURE_CONSTANTS = {
  PRESSURE_RANGE,
  SCALE_TICKS,
  BODY_FEEL,
  TREND,
  SPRING,
  WAVE,
} as const;

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

function roundRectPath(
  context: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  radius: number,
): void {
  const r = Math.min(radius, width / 2, height / 2);
  context.beginPath();
  context.moveTo(x + r, y);
  context.arcTo(x + width, y, x + width, y + height, r);
  context.arcTo(x + width, y + height, x, y + height, r);
  context.arcTo(x, y + height, x, y, r);
  context.arcTo(x, y, x + width, y, r);
  context.closePath();
}
