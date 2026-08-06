/**
 * SunlightLayer —— 日晷：影子由真实太阳位置驱动。
 *
 * Canvas2D 伪 3D：圆盘地台 + 晷针 + 方位反向影子；
 * 昏影弧带与 UV 读数随 solarPosition / 逐时数据更新。
 */
import { get } from 'svelte/store';
import type { DayData, WeatherLayer } from '../../contracts';
import { solarPosition } from '../../astro/sun';
import { currentCity } from '../../stores/app';

type Quality = 'low' | 'medium' | 'high';
type Mode = 'feel' | 'analysis';

export type TwilightBand = 'day' | 'civil' | 'nautical' | 'astronomical' | 'night';

interface QualityConfig {
  dpr: number;
  shadowBlur: number;
  glowQuality: boolean;
}

interface ShadowState {
  /** 影子方位角（度），= 太阳方位角 + 180，已归一化 */
  bearing: number;
  /** 归一化长度 0–1（相对最大可视长度） */
  lengthNorm: number;
  /** 不透明度 0–1；夜晚为 0 */
  alpha: number;
  /** 太阳是否在地平线上 */
  sunUp: boolean;
}

const HOURS = 25;
const DAY_MINUTES = 1440;
const DEG = Math.PI / 180;

/** 影子长度封顶：高度角低于此值时按此角计算（度） */
const SHADOW_MIN_ELEVATION = 8;
/** 晷针等效高度（相对圆盘半径） */
const GNOMON_HEIGHT_RATIO = 0.42;
/** 暖光晕强度随云量衰减 */
const CLOUD_LIGHT_FACTOR = 0.8;

const TWILIGHT = {
  civil: 0,
  nautical: -6,
  astronomical: -12,
  night: -18,
} as const;

const TWILIGHT_LABELS: Record<Exclude<TwilightBand, 'day' | 'night'>, string> = {
  civil: '现在是民用昏影',
  nautical: '现在是航海昏影',
  astronomical: '现在是天文昏影',
};

/** WHO 紫外线指数分级（按整数档：0–2 / 3–5 / 6–7 / 8–10 / 11+） */
const UV_GRADES = [
  { max: 2, label: '低' },
  { max: 5, label: '中' },
  { max: 7, label: '高' },
  { max: 10, label: '很高' },
  { max: Infinity, label: '极高' },
] as const;

const QUALITY: Record<Quality, QualityConfig> = {
  high: { dpr: 1.75, shadowBlur: 14, glowQuality: true },
  medium: { dpr: 1.35, shadowBlur: 10, glowQuality: true },
  low: { dpr: 1, shadowBlur: 6, glowQuality: false },
};

const WEATHER_TAU = 0.08;

