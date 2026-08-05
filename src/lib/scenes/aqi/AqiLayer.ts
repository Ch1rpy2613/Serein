/**
 * AqiLayer —— 丁达尔效应空气场景。
 *
 * 全屏解析近似单散射光柱（无 ray marching）+ 实例化悬浮尘埃。
 * 散射系数由 PM2.5 驱动，尘埃密度由 PM10 驱动；色调随 US AQI 六档变化。
 */
import { particleBudget, subscribeReducedMotion } from '../../motion';
import type { DayData, WeatherLayer } from '../../contracts';

type Quality = 'low' | 'medium' | 'high';
type PollutantKey = 'pm25' | 'pm10' | 'o3' | 'no2' | 'so2' | 'co';

interface QualityConfig {
  maxDust: number;
  dpr: number;
}

interface AqiBand {
  max: number;
  label: string;
  color: string;
  rgb: [number, number, number];
}

interface PollutantChip {
  key: PollutantKey;
  label: string;
  unit: string;
  accent: [number, number, number];
}

/*
 * ── 标定表：PM2.5 → 屏幕空间散射系数 σ ──────────────────────────────
 *
 * 依据：
 * - WHO 2021 AQG 年均值 PM2.5 = 5 μg/m³ → 洁净气柱几乎不可见（接近瑞利极限）
 * - US EPA AQI 断点（μg/m³）：12 / 35.4 / 55.4 / 150.4 / 250.4
 * - 可见丁达尔浑浊主要来自细模态气溶胶散射；PM2.5 与消光大致正相关
 * - 此处 σ 为屏幕空间光学单位（非 km⁻¹），按验收视觉标定：
 *     pm25=5  → 光柱几乎隐形；pm25=150 → 明显浑浊光柱
 * 以后现场标定只需改本表，不必动 shader。
 */
const PM25_SCATTER_TABLE: ReadonlyArray<{ pm25: number; sigma: number }> = [
  { pm25: 0, sigma: 0.015 },
  { pm25: 5, sigma: 0.055 },
  { pm25: 12, sigma: 0.16 },
  { pm25: 35, sigma: 0.52 },
  { pm25: 55, sigma: 0.9 },
  { pm25: 100, sigma: 1.55 },
  { pm25: 150, sigma: 2.35 },
  { pm25: 250, sigma: 3.6 },
  { pm25: 500, sigma: 5.2 },
];

/*
 * ── 标定表：PM10 → 尘埃密度因子 [0–1] ───────────────────────────────
 *
 * 依据：
 * - PM10 含粗模态颗粒，更易在侧光下呈现「可见尘埃」
 * - 洁净日 PM10 ≈ 10–20 → 稀疏微粒；污染日 100–200 → 密集漂浮
 * - 验收：pm25=5（通常伴低 PM10）尘埃稀少；污染峰时密集
 * density 乘以质量档粒子上限得到有效粒子数，并控制单粒基础透明度。
 */
const PM10_DENSITY_TABLE: ReadonlyArray<{ pm10: number; density: number }> = [
  { pm10: 0, density: 0.03 },
  { pm10: 10, density: 0.1 },
  { pm10: 25, density: 0.22 },
  { pm10: 50, density: 0.42 },
  { pm10: 100, density: 0.72 },
  { pm10: 150, density: 0.9 },
  { pm10: 300, density: 1 },
];

/** US AQI 六档：色值 80% 不透明度在渲染时乘以 AQI_COLOR_ALPHA。 */
const AQI_BANDS: readonly AqiBand[] = [
  { max: 50, label: '优', color: '#00e400', rgb: [0, 228 / 255, 0] },
  { max: 100, label: '良', color: '#e6d200', rgb: [230 / 255, 210 / 255, 0] },
  { max: 150, label: '轻度污染', color: '#ff7e00', rgb: [1, 126 / 255, 0] },
  { max: 200, label: '中度污染', color: '#ff0000', rgb: [1, 0, 0] },
  { max: 300, label: '重度污染', color: '#8f3f97', rgb: [143 / 255, 63 / 255, 151 / 255] },
  { max: Infinity, label: '严重污染', color: '#7e0023', rgb: [126 / 255, 0, 35 / 255] },
];

const AQI_COLOR_ALPHA = 0.8;
/** 300ms 达约 95% 的指数缓动时间常数。 */
const EASE_TAU = 0.1;
const ACCENT_HOLD_SECONDS = 1.5;
const HOURS = 25;
const DAY_MINUTES = 1440;
const DUST_SEED = 0xa91ce7b3;

const POLLUTANTS: readonly PollutantChip[] = [
  { key: 'pm25', label: 'PM2.5', unit: 'μg/m³', accent: [1.0, 0.55, 0.18] },
  { key: 'pm10', label: 'PM10', unit: 'μg/m³', accent: [0.86, 0.72, 0.42] },
  { key: 'o3', label: 'O₃', unit: 'μg/m³', accent: [0.72, 0.42, 0.95] },
  { key: 'no2', label: 'NO₂', unit: 'μg/m³', accent: [0.95, 0.38, 0.32] },
  { key: 'so2', label: 'SO₂', unit: 'μg/m³', accent: [0.78, 0.92, 0.28] },
  { key: 'co', label: 'CO', unit: 'μg/m³', accent: [0.35, 0.82, 0.92] },
];

const QUALITY: Record<Quality, QualityConfig> = {
  high: { maxDust: 4200, dpr: 1.5 },
  medium: { maxDust: 2200, dpr: 1.25 },
  low: { maxDust: 900, dpr: 1 },
};

/** 光束：从左上角射入，朝右下；UV 原点左下。 */
const LIGHT_ORIGIN_UV: [number, number] = [0.02, 0.98];
const LIGHT_DIR_UV: [number, number] = [0.72, -0.7];
const CONE_HALF_ANGLE = 0.2; // radians in UV metric

const SHAFT_VERTEX = `
attribute vec2 aPosition;

void main() {
  gl_Position = vec4(aPosition, 0.0, 1.0);
}
`;

