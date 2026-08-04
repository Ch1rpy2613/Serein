/**
 * WindLayer —— 由逐时风向、风速与阵风真实驱动的全屏流线场。
 *
 * 粒子在 CPU 上沿「全局风矢量 + 2D curl noise」平流，位置写入一个预分配
 * 的动态顶点缓冲，再由 WebGL 用单次 GL_LINES draw call 绘制。帧循环内不创建
 * 数组或临时对象，适合移动端长时间运行。
 */

import type { DayData, WeatherLayer } from '../../contracts';

type Quality = 'low' | 'medium' | 'high';

interface AudioGraph {
  context: AudioContext;
  source: AudioBufferSourceNode;
  filter: BiquadFilterNode;
  gain: GainNode;
}

const HOURS = 25;
const DAY_MINUTES = 1440;
const WIND_SEED = 0x7a31c9d5;

const PARTICLE_COUNT: Record<Quality, number> = {
  high: 20_000,
  medium: 8_000,
  low: 3_000,
};

const DPR_CAP: Record<Quality, number> = {
  high: 1,
  medium: 1,
  low: 1,
};

/** 100ms 时间常数会在约 400ms 内完成 98% 的转向与变速。 */
const WIND_EASE_TAU = 0.1;
const GUST_ATTACK = 0.3;
const GUST_RELEASE = 2;
const COMPASS_STIFFNESS = 105;
const COMPASS_DAMPING = 19;
const CURL_STRENGTH = 0.3;
const CURL_SPATIAL_SCALE = 3.2;

const COMPASS_NAMES = [
  '北风',
  '北东北风',
  '东北风',
  '东东北风',
  '东风',
  '东东南风',
  '东南风',
  '南东南风',
  '南风',
  '南西南风',
  '西南风',
  '西西南风',
  '西风',
  '西西北风',
  '西北风',
  '北西北风',
] as const;

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

uniform float uAlpha;