const LAYER_CSS = `
.serein-sunlight-layer {
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
.serein-sunlight-canvas {
  position: absolute;
  inset: 0;
  z-index: 0;
  display: block;
  width: 100%;
  height: 100%;
  pointer-events: none;
}
.serein-sunlight-header {
  position: absolute;
  top: max(28px, env(safe-area-inset-top));
  left: max(28px, env(safe-area-inset-left));
  z-index: 2;
  display: grid;
  gap: 10px;
  text-shadow: 0 1px 18px rgba(8,14,22,.32);
  pointer-events: none;
  transition: opacity 400ms ease;
}
.serein-sunlight-heading {
  display: flex;
  align-items: baseline;
  gap: 11px;
}
.serein-sunlight-heading h2,
.serein-sunlight-heading p,
.serein-sunlight-readout,
.serein-sunlight-grade,
.serein-sunlight-caption {
  margin: 0;
}
.serein-sunlight-heading h2 {
  font-size: 17px;
  font-weight: 560;
  letter-spacing: .02em;
}
.serein-sunlight-heading p {
  color: var(--fg-2, rgba(255,255,255,.45));
  font-size: 11px;
  font-weight: 500;
  letter-spacing: .08em;
}
.serein-sunlight-current {
  display: flex;
  align-items: baseline;
  gap: 12px;
}
.serein-sunlight-readout {
  color: var(--fg-1, rgba(255,255,255,.92));
  font: inherit;
  font-size: 56px;
  font-weight: 340;
  letter-spacing: -.055em;
  line-height: .9;
  font-variant-numeric: tabular-nums;
}
.serein-sunlight-grade {
  color: var(--fg-2, rgba(255,255,255,.45));
  font-size: 13px;
  font-weight: 520;
  letter-spacing: .06em;
  white-space: nowrap;
}
.serein-sunlight-caption {
  color: var(--fg-2, rgba(255,255,255,.45));
  font-size: 11px;
  font-weight: 500;
  letter-spacing: .04em;
}
.serein-sunlight-layer[data-mode="analysis"] .serein-sunlight-header {
  opacity: 0.42;
}
.serein-sunlight-analysis {
  position: absolute;
  top: max(28px, env(safe-area-inset-top));
  right: max(28px, env(safe-area-inset-right));
  z-index: 2;
  display: grid;
  gap: 10px;
  min-width: 9.5rem;
  padding: 12px 14px;
  color: var(--fg-1, rgba(255,255,255,.92));
  text-shadow: 0 1px 14px rgba(8,14,22,.35);
  opacity: 0;
  visibility: hidden;
  pointer-events: none;
  transition: opacity 400ms ease, visibility 400ms step-end;
}
.serein-sunlight-layer[data-mode="analysis"] .serein-sunlight-analysis {
  opacity: 1;
  visibility: visible;
  transition: opacity 400ms ease, visibility 0ms step-start;
}
.serein-sunlight-analysis-label {
  margin: 0;
  color: var(--fg-2, rgba(255,255,255,.45));
  font-size: 9px;
  font-weight: 520;
  letter-spacing: .08em;
}
.serein-sunlight-analysis-value {
  margin: 0;
  font-size: 22px;
  font-weight: 420;
  letter-spacing: -.02em;
  font-variant-numeric: tabular-nums;
  line-height: 1.05;
}
.serein-sunlight-analysis-row {
  display: grid;
  gap: 2px;
}
.serein-sunlight-twilight-label {
  position: absolute;
  left: 50%;
  bottom: max(72px, calc(env(safe-area-inset-bottom) + 56px));
  z-index: 2;
  margin: 0;
  color: var(--fg-1, rgba(255,255,255,.92));
  font-size: 12px;
  font-weight: 520;
  letter-spacing: .04em;
  text-align: center;
  text-shadow: 0 1px 14px rgba(8,14,22,.4);
  white-space: nowrap;
  transform: translateX(-50%);
  opacity: 0;
  transition: opacity 320ms ease;
  pointer-events: none;
}
.serein-sunlight-twilight-label.is-visible {
  opacity: 1;
}
@media (max-width: 420px) {
  .serein-sunlight-header {
    top: max(22px, env(safe-area-inset-top));
    left: max(18px, env(safe-area-inset-left));
    gap: 8px;
  }
  .serein-sunlight-readout {
    font-size: 46px;
  }
  .serein-sunlight-analysis {
    top: auto;
    right: max(18px, env(safe-area-inset-right));
    bottom: max(120px, calc(env(safe-area-inset-bottom) + 100px));
    min-width: 8.5rem;
    padding: 10px 12px;
  }
  .serein-sunlight-analysis-value {
    font-size: 18px;
  }
  .serein-sunlight-twilight-label {
    bottom: max(64px, calc(env(safe-area-inset-bottom) + 48px));
    font-size: 11px;
  }
}
`;

export class SunlightLayer implements WeatherLayer {
  readonly id = 'sunlight';
  readonly name = '日照';
  readonly preferredSkyDim = 0.15;

  private container: HTMLElement | null = null;
  private root: HTMLElement | null = null;
  private canvas: HTMLCanvasElement | null = null;
  private context: CanvasRenderingContext2D | null = null;
  private uvReadout: HTMLOutputElement | null = null;
  private uvGrade: HTMLElement | null = null;
  private twilightLabel: HTMLElement | null = null;
  private analysisSunshine: HTMLElement | null = null;
  private analysisSunrise: HTMLElement | null = null;
  private analysisSunset: HTMLElement | null = null;

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
  private uvIndex = new Float32Array(HOURS).fill(0);
  private sunshineDuration = new Float32Array(HOURS).fill(0);
  private sunriseMinutes = 360;
  private sunsetMinutes = 1080;
  private hasData = false;
  private timeMinutes = 480;

