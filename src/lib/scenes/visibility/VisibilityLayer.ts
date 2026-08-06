/**
 * VisibilityLayer —— 纵深地标剪影 + 距离加权雾。
 *
 * Canvas2D：一排按距离标尺排列的剪影，雾密度由能见度驱动，
 * 一眼读懂「8km 能见度」意味着 8km 以外隐入雾中。
 */
import type { DayData, WeatherLayer } from '../../contracts';

type Quality = 'low' | 'medium' | 'high';
type Mode = 'feel' | 'analysis';
type LandmarkKey = 'tree' | 'buildings' | 'tower' | 'chimney' | 'hills' | 'ridge';

/** 地标剪影 Path2D：模块级一次性生成，setData / 重绘不得重建。 */
const LANDMARK_PATH_CACHE = new Map<LandmarkKey, Path2D>();

interface LandmarkDef {
  key: LandmarkKey;
  name: string;
  /** 标称距离（km） */
  distanceKm: number;
}

interface QualityConfig {
  dpr: number;
  fogNoise: boolean;
}

/*
 * ── 地标常量表（可替换城市风味）──────────────────────────────────────
 * 默认天津味：电视塔命名「天塔」。距离按常见能见度断点（0.5 / 2 / 4 / 8 / 16 / 32 km）。
 */
const LANDMARKS: readonly LandmarkDef[] = [
  { key: 'tree', name: '树', distanceKm: 0.5 },
  { key: 'buildings', name: '楼群', distanceKm: 2 },
  { key: 'tower', name: '天塔', distanceKm: 4 },
  { key: 'chimney', name: '工厂烟囱', distanceKm: 8 },
  { key: 'hills', name: '远山', distanceKm: 16 },
  { key: 'ridge', name: '山脉脊线', distanceKm: 32 },
];

/*
 * ── 湿度近景薄雾权重 ─────────────────────────────────────────────────
 * RH > 阈值时近景也蒙一层薄雾；权重随 RH 线性爬到 100%。
 */
const HUMIDITY_FOG = {
  rhThreshold: 85,
  /** RH=100% 时近景额外雾盖（0–1） */
  nearFogWeight: 0.28,
  /** 近景影响半径（m）；超过后权重衰减 */
  nearRangeM: 2500,
} as const;

/** 20km+：全场几乎清晰（含 32km 脊线）。 */
const CLEAR_VISIBILITY_M = 20_000;
/** 刚好可见：雾盖处于该区间中点附近。 */
const JUST_VISIBLE_COVER = 0.55;
/** 雾浓度缓动 ≈300ms 达 95%。 */
const FOG_TAU = 0.1;
/** 地标隐现缓动 ≈600ms 达 95%。 */
const LANDMARK_TAU = 0.2;
const HOURS = 25;
const DAY_MINUTES = 1440;
const FALLBACK_FOG_COLOR: readonly [number, number, number] = [
  157 / 255,
  180 / 255,
  200 / 255,
];

const QUALITY: Record<Quality, QualityConfig> = {
  high: { dpr: 1.75, fogNoise: true },
  medium: { dpr: 1.35, fogNoise: true },
  low: { dpr: 1, fogNoise: false },
};