void main() {
  gl_FragColor = vec4(1.0, 1.0, 1.0, uAlpha);
}
`;

const LAYER_CSS = `
.serein-wind-layer {
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
.serein-wind-canvas {
  position: absolute;
  inset: 0;
  z-index: 0;
  display: block;
  width: 100%;
  height: 100%;
  pointer-events: none;
}
.serein-wind-header {
  position: absolute;
  top: max(28px, env(safe-area-inset-top));
  left: max(28px, env(safe-area-inset-left));
  z-index: 2;
  display: grid;
  gap: 12px;
  pointer-events: none;
}
.serein-wind-heading {
  display: flex;
  align-items: baseline;
  gap: 11px;
}
.serein-wind-heading h2,
.serein-wind-heading p,
.serein-wind-speed,
.serein-wind-direction {
  margin: 0;
}
.serein-wind-heading h2 {
  font-size: 17px;
  font-weight: 560;
  letter-spacing: .02em;
}
.serein-wind-heading p {
  color: var(--fg-2, rgba(255,255,255,.45));
  font-size: 11px;
  font-weight: 500;
  letter-spacing: .08em;
}
.serein-wind-current {
  display: flex;
  align-items: baseline;
  gap: 13px;
}
.serein-wind-speed {
  color: var(--fg-1, rgba(255,255,255,.92));
  font-size: 56px;
  font-weight: 340;
  letter-spacing: -.055em;
  line-height: .9;
  text-shadow: 0 0 28px rgba(255,255,255,.1);
}
.serein-wind-direction {
  color: var(--fg-2, rgba(255,255,255,.45));
  font-size: 12px;
  font-weight: 520;
  letter-spacing: .08em;
  white-space: nowrap;
}
.serein-wind-sound {
  position: absolute;
  top: max(20px, env(safe-area-inset-top));
  right: max(20px, env(safe-area-inset-right));
  z-index: 3;
  display: grid;
  width: 42px;
  height: 42px;
  padding: 0;
  place-items: center;
  border: 1px solid var(--line, rgba(255,255,255,.22));
  border-radius: 50%;
  background: rgba(5,7,10,.2);
  color: var(--fg-2, rgba(255,255,255,.45));
  cursor: pointer;
  pointer-events: auto;
  transition: color 160ms ease, background-color 160ms ease, border-color 160ms ease;
  -webkit-tap-highlight-color: transparent;
}
.serein-wind-sound:hover,
.serein-wind-sound[aria-pressed="true"] {
  border-color: rgba(255,255,255,.32);
  background: rgba(255,255,255,.06);
  color: var(--fg-1, rgba(255,255,255,.92));
}
.serein-wind-sound:focus-visible {
  outline: 2px solid var(--accent, #7ec8ff);
  outline-offset: 3px;
}
.serein-wind-sound svg {
  width: 18px;
  height: 18px;
  overflow: visible;
}
.serein-wind-sound path {
  fill: none;
  stroke: currentColor;
  stroke-linecap: round;
  stroke-linejoin: round;
  stroke-width: 1.55;
}
.serein-wind-sound[aria-pressed="false"] .serein-wind-sound-wave,
.serein-wind-sound[aria-pressed="true"] .serein-wind-sound-mute {
  display: none;
}
.serein-wind-compass {
  position: absolute;
  right: max(28px, env(safe-area-inset-right));
  bottom: max(28px, env(safe-area-inset-bottom));
  z-index: 2;
  width: 68px;
  height: 68px;
  border: 1px solid var(--line, rgba(255,255,255,.22));
  border-radius: 50%;
  box-shadow: inset 0 0 24px rgba(255,255,255,.018);
  pointer-events: none;
}
.serein-wind-compass::before {
  position: absolute;
  top: -1px;
  left: 50%;
  width: 1px;
  height: 5px;
  background: var(--fg-2, rgba(255,255,255,.45));
  content: "";
  transform: translateX(-50%);
}
.serein-wind-needle {
  position: absolute;
  inset: 8px;
  transform: rotate(0deg);
  transform-origin: 50% 50%;
  will-change: transform;
}
.serein-wind-needle::before {
  position: absolute;
  top: 0;
  left: 50%;
  width: 8px;
  height: 12px;
  background: var(--fg-1, rgba(255,255,255,.92));
  clip-path: polygon(50% 0, 100% 100%, 50% 76%, 0 100%);
  content: "";
  filter: drop-shadow(0 0 5px rgba(255,255,255,.22));
  transform: translateX(-50%);
}
.serein-wind-needle::after {
  position: absolute;
  top: 50%;
  left: 50%;
  width: 3px;
  height: 3px;
  border-radius: 50%;
  background: var(--fg-2, rgba(255,255,255,.45));
  content: "";
  transform: translate(-50%, -50%);
}
.serein-wind-layer.is-fallback::after {
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
  .serein-wind-header {
    top: max(20px, env(safe-area-inset-top));
    left: max(20px, env(safe-area-inset-left));
    gap: 10px;
  }
  .serein-wind-speed {
    font-size: 48px;
  }
  .serein-wind-sound {
    top: max(16px, env(safe-area-inset-top));
    right: max(16px, env(safe-area-inset-right));
  }
  .serein-wind-compass {
    right: max(20px, env(safe-area-inset-right));
    bottom: max(20px, env(safe-area-inset-bottom));
    width: 60px;
    height: 60px;
  }
}
`;

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function clamp01(value: number): number {
  return clamp(value, 0, 1);
}

function normalizeDegrees(value: number): number {
  return ((value % 360) + 360) % 360;
}

function shortestAngularDelta(from: number, to: number): number {
  return ((((to - from + 180) % 360) + 360) % 360) - 180;
}

function sampleSeries(values: ArrayLike<number>, hour: number): number {
  const safeHour = clamp(hour, 0, 24);
  const left = Math.min(23, Math.floor(safeHour));
  const amount = safeHour - left;
  return values[left] + (values[left + 1] - values[left]) * amount;
}

function sampleDirection(values: ArrayLike<number>, hour: number): number {
  const safeHour = clamp(hour, 0, 24);
  const left = Math.min(23, Math.floor(safeHour));
  const amount = safeHour - left;
  const start = values[left];
  return normalizeDegrees(start + shortestAngularDelta(start, values[left + 1]) * amount);
}

function directionIndex(degrees: number): number {
  return Math.floor((normalizeDegrees(degrees) + 11.25) / 22.5) % COMPASS_NAMES.length;
}

export class WindLayer implements WeatherLayer {
  readonly id = 'wind';
  readonly name = '风';
  readonly preferredSkyDim = 0.6;

  private container: HTMLElement | null = null;
  private root: HTMLElement | null = null;
  private canvas: HTMLCanvasElement | null = null;
  private speedReadout: HTMLOutputElement | null = null;
  private directionReadout: HTMLElement | null = null;
  private soundButton: HTMLButtonElement | null = null;
  private compass: HTMLElement | null = null;
  private compassNeedle: HTMLElement | null = null;

  private gl: WebGLRenderingContext | null = null;
  private program: WebGLProgram | null = null;
  private vertexBuffer: WebGLBuffer | null = null;
  private alphaUniform: WebGLUniformLocation | null = null;

  private abortController: AbortController | null = null;
  private resizeObserver: ResizeObserver | null = null;
  private raf = 0;
  private lastTimestamp = 0;
  private elapsed = 0;

  private quality: Quality = 'high';
  private viewportWidth = 1;
  private viewportHeight = 1;

  private particleCount = 0;
  private particleX = new Float32Array(0);
  private particleY = new Float32Array(0);
  private particleLife = new Float32Array(0);
  private vertexData = new Float32Array(0);
  private particleRandomState = WIND_SEED;
  private gustRandomState = WIND_SEED ^ 0x4c8f6e27;

  private windSpeed = new Float32Array(HOURS).fill(3);
  private windDirection = new Float32Array(HOURS).fill(315);
  private windGust = new Float32Array(HOURS).fill(5);
  private hasData = false;
  private timeMinutes = 480;

  private speedCurrent = 3;
  private speedTarget = 3;
  private directionCurrent = 315;
  private directionTarget = 315;
  private gustCurrent = 5;
  private gustTarget = 5;

  /** 以 m/s 表示的阵风附加速度包络。 */
  private gustBoost = 0;
  private gustPulseEnd = 0;
  private nextGustPulseAt = 0;

  private compassAngle = 315;
  private compassVelocity = 0;
  private lastCompassTenth = Number.NaN;
  private lastSpeedTenth = Number.NaN;
  private lastDirectionIndex = -1;
  private lastGustStep = -1;

  private audio: AudioGraph | null = null;
  private audioGeneration = 0;
  private audioAccumulator = 0;
  private soundEnabled = false;
  private hasUserInteracted = false;

  mount(container: HTMLElement): void {
    if (this.root) return;

    this.container = container;
    this.abortController = new AbortController();
    this.elapsed = 0;
    this.gustBoost = 0;
    this.gustPulseEnd = 0;
    this.nextGustPulseAt = 0;
    this.gustRandomState = (WIND_SEED ^ 0x4c8f6e27) >>> 0;
    this.audioAccumulator = 0;
    const root = this.createDom();
    this.attachEvents();

    try {
      if (!this.initGL()) {
        root.classList.add('is-fallback');
        console.warn('[WindLayer] WebGL 不可用，风场仅保留读数与罗盘');
      }
    } catch (error) {
      root.classList.add('is-fallback');
      console.warn('[WindLayer] WebGL 初始化失败，风场仅保留读数与罗盘', error);
    }

    this.resizeObserver = new ResizeObserver(this.resize);
    this.resizeObserver.observe(container);
    this.resize();
    if (this.gl && this.program && this.vertexBuffer) this.rebuildParticles();
    this.updateHud(true);
    this.updateCompass(true);
    this.start();
  }

  unmount(): void {
    this.stop();
    this.audioGeneration += 1;
    this.closeAudio();
    this.abortController?.abort();
    this.abortController = null;
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    this.releaseGL(true);

    this.root?.remove();
    this.container = null;
    this.root = null;
    this.canvas = null;
    this.speedReadout = null;
    this.directionReadout = null;
    this.soundButton = null;
    this.compass = null;
    this.compassNeedle = null;

    this.particleCount = 0;
    this.particleX = new Float32Array(0);
    this.particleY = new Float32Array(0);
    this.particleLife = new Float32Array(0);
    this.vertexData = new Float32Array(0);
    this.soundEnabled = false;
    this.hasUserInteracted = false;
  }

  setTime(minutes: number): void {
    this.timeMinutes = clamp(Number.isFinite(minutes) ? minutes : 0, 0, DAY_MINUTES);
    this.retargetWind();
  }

  setData(data: DayData): void {
    let speedFallback = 3;
    let directionFallback = 315;
    let gustFallback = 5;

    for (let index = 0; index < HOURS; index += 1) {
      const speedCandidate = data.windSpeed?.[index];
      if (Number.isFinite(speedCandidate)) speedFallback = Math.max(0, speedCandidate);
      this.windSpeed[index] = speedFallback;

      const directionCandidate = data.windDirection?.[index];
      if (Number.isFinite(directionCandidate)) {
        directionFallback = normalizeDegrees(directionCandidate);
      }
      this.windDirection[index] = directionFallback;

      const gustCandidate = data.windGust?.[index];
      if (Number.isFinite(gustCandidate)) gustFallback = Math.max(0, gustCandidate);
      this.windGust[index] = gustFallback;
    }

    const firstData = !this.hasData;
    this.hasData = true;
    this.retargetWind();
    if (firstData) {
      this.speedCurrent = this.speedTarget;
      this.directionCurrent = this.directionTarget;
      this.gustCurrent = this.gustTarget;
      this.compassAngle = this.directionTarget;
      this.compassVelocity = 0;
    }
    this.updateHud(true);
    this.updateCompass(true);
  }

  setQuality(quality: Quality): void {
    if (quality === this.quality) return;
    this.quality = quality;
    this.root?.setAttribute('data-quality', quality);
    this.resize();
    if (this.gl && this.program && this.vertexBuffer) this.rebuildParticles();
  }

  private createDom(): HTMLElement {
    const root = document.createElement('section');
    root.className = 'serein-wind-layer';
    root.setAttribute('aria-label', '逐时风场');
    root.setAttribute('data-quality', this.quality);
    root.innerHTML = `
      <style>${LAYER_CSS}</style>
      <canvas class="serein-wind-canvas" aria-hidden="true"></canvas>
      <header class="serein-wind-header">
        <div class="serein-wind-heading">
          <h2>风</h2>
          <p>逐时 · m/s</p>
        </div>
        <div class="serein-wind-current">
          <output class="serein-wind-speed" aria-label="当前风速">3.0</output>
          <p class="serein-wind-direction">西北风</p>
        </div>
      </header>
      <button class="serein-wind-sound" type="button" aria-label="开启风声"
        aria-pressed="false" title="开启风声">
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="M4.5 9.2h3.1l4-3.4v12.4l-4-3.4H4.5z"></path>
          <path class="serein-wind-sound-wave" d="M15 9.2c1.5 1.5 1.5 4.1 0 5.6"></path>
          <path class="serein-wind-sound-wave" d="M17.8 6.6c3 3 3 7.8 0 10.8"></path>
          <path class="serein-wind-sound-mute" d="m15.2 9.2 5.2 5.6m0-5.6-5.2 5.6"></path>
        </svg>
      </button>
      <div class="serein-wind-compass" role="img" aria-label="当前风向 西北风">
        <span class="serein-wind-needle"></span>
      </div>
    `;

    this.container?.appendChild(root);
    this.root = root;
    this.canvas = root.querySelector<HTMLCanvasElement>('.serein-wind-canvas');
    this.speedReadout = root.querySelector<HTMLOutputElement>('.serein-wind-speed');
    this.directionReadout = root.querySelector<HTMLElement>('.serein-wind-direction');
    this.soundButton = root.querySelector<HTMLButtonElement>('.serein-wind-sound');
    this.compass = root.querySelector<HTMLElement>('.serein-wind-compass');
    this.compassNeedle = root.querySelector<HTMLElement>('.serein-wind-needle');
    return root;
  }

  private attachEvents(): void {
    const signal = this.abortController?.signal;
    const canvas = this.canvas;
    if (!signal || !canvas) return;

    this.soundButton?.addEventListener('click', this.onSoundToggle, { signal });
    document.addEventListener('pointerdown', this.onUserInteraction, {
      capture: true,
      passive: true,
      signal,
    });
    document.addEventListener('keydown', this.onUserInteraction, {
      capture: true,
      signal,
    });
    document.addEventListener('visibilitychange', this.onVisibility, { signal });
    window.addEventListener('resize', this.resize, { passive: true, signal });
    window.visualViewport?.addEventListener('resize', this.resize, {
      passive: true,
      signal,
    });
    canvas.addEventListener('webglcontextlost', this.onContextLost, { signal });
    canvas.addEventListener('webglcontextrestored', this.onContextRestored, { signal });
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
      preserveDrawingBuffer: false,
      powerPreference: 'high-performance',
    });
    if (!gl) return false;
    this.gl = gl;

    const vertexShader = this.compileShader(gl.VERTEX_SHADER, VERTEX_SHADER);
    const fragmentShader = this.compileShader(gl.FRAGMENT_SHADER, FRAGMENT_SHADER);
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
      console.error('[WindLayer] 链接着色器失败:', gl.getProgramInfoLog(program));
      gl.deleteProgram(program);
      return false;
    }

    const buffer = gl.createBuffer();
    if (!buffer) {
      gl.deleteProgram(program);
      return false;
    }

    this.program = program;
    this.vertexBuffer = buffer;
    this.alphaUniform = gl.getUniformLocation(program, 'uAlpha');
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, this.vertexData, gl.DYNAMIC_DRAW);
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
    gl.lineWidth(1);
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
      console.error('[WindLayer] 编译着色器失败:', gl.getShaderInfoLog(shader));
      gl.deleteShader(shader);
      return null;
    }
    return shader;
  }

  private releaseGL(loseContext: boolean): void {
    const gl = this.gl;
    if (gl) {
      if (this.vertexBuffer) gl.deleteBuffer(this.vertexBuffer);
      if (this.program) gl.deleteProgram(this.program);
      if (loseContext) gl.getExtension('WEBGL_lose_context')?.loseContext();
    }
    this.gl = null;
    this.program = null;
    this.vertexBuffer = null;
    this.alphaUniform = null;
  }

  private rebuildParticles(): void {
    const count = PARTICLE_COUNT[this.quality];
    this.particleCount = count;
    this.particleX = new Float32Array(count);
    this.particleY = new Float32Array(count);
    this.particleLife = new Float32Array(count);
    this.vertexData = new Float32Array(count * 4);
    this.particleRandomState = (WIND_SEED ^ count) >>> 0;

    for (let index = 0; index < count; index += 1) {
      this.respawnParticle(index);
      const offset = index * 4;
      const clipX = this.particleX[index] * 2 - 1;
      const clipY = 1 - this.particleY[index] * 2;
      this.vertexData[offset] = clipX;
      this.vertexData[offset + 1] = clipY;
      this.vertexData[offset + 2] = clipX;
      this.vertexData[offset + 3] = clipY;
    }

    const gl = this.gl;
    if (gl && this.vertexBuffer) {
      gl.bindBuffer(gl.ARRAY_BUFFER, this.vertexBuffer);
      gl.bufferData(gl.ARRAY_BUFFER, this.vertexData, gl.DYNAMIC_DRAW);
    }
    this.root?.setAttribute('data-particle-count', String(count));
    this.root?.setAttribute('data-quality', this.quality);
  }

  private respawnParticle(index: number): void {
    this.particleX[index] = this.particleRandom();
    this.particleY[index] = this.particleRandom();
    this.particleLife[index] = 2 + this.particleRandom() * 3;
  }

  private particleRandom(): number {
    let state = this.particleRandomState | 0;
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    this.particleRandomState = state >>> 0;
    return this.particleRandomState / 4294967296;
  }

  private gustRandom(): number {
    let state = this.gustRandomState | 0;
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    this.gustRandomState = state >>> 0;
    return this.gustRandomState / 4294967296;
  }

  private retargetWind(): void {
    const hour = this.timeMinutes / 60;
    const previousDelta = Math.max(0, this.gustTarget - this.speedTarget);
    this.speedTarget = Math.max(0, sampleSeries(this.windSpeed, hour));
    this.directionTarget = sampleDirection(this.windDirection, hour);
    this.gustTarget = Math.max(0, sampleSeries(this.windGust, hour));

    const nextDelta = Math.max(0, this.gustTarget - this.speedTarget);
    if (nextDelta > previousDelta + 0.25 && this.elapsed >= this.gustPulseEnd) {
      this.nextGustPulseAt = Math.min(this.nextGustPulseAt, this.elapsed + 0.12);
    }
  }

  private stepWind(deltaSeconds: number): void {
    const blend = 1 - Math.exp(-deltaSeconds / WIND_EASE_TAU);
    this.speedCurrent += (this.speedTarget - this.speedCurrent) * blend;
    this.gustCurrent += (this.gustTarget - this.gustCurrent) * blend;

    const angularDelta = shortestAngularDelta(this.directionCurrent, this.directionTarget);
    this.directionCurrent += angularDelta * blend;
    if (Math.abs(angularDelta) < 0.02) this.directionCurrent += angularDelta;
    if (Math.abs(this.speedTarget - this.speedCurrent) < 0.001) {
      this.speedCurrent = this.speedTarget;
    }
    if (Math.abs(this.gustTarget - this.gustCurrent) < 0.001) {
      this.gustCurrent = this.gustTarget;
    }
    if (Math.abs(this.directionCurrent) > 720) {
      this.directionCurrent = normalizeDegrees(this.directionCurrent);
    }
  }

  private stepGust(deltaSeconds: number): void {
    if (this.elapsed >= this.nextGustPulseAt) {
      this.gustPulseEnd = this.elapsed + 0.5 + this.gustRandom() * 0.3;
      this.nextGustPulseAt = this.gustPulseEnd + 1.8 + this.gustRandom() * 2.2;
    }

    const gustDelta = Math.max(0, this.gustCurrent - this.speedCurrent);
    const target = this.elapsed < this.gustPulseEnd ? gustDelta : 0;
    const tau = target > this.gustBoost ? GUST_ATTACK : GUST_RELEASE;
    const blend = 1 - Math.exp(-deltaSeconds / tau);
    this.gustBoost += (target - this.gustBoost) * blend;
    if (target === 0 && this.gustBoost < 0.001) this.gustBoost = 0;
  }

  /**
   * windDirection 遵循气象约定，表示风的来向；流线运动方向因此旋转 180°。
   * curl 分量来自一个三频标量势的解析旋度，长度限制为 1 后取全局风的 30%。
   */
  private stepParticles(deltaSeconds: number): void {
    const count = this.particleCount;
    if (count === 0 || deltaSeconds <= 0) return;

    const width = this.viewportWidth;
    const height = this.viewportHeight;
    const minimumDimension = Math.max(1, Math.min(width, height));
    const xScale = (width / minimumDimension) * CURL_SPATIAL_SCALE;
    const yScale = (height / minimumDimension) * CURL_SPATIAL_SCALE;
    const noiseTime = this.elapsed;
    const highDetail = this.quality === 'high';

    const effectiveSpeed = Math.max(0, this.speedCurrent + this.gustBoost);
    const pixelsPerSecond =
      effectiveSpeed > 0.01 ? Math.min(520, 18 + effectiveSpeed * 34) : 0;
    const turbulenceSpeed = pixelsPerSecond * CURL_STRENGTH;
    const flowRadians = ((this.directionCurrent + 180) * Math.PI) / 180;
    const globalX = Math.sin(flowRadians) * pixelsPerSecond;
    const globalY = -Math.cos(flowRadians) * pixelsPerSecond;
    const deltaXScale = deltaSeconds / width;
    const deltaYScale = deltaSeconds / height;

    const particleX = this.particleX;
    const particleY = this.particleY;
    const particleLife = this.particleLife;
    const vertices = this.vertexData;

    for (let index = 0; index < count; index += 1) {
      const offset = index * 4;
      let life = particleLife[index] - deltaSeconds;
      if (life <= 0) {
        this.respawnParticle(index);
        const clipX = particleX[index] * 2 - 1;
        const clipY = 1 - particleY[index] * 2;
        vertices[offset] = clipX;
        vertices[offset + 1] = clipY;
        vertices[offset + 2] = clipX;
        vertices[offset + 3] = clipY;
        continue;
      }

      const previousX = particleX[index];
      const previousY = particleY[index];
      const noiseX = (previousX - 0.5) * xScale;
      const noiseY = (previousY - 0.5) * yScale;

      const cosineA = Math.cos(1.4 * noiseX + 0.9 * noiseY + noiseTime * 0.18);
      const cosineB = Math.cos(-1.1 * noiseX + 1.8 * noiseY - noiseTime * 0.13 + 2.17);
      let curlX = 0.495 * cosineA + 0.576 * cosineB;
      let curlY = -0.77 * cosineA + 0.352 * cosineB;
      if (highDetail) {
        const cosineC = Math.cos(2.5 * noiseX + 2.2 * noiseY + noiseTime * 0.09 + 4.03);
        curlX += 0.352 * cosineC;
        curlY -= 0.4 * cosineC;
      }

      const curlLengthSquared = curlX * curlX + curlY * curlY;
      if (curlLengthSquared > 1) {
        const inverseLength = 1 / Math.sqrt(curlLengthSquared);
        curlX *= inverseLength;
        curlY *= inverseLength;
      }

      let nextX = previousX + (globalX + curlX * turbulenceSpeed) * deltaXScale;
      let nextY = previousY + (globalY + curlY * turbulenceSpeed) * deltaYScale;
      const wrapped = nextX < 0 || nextX >= 1 || nextY < 0 || nextY >= 1;
      if (wrapped) {
        nextX -= Math.floor(nextX);
        nextY -= Math.floor(nextY);
      }

      particleX[index] = nextX;
      particleY[index] = nextY;
      particleLife[index] = life;

      const currentClipX = nextX * 2 - 1;
      const currentClipY = 1 - nextY * 2;
      if (wrapped) {
        vertices[offset] = currentClipX;
        vertices[offset + 1] = currentClipY;
      } else {
        vertices[offset] = previousX * 2 - 1;
        vertices[offset + 1] = 1 - previousY * 2;
      }
      vertices[offset + 2] = currentClipX;
      vertices[offset + 3] = currentClipY;
    }
  }

  private stepCompass(deltaSeconds: number): void {
    const steps = Math.max(1, Math.ceil(deltaSeconds / (1 / 120)));
    const step = deltaSeconds / steps;
    for (let iteration = 0; iteration < steps; iteration += 1) {
      const displacement = shortestAngularDelta(this.compassAngle, this.directionTarget);
      const acceleration =
        COMPASS_STIFFNESS * displacement - COMPASS_DAMPING * this.compassVelocity;
      this.compassVelocity += acceleration * step;
      this.compassAngle += this.compassVelocity * step;
    }

    const displacement = shortestAngularDelta(this.compassAngle, this.directionTarget);
    if (Math.abs(displacement) < 0.02 && Math.abs(this.compassVelocity) < 0.05) {
      this.compassAngle += displacement;
      this.compassVelocity = 0;
    }
    if (Math.abs(this.compassAngle) > 720) {
      this.compassAngle = normalizeDegrees(this.compassAngle);
    }
  }

  private render(): void {
    const gl = this.gl;
    const program = this.program;
    const buffer = this.vertexBuffer;
    if (!gl || !program || !buffer || this.particleCount === 0) return;

    const gustDelta = Math.max(0.001, this.gustCurrent - this.speedCurrent);
    const gustLevel = clamp01(this.gustBoost / gustDelta);
    const effectiveSpeed = Math.max(0, this.speedCurrent + this.gustBoost);
    const alpha = clamp(0.05 + clamp01(effectiveSpeed / 10) * 0.4 + gustLevel * 0.05, 0.05, 0.5);

    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.useProgram(program);
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, this.vertexData);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.uniform1f(this.alphaUniform, alpha);
    gl.drawArrays(gl.LINES, 0, this.particleCount * 2);
  }

  private updateHud(force = false): void {
    const speedTenth = Math.max(0, Math.round(this.speedCurrent * 10));
    if (force || speedTenth !== this.lastSpeedTenth) {
      this.lastSpeedTenth = speedTenth;
      const text = (speedTenth / 10).toFixed(1);
      if (this.speedReadout) {
        this.speedReadout.value = text;
        this.speedReadout.setAttribute('aria-label', `当前风速 ${text} 米每秒`);
      }
      this.root?.setAttribute('data-wind-speed', text);
    }

    const index = directionIndex(this.directionCurrent);
    if (force || index !== this.lastDirectionIndex) {
      this.lastDirectionIndex = index;
      const name = COMPASS_NAMES[index];
      if (this.directionReadout) this.directionReadout.textContent = name;
      this.compass?.setAttribute('aria-label', `当前风向 ${name}`);
      this.root?.setAttribute('data-wind-direction', name);
    }

    const gustDelta = Math.max(0.001, this.gustCurrent - this.speedCurrent);
    const gustStep = Math.round(clamp01(this.gustBoost / gustDelta) * 20);
    if (force || gustStep !== this.lastGustStep) {
      this.lastGustStep = gustStep;
      this.root?.setAttribute('data-gust-envelope', (gustStep / 20).toFixed(2));
    }
  }

  private updateCompass(force = false): void {
    const tenth = Math.round(this.compassAngle * 10);
    if (!force && tenth === this.lastCompassTenth) return;
    this.lastCompassTenth = tenth;
    if (this.compassNeedle) {
      this.compassNeedle.style.transform = `rotate(${tenth / 10}deg)`;
    }
  }

  private resize = (): void => {
    const canvas = this.canvas;
    const container = this.container;
    if (!canvas || !container) return;

    const width = Math.max(1, container.clientWidth);
    const height = Math.max(1, container.clientHeight);
    const dpr = Math.min(window.devicePixelRatio || 1, DPR_CAP[this.quality]);
    const drawingWidth = Math.max(1, Math.round(width * dpr));
    const drawingHeight = Math.max(1, Math.round(height * dpr));
    if (canvas.width !== drawingWidth || canvas.height !== drawingHeight) {
      canvas.width = drawingWidth;
      canvas.height = drawingHeight;
    }

    this.viewportWidth = width;
    this.viewportHeight = height;
    this.gl?.viewport(0, 0, drawingWidth, drawingHeight);
    this.root?.setAttribute('data-renderer-pixel-ratio', dpr.toFixed(2));
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

    this.stepWind(deltaSeconds);
    this.stepGust(deltaSeconds);
    this.stepCompass(deltaSeconds);
    if (this.gl && this.program && this.vertexBuffer) {
      this.stepParticles(deltaSeconds);
      this.render();
    }
    this.updateHud();
    this.updateCompass();

    this.audioAccumulator += deltaSeconds;
    if (this.audioAccumulator >= 0.08) {
      this.audioAccumulator = 0;
      this.updateAudio();
    }
    this.raf = requestAnimationFrame(this.frame);
  };

  private onVisibility = (): void => {
    if (document.hidden) {
      this.stop();
      void this.audio?.context.suspend().catch(() => undefined);
    } else {
      this.start();
      if (this.soundEnabled && this.audio) {
        void this.audio.context
          .resume()
          .then(() => this.updateAudio())
          .catch(() => undefined);
      }
    }
  };

  private onContextLost = (event: Event): void => {
    event.preventDefault();
    this.gl = null;
    this.program = null;
    this.vertexBuffer = null;
    this.alphaUniform = null;
    this.root?.setAttribute('data-webgl-status', 'lost');
  };

  private onContextRestored = (): void => {
    this.gl = null;
    this.program = null;
    this.vertexBuffer = null;
    this.alphaUniform = null;
    if (this.initGL()) {
      this.root?.classList.remove('is-fallback');
      this.root?.setAttribute('data-webgl-status', 'ready');
      this.resize();
      if (this.particleCount === 0) this.rebuildParticles();
      this.start();
    } else {
      this.root?.classList.add('is-fallback');
    }
  };

  private onUserInteraction = (): void => {
    this.hasUserInteracted = true;
  };

  private onSoundToggle = (): void => {
    this.hasUserInteracted = true;
    this.soundEnabled = !this.soundEnabled;
    this.syncSoundButton();
    if (this.soundEnabled) {
      void this.ensureAudio();
    } else {
      this.updateAudio();
      const audio = this.audio;
      if (audio) {
        const now = audio.context.currentTime;
        audio.gain.gain.cancelScheduledValues(now);
        audio.gain.gain.setValueAtTime(0, now);
        void audio.context.suspend().catch(() => undefined);
      }
    }
  };

  private syncSoundButton(): void {
    const button = this.soundButton;
    if (!button) return;
    const label = this.soundEnabled ? '关闭风声' : '开启风声';
    button.setAttribute('aria-pressed', String(this.soundEnabled));
    button.setAttribute('aria-label', label);
    button.title = label;
    this.root?.setAttribute('data-wind-sound', this.soundEnabled ? 'on' : 'off');
  }

  private async ensureAudio(): Promise<void> {
    if (!this.soundEnabled || !this.hasUserInteracted || !this.root) return;
    if (this.audio) {
      await this.audio.context.resume().catch(() => undefined);
      this.updateAudio();
      return;
    }

    const AudioContextConstructor =
      window.AudioContext ??
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AudioContextConstructor) {
      this.soundEnabled = false;
      this.syncSoundButton();
      return;
    }

    const generation = ++this.audioGeneration;
    let context: AudioContext | null = null;
    try {
      try {
        context = new AudioContextConstructor({ latencyHint: 'interactive' });
      } catch {
        context = new AudioContextConstructor();
      }

      const seconds = 2;
      const buffer = context.createBuffer(1, context.sampleRate * seconds, context.sampleRate);
      const channel = buffer.getChannelData(0);
      let noiseState = (WIND_SEED ^ 0x51f2a63b) >>> 0;
      for (let index = 0; index < channel.length; index += 1) {
        noiseState ^= noiseState << 13;
        noiseState ^= noiseState >>> 17;
        noiseState ^= noiseState << 5;
        channel[index] = ((noiseState >>> 0) / 2147483648 - 1) * 0.82;
      }

      const source = context.createBufferSource();
      const filter = context.createBiquadFilter();
      const gain = context.createGain();
      source.buffer = buffer;
      source.loop = true;
      filter.type = 'bandpass';
      filter.frequency.value = 400;
      filter.Q.value = 0.72;
      gain.gain.value = 0;
      source.connect(filter);
      filter.connect(gain);
      gain.connect(context.destination);
      source.start();

      if (generation !== this.audioGeneration || !this.root) {
        source.stop();
        source.disconnect();
        filter.disconnect();
        gain.disconnect();
        await context.close().catch(() => undefined);
        return;
      }

      this.audio = { context, source, filter, gain };
      context.onstatechange = () => {
        this.root?.setAttribute('data-audio-context', context?.state ?? 'closed');
      };
      await context.resume().catch(() => undefined);
      if (generation !== this.audioGeneration || !this.audio) return;
      this.root.setAttribute('data-audio-engine', 'white-noise-bandpass');
      this.updateAudio();
    } catch (error) {
      if (context && context.state !== 'closed') {
        await context.close().catch(() => undefined);
      }
      if (generation === this.audioGeneration) {
        console.warn('[WindLayer] 无法启动风声音频', error);
        this.audio = null;
        this.soundEnabled = false;
        this.syncSoundButton();
      }
    }
  }

  private updateAudio(): void {
    const audio = this.audio;
    if (!audio) return;

    const effectiveSpeed = Math.max(0, this.speedCurrent + this.gustBoost);
    const strength = clamp01(effectiveSpeed / 12);
    const targetGain =
      this.soundEnabled && !document.hidden ? (effectiveSpeed > 0.05 ? strength * 0.18 : 0) : 0;
    const frequency = 200 + strength * 1000;
    const now = audio.context.currentTime;
    audio.gain.gain.cancelScheduledValues(now);
    audio.gain.gain.setTargetAtTime(targetGain, now, 0.08);
    audio.filter.frequency.setTargetAtTime(frequency, now, 0.1);
  }

  private closeAudio(): void {
    const audio = this.audio;
    this.audio = null;
    if (!audio) return;

    audio.context.onstatechange = null;
    try {
      audio.source.stop();
    } catch {
      // AudioContext interruption may already have stopped the source.
    }
    audio.source.disconnect();
    audio.filter.disconnect();
    audio.gain.disconnect();
    void audio.context.close().catch(() => undefined);
  }
}