  private cloudCurrent = 0.3;
  private cloudTarget = 0.3;
  private uvCurrent = 0;
  private uvTarget = 0;

  private lastUvText = '';
  private lastGradeText = '';
  private lastTwilightText = '';
  private lastTwilightVisible: boolean | null = null;
  private lastAnalysisSunshine = '';
  private lastAnalysisSunrise = '';
  private lastAnalysisSunset = '';

  mount(container: HTMLElement): void {
    if (this.root) return;

    this.container = container;
    this.abortController = new AbortController();
    this.elapsed = 0;

    this.createDom();
    this.attachEvents();

    this.resizeObserver = new ResizeObserver(this.resize);
    this.resizeObserver.observe(container);
    this.resize();
    this.retargetWeather();
    this.snapWeather();
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
    this.uvReadout = null;
    this.uvGrade = null;
    this.twilightLabel = null;
    this.analysisSunshine = null;
    this.analysisSunrise = null;
    this.analysisSunset = null;
    this.mode = 'feel';
  }

  setTime(minutes: number): void {
    this.timeMinutes = clamp(Number.isFinite(minutes) ? minutes : 0, 0, DAY_MINUTES);
    this.retargetWeather();
    this.updateHud(false);
  }

  setData(data: DayData): void {
    this.date = typeof data.date === 'string' && data.date ? data.date : todayIso();
    copySeries(data.cloudCover, this.cloudCover, 0.3, 0, 1);
    copySeries(data.uvIndex, this.uvIndex, 0, 0, 20);
    copySeries(data.sunshineDuration, this.sunshineDuration, 0, 0, 3600);

    if (data.astro) {
      if (Number.isFinite(data.astro.sunrise)) this.sunriseMinutes = clamp(data.astro.sunrise, 0, DAY_MINUTES);
      if (Number.isFinite(data.astro.sunset)) this.sunsetMinutes = clamp(data.astro.sunset, 0, DAY_MINUTES);
    }

    const first = !this.hasData;
    this.hasData = true;
    this.retargetWeather();
    if (first) this.snapWeather();
    this.updateHud(true);
  }

  setMode(mode: Mode): void {
    if (this.mode === mode) return;
    this.mode = mode;
    if (this.root) this.root.dataset.mode = mode;
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
    root.className = 'serein-sunlight-layer';
    root.setAttribute('aria-label', '日照与日晷影子');
    root.setAttribute('data-quality', this.quality);
    root.dataset.mode = this.mode;

    root.innerHTML = `
      <style>${LAYER_CSS}</style>
      <canvas class="serein-sunlight-canvas" aria-hidden="true"></canvas>
      <header class="serein-sunlight-header">
        <div class="serein-sunlight-heading">
          <h2>紫外线</h2>
          <p>UV</p>
        </div>
        <div class="serein-sunlight-current">
          <output class="serein-sunlight-readout" aria-label="当前紫外线指数">0</output>
          <p class="serein-sunlight-grade">低</p>
        </div>
        <p class="serein-sunlight-caption">日晷影子随太阳转动</p>
      </header>
      <aside class="serein-sunlight-analysis" aria-hidden="true">
        <div class="serein-sunlight-analysis-row">
          <p class="serein-sunlight-analysis-label">当日日照累计</p>
          <p class="serein-sunlight-analysis-value" data-analysis="sunshine">0.0 h</p>
        </div>
        <div class="serein-sunlight-analysis-row">
          <p class="serein-sunlight-analysis-label">日出</p>
          <p class="serein-sunlight-analysis-value" data-analysis="sunrise">--:--</p>
        </div>
        <div class="serein-sunlight-analysis-row">
          <p class="serein-sunlight-analysis-label">日落</p>
          <p class="serein-sunlight-analysis-value" data-analysis="sunset">--:--</p>
        </div>
      </aside>
      <p class="serein-sunlight-twilight-label" aria-live="polite"></p>
    `;

    this.container?.appendChild(root);
    this.root = root;
    this.canvas = root.querySelector<HTMLCanvasElement>('.serein-sunlight-canvas');
    this.context = this.canvas?.getContext('2d') ?? null;
    this.uvReadout = root.querySelector<HTMLOutputElement>('.serein-sunlight-readout');
    this.uvGrade = root.querySelector<HTMLElement>('.serein-sunlight-grade');
    this.twilightLabel = root.querySelector<HTMLElement>('.serein-sunlight-twilight-label');
    this.analysisSunshine = root.querySelector<HTMLElement>('[data-analysis="sunshine"]');
    this.analysisSunrise = root.querySelector<HTMLElement>('[data-analysis="sunrise"]');
    this.analysisSunset = root.querySelector<HTMLElement>('[data-analysis="sunset"]');
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
  };