const LAYER_CSS = `
.serein-visibility-layer {
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
.serein-visibility-canvas {
  position: absolute;
  inset: 0;
  z-index: 0;
  display: block;
  width: 100%;
  height: 100%;
  pointer-events: none;
}
.serein-visibility-header {
  position: absolute;
  top: max(28px, env(safe-area-inset-top));
  left: max(28px, env(safe-area-inset-left));
  z-index: 2;
  display: grid;
  gap: 12px;
  text-shadow: 0 1px 18px rgba(8,14,22,.32);
  pointer-events: none;
}
.serein-visibility-heading {
  display: flex;
  align-items: baseline;
  gap: 11px;
}
.serein-visibility-heading h2,
.serein-visibility-heading p,
.serein-visibility-readout {
  margin: 0;
}
.serein-visibility-heading h2 {
  font-size: 17px;
  font-weight: 560;
  letter-spacing: .02em;
}
.serein-visibility-heading p {
  color: var(--fg-2, rgba(255,255,255,.45));
  font-size: 11px;
  font-weight: 500;
  letter-spacing: .08em;
}
.serein-visibility-readout {
  color: var(--fg-1, rgba(255,255,255,.92));
  font: inherit;
  font-size: 56px;
  font-weight: 340;
  letter-spacing: -.055em;
  line-height: .9;
  font-variant-numeric: tabular-nums;
  transition: opacity 400ms ease;
}
.serein-visibility-layer[data-mode="analysis"] .serein-visibility-readout {
  opacity: 0.4;
}
.serein-visibility-analysis {
  position: absolute;
  right: max(20px, env(safe-area-inset-right));
  bottom: max(132px, calc(env(safe-area-inset-bottom) + 112px));
  left: max(20px, env(safe-area-inset-left));
  z-index: 2;
  display: grid;
  gap: 6px;
  max-width: 16rem;
  margin-left: auto;
  opacity: 0;
  visibility: hidden;
  pointer-events: none;
  transition: opacity 400ms ease, visibility 400ms step-end;
}
.serein-visibility-layer[data-mode="analysis"] .serein-visibility-analysis {
  opacity: 1;
  visibility: visible;
  transition: opacity 400ms ease, visibility 0ms step-start;
}
.serein-visibility-analysis-label {
  margin: 0;
  color: var(--fg-2, rgba(255,255,255,.45));
  font-size: 9px;
  font-weight: 520;
  letter-spacing: .08em;
  text-shadow: 0 1px 12px rgba(8,14,22,.35);
}
.serein-visibility-analysis-canvas {
  display: block;
  width: 100%;
  height: 56px;
}
@media (max-width: 420px) {
  .serein-visibility-header {
    top: max(22px, env(safe-area-inset-top));
    left: max(18px, env(safe-area-inset-left));
    gap: 10px;
  }
  .serein-visibility-readout {
    font-size: 46px;
  }
  .serein-visibility-analysis {
    right: max(16px, env(safe-area-inset-right));
    left: max(16px, env(safe-area-inset-left));
    max-width: none;
  }
}
`;

export class VisibilityLayer implements WeatherLayer {
  readonly id = 'visibility';
  readonly name = '能见度';
  readonly preferredSkyDim = 0.4;

  private container: HTMLElement | null = null;
  private root: HTMLElement | null = null;
  private canvas: HTMLCanvasElement | null = null;
  private context: CanvasRenderingContext2D | null = null;
  private readout: HTMLOutputElement | null = null;
  private analysisCanvas: HTMLCanvasElement | null = null;

  private colorProbeCanvas: HTMLCanvasElement | null = null;
  private colorProbeContext: CanvasRenderingContext2D | null = null;

  private abortController: AbortController | null = null;
  private resizeObserver: ResizeObserver | null = null;
  private raf = 0;
  private lastTimestamp = 0;
  private elapsed = 0;
  private skySampleAt = 0;

  private quality: Quality = 'high';
  private mode: Mode = 'feel';
  private cssWidth = 1;
  private cssHeight = 1;
  private pixelRatio = 1;

  private visibility = new Float32Array(HOURS).fill(12_000);
  private humidity = new Float32Array(HOURS).fill(60);
  private hasData = false;
  private timeMinutes = 480;

  private visibilityTarget = 12_000;
  private visibilityCurrent = 12_000;
  private humidityTarget = 60;
  private humidityCurrent = 60;

  /** 各地标当前雾盖 0=清晰 1=隐没（600ms 缓动）。 */
  private landmarkCoverCurrent = LANDMARKS.map(() => 0);
  private landmarkCoverTarget = LANDMARKS.map(() => 0);

  private fogColor: [number, number, number] = [...FALLBACK_FOG_COLOR];
  private fogColorTarget: [number, number, number] = [...FALLBACK_FOG_COLOR];

  private lastReadoutText = '';
  private noisePattern: CanvasPattern | null = null;

  mount(container: HTMLElement): void {
    if (this.root) return;

    this.container = container;
    this.abortController = new AbortController();
    this.elapsed = 0;
    this.skySampleAt = 0;

    const root = this.createDom();
    this.attachEvents();

    const probe = document.createElement('canvas');
    probe.width = 8;
    probe.height = 8;
    this.colorProbeCanvas = probe;
    this.colorProbeContext = probe.getContext('2d', { willReadFrequently: true });

    this.resizeObserver = new ResizeObserver(this.resize);
    this.resizeObserver.observe(container);
    this.resize();
    this.retargetWeather();
    this.snapWeather();
    this.updateHud(true);
    this.sampleSkyColor();
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
    this.analysisCanvas = null;
    this.colorProbeCanvas = null;
    this.colorProbeContext = null;
    this.noisePattern = null;
    this.mode = 'feel';
  }

