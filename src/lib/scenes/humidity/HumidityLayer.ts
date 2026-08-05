/**
 * HumidityLayer —— 镜头起雾与玻璃结露。
 *
 * 雾由一个全屏 WebGL pass 绘制；结露使用独立 2D canvas，因此水滴物理、
 * 背景折射与擦拭轨迹不会增加雾 shader 的几何复杂度。轨迹保存在低分辨率
 * alpha mask 中，同时供雾 shader 和水滴模拟采样。
 */
import { particleBudget, subscribeReducedMotion } from '../../motion';
import type { DayData, WeatherLayer } from '../../contracts';

type Quality = 'low' | 'medium' | 'high';

interface QualityConfig {
  maxDrops: number;
  fogDpr: number;
  dropDpr: number;
  trailScale: number;
  backdropScale: number;
  backdropEvery: number;
  collisionEvery: number;
  fogOctaves: number;
  fillSeconds: number;
}

interface Droplet {
  x: number;
  y: number;
  radius: number;
  growth: number;
  slideThreshold: number;
  velocityX: number;
  velocityY: number;
  sliding: boolean;
  evaporating: boolean;
  evaporationAge: number;
  evaporationStartRadius: number;
}

type OrientationPermission = 'granted' | 'denied';
type OrientationEventConstructor = typeof DeviceOrientationEvent & {
  requestPermission?: () => Promise<OrientationPermission>;
};

const HOURS = 25;
const DAY_MINUTES = 1440;
const CONDENSATION_THRESHOLD = 0.3;
const EVAPORATION_SECONDS = 2;
const TRAIL_RECOVERY_SECONDS = 30;
const TRAIL_RECOVERY_STEP = 0.1;
const FALLBACK_FOG_COLOR = [157 / 255, 180 / 255, 200 / 255] as const;

const QUALITY: Record<Quality, QualityConfig> = {
  high: {
    maxDrops: 300,
    fogDpr: 1.5,
    dropDpr: 2,
    trailScale: 0.3,
    backdropScale: 0.75,
    backdropEvery: 3,
    collisionEvery: 2,
    fogOctaves: 4,
    fillSeconds: 14,
  },
  medium: {
    maxDrops: 150,
    fogDpr: 1.25,
    dropDpr: 1.5,
    trailScale: 0.25,
    backdropScale: 0.6,
    backdropEvery: 4,
    collisionEvery: 3,
    fogOctaves: 3,
    fillSeconds: 16,
  },
  low: {
    maxDrops: 60,
    fogDpr: 1,
    dropDpr: 1,
    trailScale: 0.2,
    backdropScale: 0.45,
    backdropEvery: 6,
    collisionEvery: 4,
    fogOctaves: 2,
    fillSeconds: 18,
  },
};

const VERTEX_SHADER = `
attribute vec2 aPosition;

void main() {
  gl_Position = vec4(aPosition, 0.0, 1.0);
}
`;

const FRAGMENT_SHADER = `
#ifdef GL_FRAGMENT_PRECISION_HIGH
precision highp float;
#else
precision mediump float;
#endif

uniform vec2 uResolution;
uniform float uElapsed;
uniform float uHumidity;
uniform vec3 uFogColor;
uniform sampler2D uTrail;

float hash21(vec2 point) {
  point = fract(point * vec2(123.34, 456.21));
  point += dot(point, point + 45.32);
  return fract(point.x * point.y);
}

float valueNoise(vec2 point) {
  vec2 cell = floor(point);
  vec2 local = fract(point);
  vec2 blend = local * local * (3.0 - 2.0 * local);
  return mix(
    mix(hash21(cell), hash21(cell + vec2(1.0, 0.0)), blend.x),
    mix(hash21(cell + vec2(0.0, 1.0)), hash21(cell + vec2(1.0, 1.0)), blend.x),
    blend.y
  );
}

float fbm(vec2 point) {
  float sum = 0.0;
  float amplitude = 0.5;
  for (int octave = 0; octave < FOG_OCTAVES; octave++) {
    sum += valueNoise(point) * amplitude;
    point = point * 2.03 + vec2(17.17, 9.41);
    amplitude *= 0.5;
  }
  return sum;
}

void main() {
  vec2 uv = gl_FragCoord.xy / max(uResolution, vec2(1.0));
  float aspect = uResolution.x / max(uResolution.y, 1.0);

  // 到最近一条屏幕边的距离：四边向内时雾逐渐加厚。
  float edgeDistance = min(min(uv.x, 1.0 - uv.x), min(uv.y, 1.0 - uv.y));
  float inward = smoothstep(0.0, 0.43, edgeDistance);

  vec2 noiseUv = (uv - 0.5) * vec2(aspect, 1.0) * 2.15;
  noiseUv += vec2(uElapsed * 0.0065, -uElapsed * 0.0042);
  float drift = fbm(noiseUv) - 0.48;

  // 30% 几乎透明；100% 时中心达到浓雾，边缘仍留少量背景轮廓。
  float humidityCurve = pow(clamp(uHumidity, 0.0, 1.0), 1.35);
  float opticalDepth = mix(0.004, 1.42, humidityCurve);
  float distribution = clamp(0.36 + inward * 0.72 + drift * 0.16, 0.18, 1.18);
  float alpha = 1.0 - exp(-opticalDepth * distribution);

  // 轨迹 alpha=1 代表刚被水滴擦干；恢复过程由 CPU 精确计时 30 秒。
  float cleared = texture2D(uTrail, uv).a;
  alpha *= 1.0 - clamp(cleared, 0.0, 1.0);

  gl_FragColor = vec4(uFogColor, alpha);
}
`;