  private retargetWeather(): void {
    this.cloudTarget = clamp(sampleSeries(this.cloudCover, this.timeMinutes), 0, 1);
    this.uvTarget = clamp(sampleSeries(this.uvIndex, this.timeMinutes), 0, 20);
  }

  private snapWeather(): void {
    this.cloudCurrent = this.cloudTarget;
    this.uvCurrent = this.uvTarget;
  }

  private stepWeather(deltaSeconds: number): void {
    const blend = 1 - Math.exp(-deltaSeconds / WEATHER_TAU);
    this.cloudCurrent += (this.cloudTarget - this.cloudCurrent) * blend;
    this.uvCurrent += (this.uvTarget - this.uvCurrent) * blend;
  }

  private updateHud(force: boolean): void {
    const uvText = formatUv(this.uvCurrent);
    if (force || uvText !== this.lastUvText) {
      this.lastUvText = uvText;
      if (this.uvReadout) this.uvReadout.textContent = uvText;
    }

    const gradeText = uvGradeLabel(this.uvCurrent);
    if (force || gradeText !== this.lastGradeText) {
      this.lastGradeText = gradeText;
      if (this.uvGrade) this.uvGrade.textContent = gradeText;
    }

    const city = get(currentCity);
    const solar = solarPosition(this.date, this.timeMinutes, city.lat, city.lon);
    const band = twilightBand(solar.elevation);
    const twilightText = TWILIGHT_LABELS[band as keyof typeof TWILIGHT_LABELS] ?? '';
    const twilightVisible = twilightText.length > 0;
    if (force || twilightText !== this.lastTwilightText) {
      this.lastTwilightText = twilightText;
      if (this.twilightLabel) this.twilightLabel.textContent = twilightText;
    }
    if (force || twilightVisible !== this.lastTwilightVisible) {
      this.lastTwilightVisible = twilightVisible;
      this.twilightLabel?.classList.toggle('is-visible', twilightVisible);
    }

    const sunshineText = `${cumulativeSunshineHours(this.sunshineDuration).toFixed(1)} h`;
    if (force || sunshineText !== this.lastAnalysisSunshine) {
      this.lastAnalysisSunshine = sunshineText;
      if (this.analysisSunshine) this.analysisSunshine.textContent = sunshineText;
    }

    const sunriseText = formatClock(this.sunriseMinutes);
    if (force || sunriseText !== this.lastAnalysisSunrise) {
      this.lastAnalysisSunrise = sunriseText;
      if (this.analysisSunrise) this.analysisSunrise.textContent = sunriseText;
    }

    const sunsetText = formatClock(this.sunsetMinutes);
    if (force || sunsetText !== this.lastAnalysisSunset) {
      this.lastAnalysisSunset = sunsetText;
      if (this.analysisSunset) this.analysisSunset.textContent = sunsetText;
    }
  }