  setTime(minutes: number): void {
    this.timeMinutes = clamp(Number.isFinite(minutes) ? minutes : 0, 0, DAY_MINUTES);
    this.retargetWeather();
    if (this.mode === 'analysis') this.drawAnalysisSparkline();
  }

  setData(data: DayData): void {
    copySeries(data.visibility, this.visibility, 12_000, 50, 50_000);
    copySeries(data.humidity, this.humidity, 60, 0, 100);
    const first = !this.hasData;
    this.hasData = true;
    this.retargetWeather();
    if (first) this.snapWeather();
    this.updateHud(true);
    if (this.mode === 'analysis') this.drawAnalysisSparkline();
  }

  setMode(mode: Mode): void {
    if (this.mode === mode) return;
    this.mode = mode;
    if (this.root) this.root.dataset.mode = mode;
    if (mode === 'analysis') this.drawAnalysisSparkline();
  }

  setQuality(quality: Quality): void {
    if (quality === this.quality) return;
    this.quality = quality;
    this.root?.setAttribute('data-quality', quality);
    this.noisePattern = null;
    this.resize();
    if (this.mode === 'analysis') this.drawAnalysisSparkline();
  }

  private createDom(): HTMLElement {
    const root = document.createElement('section');
    root.className = 'serein-visibility-layer';
    root.setAttribute('aria-label', '逐时能见度与纵深地标');
    root.setAttribute('data-quality', this.quality);
    root.dataset.mode = this.mode;

    root.innerHTML = `
      <style>${LAYER_CSS}</style>
      <canvas class="serein-visibility-canvas" aria-hidden="true"></canvas>
      <header class="serein-visibility-header">
        <div class="serein-visibility-heading">
          <h2>能见度</h2>
          <p>逐时</p>
        </div>
        <output class="serein-visibility-readout" aria-label="当前能见度">12 km</output>
      </header>
      <aside class="serein-visibility-analysis" aria-hidden="true">
        <p class="serein-visibility-analysis-label">逐时能见度</p>
        <canvas class="serein-visibility-analysis-canvas" aria-hidden="true"></canvas>
      </aside>
    `;

    this.container?.appendChild(root);
    this.root = root;
    this.canvas = root.querySelector<HTMLCanvasElement>('.serein-visibility-canvas');
    this.context = this.canvas?.getContext('2d') ?? null;
    this.readout = root.querySelector<HTMLOutputElement>('.serein-visibility-readout');
    this.analysisCanvas = root.querySelector<HTMLCanvasElement>(
      '.serein-visibility-analysis-canvas',
    );
    return root;
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

    this.stepWeather(deltaSeconds);
    if (this.elapsed >= this.skySampleAt) {
      this.sampleSkyColor();
      this.skySampleAt = this.elapsed + 0.75;
    }
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
      this.noisePattern = null;
    }
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;
    if (this.mode === 'analysis') this.drawAnalysisSparkline();
  };

  private retargetWeather(): void {
    this.visibilityTarget = clamp(
      sampleSeries(this.visibility, this.timeMinutes),
      50,
      50_000,
    );
    this.humidityTarget = clamp(sampleSeries(this.humidity, this.timeMinutes), 0, 100);
    for (let index = 0; index < LANDMARKS.length; index += 1) {
      this.landmarkCoverTarget[index] = landmarkFogCover(
        LANDMARKS[index].distanceKm * 1000,
        this.visibilityTarget,
        this.humidityTarget,
      );
    }
  }

  private snapWeather(): void {
    this.visibilityCurrent = this.visibilityTarget;
    this.humidityCurrent = this.humidityTarget;
    for (let index = 0; index < LANDMARKS.length; index += 1) {
      this.landmarkCoverCurrent[index] = this.landmarkCoverTarget[index];
    }
    this.fogColor[0] = this.fogColorTarget[0];
    this.fogColor[1] = this.fogColorTarget[1];
    this.fogColor[2] = this.fogColorTarget[2];
  }

  private stepWeather(deltaSeconds: number): void {
    const fogBlend = 1 - Math.exp(-deltaSeconds / FOG_TAU);
    this.visibilityCurrent += (this.visibilityTarget - this.visibilityCurrent) * fogBlend;
    this.humidityCurrent += (this.humidityTarget - this.humidityCurrent) * fogBlend;

    const landmarkBlend = 1 - Math.exp(-deltaSeconds / LANDMARK_TAU);
    for (let index = 0; index < LANDMARKS.length; index += 1) {
      this.landmarkCoverCurrent[index] +=
        (this.landmarkCoverTarget[index] - this.landmarkCoverCurrent[index]) * landmarkBlend;
    }

    const colorBlend = 1 - Math.exp(-deltaSeconds / 0.9);
    for (let channel = 0; channel < 3; channel += 1) {
      this.fogColor[channel] +=
        (this.fogColorTarget[channel] - this.fogColor[channel]) * colorBlend;
    }
  }

  private updateHud(force: boolean): void {
    const readoutText = formatVisibility(this.visibilityCurrent);
    if (force || readoutText !== this.lastReadoutText) {
      this.lastReadoutText = readoutText;
      if (this.readout) this.readout.textContent = readoutText;
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

    const horizonY = height * 0.62;
    const fogRgb = this.fogColor;

    this.drawGround(context, width, height, horizonY, fogRgb);
    this.drawHorizon(context, width, horizonY);
    this.drawLandmarks(context, width, height, horizonY, fogRgb);
    this.drawScreenFog(context, width, height, horizonY, fogRgb);
    this.drawTicksAndLabels(context, width, height, horizonY);
  }

  private drawGround(
    context: CanvasRenderingContext2D,
    width: number,
    height: number,
    horizonY: number,
    fogRgb: readonly [number, number, number],
  ): void {
    const gradient = context.createLinearGradient(0, horizonY, 0, height);
    const [r, g, b] = fogRgb;
    gradient.addColorStop(0, `rgba(${Math.round(r * 255)},${Math.round(g * 255)},${Math.round(b * 255)},0.08)`);
    gradient.addColorStop(1, 'rgba(8,14,22,0.55)');
    context.fillStyle = gradient;
    context.fillRect(0, horizonY, width, height - horizonY);
  }

  private drawHorizon(
    context: CanvasRenderingContext2D,
    width: number,
    horizonY: number,
  ): void {
    context.save();
    context.strokeStyle = 'rgba(255,255,255,0.22)';
    context.lineWidth = 1;
    context.beginPath();
    context.moveTo(0, horizonY + 0.5);
    context.lineTo(width, horizonY + 0.5);
    context.stroke();
    context.restore();
  }

  private drawLandmarks(
    context: CanvasRenderingContext2D,
    width: number,
    height: number,
    horizonY: number,
    fogRgb: readonly [number, number, number],
  ): void {
    const layout = landmarkLayout(width, height, horizonY);
    // 远 → 近绘制，近景盖住远景
    for (let order = LANDMARKS.length - 1; order >= 0; order -= 1) {
      const landmark = LANDMARKS[order];
      const place = layout[order];
      const cover = clamp01(this.landmarkCoverCurrent[order]);
      const perspective = atmosphericContrast(landmark.distanceKm * 1000);
      const alpha = (1 - cover) * perspective;
      if (alpha < 0.01) continue;

      const lift = mix(0.55, 0.12, cover);
      const fill = silhouetteFill(fogRgb, perspective, lift);

      context.save();
      context.globalAlpha = alpha;
      context.translate(place.x, place.baseY);
      context.scale(place.scale, place.scale);
      context.fillStyle = fill;
      context.fill(getLandmarkPath(landmark.key));
      context.restore();
    }
  }

  private drawAnalysisSparkline(): void {
    const canvas = this.analysisCanvas;
    if (!canvas || this.mode !== 'analysis') return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const cssWidth = Math.max(1, canvas.clientWidth || 240);
    const cssHeight = Math.max(1, canvas.clientHeight || 56);
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
      const v = this.visibility[i];
      if (v < min) min = v;
      if (v > max) max = v;
    }
    if (!Number.isFinite(min) || !Number.isFinite(max)) {
      min = 0;
      max = 20_000;
    }
    const span = Math.max(500, max - min);
    min -= span * 0.08;
    max += span * 0.08;
    const range = max - min;

    const padX = 2;
    const padY = 6;
    const plotW = cssWidth - padX * 2;
    const plotH = cssHeight - padY * 2;

    ctx.strokeStyle = 'rgba(255,255,255,0.16)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(padX, padY + plotH);
    ctx.lineTo(padX + plotW, padY + plotH);
    ctx.stroke();

    const accent =
      (this.root &&
        typeof getComputedStyle !== 'undefined' &&
        getComputedStyle(this.root).getPropertyValue('--accent').trim()) ||
      '#a8d4e8';
    ctx.strokeStyle = accent;
    ctx.lineWidth = 1.6;
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.beginPath();
    for (let hour = 0; hour < HOURS; hour += 1) {
      const x = padX + (hour / 24) * plotW;
      const y = padY + plotH - ((this.visibility[hour] - min) / range) * plotH;
      if (hour === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();

    const hour = clamp(this.timeMinutes / 60, 0, 24);
    const cursorX = padX + (hour / 24) * plotW;
    const cursorY =
      padY + plotH - ((sampleSeries(this.visibility, this.timeMinutes) - min) / range) * plotH;
    ctx.fillStyle = accent;
    ctx.beginPath();
    ctx.arc(cursorX, cursorY, 2.4, 0, Math.PI * 2);
    ctx.fill();
  }

  private drawScreenFog(
    context: CanvasRenderingContext2D,
    width: number,
    height: number,
    horizonY: number,
    fogRgb: readonly [number, number, number],
  ): void {
    const visibility = Math.max(this.visibilityCurrent, 50);
    const clearFactor = clamp01((CLEAR_VISIBILITY_M - visibility) / CLEAR_VISIBILITY_M);
    const humidityBoost = humidityNearFogAmount(this.humidityCurrent);
    const baseAlpha = clearFactor * 0.42 + humidityBoost * 0.18;

    const [r, g, b] = fogRgb;
    const rgb = `${Math.round(r * 255)},${Math.round(g * 255)},${Math.round(b * 255)}`;

    // 距地平线越远（画面上部 / 地面远处）雾越浓
    const skyFog = context.createLinearGradient(0, 0, 0, horizonY);
    skyFog.addColorStop(0, `rgba(${rgb},${(baseAlpha * 0.55).toFixed(3)})`);
    skyFog.addColorStop(0.72, `rgba(${rgb},${(baseAlpha * 0.22).toFixed(3)})`);
    skyFog.addColorStop(1, `rgba(${rgb},${(baseAlpha * 0.08).toFixed(3)})`);
    context.fillStyle = skyFog;
    context.fillRect(0, 0, width, horizonY);

    const groundFog = context.createLinearGradient(0, horizonY, 0, height);
    groundFog.addColorStop(0, `rgba(${rgb},${(baseAlpha * 0.12 + humidityBoost * 0.1).toFixed(3)})`);
    groundFog.addColorStop(1, `rgba(${rgb},${(baseAlpha * 0.05).toFixed(3)})`);
    context.fillStyle = groundFog;
    context.fillRect(0, horizonY, width, height - horizonY);

    if (QUALITY[this.quality].fogNoise && baseAlpha > 0.04) {
      const pattern = this.ensureNoisePattern(context);
      if (pattern) {
        context.save();
        context.globalAlpha = Math.min(0.12, baseAlpha * 0.35);
        context.fillStyle = pattern;
        context.fillRect(0, 0, width, height);
        context.restore();
      }
    }
  }

  private drawTicksAndLabels(
    context: CanvasRenderingContext2D,
    width: number,
    height: number,
    horizonY: number,
  ): void {
    const layout = landmarkLayout(width, height, horizonY);
    const justVisible = justVisibleLandmark(this.visibilityCurrent);
    const justKey = justVisible?.key ?? null;

    context.save();
    context.font = '9px Outfit, "PingFang SC", "Hiragino Sans GB", sans-serif';
    context.textAlign = 'center';
    context.textBaseline = 'top';
    context.fillStyle = 'rgba(255,255,255,0.45)';

    for (let index = 0; index < LANDMARKS.length; index += 1) {
      const landmark = LANDMARKS[index];
      const place = layout[index];
      const cover = clamp01(this.landmarkCoverCurrent[index]);
      const labelAlpha = (1 - cover) * 0.9 + 0.1;
      if (labelAlpha < 0.12) continue;

      context.globalAlpha = labelAlpha;
      context.fillText(formatTickDistance(landmark.distanceKm), place.x, place.baseY + 8);

      if (landmark.key === justKey && cover < 0.92) {
        context.globalAlpha = Math.max(0.4, 1 - cover);
        context.font = '11px Outfit, "PingFang SC", "Hiragino Sans GB", sans-serif';
        context.textBaseline = 'bottom';
        const label = `刚好能看到 ${formatLandmarkDistance(landmark.distanceKm)} 外的${landmark.name}`;
        const labelY = place.baseY - place.scale * place.labelLift - 6;
        const metrics = context.measureText(label);
        let textX = place.x - metrics.width / 2;
        textX = clamp(textX, 8, width - metrics.width - 8);
        context.textAlign = 'left';
        context.fillStyle = 'rgba(255,255,255,0.78)';
        context.shadowColor = 'rgba(8,14,22,0.55)';
        context.shadowBlur = 8;
        context.fillText(label, textX, labelY);
        context.shadowBlur = 0;
        context.textAlign = 'center';
        context.textBaseline = 'top';
        context.font = '9px Outfit, "PingFang SC", "Hiragino Sans GB", sans-serif';
        context.fillStyle = 'rgba(255,255,255,0.45)';
      }
    }
    context.restore();
  }

  private ensureNoisePattern(context: CanvasRenderingContext2D): CanvasPattern | null {
    if (this.noisePattern) return this.noisePattern;
    const tile = document.createElement('canvas');
    tile.width = 64;
    tile.height = 64;
    const tileCtx = tile.getContext('2d');
    if (!tileCtx) return null;
    const image = tileCtx.createImageData(64, 64);
    for (let index = 0; index < image.data.length; index += 4) {
      const n = (hash2(index * 0.17, index * 0.31) * 255) | 0;
      image.data[index] = n;
      image.data[index + 1] = n;
      image.data[index + 2] = n;
      image.data[index + 3] = 40;
    }
    tileCtx.putImageData(image, 0, 0);
    this.noisePattern = context.createPattern(tile, 'repeat');
    return this.noisePattern;
  }

  private sampleSkyColor(): void {
    if (this.readSkyColorHint()) return;

    const source = this.findBackdropCanvas();
    const probe = this.colorProbeCanvas;
    const probeCtx = this.colorProbeContext;
    if (!source || !probe || !probeCtx) {
      this.useFallbackFogColor();
      return;
    }

    try {
      probeCtx.clearRect(0, 0, probe.width, probe.height);
      probeCtx.drawImage(source, 0, 0, probe.width, probe.height);
      const pixels = probeCtx.getImageData(0, 0, probe.width, probe.height).data;
      let red = 0;
      let green = 0;
      let blue = 0;
      let count = 0;
      for (let index = 0; index < pixels.length; index += 4) {
        red += pixels[index];
        green += pixels[index + 1];
        blue += pixels[index + 2];
        count += 1;
      }
      if (count > 0) {
        this.setLightenedFogColor(red / count / 255, green / count / 255, blue / count / 255);
        return;
      }
    } catch {
      // tainted canvas — fall through
    }
    this.useFallbackFogColor();
  }

  private findBackdropCanvas(): HTMLCanvasElement | null {
    const searchRoot = this.container?.parentElement ?? document.body;
    const own = new Set([this.canvas, this.colorProbeCanvas]);
    let best: HTMLCanvasElement | null = null;
    let bestScore = 0;

    for (const canvas of searchRoot.querySelectorAll('canvas')) {
      if (own.has(canvas) || !canvas.isConnected || canvas.width < 2 || canvas.height < 2) {
        continue;
      }
      const rect = canvas.getBoundingClientRect();
      if (rect.width < 2 || rect.height < 2) continue;
      const style = getComputedStyle(canvas);
      if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) {
        continue;
      }
      let score = rect.width * rect.height;
      if (
        this.root &&
        (canvas.compareDocumentPosition(this.root) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0
      ) {
        score *= 1.2;
      }
      if (score > bestScore) {
        best = canvas;
        bestScore = score;
      }
    }
    return best;
  }

  private readSkyColorHint(): boolean {
    const source =
      this.container?.parentElement ?? this.container ?? document.documentElement;
    const datasetColor =
      (source as HTMLElement).dataset?.skyAverageColor ??
      document.documentElement.dataset.skyAverageColor;
    const cssColor = getComputedStyle(source).getPropertyValue('--sky-average-color').trim();
    const parsed = this.parseCssColor(datasetColor || cssColor);
    if (!parsed) return false;
    this.setLightenedFogColor(parsed[0], parsed[1], parsed[2]);
    return true;
  }

  private parseCssColor(value: string | undefined): [number, number, number] | null {
    const context = this.colorProbeContext;
    if (!context || !value) return null;
    try {
      context.save();
      context.clearRect(0, 0, 1, 1);
      context.fillStyle = '#010203';
      const sentinel = context.fillStyle;
      context.fillStyle = value;
      if (context.fillStyle === sentinel && value.trim().toLowerCase() !== sentinel) {
        context.restore();
        return null;
      }
      context.fillRect(0, 0, 1, 1);
      const pixel = context.getImageData(0, 0, 1, 1).data;
      context.restore();
      return [pixel[0] / 255, pixel[1] / 255, pixel[2] / 255];
    } catch {
      return null;
    }
  }

  private useFallbackFogColor(): void {
    this.fogColorTarget[0] = FALLBACK_FOG_COLOR[0];
    this.fogColorTarget[1] = FALLBACK_FOG_COLOR[1];
    this.fogColorTarget[2] = FALLBACK_FOG_COLOR[2];
  }

  private setLightenedFogColor(red: number, green: number, blue: number): void {
    const lighten = 0.38;
    this.fogColorTarget[0] = clamp01(red + (1 - red) * lighten);
    this.fogColorTarget[1] = clamp01(green + (1 - green) * lighten);
    this.fogColorTarget[2] = clamp01(blue + (1 - blue) * lighten);
  }
}

/* ── 雾 / 地标纯函数（可单测）─────────────────────────────────────────── */

/** 地标雾盖：0 清晰，1 完全隐没。验收：V=25km 全清；V=8km 时 8km 以外隐没；V=500m 只剩树。 */
export function landmarkFogCover(
  distanceM: number,
  visibilityM: number,
  humidity = 60,
): number {
  const v = Math.max(visibilityM, 50);
  const d = Math.max(distanceM, 0);

  let cover: number;
  if (v >= CLEAR_VISIBILITY_M) {
    // 20km+：仅极淡大气透视残留
    cover = clamp01((d / 32_000) * 0.06);
  } else {
    // 软边：d≈V 时 cover≈JUST_VISIBLE_COVER；d > V 迅速趋近 1
    const edge = Math.max(v * 0.22, 180);
    cover = smoothstep(v - edge * 0.85, v + edge * 0.9, d);
  }

  const near = humidityNearFogAmount(humidity);
  if (near > 0) {
    const nearWeight =
      near * HUMIDITY_FOG.nearFogWeight * (1 - smoothstep(0, HUMIDITY_FOG.nearRangeM, d));
    cover = clamp01(cover + nearWeight * (1 - cover * 0.35));
  }
  return cover;
}

export function justVisibleLandmark(visibilityM: number): LandmarkDef | null {
  const v = Math.max(visibilityM, 50);
  let best: LandmarkDef | null = null;
  let bestScore = Infinity;

  for (const landmark of LANDMARKS) {
    const cover = landmarkFogCover(landmark.distanceKm * 1000, v, 60);
    // 选雾盖最接近「刚好可见」且尚未完全隐没的地标
    if (cover >= 0.95) continue;
    const score = Math.abs(cover - JUST_VISIBLE_COVER) + Math.abs(landmark.distanceKm * 1000 - v) / v;
    if (score < bestScore) {
      bestScore = score;
      best = landmark;
    }
  }

  if (best) return best;

  // 极高能见度：最远地标
  if (v >= CLEAR_VISIBILITY_M) return LANDMARKS[LANDMARKS.length - 1];
  return LANDMARKS[0];
}

function humidityNearFogAmount(humidity: number): number {
  return smoothstep(HUMIDITY_FOG.rhThreshold, 100, clamp(humidity, 0, 100));
}

function atmosphericContrast(distanceM: number): number {
  // 近深远淡：对比度随距离衰减（大气透视）
  const t = clamp01(distanceM / 32_000);
  return mix(1, 0.38, t ** 0.65);
}

function silhouetteFill(
  fogRgb: readonly [number, number, number],
  perspective: number,
  lift: number,
): string {
  // 近景深色剪影，远景抬向雾色
  const dark = 0.04;
  const r = mix(dark, fogRgb[0], (1 - perspective) * 0.75 + lift * 0.35);
  const g = mix(dark, fogRgb[1], (1 - perspective) * 0.75 + lift * 0.35);
  const b = mix(dark, fogRgb[2], (1 - perspective) * 0.75 + lift * 0.35);
  return `rgb(${Math.round(r * 255)},${Math.round(g * 255)},${Math.round(b * 255)})`;
}

interface LandmarkPlace {
  x: number;
  baseY: number;
  scale: number;
  labelLift: number;
}

function landmarkLayout(width: number, height: number, horizonY: number): LandmarkPlace[] {
  const left = width * 0.1;
  const right = width * 0.9;
  const count = LANDMARKS.length;
  const maxH = height * 0.28;

  return LANDMARKS.map((landmark, index) => {
    const t = count === 1 ? 0.5 : index / (count - 1);
    // 对数距离轴：近疏远密略拉开
    const logT = Math.log1p(landmark.distanceKm) / Math.log1p(32);
    const x = mix(left, right, mix(t, logT, 0.35));
    const sizeFactor = mix(1, 0.28, logT);
    const scale = (maxH / 90) * sizeFactor;
    const baseY = horizonY + mix(6, -2, logT);
    const labelLift = mix(78, 36, logT);
    return { x, baseY, scale, labelLift };
  });
}

function getLandmarkPath(key: LandmarkKey): Path2D {
  const cached = LANDMARK_PATH_CACHE.get(key);
  if (cached) return cached;

  const path = new Path2D();
  switch (key) {
    case 'tree':
      path.moveTo(0, 0);
      path.lineTo(4, 0);
      path.lineTo(4, -18);
      path.lineTo(22, -18);
      path.lineTo(8, -48);
      path.lineTo(18, -48);
      path.lineTo(0, -78);
      path.lineTo(-18, -48);
      path.lineTo(-8, -48);
      path.lineTo(-22, -18);
      path.lineTo(-4, -18);
      path.lineTo(-4, 0);
      break;
    case 'buildings':
      path.moveTo(-40, 0);
      path.lineTo(-40, -36);
      path.lineTo(-28, -36);
      path.lineTo(-28, -58);
      path.lineTo(-12, -58);
      path.lineTo(-12, -44);
      path.lineTo(2, -44);
      path.lineTo(2, -72);
      path.lineTo(18, -72);
      path.lineTo(18, -50);
      path.lineTo(34, -50);
      path.lineTo(34, -28);
      path.lineTo(40, -28);
      path.lineTo(40, 0);
      break;
    case 'tower':
      path.moveTo(-16, 0);
      path.lineTo(-12, -22);
      path.lineTo(-6, -22);
      path.lineTo(-4, -55);
      path.lineTo(-10, -58);
      path.lineTo(-10, -64);
      path.lineTo(-3, -64);
      path.lineTo(-2, -88);
      path.lineTo(2, -88);
      path.lineTo(3, -64);
      path.lineTo(10, -64);
      path.lineTo(10, -58);
      path.lineTo(4, -55);
      path.lineTo(6, -22);
      path.lineTo(12, -22);
      path.lineTo(16, 0);
      path.moveTo(-1, -88);
      path.lineTo(0, -110);
      path.lineTo(1, -88);
      break;
    case 'chimney':
      path.moveTo(-28, 0);
      path.lineTo(-28, -30);
      path.lineTo(-18, -30);
      path.lineTo(-18, -70);
      path.lineTo(-12, -78);
      path.lineTo(-8, -70);
      path.lineTo(-8, -30);
      path.lineTo(6, -30);
      path.lineTo(6, -62);
      path.lineTo(12, -70);
      path.lineTo(16, -62);
      path.lineTo(16, -30);
      path.lineTo(28, -30);
      path.lineTo(28, 0);
      break;
    case 'hills':
      path.moveTo(-55, 0);
      path.quadraticCurveTo(-35, -28, -18, -18);
      path.quadraticCurveTo(-2, -42, 16, -22);
      path.quadraticCurveTo(32, -36, 55, 0);
      break;
    case 'ridge':
      path.moveTo(-70, 0);
      path.lineTo(-48, -16);
      path.lineTo(-30, -10);
      path.lineTo(-8, -26);
      path.lineTo(14, -14);
      path.lineTo(34, -22);
      path.lineTo(54, -12);
      path.lineTo(70, 0);
      break;
  }
  path.closePath();
  LANDMARK_PATH_CACHE.set(key, path);
  return path;
}

export function formatVisibility(meters: number): string {
  const m = Math.max(0, meters);
  if (m < 1000) return `${Math.round(m)} m`;
  const km = m / 1000;
  if (km >= 10) return `${Math.round(km)} km`;
  return `${km.toFixed(1)} km`;
}

function formatLandmarkDistance(distanceKm: number): string {
  if (distanceKm < 1) return `${Math.round(distanceKm * 1000)}m`;
  if (Number.isInteger(distanceKm)) return `${distanceKm}km`;
  return `${distanceKm}km`;
}

function formatTickDistance(distanceKm: number): string {
  if (distanceKm < 1) return `${distanceKm}km`;
  return `${distanceKm}km`;
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

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function clamp01(value: number): number {
  return clamp(value, 0, 1);
}

function mix(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function smoothstep(edge0: number, edge1: number, x: number): number {
  if (edge0 === edge1) return x < edge0 ? 0 : 1;
  const t = clamp01((x - edge0) / (edge1 - edge0));
  return t * t * (3 - 2 * t);
}

function hash2(x: number, y: number): number {
  const n = Math.sin(x * 127.1 + y * 311.7) * 43758.5453;
  return n - Math.floor(n);
}