const LAYER_CSS = `
.serein-humidity-layer {
  --fog-opacity: 0;
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
.serein-humidity-fog,
.serein-humidity-drops {
  position: absolute;
  inset: 0;
  display: block;
  width: 100%;
  height: 100%;
  pointer-events: none;
}
.serein-humidity-fog {
  z-index: 0;
}
.serein-humidity-drops {
  z-index: 1;
}
.serein-humidity-layer.is-fog-fallback .serein-humidity-fog {
  background:
    radial-gradient(
      ellipse at center,
      rgba(157,180,200,var(--fog-opacity)) 0%,
      rgba(157,180,200,calc(var(--fog-opacity) * .62)) 52%,
      rgba(157,180,200,calc(var(--fog-opacity) * .32)) 100%
    );
}
.serein-humidity-header {
  position: absolute;
  top: max(28px, env(safe-area-inset-top));
  left: max(28px, env(safe-area-inset-left));
  z-index: 3;
  display: grid;
  gap: 12px;
  text-shadow: 0 1px 18px rgba(5,7,10,.28);
}
.serein-humidity-heading {
  display: flex;
  align-items: baseline;
  gap: 11px;
}
.serein-humidity-heading h2,
.serein-humidity-heading p,
.serein-humidity-readout,
.serein-humidity-detail,
.serein-humidity-status {
  margin: 0;
}
.serein-humidity-heading h2 {
  font-size: 17px;
  font-weight: 560;
  letter-spacing: .02em;
}
.serein-humidity-heading p {
  color: var(--fg-2, rgba(255,255,255,.45));
  font-size: 11px;
  font-weight: 500;
  letter-spacing: .08em;
}
.serein-humidity-readout {
  color: var(--fg-1, rgba(255,255,255,.92));
  font: inherit;
  font-size: 56px;
  font-weight: 340;
  letter-spacing: -.055em;
  line-height: .9;
}
.serein-humidity-details {
  display: grid;
  gap: 5px;
}
.serein-humidity-detail {
  color: var(--fg-2, rgba(255,255,255,.45));
  font-size: 12px;
  font-weight: 500;
  letter-spacing: .025em;
  line-height: 1.25;
  transition: color 180ms ease, text-shadow 180ms ease;
}
.serein-humidity-gap.is-condensing {
  color: var(--accent, #7ec8ff);
  text-shadow: 0 0 16px color-mix(in srgb, var(--accent, #7ec8ff) 42%, transparent);
}
.serein-humidity-status {
  margin-left: 7px;
  font-size: 11px;
  font-weight: 650;
  letter-spacing: .08em;
}
.serein-humidity-orientation {
  position: absolute;
  top: max(20px, env(safe-area-inset-top));
  right: max(20px, env(safe-area-inset-right));
  z-index: 4;
  min-height: 38px;
  padding: 0 14px;
  border: 1px solid var(--line, rgba(255,255,255,.22));
  border-radius: 999px;
  background: rgba(5,7,10,.28);
  color: var(--fg-2, rgba(255,255,255,.45));
  font: inherit;
  font-size: 11px;
  font-weight: 560;
  letter-spacing: .06em;
  cursor: pointer;
  pointer-events: auto;
  touch-action: manipulation;
  backdrop-filter: blur(12px);
  -webkit-backdrop-filter: blur(12px);
  -webkit-tap-highlight-color: transparent;
}
.serein-humidity-orientation:hover {
  border-color: rgba(255,255,255,.34);
  color: var(--fg-1, rgba(255,255,255,.92));
}
.serein-humidity-orientation:focus-visible {
  outline: 2px solid var(--accent, #7ec8ff);
  outline-offset: 3px;
}
.serein-humidity-orientation:disabled {
  cursor: wait;
  opacity: .62;
}
.serein-humidity-orientation[hidden] {
  display: none;
}
@media (max-width: 36rem), (max-height: 34rem) {
  .serein-humidity-header {
    top: max(20px, env(safe-area-inset-top));
    left: max(20px, env(safe-area-inset-left));
    gap: 10px;
  }
  .serein-humidity-readout {
    font-size: 48px;
  }
  .serein-humidity-orientation {
    top: max(16px, env(safe-area-inset-top));
    right: max(16px, env(safe-area-inset-right));
  }
}
@media (prefers-reduced-motion: reduce) {
  .serein-humidity-detail {
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

function formatTemperature(value: number, includePlus = false): string {
  const rounded = Math.abs(value) < 0.05 ? 0 : value;
  const sign = rounded < 0 ? '−' : includePlus && rounded > 0 ? '+' : '';
  return `${sign}${Math.abs(rounded).toFixed(1)}°C`;
}

export class HumidityLayer implements WeatherLayer {
  readonly id = 'humidity';
  readonly name = '湿度';
  readonly preferredSkyDim = 0.5;

  private container: HTMLElement | null = null;
  private root: HTMLElement | null = null;
  private fogCanvas: HTMLCanvasElement | null = null;
  private dropCanvas: HTMLCanvasElement | null = null;
  private dropContext: CanvasRenderingContext2D | null = null;
  private humidityReadout: HTMLOutputElement | null = null;
  private dewPointReadout: HTMLElement | null = null;
  private gapReadout: HTMLElement | null = null;
  private condensationStatus: HTMLElement | null = null;
  private orientationButton: HTMLButtonElement | null = null;

  private gl: WebGLRenderingContext | null = null;
  private program: WebGLProgram | null = null;
  private quadBuffer: WebGLBuffer | null = null;
  private trailTexture: WebGLTexture | null = null;
  private uniforms: Record<string, WebGLUniformLocation | null> = {};
  private trailTextureWidth = 0;
  private trailTextureHeight = 0;

  private trailCanvas: HTMLCanvasElement | null = null;
  private trailContext: CanvasRenderingContext2D | null = null;
  private trailPixels: Uint8ClampedArray | null = null;
  private trailRecoveryAccumulator = 0;
  private trailDirty = true;
  private trailHasContent = false;

  private backdropCanvas: HTMLCanvasElement | null = null;
  private backdropContext: CanvasRenderingContext2D | null = null;
  private backdropSource: HTMLCanvasElement | null = null;
  private backdropAvailable = false;
  private backdropSearchAt = 0;
  private colorProbeCanvas: HTMLCanvasElement | null = null;
  private colorProbeContext: CanvasRenderingContext2D | null = null;
  private dropletSprite: HTMLCanvasElement | null = null;

  private abortController: AbortController | null = null;
  private resizeObserver: ResizeObserver | null = null;
  private orientationTimeout: number | null = null;
  private raf = 0;
  private lastTimestamp = 0;
  private elapsed = 0;
  private frameNumber = 0;

  private quality: Quality = 'high';
  private viewportWidth = 1;
  private viewportHeight = 1;
  private dropDpr = 1;

  private humidity = new Float32Array(HOURS).fill(65);
  private temperature = new Float32Array(HOURS).fill(18);
  private dewPoint = new Float32Array(HOURS).fill(16);
  private hasData = false;
  private timeMinutes = 480;

  private humidityCurrent = 65;
  private humidityTarget = 65;
  private temperatureCurrent = 18;
  private temperatureTarget = 18;
  private dewPointCurrent = 16;
  private dewPointTarget = 16;
  private condensing = false;

  private droplets: Droplet[] = [];
  private spawnAccumulator = 0;
  private randomState = 0x61c88647;

  private gravityX = 0;
  private gravityY = 1;
  private gravityTargetX = 0;
  private gravityTargetY = 1;
  private orientationListening = false;
  private orientationReceived = false;
  private orientationLastAt = 0;

  private fogColor = [...FALLBACK_FOG_COLOR];
  private fogColorTarget = [...FALLBACK_FOG_COLOR];

  private lastHumidityText = '';
  private lastDewPointText = '';
  private lastGapText = '';
  private lastCondensingState: boolean | null = null;
  private unsubscribeReducedMotion: (() => void) | null = null;

  mount(container: HTMLElement): void {
    if (this.root) return;

    this.container = container;
    this.abortController = new AbortController();
    this.elapsed = 0;
    this.frameNumber = 0;
    const root = this.createDom();
    this.createAuxiliaryCanvases();
    this.createDropletSprite();
    this.attachEvents();

    try {
      if (!this.initFogGL()) {
        root.classList.add('is-fog-fallback');
        console.warn('[HumidityLayer] WebGL 不可用，雾层退化为 CSS 径向雾');
      }
    } catch (error) {
      root.classList.add('is-fog-fallback');
      console.warn('[HumidityLayer] 雾层初始化失败，退化为 CSS 径向雾', error);
    }

    this.resizeObserver = new ResizeObserver(this.resize);
    this.resizeObserver.observe(container);
    this.unsubscribeReducedMotion = subscribeReducedMotion(() => this.trimDroplets());
    this.resize();
    this.setupOrientation();
    this.retargetWeather();
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
    if (this.orientationTimeout !== null) {
      window.clearTimeout(this.orientationTimeout);
      this.orientationTimeout = null;
    }

    this.releaseFogGL(true);
    this.root?.remove();

    this.container = null;
    this.root = null;
    this.fogCanvas = null;
    this.dropCanvas = null;
    this.dropContext = null;
    this.humidityReadout = null;
    this.dewPointReadout = null;
    this.gapReadout = null;
    this.condensationStatus = null;
    this.orientationButton = null;

    this.trailCanvas = null;
    this.trailContext = null;
    this.trailPixels = null;
    this.backdropCanvas = null;
    this.backdropContext = null;
    this.backdropSource = null;
    this.colorProbeCanvas = null;
    this.colorProbeContext = null;
    this.dropletSprite = null;
    this.backdropAvailable = false;
    this.droplets.length = 0;
    this.orientationListening = false;
    this.orientationReceived = false;
  }

  setTime(minutes: number): void {
    this.timeMinutes = clamp(Number.isFinite(minutes) ? minutes : 0, 0, DAY_MINUTES);
    this.retargetWeather();
    this.updateHud();
  }

  setData(data: DayData): void {
    copySeries(data.humidity, this.humidity, 65, 0, 100);
    copySeries(data.temperature, this.temperature, 18, -100, 100);
    copySeries(data.dewPoint, this.dewPoint, 16, -100, 100);

    const firstData = !this.hasData;
    this.hasData = true;
    this.retargetWeather();
    if (firstData) {
      this.humidityCurrent = this.humidityTarget;
      this.temperatureCurrent = this.temperatureTarget;
      this.dewPointCurrent = this.dewPointTarget;
      this.syncCondensationState();
    }
    this.updateHud(true);
  }

  setQuality(quality: Quality): void {
    if (quality === this.quality) return;
    const previous = QUALITY[this.quality];
    this.quality = quality;
    this.root?.setAttribute('data-quality', quality);

    const maximum = particleBudget(QUALITY[quality].maxDrops);
    if (this.droplets.length > maximum) {
      this.droplets.sort((a, b) => b.radius - a.radius);
      this.droplets.length = maximum;
    }

    if (this.gl && previous.fogOctaves !== QUALITY[quality].fogOctaves) {
      this.buildFogProgram();
    }
    this.resize();
  }

  private createDom(): HTMLElement {
    const root = document.createElement('section');
    root.className = 'serein-humidity-layer';
    root.setAttribute('aria-label', '逐时湿度与镜头结露');
    root.setAttribute('data-quality', this.quality);
    root.innerHTML = `
      <style>${LAYER_CSS}</style>
      <canvas class="serein-humidity-fog" aria-hidden="true"></canvas>
      <canvas class="serein-humidity-drops" aria-hidden="true"></canvas>
      <header class="serein-humidity-header">
        <div class="serein-humidity-heading">
          <h2>湿度</h2>
          <p>逐时 · %</p>
        </div>
        <output class="serein-humidity-readout" aria-label="当前相对湿度">65%</output>
        <div class="serein-humidity-details">
          <p class="serein-humidity-detail serein-humidity-dew-point">露点 16.0°C</p>
          <p class="serein-humidity-detail serein-humidity-gap">
            距露点 +2.0°C
            <span class="serein-humidity-status" hidden>正在结露</span>
          </p>
        </div>
      </header>
      <button class="serein-humidity-orientation" type="button" hidden>
        启用倾斜重力
      </button>
    `;

    this.container?.appendChild(root);
    this.root = root;
    this.fogCanvas = root.querySelector<HTMLCanvasElement>('.serein-humidity-fog');
    this.dropCanvas = root.querySelector<HTMLCanvasElement>('.serein-humidity-drops');
    this.dropContext =
      this.dropCanvas?.getContext('2d', { alpha: true, desynchronized: true }) ?? null;
    this.humidityReadout =
      root.querySelector<HTMLOutputElement>('.serein-humidity-readout');
    this.dewPointReadout =
      root.querySelector<HTMLElement>('.serein-humidity-dew-point');
    this.gapReadout = root.querySelector<HTMLElement>('.serein-humidity-gap');
    this.condensationStatus =
      root.querySelector<HTMLElement>('.serein-humidity-status');
    this.orientationButton =
      root.querySelector<HTMLButtonElement>('.serein-humidity-orientation');
    return root;
  }

  private createAuxiliaryCanvases(): void {
    const trail = document.createElement('canvas');
    trail.width = 1;
    trail.height = 1;
    this.trailCanvas = trail;
    this.trailContext = trail.getContext('2d', {
      alpha: true,
      willReadFrequently: true,
    });

    const backdrop = document.createElement('canvas');
    backdrop.width = 1;
    backdrop.height = 1;
    this.backdropCanvas = backdrop;
    this.backdropContext = backdrop.getContext('2d', { alpha: false });

    const probe = document.createElement('canvas');
    probe.width = 8;
    probe.height = 8;
    this.colorProbeCanvas = probe;
    this.colorProbeContext = probe.getContext('2d', {
      alpha: false,
      willReadFrequently: true,
    });
  }

  private createDropletSprite(): void {
    const canvas = document.createElement('canvas');
    const size = 96;
    canvas.width = size;
    canvas.height = size;
    const context = canvas.getContext('2d');
    if (!context) return;

    const center = size / 2;
    const edge = context.createRadialGradient(center, center, size * 0.12, center, center, size * 0.48);
    edge.addColorStop(0, 'rgba(255,255,255,0.015)');
    edge.addColorStop(0.58, 'rgba(220,238,248,0.025)');
    edge.addColorStop(0.82, 'rgba(15,25,34,0.12)');
    edge.addColorStop(0.94, 'rgba(3,8,13,0.34)');
    edge.addColorStop(1, 'rgba(205,232,246,0.34)');
    context.fillStyle = edge;
    context.beginPath();
    context.arc(center, center, size * 0.48, 0, Math.PI * 2);
    context.fill();

    const highlight = context.createRadialGradient(
      size * 0.34,
      size * 0.29,
      0,
      size * 0.34,
      size * 0.29,
      size * 0.16,
    );
    highlight.addColorStop(0, 'rgba(255,255,255,0.92)');
    highlight.addColorStop(0.2, 'rgba(255,255,255,0.58)');
    highlight.addColorStop(1, 'rgba(255,255,255,0)');
    context.fillStyle = highlight;
    context.fillRect(0, 0, size, size);

    context.strokeStyle = 'rgba(220,240,250,0.24)';
    context.lineWidth = 1.25;
    context.beginPath();
    context.arc(center, center, size * 0.465, Math.PI * 0.12, Math.PI * 1.28);
    context.stroke();
    this.dropletSprite = canvas;
  }

  private attachEvents(): void {
    const signal = this.abortController?.signal;
    const fogCanvas = this.fogCanvas;
    if (!signal || !fogCanvas) return;

    document.addEventListener('visibilitychange', this.onVisibility, { signal });
    window.addEventListener('resize', this.resize, { passive: true, signal });
    window.visualViewport?.addEventListener('resize', this.resize, {
      passive: true,
      signal,
    });
    fogCanvas.addEventListener('webglcontextlost', this.onContextLost, { signal });
    fogCanvas.addEventListener('webglcontextrestored', this.onContextRestored, { signal });
    this.orientationButton?.addEventListener('click', this.onOrientationRequest, {
      signal,
    });
  }

  private initFogGL(): boolean {
    const canvas = this.fogCanvas;
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

    const buffer = gl.createBuffer();
    const texture = gl.createTexture();
    if (!buffer || !texture) {
      if (buffer) gl.deleteBuffer(buffer);
      if (texture) gl.deleteTexture(texture);
      this.gl = null;
      return false;
    }

    this.quadBuffer = buffer;
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(
      gl.ARRAY_BUFFER,
      new Float32Array([-1, -1, 3, -1, -1, 3]),
      gl.STATIC_DRAW,
    );

    this.trailTexture = texture;
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    gl.texImage2D(
      gl.TEXTURE_2D,
      0,
      gl.RGBA,
      1,
      1,
      0,
      gl.RGBA,
      gl.UNSIGNED_BYTE,
      new Uint8Array(4),
    );

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
    return this.buildFogProgram();
  }

  private buildFogProgram(): boolean {
    const gl = this.gl;
    if (!gl) return false;
    const fragmentSource =
      `#define FOG_OCTAVES ${QUALITY[this.quality].fogOctaves}\n${FRAGMENT_SHADER}`;
    const vertexShader = this.compileShader(gl.VERTEX_SHADER, VERTEX_SHADER);
    const fragmentShader = this.compileShader(gl.FRAGMENT_SHADER, fragmentSource);
    if (!vertexShader || !fragmentShader) {
      if (vertexShader) gl.deleteShader(vertexShader);
      if (fragmentShader) gl.deleteShader(fragmentShader);
      return false;
    }

    const program = gl.createProgram();
    if (!program) {
      gl.deleteShader(vertexShader);
      gl.deleteShader(fragmentShader);
      return false;
    }
    gl.attachShader(program, vertexShader);
    gl.attachShader(program, fragmentShader);
    gl.bindAttribLocation(program, 0, 'aPosition');
    gl.linkProgram(program);
    gl.deleteShader(vertexShader);
    gl.deleteShader(fragmentShader);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      console.error('[HumidityLayer] 雾层 shader 链接失败:', gl.getProgramInfoLog(program));
      gl.deleteProgram(program);
      return false;
    }

    if (this.program) gl.deleteProgram(this.program);
    this.program = program;
    this.uniforms = {};
    for (const name of [
      'uResolution',
      'uElapsed',
      'uHumidity',
      'uFogColor',
      'uTrail',
    ]) {
      this.uniforms[name] = gl.getUniformLocation(program, name);
    }
    return true;
  }

  private compileShader(type: number, source: string): WebGLShader | null {
    const gl = this.gl;
    if (!gl) return null;
    const shader = gl.createShader(type);
    if (!shader) return null;
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      console.error('[HumidityLayer] 雾层 shader 编译失败:', gl.getShaderInfoLog(shader));
      gl.deleteShader(shader);
      return null;
    }
    return shader;
  }

  private releaseFogGL(loseContext: boolean): void {
    const gl = this.gl;
    if (gl) {
      if (this.trailTexture) gl.deleteTexture(this.trailTexture);
      if (this.quadBuffer) gl.deleteBuffer(this.quadBuffer);
      if (this.program) gl.deleteProgram(this.program);
      if (loseContext) gl.getExtension('WEBGL_lose_context')?.loseContext();
    }
    this.gl = null;
    this.program = null;
    this.quadBuffer = null;
    this.trailTexture = null;
    this.uniforms = {};
    this.trailTextureWidth = 0;
    this.trailTextureHeight = 0;
  }

  private retargetWeather(): void {
    this.humidityTarget = clamp(sampleSeries(this.humidity, this.timeMinutes), 0, 100);
    this.temperatureTarget = sampleSeries(this.temperature, this.timeMinutes);
    this.dewPointTarget = sampleSeries(this.dewPoint, this.timeMinutes);
  }

  private stepWeather(deltaSeconds: number): void {
    const blend = 1 - Math.exp(-deltaSeconds / 0.16);
    this.humidityCurrent += (this.humidityTarget - this.humidityCurrent) * blend;
    this.temperatureCurrent += (this.temperatureTarget - this.temperatureCurrent) * blend;
    this.dewPointCurrent += (this.dewPointTarget - this.dewPointCurrent) * blend;

    const colorBlend = 1 - Math.exp(-deltaSeconds / 0.9);
    for (let channel = 0; channel < 3; channel += 1) {
      this.fogColor[channel] +=
        (this.fogColorTarget[channel] - this.fogColor[channel]) * colorBlend;
    }
    this.syncCondensationState();
  }

  private syncCondensationState(): void {
    const next =
      this.temperatureCurrent - this.dewPointCurrent <= CONDENSATION_THRESHOLD;
    if (next === this.condensing) return;
    this.condensing = next;

    if (next) {
      this.spawnAccumulator = Math.max(this.spawnAccumulator, 1);
      for (const droplet of this.droplets) {
        droplet.evaporating = false;
        droplet.evaporationAge = 0;
      }
    } else {
      for (const droplet of this.droplets) {
        droplet.evaporating = true;
        droplet.evaporationAge = 0;
        droplet.evaporationStartRadius = droplet.radius;
      }
    }
    this.root?.setAttribute('data-condensing', String(next));
  }

  private effectiveMaxDrops(): number {
    return particleBudget(QUALITY[this.quality].maxDrops);
  }

  private trimDroplets(): void {
    const maximum = this.effectiveMaxDrops();
    if (this.droplets.length > maximum) {
      this.droplets.sort((a, b) => b.radius - a.radius);
      this.droplets.length = maximum;
    }
  }

  private stepDroplets(deltaSeconds: number): void {
    const config = QUALITY[this.quality];
    const maxDrops = this.effectiveMaxDrops();
    const gap = this.temperatureCurrent - this.dewPointCurrent;
    if (this.condensing && this.droplets.length < maxDrops) {
      const saturation = 0.28 + clamp01((CONDENSATION_THRESHOLD - gap) / 1.7) * 0.72;
      const humidityBoost = 0.55 + clamp01(this.humidityCurrent / 100) * 0.45;
      const rate = (maxDrops / config.fillSeconds) * saturation * humidityBoost;
      this.spawnAccumulator += rate * deltaSeconds;
      while (this.spawnAccumulator >= 1 && this.droplets.length < maxDrops) {
        this.spawnDroplet();
        this.spawnAccumulator -= 1;
      }
    }

    const gravityMagnitude = Math.hypot(this.gravityX, this.gravityY);
    for (let index = this.droplets.length - 1; index >= 0; index -= 1) {
      const droplet = this.droplets[index];
      if (droplet.evaporating) {
        droplet.evaporationAge += deltaSeconds;
        const remaining = 1 - droplet.evaporationAge / EVAPORATION_SECONDS;
        if (remaining <= 0) {
          this.droplets.splice(index, 1);
          continue;
        }
        droplet.radius = droplet.evaporationStartRadius * remaining;
        droplet.velocityX *= Math.exp(-deltaSeconds * 3);
        droplet.velocityY *= Math.exp(-deltaSeconds * 3);
        continue;
      }

      if (!droplet.sliding) {
        const growthFactor = 0.72 + clamp01(this.humidityCurrent / 100) * 0.55;
        droplet.radius += droplet.growth * growthFactor * deltaSeconds;
        if (droplet.radius >= droplet.slideThreshold) {
          this.beginSliding(droplet);
        }
      }

      if (droplet.sliding) {
        const previousX = droplet.x;
        const previousY = droplet.y;
        const acceleration = 68 + droplet.radius * 7.5;
        droplet.velocityX += this.gravityX * acceleration * deltaSeconds;
        droplet.velocityY += this.gravityY * acceleration * deltaSeconds;

        const drag = Math.exp(-deltaSeconds * (gravityMagnitude < 0.06 ? 3.5 : 0.82));
        droplet.velocityX *= drag;
        droplet.velocityY *= drag;
        const speed = Math.hypot(droplet.velocityX, droplet.velocityY);
        const terminal = 105 + droplet.radius * 6;
        if (speed > terminal) {
          const scale = terminal / speed;
          droplet.velocityX *= scale;
          droplet.velocityY *= scale;
        }

        droplet.x += droplet.velocityX * deltaSeconds;
        droplet.y += droplet.velocityY * deltaSeconds;
        if (Math.hypot(droplet.x - previousX, droplet.y - previousY) > 0.08) {
          this.drawTrail(previousX, previousY, droplet.x, droplet.y, droplet.radius);
        }
      } else if (this.sampleTrail(droplet.x, droplet.y) > 0.5) {
        // 新鲜擦痕内不能立即重新挂住小水滴。
        this.droplets.splice(index, 1);
        continue;
      }

      const margin = Math.max(18, droplet.radius * 2.2);
      if (
        droplet.x < -margin ||
        droplet.x > this.viewportWidth + margin ||
        droplet.y < -margin ||
        droplet.y > this.viewportHeight + margin
      ) {
        this.droplets.splice(index, 1);
      }
    }

    if (
      this.condensing &&
      this.frameNumber % config.collisionEvery === 0 &&
      this.droplets.length > 1
    ) {
      this.mergeTouchingDroplets();
    }
  }

  private spawnDroplet(): void {
    const radius = 1 + this.random() * 2;
    let x = radius;
    let y = radius;

    for (let attempt = 0; attempt < 8; attempt += 1) {
      x = 7 + this.random() * Math.max(1, this.viewportWidth - 14);
      y = 7 + this.random() * Math.max(1, this.viewportHeight - 14);
      if (this.sampleTrail(x, y) > 0.22) continue;

      let occupied = false;
      for (let index = 0; index < this.droplets.length; index += 1) {
        const other = this.droplets[index];
        const minimumDistance = (radius + other.radius) * 1.15;
        if ((x - other.x) ** 2 + (y - other.y) ** 2 < minimumDistance ** 2) {
          occupied = true;
          break;
        }
      }
      if (!occupied) break;
    }

    this.droplets.push({
      x,
      y,
      radius,
      growth: 0.32 + this.random() * 0.36,
      slideThreshold: 8 + this.random() * 6,
      velocityX: 0,
      velocityY: 0,
      sliding: false,
      evaporating: false,
      evaporationAge: 0,
      evaporationStartRadius: radius,
    });
  }

  private beginSliding(droplet: Droplet): void {
    if (droplet.sliding) return;
    droplet.sliding = true;
    droplet.velocityX += this.gravityX * (3 + this.random() * 4);
    droplet.velocityY += this.gravityY * (3 + this.random() * 4);
  }

  private mergeTouchingDroplets(): void {
    for (let left = 0; left < this.droplets.length; left += 1) {
      const a = this.droplets[left];
      if (a.evaporating) continue;

      for (let right = this.droplets.length - 1; right > left; right -= 1) {
        const b = this.droplets[right];
        if (b.evaporating) continue;
        const touchDistance = (a.radius + b.radius) * 0.92;
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        if (dx * dx + dy * dy > touchDistance * touchDistance) continue;

        // 球体体积守恒：合并后 r³ = r₁³ + r₂³。
        const volumeA = a.radius ** 3;
        const volumeB = b.radius ** 3;
        const volume = volumeA + volumeB;
        a.x = (a.x * volumeA + b.x * volumeB) / volume;
        a.y = (a.y * volumeA + b.y * volumeB) / volume;
        a.velocityX =
          (a.velocityX * volumeA + b.velocityX * volumeB) / volume;
        a.velocityY =
          (a.velocityY * volumeA + b.velocityY * volumeB) / volume;
        a.radius = Math.cbrt(volume);
        a.growth = Math.max(a.growth, b.growth);
        a.slideThreshold = Math.min(a.slideThreshold, b.slideThreshold);
        a.sliding ||= b.sliding;
        this.droplets.splice(right, 1);

        if (a.sliding || a.radius >= a.slideThreshold) this.beginSliding(a);
      }
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

  private drawTrail(
    fromX: number,
    fromY: number,
    toX: number,
    toY: number,
    radius: number,
  ): void {
    const context = this.trailContext;
    const canvas = this.trailCanvas;
    if (!context || !canvas) return;
    const scaleX = canvas.width / Math.max(1, this.viewportWidth);
    const scaleY = canvas.height / Math.max(1, this.viewportHeight);

    context.save();
    context.setTransform(scaleX, 0, 0, scaleY, 0, 0);
    context.globalCompositeOperation = 'source-over';
    context.strokeStyle = 'rgba(255,255,255,.98)';
    context.lineWidth = Math.max(2.2, radius * 1.62);
    context.lineCap = 'round';
    context.lineJoin = 'round';
    context.beginPath();
    context.moveTo(fromX, fromY);
    context.lineTo(toX, toY);
    context.stroke();
    context.restore();

    this.trailDirty = true;
    this.trailHasContent = true;
  }

  private recoverTrails(deltaSeconds: number): void {
    if (!this.trailHasContent) return;
    this.trailRecoveryAccumulator += deltaSeconds;
    if (this.trailRecoveryAccumulator < TRAIL_RECOVERY_STEP) return;

    const canvas = this.trailCanvas;
    const context = this.trailContext;
    if (!canvas || !context) return;
    const elapsed = this.trailRecoveryAccumulator;
    this.trailRecoveryAccumulator = 0;

    try {
      const image = context.getImageData(0, 0, canvas.width, canvas.height);
      const pixels = image.data;
      const decrement = (255 * elapsed) / TRAIL_RECOVERY_SECONDS;
      let hasContent = false;
      for (let index = 3; index < pixels.length; index += 4) {
        const next = Math.max(0, pixels[index] - decrement);
        pixels[index] = next;
        hasContent ||= next > 0;
      }
      context.putImageData(image, 0, 0);
      this.trailPixels = pixels;
      this.trailHasContent = hasContent;
      this.trailDirty = true;
    } catch {
      this.trailPixels = null;
    }
  }

  private sampleTrail(x: number, y: number): number {
    const canvas = this.trailCanvas;
    const pixels = this.trailPixels;
    if (!canvas || !pixels || pixels.length < 4) return 0;
    const px = clamp(Math.floor((x / Math.max(1, this.viewportWidth)) * canvas.width), 0, canvas.width - 1);
    const py = clamp(Math.floor((y / Math.max(1, this.viewportHeight)) * canvas.height), 0, canvas.height - 1);
    return pixels[(py * canvas.width + px) * 4 + 3] / 255;
  }

  private captureBackdrop(): void {
    const canvas = this.backdropCanvas;
    const context = this.backdropContext;
    if (!canvas || !context) return;

    if (
      !this.backdropSource ||
      !this.backdropSource.isConnected ||
      this.elapsed >= this.backdropSearchAt
    ) {
      this.backdropSource = this.findBackdropCanvas();
      this.backdropSearchAt = this.elapsed + 1;
    }
    const source = this.backdropSource;
    if (!source || source.width < 2 || source.height < 2) {
      this.backdropAvailable = false;
      if (!this.readSkyColorHint()) this.useFallbackFogColor();
      return;
    }

    try {
      context.setTransform(1, 0, 0, 1, 0, 0);
      context.drawImage(
        source,
        0,
        0,
        source.width,
        source.height,
        0,
        0,
        canvas.width,
        canvas.height,
      );
      this.backdropAvailable = true;
      if (!this.readSkyColorHint() && this.frameNumber % 30 === 0) {
        this.sampleBackdropColor();
      }
    } catch {
      this.backdropAvailable = false;
      if (!this.readSkyColorHint()) this.useFallbackFogColor();
    }
  }

  private findBackdropCanvas(): HTMLCanvasElement | null {
    const searchRoot = this.container?.parentElement ?? document.body;
    const own = new Set([
      this.fogCanvas,
      this.dropCanvas,
      this.trailCanvas,
      this.backdropCanvas,
      this.colorProbeCanvas,
      this.dropletSprite,
    ]);
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
    const cssColor =
      getComputedStyle(source).getPropertyValue('--sky-average-color').trim();
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

  private sampleBackdropColor(): void {
    const probe = this.colorProbeCanvas;
    const context = this.colorProbeContext;
    const backdrop = this.backdropCanvas;
    if (!probe || !context || !backdrop) return;

    try {
      context.clearRect(0, 0, probe.width, probe.height);
      context.drawImage(backdrop, 0, 0, probe.width, probe.height);
      const pixels = context.getImageData(0, 0, probe.width, probe.height).data;
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
      if (count > 0) this.setLightenedFogColor(red / count / 255, green / count / 255, blue / count / 255);
    } catch {
      this.useFallbackFogColor();
    }
  }

  private useFallbackFogColor(): void {
    this.fogColorTarget[0] = FALLBACK_FOG_COLOR[0];
    this.fogColorTarget[1] = FALLBACK_FOG_COLOR[1];
    this.fogColorTarget[2] = FALLBACK_FOG_COLOR[2];
  }

  private setLightenedFogColor(red: number, green: number, blue: number): void {
    const lighten = 0.42;
    this.fogColorTarget[0] = clamp01(red + (1 - red) * lighten);
    this.fogColorTarget[1] = clamp01(green + (1 - green) * lighten);
    this.fogColorTarget[2] = clamp01(blue + (1 - blue) * lighten);
  }

  private renderFog(): void {
    const normalizedHumidity = clamp01((this.humidityCurrent - 30) / 70);
    const fallbackOpacity = 0.005 + normalizedHumidity ** 1.35 * 0.82;
    this.root?.style.setProperty('--fog-opacity', fallbackOpacity.toFixed(3));

    const gl = this.gl;
    const program = this.program;
    const buffer = this.quadBuffer;
    const texture = this.trailTexture;
    const canvas = this.fogCanvas;
    if (!gl || !program || !buffer || !texture || !canvas) return;

    this.uploadTrailTexture();
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.useProgram(program);
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.uniform2f(this.uniforms.uResolution, canvas.width, canvas.height);
    gl.uniform1f(this.uniforms.uElapsed, this.elapsed);
    gl.uniform1f(this.uniforms.uHumidity, normalizedHumidity);
    gl.uniform3f(
      this.uniforms.uFogColor,
      this.fogColor[0],
      this.fogColor[1],
      this.fogColor[2],
    );
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.uniform1i(this.uniforms.uTrail, 0);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  private uploadTrailTexture(): void {
    if (!this.trailDirty) return;
    const gl = this.gl;
    const texture = this.trailTexture;
    const canvas = this.trailCanvas;
    if (!gl || !texture || !canvas) return;

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    if (
      this.trailTextureWidth !== canvas.width ||
      this.trailTextureHeight !== canvas.height
    ) {
      gl.texImage2D(
        gl.TEXTURE_2D,
        0,
        gl.RGBA,
        gl.RGBA,
        gl.UNSIGNED_BYTE,
        canvas,
      );
      this.trailTextureWidth = canvas.width;
      this.trailTextureHeight = canvas.height;
    } else {
      gl.texSubImage2D(
        gl.TEXTURE_2D,
        0,
        0,
        0,
        gl.RGBA,
        gl.UNSIGNED_BYTE,
        canvas,
      );
    }
    this.trailDirty = false;
  }

  private renderDroplets(): void {
    const context = this.dropContext;
    const canvas = this.dropCanvas;
    if (!context || !canvas) return;

    context.setTransform(1, 0, 0, 1, 0, 0);
    context.clearRect(0, 0, canvas.width, canvas.height);
    context.setTransform(this.dropDpr, 0, 0, this.dropDpr, 0, 0);
    context.imageSmoothingEnabled = true;
    context.imageSmoothingQuality = this.quality === 'low' ? 'low' : 'high';

    for (let index = 0; index < this.droplets.length; index += 1) {
      this.renderDroplet(context, this.droplets[index]);
    }
    context.setTransform(1, 0, 0, 1, 0, 0);
  }

  private renderDroplet(context: CanvasRenderingContext2D, droplet: Droplet): void {
    const speed = Math.hypot(droplet.velocityX, droplet.velocityY);
    const stretch = droplet.sliding ? 1 + Math.min(0.38, speed / 360) : 1;
    const radiusX = droplet.radius * stretch;
    const radiusY = droplet.radius / Math.sqrt(stretch);
    const angle = droplet.sliding
      ? Math.atan2(droplet.velocityY, droplet.velocityX)
      : 0;
    const opacity = clamp01((droplet.radius - 0.45) / 1.4);

    context.save();
    context.globalAlpha = opacity;
    context.beginPath();
    context.ellipse(
      droplet.x,
      droplet.y,
      Math.max(0.2, radiusX),
      Math.max(0.2, radiusY),
      angle,
      0,
      Math.PI * 2,
    );
    context.clip();

    if (this.backdropAvailable && this.backdropCanvas) {
      const backdrop = this.backdropCanvas;
      const scaleX = backdrop.width / Math.max(1, this.viewportWidth);
      const scaleY = backdrop.height / Math.max(1, this.viewportHeight);
      const magnification = 1.1 + Math.min(0.16, droplet.radius / 85);
      const sourceWidth = (radiusX * 2.08) / magnification;
      const sourceHeight = (radiusY * 2.08) / magnification;
      const offsetX = -this.gravityX * droplet.radius * 0.12;
      const offsetY = -this.gravityY * droplet.radius * 0.12;
      const sourceX = clamp(
        droplet.x - sourceWidth / 2 + offsetX,
        0,
        Math.max(0, this.viewportWidth - sourceWidth),
      );
      const sourceY = clamp(
        droplet.y - sourceHeight / 2 + offsetY,
        0,
        Math.max(0, this.viewportHeight - sourceHeight),
      );
      context.drawImage(
        backdrop,
        sourceX * scaleX,
        sourceY * scaleY,
        sourceWidth * scaleX,
        sourceHeight * scaleY,
        droplet.x - radiusX * 1.04,
        droplet.y - radiusY * 1.04,
        radiusX * 2.08,
        radiusY * 2.08,
      );
    } else {
      context.fillStyle = `rgba(${Math.round(this.fogColor[0] * 255)},${Math.round(
        this.fogColor[1] * 255,
      )},${Math.round(this.fogColor[2] * 255)},.2)`;
      context.fillRect(
        droplet.x - radiusX,
        droplet.y - radiusY,
        radiusX * 2,
        radiusY * 2,
      );
    }
    context.restore();

    const sprite = this.dropletSprite;
    if (sprite) {
      context.save();
      context.globalAlpha = opacity * 0.98;
      context.translate(droplet.x, droplet.y);
      context.rotate(angle);
      context.scale(radiusX / 48, radiusY / 48);
      context.drawImage(sprite, -48, -48);
      context.restore();
    }
  }

  private updateHud(force = false): void {
    const humidityText = `${Math.round(clamp(this.humidityCurrent, 0, 100))}%`;
    if (force || humidityText !== this.lastHumidityText) {
      this.lastHumidityText = humidityText;
      if (this.humidityReadout) {
        this.humidityReadout.value = humidityText;
        this.humidityReadout.setAttribute(
          'aria-label',
          `当前相对湿度 ${humidityText}`,
        );
      }
    }

    const dewPointText = `露点 ${formatTemperature(this.dewPointCurrent)}`;
    if (force || dewPointText !== this.lastDewPointText) {
      this.lastDewPointText = dewPointText;
      if (this.dewPointReadout) this.dewPointReadout.textContent = dewPointText;
    }

    const gap = this.temperatureCurrent - this.dewPointCurrent;
    const gapText = `距露点 ${formatTemperature(gap, true)}`;
    if (force || gapText !== this.lastGapText) {
      this.lastGapText = gapText;
      if (this.gapReadout) {
        const textNode = this.gapReadout.firstChild;
        if (textNode) textNode.textContent = `${gapText} `;
        this.gapReadout.setAttribute(
          'aria-label',
          this.condensing ? `${gapText}，正在结露` : gapText,
        );
      }
    }

    if (force || this.lastCondensingState !== this.condensing) {
      this.lastCondensingState = this.condensing;
      this.gapReadout?.classList.toggle('is-condensing', this.condensing);
      if (this.condensationStatus) this.condensationStatus.hidden = !this.condensing;
      this.gapReadout?.setAttribute(
        'aria-label',
        this.condensing ? `${gapText}，正在结露` : gapText,
      );
    }
    this.root?.setAttribute('data-droplet-count', String(this.droplets.length));
  }

  private setupOrientation(): void {
    const Constructor = window.DeviceOrientationEvent as
      | OrientationEventConstructor
      | undefined;
    if (!Constructor) {
      this.useFallbackGravity('unsupported');
      return;
    }

    if (typeof Constructor.requestPermission === 'function') {
      if (this.orientationButton) {
        this.orientationButton.hidden = false;
        this.orientationButton.disabled = false;
        this.orientationButton.textContent = '启用倾斜重力';
        this.orientationButton.setAttribute('aria-label', '允许设备方向传感器控制水滴重力');
      }
      this.root?.setAttribute('data-orientation', 'permission-required');
      this.useFallbackGravity('permission-required');
    } else {
      this.connectOrientationListener();
    }
  }

  private connectOrientationListener(): void {
    if (this.orientationListening) return;
    const signal = this.abortController?.signal;
    if (!signal) return;
    this.orientationListening = true;
    this.orientationReceived = false;
    window.addEventListener('deviceorientation', this.onDeviceOrientation, {
      passive: true,
      signal,
    });
    this.root?.setAttribute('data-orientation', 'waiting');

    if (this.orientationTimeout !== null) window.clearTimeout(this.orientationTimeout);
    this.orientationTimeout = window.setTimeout(() => {
      this.orientationTimeout = null;
      if (!this.orientationReceived) this.useFallbackGravity('no-sensor');
    }, 2800);
  }

  private useFallbackGravity(reason: string): void {
    this.gravityTargetX = 0;
    this.gravityTargetY = 1;
    this.root?.setAttribute('data-orientation-fallback', reason);
    if (reason !== 'permission-required') {
      this.root?.setAttribute('data-orientation', 'fallback');
    }
  }

  private stepGravity(deltaSeconds: number): void {
    if (
      this.orientationReceived &&
      performance.now() - this.orientationLastAt > 4000 &&
      !document.hidden
    ) {
      this.orientationReceived = false;
      this.useFallbackGravity('stale-sensor');
    }
    const blend = 1 - Math.exp(-deltaSeconds / 0.18);
    this.gravityX += (this.gravityTargetX - this.gravityX) * blend;
    this.gravityY += (this.gravityTargetY - this.gravityY) * blend;
  }

  private onOrientationRequest = async (): Promise<void> => {
    const button = this.orientationButton;
    const Constructor = window.DeviceOrientationEvent as
      | OrientationEventConstructor
      | undefined;
    if (!button || !Constructor?.requestPermission) return;

    button.disabled = true;
    button.textContent = '正在请求…';
    try {
      const result = await Constructor.requestPermission();
      if (!this.root) return;
      if (result === 'granted') {
        button.hidden = true;
        this.connectOrientationListener();
      } else {
        button.hidden = true;
        this.useFallbackGravity('permission-denied');
      }
    } catch {
      if (!this.root) return;
      button.hidden = true;
      this.useFallbackGravity('permission-error');
    } finally {
      button.disabled = false;
    }
  };

  private onDeviceOrientation = (event: DeviceOrientationEvent): void => {
    if (!Number.isFinite(event.beta) || !Number.isFinite(event.gamma)) return;
    const beta = ((event.beta ?? 0) * Math.PI) / 180;
    const gamma = ((event.gamma ?? 0) * Math.PI) / 180;

    // 重力在玻璃平面上的投影；随后按当前屏幕方向转回屏幕坐标。
    const naturalX = Math.sin(gamma);
    const naturalY = Math.sin(beta) * Math.cos(gamma);
    const legacyOrientation = (window as unknown as { orientation?: number }).orientation;
    const screenAngle =
      screen.orientation?.angle ?? (Number.isFinite(legacyOrientation) ? legacyOrientation! : 0);
    const angle = (screenAngle * Math.PI) / 180;
    const cosine = Math.cos(angle);
    const sine = Math.sin(angle);
    const screenX = naturalX * cosine + naturalY * sine;
    const screenY = -naturalX * sine + naturalY * cosine;

    this.gravityTargetX = clamp(screenX, -1, 1);
    this.gravityTargetY = clamp(screenY, -1, 1);
    this.orientationReceived = true;
    this.orientationLastAt = performance.now();
    if (this.orientationTimeout !== null) {
      window.clearTimeout(this.orientationTimeout);
      this.orientationTimeout = null;
    }
    this.root?.setAttribute('data-orientation', 'active');
    this.root?.removeAttribute('data-orientation-fallback');
  };

  private resize = (): void => {
    const container = this.container;
    const fogCanvas = this.fogCanvas;
    const dropCanvas = this.dropCanvas;
    if (!container || !fogCanvas || !dropCanvas) return;
    const config = QUALITY[this.quality];
    const width = Math.max(1, container.clientWidth);
    const height = Math.max(1, container.clientHeight);
    const deviceDpr = window.devicePixelRatio || 1;
    const fogDpr = Math.min(deviceDpr, config.fogDpr);
    const dropDpr = Math.min(deviceDpr, config.dropDpr);

    this.viewportWidth = width;
    this.viewportHeight = height;
    this.dropDpr = dropDpr;
    this.resizeCanvas(fogCanvas, width * fogDpr, height * fogDpr);
    this.resizeCanvas(dropCanvas, width * dropDpr, height * dropDpr);
    this.gl?.viewport(0, 0, fogCanvas.width, fogCanvas.height);

    const trail = this.trailCanvas;
    if (trail) {
      const trailWidth = Math.max(2, Math.round(width * config.trailScale));
      const trailHeight = Math.max(2, Math.round(height * config.trailScale));
      if (trail.width !== trailWidth || trail.height !== trailHeight) {
        trail.width = trailWidth;
        trail.height = trailHeight;
        this.trailPixels = new Uint8ClampedArray(trailWidth * trailHeight * 4);
        this.trailHasContent = false;
        this.trailDirty = true;
        this.trailTextureWidth = 0;
        this.trailTextureHeight = 0;
      }
    }

    const backdrop = this.backdropCanvas;
    if (backdrop) {
      this.resizeCanvas(
        backdrop,
        Math.max(2, width * config.backdropScale),
        Math.max(2, height * config.backdropScale),
      );
    }
    this.backdropSource = null;
    this.backdropSearchAt = 0;
    this.root?.setAttribute('data-renderer-pixel-ratio', fogDpr.toFixed(2));
  };

  private resizeCanvas(canvas: HTMLCanvasElement, width: number, height: number): void {
    const nextWidth = Math.max(1, Math.round(width));
    const nextHeight = Math.max(1, Math.round(height));
    if (canvas.width !== nextWidth) canvas.width = nextWidth;
    if (canvas.height !== nextHeight) canvas.height = nextHeight;
  }

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
    this.frameNumber += 1;

    this.stepWeather(deltaSeconds);
    this.stepGravity(deltaSeconds);
    this.recoverTrails(deltaSeconds);
    this.stepDroplets(deltaSeconds);
    if (this.frameNumber % QUALITY[this.quality].backdropEvery === 0) {
      this.captureBackdrop();
    }
    this.renderFog();
    this.renderDroplets();
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
    this.program = null;
    this.quadBuffer = null;
    this.trailTexture = null;
    this.uniforms = {};
    this.trailTextureWidth = 0;
    this.trailTextureHeight = 0;
    this.trailDirty = true;
    this.root?.setAttribute('data-webgl-status', 'lost');
  };

  private onContextRestored = (): void => {
    if (this.initFogGL()) {
      this.root?.classList.remove('is-fog-fallback');
      this.root?.setAttribute('data-webgl-status', 'ready');
      this.resize();
    } else {
      this.root?.classList.add('is-fog-fallback');
    }
  };
}