  private draw(): void {
    const context = this.context;
    const canvas = this.canvas;
    if (!context || !canvas) return;

    const width = this.cssWidth;
    const height = this.cssHeight;
    const dpr = this.pixelRatio;
    const city = get(currentCity);
    const solar = solarPosition(this.date, this.timeMinutes, city.lat, city.lon);
    const shadow = computeShadow(solar.azimuth, solar.elevation);
    const band = twilightBand(solar.elevation);
    const lightStrength =
      shadow.sunUp
        ? Math.sin(Math.max(0, solar.elevation) * DEG) * (1 - this.cloudCurrent * CLOUD_LIGHT_FACTOR)
        : 0;

    context.setTransform(dpr, 0, 0, dpr, 0, 0);
    context.clearRect(0, 0, width, height);

    const cx = width * 0.5;
    const cy = height * 0.46;
    const dialRadius = Math.min(width, height) * 0.28;

    if (lightStrength > 0.01) {
      this.drawSunGlow(context, width, height, cx, cy, solar.azimuth, lightStrength);
    }

    this.drawDial(context, cx, cy, dialRadius, lightStrength);
    this.drawShadow(context, cx, cy, dialRadius, shadow, this.uvCurrent);
    this.drawGnomon(context, cx, cy, dialRadius, lightStrength, this.uvCurrent);
    this.drawTwilightArc(context, width, height, solar.elevation, band);
  }

  private drawSunGlow(
    context: CanvasRenderingContext2D,
    width: number,
    height: number,
    cx: number,
    cy: number,
    azimuth: number,
    strength: number,
  ): void {
    if (!QUALITY[this.quality].glowQuality && strength < 0.08) return;

    // 太阳方位：自北顺时针；屏幕 N 在上 → 光从该方向射入
    const sunX = Math.sin(azimuth * DEG);
    const sunY = -Math.cos(azimuth * DEG);
    const reach = Math.max(width, height) * 0.95;
    const ox = cx + sunX * reach * 0.55;
    const oy = cy + sunY * reach * 0.55;

    const gradient = context.createRadialGradient(ox, oy, 0, ox, oy, reach);
    const peak = 0.22 * strength;
    gradient.addColorStop(0, `rgba(255,196,120,${(peak * 0.95).toFixed(3)})`);
    gradient.addColorStop(0.35, `rgba(255,168,88,${(peak * 0.45).toFixed(3)})`);
    gradient.addColorStop(0.7, `rgba(255,140,70,${(peak * 0.12).toFixed(3)})`);
    gradient.addColorStop(1, 'rgba(255,140,70,0)');

    context.save();
    context.globalCompositeOperation = 'lighter';
    context.fillStyle = gradient;
    context.fillRect(0, 0, width, height);
    context.restore();
  }

  private drawDial(
    context: CanvasRenderingContext2D,
    cx: number,
    cy: number,
    radius: number,
    lightStrength: number,
  ): void {
    const fillAlpha = 0.04 + lightStrength * 0.06;
    context.save();

    // 地台微弱填充
    context.beginPath();
    context.arc(cx, cy, radius, 0, Math.PI * 2);
    context.fillStyle = `rgba(255,255,255,${fillAlpha.toFixed(3)})`;
    context.fill();

    // 1px 圆环
    context.beginPath();
    context.arc(cx, cy, radius, 0, Math.PI * 2);
    context.strokeStyle = 'rgba(255,255,255,0.45)';
    context.lineWidth = 1;
    context.stroke();

    // 方位刻度与 N/E/S/W
    const labels = [
      { az: 0, text: 'N' },
      { az: 90, text: 'E' },
      { az: 180, text: 'S' },
      { az: 270, text: 'W' },
    ] as const;

    context.strokeStyle = 'rgba(255,255,255,0.22)';
    context.fillStyle = 'rgba(255,255,255,0.45)';
    context.font = '11px Outfit, "PingFang SC", "Hiragino Sans GB", sans-serif';
    context.textAlign = 'center';
    context.textBaseline = 'middle';

    for (let tick = 0; tick < 360; tick += 30) {
      const rad = tick * DEG;
      const outer = radius;
      const inner = radius - (tick % 90 === 0 ? 10 : 5);
      const cos = Math.sin(rad);
      const sin = -Math.cos(rad);
      context.beginPath();
      context.moveTo(cx + cos * inner, cy + sin * inner);
      context.lineTo(cx + cos * outer, cy + sin * outer);
      context.stroke();
    }

    for (const { az, text } of labels) {
      const rad = az * DEG;
      const lx = cx + Math.sin(rad) * (radius + 16);
      const ly = cy - Math.cos(rad) * (radius + 16);
      context.fillText(text, lx, ly);
    }

    context.restore();
  }