const SHAFT_FRAGMENT = `
#ifdef GL_FRAGMENT_PRECISION_HIGH
precision highp float;
#else
precision mediump float;
#endif

uniform vec2 uResolution;
uniform vec2 uLightOrigin;
uniform vec2 uLightDir;
uniform float uConeTan;
uniform float uScatter;
uniform vec3 uColor;
uniform float uColorAlpha;
uniform float uElapsed;

float hash21(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}

void main() {
  vec2 uv = gl_FragCoord.xy / max(uResolution, vec2(1.0));
  float aspect = uResolution.x / max(uResolution.y, 1.0);

  // 各向同性距离：横向按宽高比校正，避免光锥随屏幕拉伸。
  vec2 origin = uLightOrigin;
  vec2 dir = normalize(uLightDir);
  vec2 toPoint = (uv - origin) * vec2(aspect, 1.0);
  vec2 dirScaled = normalize(dir * vec2(aspect, 1.0));
  float along = dot(toPoint, dirScaled);
  vec2 closest = dirScaled * max(along, 0.0);
  float across = length(toPoint - closest);

  float radius = max(along, 0.0) * uConeTan + 0.012;
  float radial = 1.0 - smoothstep(radius * 0.12, radius, across);
  float axial = smoothstep(0.0, 0.04, along) * (1.0 - smoothstep(1.35, 1.85, along));
  float beamMask = radial * axial;

  // 解析单散射近似（无 ray marching）：
  //   I ≈ (1 - e^{-σ L}) · e^{-σ D} · mask
  // L ≈ 沿轴光程，D ≈ 径向偏移；σ 由 PM2.5 标定。
  float path = along * 0.85 + 0.25;
  float inScatter = 1.0 - exp(-uScatter * path);
  float extinction = exp(-uScatter * across * 2.4);
  float sigmaGain = mix(0.08, 1.0, clamp(uScatter / 2.4, 0.0, 1.0));
  float shaft = beamMask * inScatter * extinction * sigmaGain;

  // 极弱体积噪点，避免光柱过「塑料」。
  float grain = hash21(uv * uResolution * 0.35 + uElapsed * 0.07) * 0.04;
  float alpha = clamp(shaft * uColorAlpha * (0.96 + grain), 0.0, uColorAlpha);

  // 近光源端稍亮，模拟侧光入射。
  float hotspot = exp(-across * 14.0) * exp(-along * 1.8) * sigmaGain * 0.35;
  vec3 color = uColor * (0.72 + hotspot);
  gl_FragColor = vec4(color, alpha);
}
`;

const DUST_VERTEX = `
attribute vec2 aPosition;
attribute float aSeed;
attribute float aSize;

uniform vec2 uResolution;
uniform vec2 uLightOrigin;
uniform vec2 uLightDir;
uniform float uConeTan;
uniform float uDensity;
uniform float uPixelRatio;
uniform float uScatter;

varying float vLit;
varying float vAlpha;
varying float vSeed;

void main() {
  vSeed = aSeed;
  float visible = step(aSeed, clamp(uDensity, 0.0, 1.0));

  vec2 uv = aPosition;
  float aspect = uResolution.x / max(uResolution.y, 1.0);
  vec2 origin = uLightOrigin;
  vec2 dir = normalize(uLightDir);
  vec2 toPoint = (uv - origin) * vec2(aspect, 1.0);
  vec2 dirScaled = normalize(dir * vec2(aspect, 1.0));
  float along = dot(toPoint, dirScaled);
  float across = length(toPoint - dirScaled * max(along, 0.0));
  float radius = max(along, 0.0) * uConeTan + 0.014;
  float inBeam = (1.0 - smoothstep(radius * 0.08, radius, across)) * step(0.0, along);
  // 到光束中心线距离衰减
  float axisFalloff = exp(-across * 10.0);
  vLit = inBeam * axisFalloff;

  float baseAlpha = mix(0.04, 0.22, uDensity) * (0.45 + aSeed * 0.55);
  float litBoost = mix(0.12, 1.0, vLit);
  // 污染越重，光柱外尘埃也略可见；洁净时几乎只在光柱内闪一下。
  float ambient = mix(0.02, 0.18, clamp(uScatter / 2.5, 0.0, 1.0));
  vAlpha = visible * baseAlpha * (ambient + litBoost * (0.55 + uScatter * 0.18));

  vec2 clip = uv * 2.0 - 1.0;
  gl_Position = vec4(clip, 0.0, 1.0);
  float size = mix(1.2, 3.4, aSize) * uPixelRatio * mix(0.85, 1.35, vLit);
  gl_PointSize = clamp(size, 1.0, 7.0 * uPixelRatio);
}
`;

const DUST_FRAGMENT = `
#ifdef GL_FRAGMENT_PRECISION_HIGH
precision highp float;
#else
precision mediump float;
#endif

uniform vec3 uColor;
uniform vec3 uAccent;
uniform float uAccentMix;
uniform float uColorAlpha;

varying float vLit;
varying float vAlpha;
varying float vSeed;

void main() {
  vec2 p = gl_PointCoord - vec2(0.5);
  float r = length(p);
  if (r > 0.5) discard;
  float soft = 1.0 - smoothstep(0.12, 0.5, r);
  float core = exp(-r * r * 18.0);
  float shape = max(soft * 0.55, core);
  float alpha = vAlpha * shape * uColorAlpha;
  if (alpha < 0.004) discard;

  vec3 dust = mix(uColor, uAccent, uAccentMix);
  // 光柱内偏暖白高光，柱外保持档位色。
  dust = mix(dust * 0.75, mix(dust, vec3(1.0), 0.35), vLit);
  gl_FragColor = vec4(dust, alpha);
}
`;