  private drawShadow(
    context: CanvasRenderingContext2D,
    cx: number,
    cy: number,
    dialRadius: number,
    shadow: ShadowState,
    uv: number,
  ): void {
    if (shadow.alpha < 0.01 || shadow.lengthNorm < 0.01) return;

    const sharp = uv >= 6;
    const maxLen = dialRadius * 1.55;
    const length = shadow.lengthNorm * maxLen;
    const bearing = shadow.bearing * DEG;
    const dx = Math.sin(bearing);
    const dy = -Math.cos(bearing);
    const px = -dy;
    const py = dx;

    const tipX = cx + dx * length;
    const tipY = cy + dy * length;
    const baseHalf = dialRadius * (sharp ? 0.028 : 0.045);
    const tipHalf = dialRadius * (sharp ? 0.01 : 0.018);

    context.save();
    const blur = sharp
      ? Math.max(1, QUALITY[this.quality].shadowBlur * 0.28)
      : QUALITY[this.quality].shadowBlur * (0.55 + shadow.lengthNorm * 0.7);

    context.shadowColor = `rgba(0,0,0,${(shadow.alpha * (sharp ? 0.85 : 0.55)).toFixed(3)})`;
    context.shadowBlur = blur;
    context.fillStyle = `rgba(4,8,14,${(shadow.alpha * (sharp ? 0.72 : 0.48)).toFixed(3)})`;

    context.beginPath();
    context.moveTo(cx + px * baseHalf, cy + py * baseHalf);
    context.lineTo(cx - px * baseHalf, cy - py * baseHalf);
    context.lineTo(tipX - px * tipHalf, tipY - py * tipHalf);
    context.lineTo(tipX + px * tipHalf, tipY + py * tipHalf);
    context.closePath();
    context.fill();

    // 锐利模式下再叠一层硬边核心
    if (sharp) {
      context.shadowBlur = 0;
      context.fillStyle = `rgba(2,6,12,${(shadow.alpha * 0.55).toFixed(3)})`;
      context.fill();
    }

    context.restore();
  }

  private drawGnomon(
    context: CanvasRenderingContext2D,
    cx: number,
    cy: number,
    dialRadius: number,
    lightStrength: number,
    uv: number,
  ): void {
    const height = dialRadius * GNOMON_HEIGHT_RATIO;
    const baseHalf = dialRadius * 0.035;
    const tipX = cx;
    const tipY = cy - height;

    // 环境光 / 日照：夜晚仅微弱亮起
    const ambient = 0.18 + lightStrength * 0.55;
    const body = `rgba(235,240,248,${clamp(ambient, 0.14, 0.92).toFixed(3)})`;
    const edge = `rgba(255,255,255,${clamp(0.25 + lightStrength * 0.4, 0.2, 0.85).toFixed(3)})`;

    context.save();

    // UV 顶端光晕
    const uvNorm = clamp(uv / 11, 0, 1.35);
    if (uvNorm > 0.02) {
      const glowR = dialRadius * (0.08 + uvNorm * 0.22);
      const glow = context.createRadialGradient(tipX, tipY, 0, tipX, tipY, glowR);
      const peak = 0.18 + uvNorm * 0.55;
      glow.addColorStop(0, `rgba(255,220,140,${peak.toFixed(3)})`);
      glow.addColorStop(0.45, `rgba(255,180,90,${(peak * 0.35).toFixed(3)})`);
      glow.addColorStop(1, 'rgba(255,160,70,0)');
      context.globalCompositeOperation = 'lighter';
      context.fillStyle = glow;
      context.beginPath();
      context.arc(tipX, tipY, glowR, 0, Math.PI * 2);
      context.fill();
      context.globalCompositeOperation = 'source-over';
    }

    // 细长三角晷针
    context.beginPath();
    context.moveTo(cx - baseHalf, cy + baseHalf * 0.35);
    context.lineTo(cx + baseHalf, cy + baseHalf * 0.35);
    context.lineTo(tipX, tipY);
    context.closePath();
    context.fillStyle = body;
    context.fill();
    context.strokeStyle = edge;
    context.lineWidth = 1;
    context.stroke();

    // 针尖高光点
    context.beginPath();
    context.arc(tipX, tipY, Math.max(1.2, dialRadius * 0.012), 0, Math.PI * 2);
    context.fillStyle = `rgba(255,255,255,${clamp(0.35 + lightStrength * 0.45 + uvNorm * 0.2, 0.3, 1).toFixed(3)})`;
    context.fill();

    context.restore();
  }

  private drawTwilightArc(
    context: CanvasRenderingContext2D,
    width: number,
    height: number,
    elevation: number,
    band: TwilightBand,
  ): void {
    const cx = width * 0.5;
    const cy = height + width * 0.08;
    const radius = width * 0.62;
    const startAngle = Math.PI + 0.55;
    const endAngle = -0.55;
    const sweep = endAngle - startAngle; // negative (clockwise visually via arc)

    const bands: Array<{
      key: Exclude<TwilightBand, 'day' | 'night'>;
      from: number;
      to: number;
      colors: [string, string];
    }> = [
      {
        key: 'civil',
        from: TWILIGHT.civil,
        to: TWILIGHT.nautical,
        colors: ['rgba(255,176,96,0.85)', 'rgba(210,120,90,0.7)'],
      },
      {
        key: 'nautical',
        from: TWILIGHT.nautical,
        to: TWILIGHT.astronomical,
        colors: ['rgba(120,110,160,0.75)', 'rgba(70,90,150,0.7)'],
      },
      {
        key: 'astronomical',
        from: TWILIGHT.astronomical,
        to: TWILIGHT.night,
        colors: ['rgba(50,70,130,0.7)', 'rgba(20,36,80,0.75)'],
      },
    ];

    const elevToT = (elev: number): number =>
      clamp((0 - elev) / (0 - TWILIGHT.night), 0, 1);

    context.save();
    context.lineCap = 'butt';

    // 底轨
    context.beginPath();
    context.arc(cx, cy, radius, startAngle, endAngle, true);
    context.strokeStyle = 'rgba(255,255,255,0.12)';
    context.lineWidth = 7;
    context.stroke();

    for (const segment of bands) {
      const t0 = elevToT(segment.from);
      const t1 = elevToT(segment.to);
      const a0 = startAngle + sweep * t0;
      const a1 = startAngle + sweep * t1;
      const active = band === segment.key;
      const alphaBoost = active ? 1 : 0.38;

      context.beginPath();
      context.arc(cx, cy, radius, a0, a1, true);
      const gx0 = cx + Math.cos(a0) * radius;
      const gy0 = cy + Math.sin(a0) * radius;
      const gx1 = cx + Math.cos(a1) * radius;
      const gy1 = cy + Math.sin(a1) * radius;
      const gradient = context.createLinearGradient(gx0, gy0, gx1, gy1);
      gradient.addColorStop(0, withAlpha(segment.colors[0], alphaBoost));
      gradient.addColorStop(1, withAlpha(segment.colors[1], alphaBoost));
      context.strokeStyle = gradient;
      context.lineWidth = active ? 9 : 6;
      context.stroke();
    }

    // 当前高度角标记（仅昏影/近地平）
    if (elevation < 2 && elevation > TWILIGHT.night - 2) {
      const t = elevToT(clamp(elevation, TWILIGHT.night, 0));
      const angle = startAngle + sweep * t;
      const mx = cx + Math.cos(angle) * radius;
      const my = cy + Math.sin(angle) * radius;
      context.beginPath();
      context.arc(mx, my, 4.5, 0, Math.PI * 2);
      context.fillStyle = 'rgba(255,255,255,0.9)';
      context.fill();
      context.strokeStyle = 'rgba(8,14,22,0.45)';
      context.lineWidth = 1;
      context.stroke();
    }

    // 区段刻度文字
    context.fillStyle = 'rgba(255,255,255,0.45)';
    context.font = '9px Outfit, "PingFang SC", "Hiragino Sans GB", sans-serif';
    context.textAlign = 'center';
    context.textBaseline = 'middle';
    const ticks: Array<{ elev: number; label: string }> = [
      { elev: 0, label: '0°' },
      { elev: -6, label: '民用' },
      { elev: -12, label: '航海' },
      { elev: -18, label: '天文' },
    ];
    for (const tick of ticks) {
      const t = elevToT(tick.elev);
      const angle = startAngle + sweep * t;
      const lx = cx + Math.cos(angle) * (radius + 14);
      const ly = cy + Math.sin(angle) * (radius + 14);
      context.fillText(tick.label, lx, ly);
    }

    context.restore();
  }
}