const LAYER_CSS = `
.serein-aqi-layer {
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
.serein-aqi-canvas {
  position: absolute;
  inset: 0;
  z-index: 0;
  display: block;
  width: 100%;
  height: 100%;
  pointer-events: none;
}
.serein-aqi-header {
  position: absolute;
  top: max(28px, env(safe-area-inset-top));
  left: max(28px, env(safe-area-inset-left));
  z-index: 2;
  display: grid;
  gap: 12px;
  text-shadow: 0 1px 18px rgba(5,7,10,.32);
  pointer-events: none;
}
.serein-aqi-heading {
  display: flex;
  align-items: baseline;
  gap: 11px;
}
.serein-aqi-heading h2,
.serein-aqi-heading p,
.serein-aqi-readout,
.serein-aqi-grade {
  margin: 0;
}
.serein-aqi-heading h2 {
  font-size: 17px;
  font-weight: 560;
  letter-spacing: .02em;
}
.serein-aqi-heading p {
  color: var(--fg-2, rgba(255,255,255,.45));
  font-size: 11px;
  font-weight: 500;
  letter-spacing: .08em;
}
.serein-aqi-current {
  display: flex;
  align-items: baseline;
  gap: 14px;
}
.serein-aqi-readout {
  color: var(--fg-1, rgba(255,255,255,.92));
  font: inherit;
  font-size: 56px;
  font-weight: 340;
  letter-spacing: -.055em;
  line-height: .9;
  font-variant-numeric: tabular-nums;
  transition: opacity 400ms ease;
}
.serein-aqi-grade {
  color: var(--fg-2, rgba(255,255,255,.45));
  font-size: 13px;
  font-weight: 520;
  letter-spacing: .06em;
  white-space: nowrap;
  transition: color 300ms ease, opacity 400ms ease;
}
.serein-aqi-layer[data-mode="analysis"] .serein-aqi-readout,
.serein-aqi-layer[data-mode="analysis"] .serein-aqi-grade {
  opacity: 0.4;
}
.serein-aqi-analysis {
  position: absolute;
  top: clamp(128px, 40vh, 46vh);
  left: 50%;
  z-index: 2;
  display: grid;
  grid-template-columns: repeat(3, minmax(5.5rem, 1fr));
  gap: 14px 18px;
  width: min(22rem, calc(100% - 2 * max(16px, env(safe-area-inset-left))));
  padding: 0 max(16px, env(safe-area-inset-left));
  opacity: 0;
  visibility: hidden;
  pointer-events: none;
  transform: translate(-50%, -50%);
  transition: opacity 400ms ease, visibility 400ms step-end;
}
.serein-aqi-layer[data-mode="analysis"] .serein-aqi-analysis {
  opacity: 1;
  visibility: visible;
  transition: opacity 400ms ease, visibility 0ms step-start;
}
.serein-aqi-layer[data-mode="analysis"] .serein-aqi-chips {
  opacity: 0.55;
}
.serein-aqi-analysis-panel {
  display: grid;
  gap: 5px;
  min-width: 0;
}
.serein-aqi-analysis-label {
  color: var(--fg-2, rgba(255,255,255,.45));
  font-size: 9px;
  font-weight: 520;
  letter-spacing: .04em;
  white-space: nowrap;
}
.serein-aqi-analysis-canvas {
  display: block;
  width: 100%;
  height: 34px;
}
.serein-aqi-chips {
  position: absolute;
  left: 0;
  right: 0;
  bottom: max(22px, env(safe-area-inset-bottom));
  z-index: 3;
  display: flex;
  flex-wrap: nowrap;
  gap: 8px;
  justify-content: center;
  padding: 0 max(16px, env(safe-area-inset-left)) 0 max(16px, env(safe-area-inset-right));
  overflow-x: auto;
  -webkit-overflow-scrolling: touch;
  scrollbar-width: none;
  pointer-events: auto;
  transition: opacity 400ms ease;
}
.serein-aqi-chips::-webkit-scrollbar {
  display: none;
}
.serein-aqi-chip {
  display: grid;
  gap: 3px;
  min-width: 4.6rem;
  padding: 8px 10px;
  border: 1px solid var(--line, rgba(255,255,255,.22));
  border-radius: 12px;
  background: rgba(5,7,10,.28);
  color: inherit;
  font: inherit;
  text-align: left;
  cursor: pointer;
  pointer-events: auto;
  touch-action: manipulation;
  backdrop-filter: blur(12px);
  -webkit-backdrop-filter: blur(12px);
  -webkit-tap-highlight-color: transparent;
  transition: border-color 180ms ease, background-color 180ms ease;
}
.serein-aqi-chip:hover,
.serein-aqi-chip.is-active {
  border-color: rgba(255,255,255,.4);
  background: rgba(255,255,255,.08);
}
.serein-aqi-chip:focus-visible {
  outline: 2px solid var(--accent, #7ec8ff);
  outline-offset: 3px;
}
.serein-aqi-chip-label {
  color: var(--fg-2, rgba(255,255,255,.45));
  font-size: 11px;
  font-weight: 520;
  letter-spacing: .04em;
}
.serein-aqi-chip-value {
  display: flex;
  align-items: baseline;
  gap: 4px;
  font-size: 11px;
  font-weight: 500;
  letter-spacing: .01em;
}
.serein-aqi-chip-number {
  color: var(--fg-1, rgba(255,255,255,.92));
  font-variant-numeric: tabular-nums;
}
.serein-aqi-chip-unit {
  color: var(--fg-2, rgba(255,255,255,.45));
  font-size: 11px;
  font-weight: 500;
}
.serein-aqi-layer.is-fallback::after {
  position: absolute;
  top: 50%;
  left: 50%;
  color: var(--fg-2, rgba(255,255,255,.45));
  font-size: 11px;
  letter-spacing: .08em;
  content: "WebGL 不可用";
  transform: translate(-50%, -50%);
}
@media (max-width: 36rem), (max-height: 34rem) {
  .serein-aqi-header {
    top: max(20px, env(safe-area-inset-top));
    left: max(20px, env(safe-area-inset-left));
    gap: 10px;
  }
  .serein-aqi-readout {
    font-size: 48px;
  }
  .serein-aqi-chips {
    bottom: max(16px, env(safe-area-inset-bottom));
    justify-content: flex-start;
  }
  .serein-aqi-chip {
    min-width: 4.2rem;
    padding: 7px 9px;
  }
}
@media (max-width: 36rem) {
  .serein-aqi-analysis {
    grid-template-columns: repeat(2, minmax(4.8rem, 1fr));
    width: min(18rem, calc(100% - 2 * max(16px, env(safe-area-inset-left))));
  }
}
@media (prefers-reduced-motion: reduce) {
  .serein-aqi-grade,
  .serein-aqi-chip,
  .serein-aqi-readout,
  .serein-aqi-chips,
  .serein-aqi-analysis {
    transition-duration: .01ms;
  }
}
`;

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function clamp01(value: number): number {
  return clamp(value, 0, 1);
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

function lookupTable(
  table: ReadonlyArray<{ [key: string]: number }>,
  key: string,
  valueKey: string,
  x: number,
): number {
  if (table.length === 0) return 0;
  if (x <= table[0][key]) return table[0][valueKey];
  for (let index = 1; index < table.length; index += 1) {
    const right = table[index];
    const left = table[index - 1];
    if (x <= right[key]) {
      const span = right[key] - left[key];
      const t = span > 0 ? (x - left[key]) / span : 0;
      return left[valueKey] + (right[valueKey] - left[valueKey]) * t;
    }
  }
  return table[table.length - 1][valueKey];
}

function scatterFromPm25(pm25: number): number {
  return lookupTable(PM25_SCATTER_TABLE, 'pm25', 'sigma', clamp(pm25, 0, 500));
}

function densityFromPm10(pm10: number): number {
  return lookupTable(PM10_DENSITY_TABLE, 'pm10', 'density', clamp(pm10, 0, 500));
}

function aqiBandIndex(aqi: number): number {
  const value = clamp(aqi, 0, 500);
  for (let index = 0; index < AQI_BANDS.length; index += 1) {
    if (value <= AQI_BANDS[index].max) return index;
  }
  return AQI_BANDS.length - 1;
}

function formatPollutant(key: PollutantKey, value: number): string {
  if (key === 'co') {
    return value >= 100 ? Math.round(value).toString() : value.toFixed(1);
  }
  if (value >= 100) return Math.round(value).toString();
  if (value >= 10) return value.toFixed(1);
  return value.toFixed(1);
}

function accentRgb(accent: [number, number, number]): string {
  return `rgb(${Math.round(accent[0] * 255)}, ${Math.round(accent[1] * 255)}, ${Math.round(accent[2] * 255)})`;
}

export class AqiLayer implements WeatherLayer {
  readonly id = 'aqi';
  readonly name = '空气';
  readonly preferredSkyDim = 0.7;

  private container: HTMLElement | null = null;
  private root: HTMLElement | null = null;
  private canvas: HTMLCanvasElement | null = null;
  private aqiReadout: HTMLOutputElement | null = null;
  private gradeReadout: HTMLElement | null = null;
  private chipButtons: HTMLButtonElement[] = [];
  private chipValueNodes: HTMLElement[] = [];
  private analysisCanvases: HTMLCanvasElement[] = [];

  private mode: 'feel' | 'analysis' = 'feel';

  private gl: WebGLRenderingContext | null = null;
  private shaftProgram: WebGLProgram | null = null;
  private dustProgram: WebGLProgram | null = null;
  private quadBuffer: WebGLBuffer | null = null;
  private dustBuffer: WebGLBuffer | null = null;
  private shaftUniforms: Record<string, WebGLUniformLocation | null> = {};
  private dustUniforms: Record<string, WebGLUniformLocation | null> = {};

  private abortController: AbortController | null = null;
  private resizeObserver: ResizeObserver | null = null;
  private raf = 0;
  private lastTimestamp = 0;
  private elapsed = 0;

  private quality: Quality = 'high';
  private pixelRatio = 1;

  private dustCapacity = 0;
  private dustCount = 0;
  private dustX = new Float32Array(0);
  private dustY = new Float32Array(0);
  private dustSeed = new Float32Array(0);
  private dustSize = new Float32Array(0);
  private dustPhase = new Float32Array(0);
  private dustInterleaved = new Float32Array(0);
  private randomState = DUST_SEED;

  private usAqi = new Float32Array(HOURS).fill(56);
  private pm25 = new Float32Array(HOURS).fill(12);
  private pm10 = new Float32Array(HOURS).fill(20);
  private o3 = new Float32Array(HOURS).fill(40);
  private no2 = new Float32Array(HOURS).fill(18);
  private so2 = new Float32Array(HOURS).fill(5);
  private co = new Float32Array(HOURS).fill(0.4);
  private hasData = false;
  private timeMinutes = 480;

  private aqiCurrent = 56;
  private aqiTarget = 56;
  private pm25Current = 12;
  private pm25Target = 12;
  private pm10Current = 20;
  private pm10Target = 20;
  private o3Current = 40;
  private o3Target = 40;
  private no2Current = 18;
  private no2Target = 18;
  private so2Current = 5;
  private so2Target = 5;
  private coCurrent = 0.4;
  private coTarget = 0.4;

  private scatterCurrent = scatterFromPm25(12);
  private scatterTarget = this.scatterCurrent;
  private densityCurrent = densityFromPm10(20);
  private densityTarget = this.densityCurrent;

  private colorCurrent: [number, number, number] = [...AQI_BANDS[1].rgb];
  private colorTarget: [number, number, number] = [...AQI_BANDS[1].rgb];

  private accentCurrent: [number, number, number] = [1, 1, 1];
  private accentTarget: [number, number, number] = [1, 1, 1];
  private accentMixCurrent = 0;
  private accentMixTarget = 0;
  private accentUntil = 0;
  private activeChip: PollutantKey | null = null;

  private lightDirNormalized: [number, number] = [0, 0];
  private coneTan = Math.tan(CONE_HALF_ANGLE);

  private lastAqiText = '';
  private lastGradeText = '';
  private lastChipTexts: string[] = POLLUTANTS.map(() => '');
  private unsubscribeReducedMotion: (() => void) | null = null;

  mount(container: HTMLElement): void {
    if (this.root) return;

    this.container = container;
    this.abortController = new AbortController();
    this.elapsed = 0;
    this.accentUntil = 0;
    this.accentMixTarget = 0;
    this.accentMixCurrent = 0;
    this.activeChip = null;
    this.normalizeLightDir();

    const root = this.createDom();
    this.attachEvents();

    try {
      if (!this.initGL()) {
        root.classList.add('is-fallback');
        console.warn('[AqiLayer] WebGL 不可用，空气层仅保留读数');
      }
    } catch (error) {
      root.classList.add('is-fallback');
      console.warn('[AqiLayer] WebGL 初始化失败，空气层仅保留读数', error);
    }

    this.resizeObserver = new ResizeObserver(this.resize);
    this.resizeObserver.observe(container);
    this.unsubscribeReducedMotion = subscribeReducedMotion(() => {
      if (this.gl) this.rebuildDust();
    });
    this.resize();
    if (this.gl) this.rebuildDust();
    this.retargetWeather();
    this.snapWeather();
    this.updateHud(true);
    this.start();
  }

  unmount(): void {
    this.stop();
    this.abortController?.abort();
    this.abortController = null;
    this.unsubscribeReducedMotion?.();
    this.unsubscribeReducedMotion = null;
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    this.releaseGL(true);

    this.root?.remove();
    this.container = null;
    this.root = null;
    this.canvas = null;
    this.aqiReadout = null;
    this.gradeReadout = null;
    this.chipButtons = [];
    this.chipValueNodes = [];
    this.analysisCanvases = [];
    this.mode = 'feel';
    this.activeChip = null;

    this.dustCapacity = 0;
    this.dustCount = 0;
    this.dustX = new Float32Array(0);
    this.dustY = new Float32Array(0);
    this.dustSeed = new Float32Array(0);
    this.dustSize = new Float32Array(0);
    this.dustPhase = new Float32Array(0);
    this.dustInterleaved = new Float32Array(0);
  }

  setTime(minutes: number): void {
    this.timeMinutes = clamp(Number.isFinite(minutes) ? minutes : 0, 0, DAY_MINUTES);
    this.retargetWeather();
    if (this.mode === 'analysis') this.drawSparklines();
  }

  setData(data: DayData): void {
    const aqi = data.aqi;
    copySeries(aqi?.usAqi, this.usAqi, 56, 0, 500);
    copySeries(aqi?.pm25, this.pm25, 12, 0, 1000);
    copySeries(aqi?.pm10, this.pm10, 20, 0, 1000);
    copySeries(aqi?.o3, this.o3, 40, 0, 1000);
    copySeries(aqi?.no2, this.no2, 18, 0, 1000);
    copySeries(aqi?.so2, this.so2, 5, 0, 1000);
    copySeries(aqi?.co, this.co, 0.4, 0, 50_000);

    const firstData = !this.hasData;
    this.hasData = true;
    this.retargetWeather();
    if (firstData) this.snapWeather();
    this.updateHud(true);
    if (this.mode === 'analysis') this.drawSparklines();
  }

  setMode(mode: 'feel' | 'analysis'): void {
    if (this.mode === mode) return;
    this.mode = mode;
    this.root?.setAttribute('data-mode', mode);
    if (mode === 'analysis') this.drawSparklines();
  }

  setQuality(quality: Quality): void {
    if (quality === this.quality) return;
    this.quality = quality;
    this.root?.setAttribute('data-quality', quality);
    this.resize();
    if (this.gl) this.rebuildDust();
  }

  private createDom(): HTMLElement {
    const root = document.createElement('section');
    root.className = 'serein-aqi-layer';
    root.setAttribute('aria-label', '逐时空气质量与丁达尔光柱');
    root.setAttribute('data-quality', this.quality);
    root.setAttribute('data-mode', this.mode);

    const chipsHtml = POLLUTANTS.map(
      (pollutant, index) => `
      <button class="serein-aqi-chip" type="button" data-pollutant="${pollutant.key}"
        aria-pressed="false" aria-label="${pollutant.label}">
        <span class="serein-aqi-chip-label">${pollutant.label}</span>
        <span class="serein-aqi-chip-value">
          <span class="serein-aqi-chip-number" data-chip-index="${index}">—</span>
          <span class="serein-aqi-chip-unit">${pollutant.unit}</span>
        </span>
      </button>`,
    ).join('');

    const analysisHtml = POLLUTANTS.map(
      (pollutant) => `
      <div class="serein-aqi-analysis-panel" data-pollutant="${pollutant.key}">
        <span class="serein-aqi-analysis-label">${pollutant.label} · ${pollutant.unit}</span>
        <canvas class="serein-aqi-analysis-canvas" aria-hidden="true"></canvas>
      </div>`,
    ).join('');

    root.innerHTML = `
      <style>${LAYER_CSS}</style>
      <canvas class="serein-aqi-canvas" aria-hidden="true"></canvas>
      <header class="serein-aqi-header">
        <div class="serein-aqi-heading">
          <h2>空气</h2>
          <p>US AQI</p>
        </div>
        <div class="serein-aqi-current">
          <output class="serein-aqi-readout" aria-label="当前美国空气质量指数">56</output>
          <p class="serein-aqi-grade">良</p>
        </div>
      </header>
      <div class="serein-aqi-analysis" aria-hidden="true">${analysisHtml}</div>
      <div class="serein-aqi-chips" role="toolbar" aria-label="污染物浓度" data-scene-swipe-ignore>
        ${chipsHtml}
      </div>
    `;

    this.container?.appendChild(root);
    this.root = root;
    this.canvas = root.querySelector<HTMLCanvasElement>('.serein-aqi-canvas');
    this.aqiReadout = root.querySelector<HTMLOutputElement>('.serein-aqi-readout');
    this.gradeReadout = root.querySelector<HTMLElement>('.serein-aqi-grade');
    this.chipButtons = Array.from(root.querySelectorAll<HTMLButtonElement>('.serein-aqi-chip'));
    this.chipValueNodes = Array.from(
      root.querySelectorAll<HTMLElement>('.serein-aqi-chip-number'),
    );
    this.analysisCanvases = Array.from(
      root.querySelectorAll<HTMLCanvasElement>('.serein-aqi-analysis-canvas'),
    );
    return root;
  }

  private attachEvents(): void {
    const signal = this.abortController?.signal;
    const canvas = this.canvas;
    if (!signal || !canvas) return;

    for (const button of this.chipButtons) {
      button.addEventListener('click', this.onChipClick, { signal });
    }
    document.addEventListener('visibilitychange', this.onVisibility, { signal });
    window.addEventListener('resize', this.resize, { passive: true, signal });
    window.visualViewport?.addEventListener('resize', this.resize, {
      passive: true,
      signal,
    });
    canvas.addEventListener('webglcontextlost', this.onContextLost, { signal });
    canvas.addEventListener('webglcontextrestored', this.onContextRestored, { signal });
  }

  private onChipClick = (event: Event): void => {
    const button = event.currentTarget as HTMLButtonElement | null;
    const key = button?.dataset.pollutant as PollutantKey | undefined;
    if (!key) return;
    const pollutant = POLLUTANTS.find((item) => item.key === key);
    if (!pollutant) return;

    this.activeChip = key;
    this.accentTarget[0] = pollutant.accent[0];
    this.accentTarget[1] = pollutant.accent[1];
    this.accentTarget[2] = pollutant.accent[2];
    this.accentMixTarget = 1;
    this.accentUntil = this.elapsed + ACCENT_HOLD_SECONDS;

    for (const chip of this.chipButtons) {
      const active = chip.dataset.pollutant === key;
      chip.classList.toggle('is-active', active);
      chip.setAttribute('aria-pressed', String(active));
    }
  };

  private normalizeLightDir(): void {
    const [x, y] = LIGHT_DIR_UV;
    const length = Math.hypot(x, y) || 1;
    this.lightDirNormalized = [x / length, y / length];
    this.coneTan = Math.tan(CONE_HALF_ANGLE);
  }

  private initGL(): boolean {
    const canvas = this.canvas;
    if (!canvas) return false;

    const gl = canvas.getContext('webgl', {
      alpha: true,
      antialias: false,
      depth: false,
      stencil: false,
      premultipliedAlpha: false,
      preserveDrawingBuffer: true,
      powerPreference: 'high-performance',
    });
    if (!gl) return false;
    this.gl = gl;

    const quad = gl.createBuffer();
    const dust = gl.createBuffer();
    if (!quad || !dust) {
      if (quad) gl.deleteBuffer(quad);
      if (dust) gl.deleteBuffer(dust);
      this.gl = null;
      return false;
    }
    this.quadBuffer = quad;
    this.dustBuffer = dust;
    gl.bindBuffer(gl.ARRAY_BUFFER, quad);
    gl.bufferData(
      gl.ARRAY_BUFFER,
      new Float32Array([-1, -1, 3, -1, -1, 3]),
      gl.STATIC_DRAW,
    );

    if (!this.buildShaftProgram() || !this.buildDustProgram()) {
      this.releaseGL(false);
      return false;
    }

    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.CULL_FACE);
    gl.enable(gl.BLEND);
    gl.blendFuncSeparate(
      gl.SRC_ALPHA,
      gl.ONE_MINUS_SRC_ALPHA,
      gl.ONE,
      gl.ONE_MINUS_SRC_ALPHA,
    );
    gl.clearColor(0, 0, 0, 0);
    return true;
  }

  private buildShaftProgram(): boolean {
    const gl = this.gl;
    if (!gl) return false;
    const program = this.linkProgram(SHAFT_VERTEX, SHAFT_FRAGMENT, ['aPosition']);
    if (!program) return false;
    if (this.shaftProgram) gl.deleteProgram(this.shaftProgram);
    this.shaftProgram = program;
    this.shaftUniforms = {};
    for (const name of [
      'uResolution',
      'uLightOrigin',
      'uLightDir',
      'uConeTan',
      'uScatter',
      'uColor',
      'uColorAlpha',
      'uElapsed',
    ]) {
      this.shaftUniforms[name] = gl.getUniformLocation(program, name);
    }
    return true;
  }

  private buildDustProgram(): boolean {
    const gl = this.gl;
    if (!gl) return false;
    const program = this.linkProgram(DUST_VERTEX, DUST_FRAGMENT, [
      'aPosition',
      'aSeed',
      'aSize',
    ]);
    if (!program) return false;
    if (this.dustProgram) gl.deleteProgram(this.dustProgram);
    this.dustProgram = program;
    this.dustUniforms = {};
    for (const name of [
      'uResolution',
      'uLightOrigin',
      'uLightDir',
      'uConeTan',
      'uDensity',
      'uPixelRatio',
      'uScatter',
      'uColor',
      'uAccent',
      'uAccentMix',
      'uColorAlpha',
    ]) {
      this.dustUniforms[name] = gl.getUniformLocation(program, name);
    }
    return true;
  }

  private linkProgram(
    vertexSource: string,
    fragmentSource: string,
    attributes: string[],
  ): WebGLProgram | null {
    const gl = this.gl;
    if (!gl) return null;
    const vertexShader = this.compileShader(gl.VERTEX_SHADER, vertexSource);
    const fragmentShader = this.compileShader(gl.FRAGMENT_SHADER, fragmentSource);
    if (!vertexShader || !fragmentShader) {
      if (vertexShader) gl.deleteShader(vertexShader);
      if (fragmentShader) gl.deleteShader(fragmentShader);
      return null;
    }
    const program = gl.createProgram();
    if (!program) {
      gl.deleteShader(vertexShader);
      gl.deleteShader(fragmentShader);
      return null;
    }
    gl.attachShader(program, vertexShader);
    gl.attachShader(program, fragmentShader);
    for (let index = 0; index < attributes.length; index += 1) {
      gl.bindAttribLocation(program, index, attributes[index]);
    }
    gl.linkProgram(program);
    gl.deleteShader(vertexShader);
    gl.deleteShader(fragmentShader);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      console.error('[AqiLayer] shader 链接失败:', gl.getProgramInfoLog(program));
      gl.deleteProgram(program);
      return null;
    }
    return program;
  }

  private compileShader(type: number, source: string): WebGLShader | null {
    const gl = this.gl;
    if (!gl) return null;
    const shader = gl.createShader(type);
    if (!shader) return null;
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      console.error('[AqiLayer] shader 编译失败:', gl.getShaderInfoLog(shader));
      gl.deleteShader(shader);
      return null;
    }
    return shader;
  }

  private releaseGL(loseContext: boolean): void {
    const gl = this.gl;
    if (gl) {
      if (this.quadBuffer) gl.deleteBuffer(this.quadBuffer);
      if (this.dustBuffer) gl.deleteBuffer(this.dustBuffer);
      if (this.shaftProgram) gl.deleteProgram(this.shaftProgram);
      if (this.dustProgram) gl.deleteProgram(this.dustProgram);
      if (loseContext) gl.getExtension('WEBGL_lose_context')?.loseContext();
    }
    this.gl = null;
    this.shaftProgram = null;
    this.dustProgram = null;
    this.quadBuffer = null;
    this.dustBuffer = null;
    this.shaftUniforms = {};
    this.dustUniforms = {};
  }

  private rebuildDust(): void {
    const capacity = particleBudget(QUALITY[this.quality].maxDust);
    this.dustCapacity = capacity;
    this.dustCount = capacity;
    this.dustX = new Float32Array(capacity);
    this.dustY = new Float32Array(capacity);
    this.dustSeed = new Float32Array(capacity);
    this.dustSize = new Float32Array(capacity);
    this.dustPhase = new Float32Array(capacity);
    this.dustInterleaved = new Float32Array(capacity * 4);
    this.randomState = DUST_SEED;

    for (let index = 0; index < capacity; index += 1) {
      this.dustX[index] = this.random();
      this.dustY[index] = this.random();
      this.dustSeed[index] = this.random();
      this.dustSize[index] = this.random();
      this.dustPhase[index] = this.random() * Math.PI * 2;
    }

    const gl = this.gl;
    const buffer = this.dustBuffer;
    if (gl && buffer) {
      gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
      gl.bufferData(gl.ARRAY_BUFFER, this.dustInterleaved.byteLength, gl.DYNAMIC_DRAW);
    }
  }

  private random(): number {
    let state = this.randomState | 0;
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    this.randomState = state >>> 0;
    return this.randomState / 4294967296;
  }

  private currentFor(key: PollutantKey): number {
    switch (key) {
      case 'pm25':
        return this.pm25Current;
      case 'pm10':
        return this.pm10Current;
      case 'o3':
        return this.o3Current;
      case 'no2':
        return this.no2Current;
      case 'so2':
        return this.so2Current;
      case 'co':
        return this.coCurrent;
    }
  }

  private seriesFor(key: PollutantKey): Float32Array {
    switch (key) {
      case 'pm25':
        return this.pm25;
      case 'pm10':
        return this.pm10;
      case 'o3':
        return this.o3;
      case 'no2':
        return this.no2;
      case 'so2':
        return this.so2;
      case 'co':
        return this.co;
    }
  }

  private drawSparklines(): void {
    if (this.mode !== 'analysis' || this.analysisCanvases.length === 0) return;

    const hour = clamp(this.timeMinutes / 60, 0, 24);
    const left = Math.min(23, Math.floor(hour));
    const amount = hour - left;

    for (let index = 0; index < POLLUTANTS.length; index += 1) {
      const pollutant = POLLUTANTS[index];
      const canvas = this.analysisCanvases[index];
      if (!canvas) continue;

      const ctx = canvas.getContext('2d');
      if (!ctx) continue;

      const cssWidth = Math.max(1, canvas.clientWidth);
      const cssHeight = Math.max(1, canvas.clientHeight);
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const pixelWidth = Math.max(1, Math.round(cssWidth * dpr));
      const pixelHeight = Math.max(1, Math.round(cssHeight * dpr));
      if (canvas.width !== pixelWidth) canvas.width = pixelWidth;
      if (canvas.height !== pixelHeight) canvas.height = pixelHeight;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, cssWidth, cssHeight);

      const series = this.seriesFor(pollutant.key);
      let min = Infinity;
      let max = -Infinity;
      for (let point = 0; point < HOURS; point += 1) {
        const value = series[point];
        if (value < min) min = value;
        if (value > max) max = value;
      }
      if (!Number.isFinite(min) || !Number.isFinite(max)) {
        min = 0;
        max = 1;
      }
      const span = max - min || 1;
      const padY = span * 0.1;
      min -= padY;
      max += padY;

      const insetX = 1;
      const insetY = 2;
      const plotWidth = cssWidth - insetX * 2;
      const plotHeight = cssHeight - insetY * 2;
      const stepX = plotWidth / (HOURS - 1);
      const color = accentRgb(pollutant.accent);

      ctx.strokeStyle = 'rgba(255,255,255,.14)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(insetX, cssHeight - insetY + 0.5);
      ctx.lineTo(cssWidth - insetX, cssHeight - insetY + 0.5);
      ctx.stroke();

      ctx.beginPath();
      for (let point = 0; point < HOURS; point += 1) {
        const x = insetX + point * stepX;
        const y =
          insetY + plotHeight - ((series[point] - min) / (max - min)) * plotHeight;
        if (point === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.strokeStyle = color;
      ctx.lineWidth = 1.5;
      ctx.lineJoin = 'round';
      ctx.lineCap = 'round';
      ctx.stroke();

      const currentValue = series[left] + (series[left + 1] - series[left]) * amount;
      const markerX = insetX + hour * stepX;
      const markerY =
        insetY + plotHeight - ((currentValue - min) / (max - min)) * plotHeight;
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.arc(markerX, markerY, 2.5, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = 'rgba(5,7,10,.55)';
      ctx.lineWidth = 1;
      ctx.stroke();
    }
  }

  private retargetWeather(): void {
    this.aqiTarget = clamp(sampleSeries(this.usAqi, this.timeMinutes), 0, 500);
    this.pm25Target = Math.max(0, sampleSeries(this.pm25, this.timeMinutes));
    this.pm10Target = Math.max(0, sampleSeries(this.pm10, this.timeMinutes));
    this.o3Target = Math.max(0, sampleSeries(this.o3, this.timeMinutes));
    this.no2Target = Math.max(0, sampleSeries(this.no2, this.timeMinutes));
    this.so2Target = Math.max(0, sampleSeries(this.so2, this.timeMinutes));
    this.coTarget = Math.max(0, sampleSeries(this.co, this.timeMinutes));
    this.scatterTarget = scatterFromPm25(this.pm25Target);
    this.densityTarget = densityFromPm10(this.pm10Target);

    const band = AQI_BANDS[aqiBandIndex(this.aqiTarget)];
    this.colorTarget[0] = band.rgb[0];
    this.colorTarget[1] = band.rgb[1];
    this.colorTarget[2] = band.rgb[2];
  }

  private snapWeather(): void {
    this.aqiCurrent = this.aqiTarget;
    this.pm25Current = this.pm25Target;
    this.pm10Current = this.pm10Target;
    this.o3Current = this.o3Target;
    this.no2Current = this.no2Target;
    this.so2Current = this.so2Target;
    this.coCurrent = this.coTarget;
    this.scatterCurrent = this.scatterTarget;
    this.densityCurrent = this.densityTarget;
    this.colorCurrent[0] = this.colorTarget[0];
    this.colorCurrent[1] = this.colorTarget[1];
    this.colorCurrent[2] = this.colorTarget[2];
  }

  private stepWeather(deltaSeconds: number): void {
    const blend = 1 - Math.exp(-deltaSeconds / EASE_TAU);
    this.aqiCurrent += (this.aqiTarget - this.aqiCurrent) * blend;
    this.pm25Current += (this.pm25Target - this.pm25Current) * blend;
    this.pm10Current += (this.pm10Target - this.pm10Current) * blend;
    this.o3Current += (this.o3Target - this.o3Current) * blend;
    this.no2Current += (this.no2Target - this.no2Current) * blend;
    this.so2Current += (this.so2Target - this.so2Current) * blend;
    this.coCurrent += (this.coTarget - this.coCurrent) * blend;
    this.scatterCurrent += (this.scatterTarget - this.scatterCurrent) * blend;
    this.densityCurrent += (this.densityTarget - this.densityCurrent) * blend;
    this.colorCurrent[0] += (this.colorTarget[0] - this.colorCurrent[0]) * blend;
    this.colorCurrent[1] += (this.colorTarget[1] - this.colorCurrent[1]) * blend;
    this.colorCurrent[2] += (this.colorTarget[2] - this.colorCurrent[2]) * blend;

    if (this.elapsed >= this.accentUntil) {
      this.accentMixTarget = 0;
      if (this.accentMixCurrent < 0.02 && this.activeChip) {
        this.activeChip = null;
        for (const chip of this.chipButtons) {
          chip.classList.remove('is-active');
          chip.setAttribute('aria-pressed', 'false');
        }
      }
    }

    this.accentMixCurrent += (this.accentMixTarget - this.accentMixCurrent) * blend;
    this.accentCurrent[0] += (this.accentTarget[0] - this.accentCurrent[0]) * blend;
    this.accentCurrent[1] += (this.accentTarget[1] - this.accentCurrent[1]) * blend;
    this.accentCurrent[2] += (this.accentTarget[2] - this.accentCurrent[2]) * blend;
  }

  private stepDust(deltaSeconds: number): void {
    const count = this.dustCount;
    if (count === 0) return;

    const drift = deltaSeconds * 0.012;
    const brownian = deltaSeconds * 0.045;
    const time = this.elapsed;

    for (let index = 0; index < count; index += 1) {
      const seed = this.dustSeed[index];
      const phase = this.dustPhase[index] + time * (0.35 + seed * 0.55);
      // 缓慢漂浮 + 布朗微抖动
      let x =
        this.dustX[index] +
        Math.sin(phase) * drift * (0.4 + seed) +
        Math.sin(time * 3.1 + seed * 40.0) * brownian * 0.35;
      let y =
        this.dustY[index] +
        Math.cos(phase * 0.87) * drift * (0.35 + (1 - seed) * 0.5) +
        Math.cos(time * 2.7 + seed * 33.0) * brownian * 0.35;

      if (x < -0.05) x += 1.1;
      if (x > 1.05) x -= 1.1;
      if (y < -0.05) y += 1.1;
      if (y > 1.05) y -= 1.1;

      this.dustX[index] = x;
      this.dustY[index] = y;

      const stride = index * 4;
      this.dustInterleaved[stride] = x;
      this.dustInterleaved[stride + 1] = y;
      this.dustInterleaved[stride + 2] = seed;
      this.dustInterleaved[stride + 3] = this.dustSize[index];
    }
  }

  private render(): void {
    const gl = this.gl;
    const canvas = this.canvas;
    if (!gl || !canvas) return;

    gl.viewport(0, 0, canvas.width, canvas.height);
    gl.clear(gl.COLOR_BUFFER_BIT);
    this.renderShaft();
    this.renderDust();
  }

  private renderShaft(): void {
    const gl = this.gl;
    const program = this.shaftProgram;
    const buffer = this.quadBuffer;
    const canvas = this.canvas;
    if (!gl || !program || !buffer || !canvas) return;

    gl.useProgram(program);
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.disableVertexAttribArray(1);
    gl.disableVertexAttribArray(2);

    gl.uniform2f(this.shaftUniforms.uResolution, canvas.width, canvas.height);
    gl.uniform2f(
      this.shaftUniforms.uLightOrigin,
      LIGHT_ORIGIN_UV[0],
      LIGHT_ORIGIN_UV[1],
    );
    gl.uniform2f(
      this.shaftUniforms.uLightDir,
      this.lightDirNormalized[0],
      this.lightDirNormalized[1],
    );
    gl.uniform1f(this.shaftUniforms.uConeTan, this.coneTan);
    gl.uniform1f(this.shaftUniforms.uScatter, this.scatterCurrent);
    gl.uniform3f(
      this.shaftUniforms.uColor,
      this.colorCurrent[0],
      this.colorCurrent[1],
      this.colorCurrent[2],
    );
    gl.uniform1f(this.shaftUniforms.uColorAlpha, AQI_COLOR_ALPHA);
    gl.uniform1f(this.shaftUniforms.uElapsed, this.elapsed);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  private renderDust(): void {
    const gl = this.gl;
    const program = this.dustProgram;
    const buffer = this.dustBuffer;
    const canvas = this.canvas;
    const count = this.dustCount;
    if (!gl || !program || !buffer || !canvas || count === 0) return;

    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, this.dustInterleaved);

    gl.useProgram(program);
    const stride = 16;
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, stride, 0);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 1, gl.FLOAT, false, stride, 8);
    gl.enableVertexAttribArray(2);
    gl.vertexAttribPointer(2, 1, gl.FLOAT, false, stride, 12);

    gl.uniform2f(this.dustUniforms.uResolution, canvas.width, canvas.height);
    gl.uniform2f(
      this.dustUniforms.uLightOrigin,
      LIGHT_ORIGIN_UV[0],
      LIGHT_ORIGIN_UV[1],
    );
    gl.uniform2f(
      this.dustUniforms.uLightDir,
      this.lightDirNormalized[0],
      this.lightDirNormalized[1],
    );
    gl.uniform1f(this.dustUniforms.uConeTan, this.coneTan);
    gl.uniform1f(this.dustUniforms.uDensity, this.densityCurrent);
    gl.uniform1f(this.dustUniforms.uPixelRatio, this.pixelRatio);
    gl.uniform1f(this.dustUniforms.uScatter, this.scatterCurrent);
    gl.uniform3f(
      this.dustUniforms.uColor,
      this.colorCurrent[0],
      this.colorCurrent[1],
      this.colorCurrent[2],
    );
    gl.uniform3f(
      this.dustUniforms.uAccent,
      this.accentCurrent[0],
      this.accentCurrent[1],
      this.accentCurrent[2],
    );
    gl.uniform1f(this.dustUniforms.uAccentMix, this.accentMixCurrent);
    gl.uniform1f(this.dustUniforms.uColorAlpha, AQI_COLOR_ALPHA);

    // 加色混合让光柱内尘埃更「被点亮」
    gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.drawArrays(gl.POINTS, 0, count);
    gl.blendFuncSeparate(
      gl.SRC_ALPHA,
      gl.ONE_MINUS_SRC_ALPHA,
      gl.ONE,
      gl.ONE_MINUS_SRC_ALPHA,
    );

    gl.disableVertexAttribArray(1);
    gl.disableVertexAttribArray(2);
  }

  private updateHud(force = false): void {
    const aqiValue = Math.round(clamp(this.aqiCurrent, 0, 500));
    const aqiText = String(aqiValue);
    if (force || aqiText !== this.lastAqiText) {
      this.lastAqiText = aqiText;
      if (this.aqiReadout) {
        this.aqiReadout.value = aqiText;
        this.aqiReadout.setAttribute('aria-label', `当前美国空气质量指数 ${aqiText}`);
      }
    }

    const band = AQI_BANDS[aqiBandIndex(this.aqiCurrent)];
    if (force || band.label !== this.lastGradeText) {
      this.lastGradeText = band.label;
      if (this.gradeReadout) {
        this.gradeReadout.textContent = band.label;
        this.gradeReadout.style.color = band.color;
      }
      this.root?.setAttribute('data-aqi-grade', band.label);
    }

    for (let index = 0; index < POLLUTANTS.length; index += 1) {
      const pollutant = POLLUTANTS[index];
      const value = this.currentFor(pollutant.key);
      const text = formatPollutant(pollutant.key, value);
      if (!force && text === this.lastChipTexts[index]) continue;
      this.lastChipTexts[index] = text;
      const node = this.chipValueNodes[index];
      if (node) node.textContent = text;
      const button = this.chipButtons[index];
      if (button) {
        button.setAttribute(
          'aria-label',
          `${pollutant.label} ${text} ${pollutant.unit}`,
        );
      }
    }

    this.root?.setAttribute('data-scatter', this.scatterCurrent.toFixed(3));
    this.root?.setAttribute('data-density', this.densityCurrent.toFixed(3));
  }

  private resize = (): void => {
    const container = this.container;
    const canvas = this.canvas;
    if (!container || !canvas) return;
    const width = Math.max(1, container.clientWidth);
    const height = Math.max(1, container.clientHeight);
    const dpr = Math.min(window.devicePixelRatio || 1, QUALITY[this.quality].dpr);
    this.pixelRatio = dpr;

    const nextWidth = Math.max(1, Math.round(width * dpr));
    const nextHeight = Math.max(1, Math.round(height * dpr));
    if (canvas.width !== nextWidth) canvas.width = nextWidth;
    if (canvas.height !== nextHeight) canvas.height = nextHeight;
    this.gl?.viewport(0, 0, canvas.width, canvas.height);
    this.root?.setAttribute('data-renderer-pixel-ratio', dpr.toFixed(2));
    if (this.mode === 'analysis') this.drawSparklines();
  };

  private start(): void {
    if (this.raf || document.hidden || !this.root) return;
    this.lastTimestamp = performance.now();
    this.raf = requestAnimationFrame(this.frame);
  }

  private stop(): void {
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
  }

  private frame = (timestamp: number): void => {
    this.raf = 0;
    if (!this.root || document.hidden) return;
    const deltaSeconds = clamp((timestamp - this.lastTimestamp) / 1000, 0, 0.05);
    this.lastTimestamp = timestamp;
    this.elapsed += deltaSeconds;

    this.stepWeather(deltaSeconds);
    this.stepDust(deltaSeconds);
    this.render();
    this.updateHud();
    this.raf = requestAnimationFrame(this.frame);
  };

  private onVisibility = (): void => {
    if (document.hidden) this.stop();
    else this.start();
  };

  private onContextLost = (event: Event): void => {
    event.preventDefault();
    this.gl = null;
    this.shaftProgram = null;
    this.dustProgram = null;
    this.quadBuffer = null;
    this.dustBuffer = null;
    this.shaftUniforms = {};
    this.dustUniforms = {};
    this.root?.setAttribute('data-webgl-status', 'lost');
  };

  private onContextRestored = (): void => {
    if (this.initGL()) {
      this.root?.classList.remove('is-fallback');
      this.root?.setAttribute('data-webgl-status', 'ready');
      this.rebuildDust();
      this.resize();
    } else {
      this.root?.classList.add('is-fallback');
    }
  };
}