/* ── 纯函数（导出供验收测试）──────────────────────────────────────── */

/** 影子方位 = 太阳方位 + 180°，归一化到 [0, 360) */
export function shadowBearing(sunAzimuth: number): number {
  return ((sunAzimuth + 180) % 360 + 360) % 360;
}

/**
 * 影子长度（相对晷针高度）：1/tan(elev)，高度角过低时封顶。
 * elev ≤ 0 → 0
 */
export function shadowLengthRatio(elevationDeg: number): number {
  if (elevationDeg <= 0) return 0;
  const capped = Math.max(elevationDeg, SHADOW_MIN_ELEVATION);
  return 1 / Math.tan(capped * DEG);
}

export function computeShadow(sunAzimuth: number, elevationDeg: number): ShadowState {
  const sunUp = elevationDeg > 0;
  if (!sunUp) {
    return { bearing: shadowBearing(sunAzimuth), lengthNorm: 0, alpha: 0, sunUp: false };
  }

  const maxRatio = 1 / Math.tan(SHADOW_MIN_ELEVATION * DEG);
  const ratio = shadowLengthRatio(elevationDeg);
  const lengthNorm = clamp(ratio / maxRatio, 0, 1);
  // 低角度：影子拉长变淡
  const elevFade = clamp(elevationDeg / 28, 0.22, 1);
  const lengthFade = 1 - lengthNorm * 0.55;
  const alpha = clamp(elevFade * lengthFade, 0.12, 0.78);

  return {
    bearing: shadowBearing(sunAzimuth),
    lengthNorm,
    alpha,
    sunUp: true,
  };
}

export function twilightBand(elevationDeg: number): TwilightBand {
  if (elevationDeg >= TWILIGHT.civil) return 'day';
  if (elevationDeg >= TWILIGHT.nautical) return 'civil';
  if (elevationDeg >= TWILIGHT.astronomical) return 'nautical';
  if (elevationDeg >= TWILIGHT.night) return 'astronomical';
  return 'night';
}

export function uvGradeLabel(uv: number): string {
  const value = Math.floor(Math.max(0, uv));
  for (const grade of UV_GRADES) {
    if (value <= grade.max) return grade.label;
  }
  return '极高';
}

/** sunshineDuration 为每小时秒数 → 累计小时 */
export function cumulativeSunshineHours(series: ArrayLike<number>): number {
  let seconds = 0;
  // 索引 0..23 为当日各小时；24 为日界冗余点，不计入
  for (let index = 0; index < HOURS - 1; index += 1) {
    const value = series[index];
    if (typeof value === 'number' && Number.isFinite(value)) {
      seconds += Math.max(0, value);
    }
  }
  return seconds / 3600;
}

export function formatClock(minutes: number): string {
  const safe = clamp(Math.round(minutes), 0, DAY_MINUTES);
  const wrapped = safe === DAY_MINUTES ? 0 : safe;
  const h = Math.floor(wrapped / 60);
  const m = wrapped % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

export function formatUv(uv: number): string {
  const value = clamp(uv, 0, 20);
  return value >= 10 ? value.toFixed(0) : value.toFixed(1);
}

export const SUNLIGHT_CONSTANTS = {
  SHADOW_MIN_ELEVATION,
  GNOMON_HEIGHT_RATIO,
  CLOUD_LIGHT_FACTOR,
  TWILIGHT,
} as const;

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

/** 调整 rgba(...) 字符串的 alpha 倍率（粗解析，仅本层色带用） */
function withAlpha(rgba: string, multiply: number): string {
  const match = rgba.match(/rgba?\(([^)]+)\)/i);
  if (!match) return rgba;
  const parts = match[1].split(',').map((part) => part.trim());
  if (parts.length < 4) return rgba;
  const alpha = clamp(Number(parts[3]) * multiply, 0, 1);
  return `rgba(${parts[0]},${parts[1]},${parts[2]},${alpha.toFixed(3)})`;
}
