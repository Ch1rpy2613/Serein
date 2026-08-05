import * as THREE from 'three';
import { getPrefersReducedMotion, particleBudget, subscribeReducedMotion } from '../../motion';
import type { DayData, WeatherLayer } from '../../contracts';

type Quality = 'low' | 'medium' | 'high';

interface QualityConfig {
  tubeSegments: number;
  radialSegments: number;
  haloPoints: number;
  frostParticles: number;
  heatSegments: number;
  backdropWidth: number;
  backdropEvery: number;
  dpr: number;
}

const HOURS = 25;
const DAY_MINUTES = 1440;
const TUBE_RADIUS = 0.05;
const TEMPERATURE_MIN = -15;
const TEMPERATURE_MAX = 45;
const HEAT_THRESHOLD = 30;
const HEAT_CEILING = 38;
const SPRING_STIFFNESS = 120;
const SPRING_DAMPING = 14;
/** 200ms time constant reaches 95% in about 600ms. */
const PHASE_FADE_TAU = 0.2;
const MODE_BLEND_MS = 400;
const CAMERA_X_MIN = -5.15;
const CAMERA_X_MAX = 5.15;
const CURVE_X_MIN = -5;
const CURVE_X_MAX = 5;
const Y_TICKS = [-10, 0, 10, 20, 30, 40] as const;

const QUALITY: Record<Quality, QualityConfig> = {
  low: {
    tubeSegments: 200,
    radialSegments: 6,
    haloPoints: 100,
    frostParticles: 90,
    heatSegments: 96,
    backdropWidth: 224,
    backdropEvery: 6,
    dpr: 1.25,
  },
  medium: {
    tubeSegments: 280,
    radialSegments: 8,
    haloPoints: 160,
    frostParticles: 210,
    heatSegments: 144,
    backdropWidth: 320,
    backdropEvery: 4,
    dpr: 1.75,
  },
  high: {
    tubeSegments: 400,
    radialSegments: 10,
    haloPoints: 240,
    frostParticles: 360,
    heatSegments: 216,
    backdropWidth: 480,
    backdropEvery: 2,
    dpr: 2,
  },
};

/**
 * Hex/CSS inputs are converted by three.js from sRGB to its linear working
 * space. Shader `mix` operations therefore meet the linear interpolation
 * requirement without hand-authored gamma corrections.
 */
const TEMPERATURE_COLORS = [
  new THREE.Color('#4c7dff'),
  new THREE.Color('#cfe8ff'),
  new THREE.Color('#e8e8e8'),
  new THREE.Color('#ffb03a'),
  new THREE.Color('#ff4d2e'),
] as const;

const TEMPERATURE_COLOR_GLSL = `
uniform vec3 uColorCold;
uniform vec3 uColorFreeze;
uniform vec3 uColorMild;
uniform vec3 uColorWarm;
uniform vec3 uColorHot;

vec3 temperatureColor(float temperature) {
  if (temperature <= -10.0) return uColorCold;
  if (temperature < 0.0) {
    return mix(uColorCold, uColorFreeze, (temperature + 10.0) / 10.0);
  }
  if (temperature < 15.0) {
    return mix(uColorFreeze, uColorMild, temperature / 15.0);
  }
  if (temperature < 28.0) {
    return mix(uColorMild, uColorWarm, (temperature - 15.0) / 13.0);
  }
  if (temperature < 38.0) {
    return mix(uColorWarm, uColorHot, (temperature - 28.0) / 10.0);
  }
  return uColorHot;
}
`;

const TUBE_VERTEX = `
attribute float aTemperature;
varying float vTemperature;
varying vec3 vNormal;
varying vec3 vViewDirection;

void main() {
  vTemperature = aTemperature;
  vec4 viewPosition = modelViewMatrix * vec4(position, 1.0);
  vNormal = normalize(normalMatrix * normal);
  vViewDirection = normalize(-viewPosition.xyz);
  gl_Position = projectionMatrix * viewPosition;
}
`;

const TUBE_FRAGMENT = `
${TEMPERATURE_COLOR_GLSL}
varying float vTemperature;
varying vec3 vNormal;
varying vec3 vViewDirection;

void main() {
  vec3 color = temperatureColor(vTemperature);
  float facing = max(dot(normalize(vNormal), normalize(vViewDirection)), 0.0);
  float rim = pow(1.0 - facing, 2.0);
  float sheen = 0.82 + facing * 0.32 + rim * 0.62;
  gl_FragColor = vec4(color * sheen, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

const HALO_VERTEX = `
attribute float aTemperature;
uniform float uDpr;
uniform float uSize;
varying float vTemperature;

void main() {
  vTemperature = aTemperature;
  gl_PointSize = uSize * uDpr;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const HALO_FRAGMENT = `
${TEMPERATURE_COLOR_GLSL}
uniform float uFeel;
varying float vTemperature;

void main() {
  vec2 point = gl_PointCoord * 2.0 - 1.0;
  float radius2 = dot(point, point);
  if (radius2 > 1.0) discard;
  float halo = exp(-radius2 * 4.4) * (1.0 - smoothstep(0.72, 1.0, radius2));
  gl_FragColor = vec4(temperatureColor(vTemperature) * 1.18, halo * 0.11 * uFeel);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

const FROST_VERTEX = `
attribute float aPhase;
attribute float aSize;
attribute float aOpacity;
uniform float uElapsed;
uniform float uBreath;
uniform float uDpr;
varying float vPulse;
varying float vOpacity;

void main() {
  float pulse = 0.72 + 0.28 * uBreath * sin(uElapsed * (2.2 + fract(aPhase) * 2.4) + aPhase);
  vPulse = pulse;
  vOpacity = aOpacity;
  gl_PointSize = aSize * uDpr * (0.88 + pulse * 0.22);
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const FROST_FRAGMENT = `
uniform float uFeel;
varying float vPulse;
varying float vOpacity;

void main() {
  vec2 point = gl_PointCoord * 2.0 - 1.0;
  float radius = length(point);
  if (radius > 1.0) discard;

  float vertical = exp(-abs(point.x) * 24.0) * (1.0 - smoothstep(0.18, 1.0, abs(point.y)));
  float horizontal = exp(-abs(point.y) * 24.0) * (1.0 - smoothstep(0.18, 1.0, abs(point.x)));
  float diagonalA = exp(-abs(point.x - point.y) * 17.0)
    * (1.0 - smoothstep(0.12, 0.88, radius));
  float diagonalB = exp(-abs(point.x + point.y) * 17.0)
    * (1.0 - smoothstep(0.12, 0.88, radius));
  float core = exp(-radius * radius * 24.0);
  float star = max(max(vertical, horizontal), max(diagonalA, diagonalB) * 0.72);
  float alpha = (star * 0.72 + core) * vOpacity * (0.58 + vPulse * 0.42) * uFeel;
  if (alpha < 0.008) discard;

  vec3 color = mix(vec3(0.38, 0.60, 1.0), vec3(0.82, 0.94, 1.0), core);
  gl_FragColor = vec4(color * (1.08 + vPulse * 0.36), alpha);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

const HEAT_VERTEX = `
attribute float aSide;
attribute float aAlong;
attribute float aHeat;
varying float vSide;
varying float vAlong;
varying float vHeat;

void main() {
  vSide = aSide;
  vAlong = aAlong;
  vHeat = aHeat;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const HEAT_FRAGMENT = `
uniform sampler2D uBackdrop;
uniform vec2 uResolution;
uniform float uElapsed;
uniform float uHasBackdrop;
uniform float uFeel;
varying float vSide;
varying float vAlong;
varying float vHeat;

float waveNoise(vec2 point) {
  float a = sin(point.x * 17.0 + point.y * 11.0 + uElapsed * 2.3);
  float b = sin(point.x * 31.0 - point.y * 19.0 - uElapsed * 1.7);
  return (a + b) * 0.5;
}

void main() {
  float crossFade = pow(max(1.0 - abs(vSide), 0.0), 1.65);
  float strength = clamp(vHeat * crossFade, 0.0, 1.0);
  if (strength < 0.003) discard;

  vec2 uv = gl_FragCoord.xy / max(uResolution, vec2(1.0));
  float noise = waveNoise(vec2(vAlong * 5.0, vSide * 1.7));
  vec2 offset = vec2(
    noise,
    sin(vAlong * 42.0 - uElapsed * 3.1 + vSide * 2.0)
  ) * (0.0007 + strength * 0.0031);

  vec3 warped = texture2D(uBackdrop, clamp(uv + offset, 0.001, 0.999)).rgb;
  vec3 fallback = vec3(1.0, 0.39, 0.08) * (0.18 + noise * 0.04);
  vec3 color = mix(fallback, warped, uHasBackdrop);
  float alpha = mix(strength * 0.045, strength * 0.76, uHasBackdrop) * uFeel;
  gl_FragColor = vec4(color, alpha);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

const HANDLE_VERTEX = `
attribute float aSelected;
uniform float uDpr;
varying float vSelected;

void main() {
  vSelected = aSelected;
  gl_PointSize = mix(4.0, 12.0, aSelected) * uDpr;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const HANDLE_FRAGMENT = `
varying float vSelected;

void main() {
  vec2 point = gl_PointCoord * 2.0 - 1.0;
  float radius = length(point);
  if (radius > 1.0) discard;
  float disc = 1.0 - smoothstep(0.42, 0.92, radius);
  float ring = smoothstep(0.30, 0.48, radius) * (1.0 - smoothstep(0.72, 0.92, radius));
  float alpha = mix(disc * 0.34, max(disc, ring), vSelected);
  vec3 color = mix(vec3(0.74), vec3(0.80, 0.94, 1.0), vSelected);
  gl_FragColor = vec4(color, alpha);
  #include <colorspace_fragment>
}
`;

const BEAD_HALO_VERTEX = `
uniform float uDpr;
uniform float uPulse;

void main() {
  gl_PointSize = (30.0 + uPulse * 7.0) * uDpr;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const BEAD_HALO_FRAGMENT = `
uniform vec3 uColor;
uniform float uPulse;
uniform float uFeel;

void main() {
  vec2 point = gl_PointCoord * 2.0 - 1.0;
  float radius2 = dot(point, point);
  if (radius2 > 1.0) discard;
  float halo = exp(-radius2 * 4.8) * (1.0 - smoothstep(0.68, 1.0, radius2));
  gl_FragColor = vec4(uColor * (1.18 + uPulse * 0.28), halo * (0.25 + uPulse * 0.12) * uFeel);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

const LAYER_CSS = `
.serein-temperature-layer {
  position: absolute;
  inset: 0;
  overflow: hidden;
  color: var(--fg-1, rgba(255,255,255,.92));
  font-family: -apple-system, "SF Pro", Inter, "PingFang SC", sans-serif;
  font-variant-numeric: tabular-nums;
  pointer-events: none;
  user-select: none;
  -webkit-user-select: none;
}
.serein-temperature-canvas {
  position: absolute;
  inset: 0;
  z-index: 0;
  display: block;
  width: 100%;
  height: 100%;
  pointer-events: none;
}
.serein-temperature-header {
  position: absolute;
  top: max(28px, env(safe-area-inset-top));
  left: max(28px, env(safe-area-inset-left));
  z-index: 2;
  display: grid;
  gap: 13px;
}
.serein-temperature-heading {
  display: flex;
  align-items: baseline;
  gap: 11px;
}
.serein-temperature-heading h2,
.serein-temperature-heading p {
  margin: 0;
}
.serein-temperature-heading h2 {
  font-size: 17px;
  font-weight: 560;
  letter-spacing: .02em;
}
.serein-temperature-heading p {
  color: var(--fg-2, rgba(255,255,255,.45));
  font-size: 11px;
  font-weight: 500;
  letter-spacing: .08em;
}
.serein-temperature-readout {
  margin: 0;
  color: var(--temperature-color, var(--fg-1, rgba(255,255,255,.92)));
  font: inherit;
  font-size: 56px;
  font-weight: 360;
  font-variant-numeric: tabular-nums;
  letter-spacing: -.055em;
  line-height: .92;
  text-shadow: 0 0 24px color-mix(in srgb, var(--temperature-color, #fff) 28%, transparent);
  transition: opacity 400ms ease;
}
.serein-temperature-plot,
.serein-temperature-hit {
  position: absolute;
  top: clamp(148px, 20vh, 188px);
  right: clamp(24px, 4vw, 60px);
  bottom: clamp(82px, 12vh, 116px);
  left: clamp(74px, 8vw, 116px);
}
.serein-temperature-plot {
  z-index: 2;
  overflow: visible;
  pointer-events: none;
}
.serein-temperature-hit {
  z-index: 3;
  cursor: crosshair;
  pointer-events: auto;
  touch-action: none;
  -webkit-tap-highlight-color: transparent;
}
.serein-temperature-hit[data-dragging="true"] {
  cursor: ns-resize;
}
.serein-temperature-axis-line {
  position: absolute;
  background: var(--line, rgba(255,255,255,.22));
}
.serein-temperature-axis-x {
  height: 1px;
}
.serein-temperature-axis-y {
  width: 1px;
}
.serein-temperature-x-tick,
.serein-temperature-y-tick {
  position: absolute;
  color: var(--axis-tick-color, var(--fg-2, rgba(255,255,255,.45)));
  font-size: var(--axis-tick-size, 11px);
  font-variant-numeric: tabular-nums;
  line-height: 1;
  white-space: nowrap;
}
.serein-temperature-x-tick::before,
.serein-temperature-y-tick::before {
  position: absolute;
  content: "";
  background: var(--line, rgba(255,255,255,.22));
}
.serein-temperature-x-tick {
  padding-top: 10px;
  transform: translateX(-50%);
}
.serein-temperature-x-tick::before {
  top: 1px;
  left: 50%;
  width: 1px;
  height: 5px;
}
.serein-temperature-x-tick[data-edge="start"] {
  transform: translateX(0);
}
.serein-temperature-x-tick[data-edge="start"]::before {
  left: 0;
}
.serein-temperature-x-tick[data-edge="end"] {
  transform: translateX(-100%);
}
.serein-temperature-x-tick[data-edge="end"]::before {
  left: 100%;
}
.serein-temperature-y-tick {
  padding-right: 11px;
  text-align: right;
  transform: translate(-100%, -50%);
}
.serein-temperature-y-tick::before {
  top: 50%;
  right: 1px;
  width: 5px;
  height: 1px;
}
.serein-temperature-analysis {
  position: absolute;
  inset: 0;
  z-index: 1;
  overflow: visible;
  opacity: 0;
  visibility: hidden;
  pointer-events: none;
  transition: opacity 400ms ease, visibility 400ms step-end;
}
.serein-temperature-layer[data-mode="analysis"] .serein-temperature-analysis {
  opacity: 1;
  visibility: visible;
  transition: opacity 400ms ease, visibility 0ms step-start;
}
.serein-temperature-layer[data-mode="analysis"] .serein-temperature-readout {
  opacity: 0.42;
}
.serein-temperature-grid-line {
  position: absolute;
  left: 0;
  right: 0;
  height: 1px;
  background: var(--line, rgba(255,255,255,.22));
  opacity: 0.55;
  transform: translateY(-50%);
}
.serein-temperature-point-label {
  position: absolute;
  color: var(--fg-2, rgba(255,255,255,.45));
  font-size: 9px;
  font-variant-numeric: tabular-nums;
  line-height: 1;
  white-space: nowrap;
  transform: translate(-50%, calc(-100% - 6px));
}
.serein-temperature-extrema {
  position: absolute;
  display: grid;
  justify-items: center;
  gap: 3px;
  transform: translate(-50%, -50%);
}
.serein-temperature-extrema-dot {
  width: 7px;
  height: 7px;
  border: 1.5px solid var(--accent, #7ec8ff);
  border-radius: 50%;
  background: rgba(5, 7, 10, 0.55);
  box-shadow: 0 0 0 1px rgba(126, 200, 255, 0.2);
}
.serein-temperature-extrema[data-kind="low"] .serein-temperature-extrema-dot {
  border-color: #8eb6ff;
}
.serein-temperature-extrema-value {
  color: var(--fg-2, rgba(255,255,255,.45));
  font-size: 9px;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}
.serein-temperature-extrema[data-kind="high"] .serein-temperature-extrema-value {
  order: -1;
  margin-bottom: 2px;
}
.serein-temperature-layer.is-fallback::after {
  position: absolute;
  top: 50%;
  left: 50%;
  color: var(--fg-2, rgba(255,255,255,.45));
  font-size: 12px;
  content: "WebGL 不可用";
  transform: translate(-50%, -50%);
}
@media (max-width: 42rem) {
  .serein-temperature-plot,
  .serein-temperature-hit {
    top: 138px;
    right: 18px;
    bottom: 76px;
    left: 64px;
  }
  .serein-temperature-x-tick[data-responsive-minor="true"] {
    visibility: hidden;
  }
}
@media (max-height: 34rem) {
  .serein-temperature-header {
    top: 20px;
  }
  .serein-temperature-readout {
    font-size: 46px;
  }
  .serein-temperature-plot,
  .serein-temperature-hit {
    top: 118px;
    bottom: 58px;
  }
}
@media (prefers-reduced-motion: reduce) {
  .serein-temperature-analysis,
  .serein-temperature-readout {
    transition-duration: 0.01ms;
  }
}
`;

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function clamp01(value: number): number {
  return clamp(value, 0, 1);
}

function hourToX(hour: number): number {
  return THREE.MathUtils.lerp(CURVE_X_MIN, CURVE_X_MAX, hour / 24);
}

function hash(index: number, salt: number): number {
  const value = Math.sin(index * 127.1 + salt * 311.7) * 43758.5453123;
  return value - Math.floor(value);
}

function temperatureUniforms(): Record<string, { value: THREE.Color }> {
  return {
    uColorCold: { value: TEMPERATURE_COLORS[0].clone() },
    uColorFreeze: { value: TEMPERATURE_COLORS[1].clone() },
    uColorMild: { value: TEMPERATURE_COLORS[2].clone() },
    uColorWarm: { value: TEMPERATURE_COLORS[3].clone() },
    uColorHot: { value: TEMPERATURE_COLORS[4].clone() },
  };
}

function interpolateTemperatureColor(temperature: number, target: THREE.Color): THREE.Color {
  let lower = 0;
  let upper = 0;
  let amount = 0;

  if (temperature <= -10) {
    lower = upper = 0;
  } else if (temperature < 0) {
    lower = 0;
    upper = 1;
    amount = (temperature + 10) / 10;
  } else if (temperature < 15) {
    lower = 1;
    upper = 2;
    amount = temperature / 15;
  } else if (temperature < 28) {
    lower = 2;
    upper = 3;
    amount = (temperature - 15) / 13;
  } else if (temperature < 38) {
    lower = 3;
    upper = 4;
    amount = (temperature - 28) / 10;
  } else {
    lower = upper = 4;
  }

  return target.copy(TEMPERATURE_COLORS[lower]).lerp(TEMPERATURE_COLORS[upper], amount);
}

export class TemperatureLayer implements WeatherLayer {
  readonly id = 'temperature';
  readonly name = '温度';
  readonly preferredSkyDim = 0.55;

  private container: HTMLElement | null = null;
  private root: HTMLElement | null = null;
  private plotElement: HTMLElement | null = null;
  private hitElement: HTMLElement | null = null;
  private readout: HTMLOutputElement | null = null;
  private xAxis: HTMLElement | null = null;
  private yAxis: HTMLElement | null = null;
  private xTicks: Array<{ hour: number; element: HTMLElement }> = [];
  private yTicks: Array<{ temperature: number; element: HTMLElement }> = [];
  private analysisRoot: HTMLElement | null = null;
  private analysisGridLines: HTMLElement[] = [];
  private analysisLabels: HTMLElement[] = [];
  private extremaHigh: HTMLElement | null = null;
  private extremaLow: HTMLElement | null = null;
  private extremaHighValue: HTMLElement | null = null;
  private extremaLowValue: HTMLElement | null = null;

  private renderer: THREE.WebGLRenderer | null = null;
  private scene: THREE.Scene | null = null;
  private camera: THREE.OrthographicCamera | null = null;
  private curve: THREE.CatmullRomCurve3 | null = null;
  private tube: THREE.Mesh<THREE.TubeGeometry, THREE.ShaderMaterial> | null = null;
  private halo: THREE.Points<THREE.BufferGeometry, THREE.ShaderMaterial> | null = null;
  private frost: THREE.Points<THREE.BufferGeometry, THREE.ShaderMaterial> | null = null;
  private heat: THREE.Mesh<THREE.BufferGeometry, THREE.ShaderMaterial> | null = null;
  private handles: THREE.Points<THREE.BufferGeometry, THREE.ShaderMaterial> | null = null;
  private bead: THREE.Mesh<THREE.SphereGeometry, THREE.MeshBasicMaterial> | null = null;
  private beadHalo: THREE.Points<THREE.BufferGeometry, THREE.ShaderMaterial> | null = null;

  private backdropCanvas: HTMLCanvasElement | null = null;
  private backdropContext: CanvasRenderingContext2D | null = null;
  private backdropTexture: THREE.CanvasTexture | null = null;
  private backdropFrame = 0;

  private quality: Quality = 'high';
  private mode: 'feel' | 'analysis' = 'feel';
  private modeBlend = 0;
  private data: DayData | null = null;
  private hasData = false;
  private visualTemperatures = new Float32Array(HOURS).fill(15);
  private targetTemperatures = new Float32Array(HOURS).fill(15);
  private temperatureVelocities = new Float32Array(HOURS);
  private timeMinutes = 480;
  private elapsed = 0;
  private lastTimestamp = 0;
  private raf = 0;
  private resizeObserver: ResizeObserver | null = null;
  private geometryDirty = true;

  private viewportX = 0;
  private viewportY = 0;
  private viewportWidth = 1;
  private viewportHeight = 1;

  private frostU = new Float32Array(0);
  private frostAngle = new Float32Array(0);
  private frostTargets = new Float32Array(0);
  private frostVisibility = new Float32Array(0);
  private heatTargets = new Float32Array(0);
  private heatVisibility = new Float32Array(0);

  private activePointerId: number | null = null;
  private dragIndex = -1;
  private dragStartPointerTemperature = 0;
  private dragBaseTemperatures = new Float32Array(HOURS);

  private readonly colorScratch = new THREE.Color();
  private readonly pointScratch = new THREE.Vector3();
  private readonly tangentScratch = new THREE.Vector3();
  private readonly normalScratch = new THREE.Vector3();
  private readonly sizeScratch = new THREE.Vector2();

  private reducedMotion = getPrefersReducedMotion();
  private unsubscribeReducedMotion: (() => void) | null = null;

  mount(container: HTMLElement): void {
    if (this.root) return;

    this.container = container;
    const root = this.createDom();
    this.scene = new THREE.Scene();
    this.camera = new THREE.OrthographicCamera(CAMERA_X_MIN, CAMERA_X_MAX, 3, -3, 0.1, 20);
    this.camera.position.set(0, 0, 8);
    this.camera.lookAt(0, 0, 0);

    try {
      const renderer = new THREE.WebGLRenderer({
        alpha: true,
        antialias: false,
        depth: true,
        stencil: false,
        premultipliedAlpha: false,
        preserveDrawingBuffer: true,
        powerPreference: 'high-performance',
      });
      renderer.setClearColor(0x000000, 0);
      renderer.outputColorSpace = THREE.SRGBColorSpace;
      renderer.autoClear = false;
      renderer.domElement.className = 'serein-temperature-canvas';
      renderer.domElement.setAttribute('aria-hidden', 'true');
      root.prepend(renderer.domElement);
      this.renderer = renderer;

      renderer.domElement.addEventListener('webglcontextlost', this.onContextLost);
      renderer.domElement.addEventListener('webglcontextrestored', this.onContextRestored);
    } catch (error) {
      console.warn('[TemperatureLayer] WebGL 不可用，温度层仅保留坐标与读数', error);
      root.classList.add('is-fallback');
      if (this.hitElement) {
        this.hitElement.style.pointerEvents = 'none';
        this.hitElement.setAttribute('aria-disabled', 'true');
      }
    }

    this.attachEvents();
    this.resizeObserver = new ResizeObserver(this.resize);
    this.resizeObserver.observe(container);
    if (this.plotElement) this.resizeObserver.observe(this.plotElement);
    this.unsubscribeReducedMotion = subscribeReducedMotion((reduced) => {
      this.reducedMotion = reduced;
      if (this.renderer) this.buildSceneResources();
    });
    document.addEventListener('visibilitychange', this.onVisibility);
    window.addEventListener('resize', this.resize, { passive: true });
    window.visualViewport?.addEventListener('resize', this.resize, { passive: true });

    this.resize();
    if (this.renderer) {
      this.createBackdrop();
      this.resizeBackdrop(container.clientWidth, container.clientHeight);
      this.buildSceneResources();
      this.start();
    } else {
      this.rebuildCurve();
      this.updateTimeVisuals();
    }
  }

  unmount(): void {
    this.stop();
    this.unsubscribeReducedMotion?.();
    this.unsubscribeReducedMotion = null;
    document.removeEventListener('visibilitychange', this.onVisibility);
    window.removeEventListener('resize', this.resize);
    window.visualViewport?.removeEventListener('resize', this.resize);
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    this.detachEvents();
    this.releasePointerCapture();

    const canvas = this.renderer?.domElement;
    canvas?.removeEventListener('webglcontextlost', this.onContextLost);
    canvas?.removeEventListener('webglcontextrestored', this.onContextRestored);

    this.disposeSceneResources();
    this.backdropTexture?.dispose();
    this.backdropTexture = null;
    this.backdropContext = null;
    this.backdropCanvas = null;

    if (this.renderer) {
      this.renderer.dispose();
      this.renderer.forceContextLoss();
      this.renderer.domElement.remove();
    }
    this.renderer = null;
    this.scene = null;
    this.camera = null;
    this.curve = null;

    this.root?.remove();
    this.root = null;
    this.plotElement = null;
    this.hitElement = null;
    this.readout = null;
    this.xAxis = null;
    this.yAxis = null;
    this.xTicks = [];
    this.yTicks = [];
    this.analysisRoot = null;
    this.analysisGridLines = [];
    this.analysisLabels = [];
    this.extremaHigh = null;
    this.extremaLow = null;
    this.extremaHighValue = null;
    this.extremaLowValue = null;
    this.container = null;
  }

  setTime(minutes: number): void {
    this.timeMinutes = clamp(Number.isFinite(minutes) ? minutes : 0, 0, DAY_MINUTES);
    this.updateTimeVisuals();
  }

  setData(data: DayData): void {
    if (this.activePointerId !== null) this.finishDrag(false);
    this.data = data;
    const next = new Float32Array(HOURS);
    let fallback = 15;

    for (let index = 0; index < HOURS; index += 1) {
      const candidate = data.temperature[index];
      if (Number.isFinite(candidate)) fallback = candidate;
      next[index] = clamp(fallback, TEMPERATURE_MIN, TEMPERATURE_MAX);
    }

    if (!this.hasData || !this.renderer) {
      this.visualTemperatures.set(next);
      this.temperatureVelocities.fill(0);
      this.hasData = true;
    }
    this.targetTemperatures.set(next);
    this.geometryDirty = true;
    if (!this.renderer) {
      this.rebuildCurve();
      this.updateTimeVisuals();
      return;
    }
    this.updateTimeVisuals();
  }

  setQuality(quality: Quality): void {
    if (quality === this.quality) return;
    this.quality = quality;
    if (!this.renderer) return;

    this.resize();
    this.buildSceneResources();
  }

  setMode(mode: 'feel' | 'analysis'): void {
    if (this.mode === mode) return;
    this.mode = mode;
    if (this.root) this.root.dataset.mode = mode;
    if (this.reducedMotion) {
      this.modeBlend = mode === 'analysis' ? 1 : 0;
      this.applyFeelDecorBlend();
    }
    this.updateAnalysisOverlay();
  }

  private createDom(): HTMLElement {
    const root = document.createElement('section');
    root.className = 'serein-temperature-layer';
    root.dataset.mode = this.mode;
    root.setAttribute('aria-label', '逐时温度曲线');
    root.innerHTML = `
      <style>${LAYER_CSS}</style>
      <header class="serein-temperature-header">
        <div class="serein-temperature-heading">
          <h2>温度</h2>
          <p>逐时 · °C</p>
        </div>
        <output class="serein-temperature-readout" aria-label="当前时刻温度">15.0°</output>
      </header>
      <div class="serein-temperature-plot" aria-hidden="true">
        <span class="serein-temperature-axis-line serein-temperature-axis-x"></span>
        <span class="serein-temperature-axis-line serein-temperature-axis-y"></span>
        <div class="serein-temperature-analysis"></div>
      </div>
      <div
        class="serein-temperature-hit"
        role="group"
        aria-label="拖动曲线上的逐时点可修改温度"
        data-dragging="false"
        data-scene-vertical-drag
      ></div>
    `;

    this.container?.appendChild(root);
    this.root = root;
    this.plotElement = root.querySelector<HTMLElement>('.serein-temperature-plot');
    this.hitElement = root.querySelector<HTMLElement>('.serein-temperature-hit');
    this.readout = root.querySelector<HTMLOutputElement>('.serein-temperature-readout');
    this.xAxis = root.querySelector<HTMLElement>('.serein-temperature-axis-x');
    this.yAxis = root.querySelector<HTMLElement>('.serein-temperature-axis-y');
    this.analysisRoot = root.querySelector<HTMLElement>('.serein-temperature-analysis');
    this.createAxisTicks();
    this.createAnalysisOverlay();
    return root;
  }

  private createAnalysisOverlay(): void {
    const analysis = this.analysisRoot;
    if (!analysis) return;
    analysis.replaceChildren();
    this.analysisGridLines = [];
    this.analysisLabels = [];

    for (const temperature of Y_TICKS) {
      const line = document.createElement('span');
      line.className = 'serein-temperature-grid-line';
      line.dataset.temperature = String(temperature);
      analysis.appendChild(line);
      this.analysisGridLines.push(line);
    }

    for (let hour = 0; hour < HOURS; hour += 1) {
      const label = document.createElement('span');
      label.className = 'serein-temperature-point-label';
      label.textContent = '—';
      analysis.appendChild(label);
      this.analysisLabels.push(label);
    }

    this.extremaHigh = this.createExtremaMarker('high');
    this.extremaLow = this.createExtremaMarker('low');
    analysis.append(this.extremaHigh, this.extremaLow);
    this.extremaHighValue = this.extremaHigh.querySelector('.serein-temperature-extrema-value');
    this.extremaLowValue = this.extremaLow.querySelector('.serein-temperature-extrema-value');
  }

  private createExtremaMarker(kind: 'high' | 'low'): HTMLElement {
    const marker = document.createElement('div');
    marker.className = 'serein-temperature-extrema';
    marker.dataset.kind = kind;
    marker.innerHTML = `
      <span class="serein-temperature-extrema-dot"></span>
      <span class="serein-temperature-extrema-value">—</span>
    `;
    return marker;
  }

  private createAxisTicks(): void {
    const plot = this.plotElement;
    if (!plot) return;

    for (let hour = 0; hour <= 24; hour += 2) {
      const element = document.createElement('span');
      element.className = 'serein-temperature-x-tick';
      element.textContent = `${String(hour).padStart(2, '0')}:00`;
      if (hour === 0) element.dataset.edge = 'start';
      if (hour === 24) element.dataset.edge = 'end';
      if (hour % 4 !== 0) element.dataset.responsiveMinor = 'true';
      plot.appendChild(element);
      this.xTicks.push({ hour, element });
    }

    for (const temperature of Y_TICKS) {
      const element = document.createElement('span');
      element.className = 'serein-temperature-y-tick';
      element.textContent = `${temperature < 0 ? '−' : ''}${Math.abs(temperature)}°`;
      plot.appendChild(element);
      this.yTicks.push({ temperature, element });
    }
  }

  private attachEvents(): void {
    const hit = this.hitElement;
    if (!hit) return;
    hit.addEventListener('pointerdown', this.onPointerDown);
    hit.addEventListener('pointermove', this.onPointerMove);
    hit.addEventListener('pointerup', this.onPointerUp);
    hit.addEventListener('pointercancel', this.onPointerCancel);
    hit.addEventListener('lostpointercapture', this.onLostPointerCapture);
    hit.addEventListener('pointerleave', this.onPointerLeave);
  }

  private detachEvents(): void {
    const hit = this.hitElement;
    if (!hit) return;
    hit.removeEventListener('pointerdown', this.onPointerDown);
    hit.removeEventListener('pointermove', this.onPointerMove);
    hit.removeEventListener('pointerup', this.onPointerUp);
    hit.removeEventListener('pointercancel', this.onPointerCancel);
    hit.removeEventListener('lostpointercapture', this.onLostPointerCapture);
    hit.removeEventListener('pointerleave', this.onPointerLeave);
  }

  private createBackdrop(): void {
    const canvas = document.createElement('canvas');
    canvas.width = 2;
    canvas.height = 2;
    const context = canvas.getContext('2d', { alpha: true });
    if (!context) return;

    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.minFilter = THREE.LinearFilter;
    texture.magFilter = THREE.LinearFilter;
    texture.generateMipmaps = false;

    this.backdropCanvas = canvas;
    this.backdropContext = context;
    this.backdropTexture = texture;
  }

  private buildSceneResources(): void {
    const scene = this.scene;
    const camera = this.camera;
    if (!scene || !camera) return;

    this.disposeSceneResources();
    this.rebuildCurve();
    const curve = this.curve;
    if (!curve) return;

    const config = QUALITY[this.quality];
    const dpr = this.renderer?.getPixelRatio() ?? 1;

    const tubeGeometry = new THREE.TubeGeometry(
      curve,
      config.tubeSegments,
      TUBE_RADIUS,
      config.radialSegments,
      false,
    );
    tubeGeometry.setAttribute(
      'aTemperature',
      new THREE.BufferAttribute(
        new Float32Array((config.tubeSegments + 1) * (config.radialSegments + 1)),
        1,
      ),
    );
    const tubeMaterial = new THREE.ShaderMaterial({
      uniforms: temperatureUniforms(),
      vertexShader: TUBE_VERTEX,
      fragmentShader: TUBE_FRAGMENT,
      depthTest: true,
      depthWrite: true,
      side: THREE.FrontSide,
    });
    this.tube = new THREE.Mesh(tubeGeometry, tubeMaterial);
    this.tube.renderOrder = 2;
    scene.add(this.tube);

    const haloGeometry = new THREE.BufferGeometry();
    haloGeometry.setAttribute(
      'position',
      new THREE.BufferAttribute(new Float32Array(config.haloPoints * 3), 3),
    );
    haloGeometry.setAttribute(
      'aTemperature',
      new THREE.BufferAttribute(new Float32Array(config.haloPoints), 1),
    );
    const haloMaterial = new THREE.ShaderMaterial({
      uniforms: {
        ...temperatureUniforms(),
        uDpr: { value: dpr },
        uSize: { value: this.quality === 'low' ? 20 : 27 },
        uFeel: { value: 1 - this.modeBlend * 0.88 },
      },
      vertexShader: HALO_VERTEX,
      fragmentShader: HALO_FRAGMENT,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthTest: false,
      depthWrite: false,
    });
    this.halo = new THREE.Points(haloGeometry, haloMaterial);
    this.halo.frustumCulled = false;
    this.halo.renderOrder = 1;
    scene.add(this.halo);

    this.createHeatResources(config, dpr);
    this.createFrostResources(config, dpr);
    this.createHandleResources(dpr);
    this.createBeadResources(config, dpr);

    this.geometryDirty = true;
    this.updateShapeGeometry();
    this.primeThresholdVisibility();
    this.updateTimeVisuals();
    if (this.renderer && this.heat) {
      this.renderer.getDrawingBufferSize(this.sizeScratch);
      this.heat.material.uniforms.uResolution.value.copy(this.sizeScratch);
    }
  }

  private createHeatResources(config: QualityConfig, dpr: number): void {
    const scene = this.scene;
    if (!scene) return;

    const count = config.heatSegments + 1;
    const geometry = new THREE.BufferGeometry();
    const positions = new Float32Array(count * 2 * 3);
    const sides = new Float32Array(count * 2);
    const along = new Float32Array(count * 2);
    const heat = new Float32Array(count * 2);
    const indices = new Uint16Array(config.heatSegments * 6);

    for (let index = 0; index < count; index += 1) {
      const vertex = index * 2;
      sides[vertex] = -1;
      sides[vertex + 1] = 1;
      along[vertex] = along[vertex + 1] = index / config.heatSegments;
    }
    for (let index = 0; index < config.heatSegments; index += 1) {
      const offset = index * 6;
      const vertex = index * 2;
      indices.set(
        [vertex, vertex + 2, vertex + 1, vertex + 2, vertex + 3, vertex + 1],
        offset,
      );
    }

    geometry.setIndex(new THREE.BufferAttribute(indices, 1));
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute('aSide', new THREE.BufferAttribute(sides, 1));
    geometry.setAttribute('aAlong', new THREE.BufferAttribute(along, 1));
    geometry.setAttribute('aHeat', new THREE.BufferAttribute(heat, 1));

    const material = new THREE.ShaderMaterial({
      uniforms: {
        uBackdrop: { value: this.backdropTexture },
        uResolution: { value: new THREE.Vector2(1, 1) },
        uElapsed: { value: 0 },
        uHasBackdrop: { value: 0 },
        uDpr: { value: dpr },
        uFeel: { value: 1 - this.modeBlend * 0.88 },
      },
      vertexShader: HEAT_VERTEX,
      fragmentShader: HEAT_FRAGMENT,
      transparent: true,
      depthTest: false,
      depthWrite: false,
      blending: THREE.NormalBlending,
    });
    this.heatTargets = new Float32Array(count);
    this.heatVisibility = new Float32Array(count);
    this.heat = new THREE.Mesh(geometry, material);
    this.heat.frustumCulled = false;
    this.heat.renderOrder = 0;
    scene.add(this.heat);
  }

  private createFrostResources(config: QualityConfig, dpr: number): void {
    const scene = this.scene;
    if (!scene) return;

    const count = particleBudget(config.frostParticles);
    const geometry = new THREE.BufferGeometry();
    const positions = new Float32Array(count * 3);
    const phase = new Float32Array(count);
    const size = new Float32Array(count);
    const opacity = new Float32Array(count);

    this.frostU = new Float32Array(count);
    this.frostAngle = new Float32Array(count);
    this.frostTargets = new Float32Array(count);
    this.frostVisibility = new Float32Array(count);

    for (let index = 0; index < count; index += 1) {
      this.frostU[index] = clamp01((index + 0.18 + hash(index, 1)) / count);
      this.frostAngle[index] = hash(index, 2) * Math.PI * 2;
      phase[index] = hash(index, 3) * Math.PI * 2;
      size[index] = 6.5 + hash(index, 4) * (this.quality === 'low' ? 5 : 8);
    }

    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute('aPhase', new THREE.BufferAttribute(phase, 1));
    geometry.setAttribute('aSize', new THREE.BufferAttribute(size, 1));
    geometry.setAttribute(
      'aOpacity',
      new THREE.BufferAttribute(opacity, 1).setUsage(THREE.DynamicDrawUsage),
    );

    const material = new THREE.ShaderMaterial({
      uniforms: {
        uElapsed: { value: 0 },
        uBreath: { value: this.reducedMotion ? 0 : 1 },
        uDpr: { value: dpr },
        uFeel: { value: 1 - this.modeBlend * 0.88 },
      },
      vertexShader: FROST_VERTEX,
      fragmentShader: FROST_FRAGMENT,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthTest: false,
      depthWrite: false,
    });
    this.frost = new THREE.Points(geometry, material);
    this.frost.frustumCulled = false;
    this.frost.renderOrder = 5;
    scene.add(this.frost);
  }

  private createHandleResources(dpr: number): void {
    const scene = this.scene;
    if (!scene) return;

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(HOURS * 3), 3));
    geometry.setAttribute('aSelected', new THREE.BufferAttribute(new Float32Array(HOURS), 1));
    const material = new THREE.ShaderMaterial({
      uniforms: { uDpr: { value: dpr } },
      vertexShader: HANDLE_VERTEX,
      fragmentShader: HANDLE_FRAGMENT,
      transparent: true,
      depthTest: false,
      depthWrite: false,
    });
    this.handles = new THREE.Points(geometry, material);
    this.handles.frustumCulled = false;
    this.handles.renderOrder = 3;
    scene.add(this.handles);
  }

  private createBeadResources(config: QualityConfig, dpr: number): void {
    const scene = this.scene;
    if (!scene) return;

    const widthSegments = config.radialSegments * 2;
    const sphereGeometry = new THREE.SphereGeometry(
      TUBE_RADIUS * 1.72,
      widthSegments,
      Math.max(6, config.radialSegments),
    );
    const sphereMaterial = new THREE.MeshBasicMaterial({
      color: 0xffffff,
      toneMapped: false,
      depthTest: false,
      depthWrite: false,
    });
    this.bead = new THREE.Mesh(sphereGeometry, sphereMaterial);
    this.bead.renderOrder = 4;
    scene.add(this.bead);

    const haloGeometry = new THREE.BufferGeometry();
    haloGeometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(3), 3));
    const haloMaterial = new THREE.ShaderMaterial({
      uniforms: {
        uColor: { value: TEMPERATURE_COLORS[2].clone() },
        uDpr: { value: dpr },
        uPulse: { value: 0.5 },
        uFeel: { value: 1 - this.modeBlend * 0.88 },
      },
      vertexShader: BEAD_HALO_VERTEX,
      fragmentShader: BEAD_HALO_FRAGMENT,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthTest: false,
      depthWrite: false,
    });
    this.beadHalo = new THREE.Points(haloGeometry, haloMaterial);
    this.beadHalo.frustumCulled = false;
    this.beadHalo.renderOrder = 4;
    scene.add(this.beadHalo);
  }

  private disposeSceneResources(): void {
    const objects = [
      this.tube,
      this.halo,
      this.frost,
      this.heat,
      this.handles,
      this.bead,
      this.beadHalo,
    ];
    for (const object of objects) {
      if (!object) continue;
      this.scene?.remove(object);
      object.geometry.dispose();
      const material = object.material;
      if (Array.isArray(material)) {
        for (const item of material) item.dispose();
      } else {
        material.dispose();
      }
    }

    this.tube = null;
    this.halo = null;
    this.frost = null;
    this.heat = null;
    this.handles = null;
    this.bead = null;
    this.beadHalo = null;
    this.frostU = new Float32Array(0);
    this.frostAngle = new Float32Array(0);
    this.frostTargets = new Float32Array(0);
    this.frostVisibility = new Float32Array(0);
    this.heatTargets = new Float32Array(0);
    this.heatVisibility = new Float32Array(0);
  }

  private rebuildCurve(): void {
    const points = Array.from({ length: HOURS }, (_, index) => {
      return new THREE.Vector3(
        hourToX(index),
        this.temperatureToY(this.visualTemperatures[index]),
        0,
      );
    });
    this.curve = new THREE.CatmullRomCurve3(points, false, 'centripetal');
  }

  private updateShapeGeometry(): void {
    this.rebuildCurve();
    const curve = this.curve;
    if (!curve) return;

    this.updateTubeGeometry(curve);
    this.updateHaloGeometry(curve);
    this.updateHeatGeometry(curve);
    this.updateFrostGeometry(curve);
    this.updateHandleGeometry(curve);
    this.geometryDirty = false;
  }

  private updateTubeGeometry(curve: THREE.CatmullRomCurve3): void {
    const tube = this.tube;
    if (!tube) return;

    const config = QUALITY[this.quality];
    const positions = tube.geometry.getAttribute('position') as THREE.BufferAttribute;
    const normals = tube.geometry.getAttribute('normal') as THREE.BufferAttribute;
    const temperatures = tube.geometry.getAttribute('aTemperature') as THREE.BufferAttribute;
    const frames = curve.computeFrenetFrames(config.tubeSegments, false);

    for (let segment = 0; segment <= config.tubeSegments; segment += 1) {
      const center = curve.getPointAt(segment / config.tubeSegments, this.pointScratch);
      const normal = frames.normals[segment];
      const binormal = frames.binormals[segment];
      const temperature = this.yToTemperature(center.y);

      for (let radial = 0; radial <= config.radialSegments; radial += 1) {
        const angle = (radial / config.radialSegments) * Math.PI * 2;
        const sin = Math.sin(angle);
        const cos = -Math.cos(angle);
        const nx = cos * normal.x + sin * binormal.x;
        const ny = cos * normal.y + sin * binormal.y;
        const nz = cos * normal.z + sin * binormal.z;
        const vertex = segment * (config.radialSegments + 1) + radial;

        normals.setXYZ(vertex, nx, ny, nz);
        positions.setXYZ(
          vertex,
          center.x + TUBE_RADIUS * nx,
          center.y + TUBE_RADIUS * ny,
          center.z + TUBE_RADIUS * nz,
        );
        temperatures.setX(vertex, temperature);
      }
    }

    positions.needsUpdate = true;
    normals.needsUpdate = true;
    temperatures.needsUpdate = true;
    tube.geometry.computeBoundingSphere();
  }

  private updateHaloGeometry(curve: THREE.CatmullRomCurve3): void {
    const halo = this.halo;
    if (!halo) return;

    const positions = halo.geometry.getAttribute('position') as THREE.BufferAttribute;
    const temperatures = halo.geometry.getAttribute('aTemperature') as THREE.BufferAttribute;
    const count = positions.count;

    for (let index = 0; index < count; index += 1) {
      const point = curve.getPoint(index / Math.max(1, count - 1), this.pointScratch);
      positions.setXYZ(index, point.x, point.y, -0.045);
      temperatures.setX(index, this.yToTemperature(point.y));
    }
    positions.needsUpdate = true;
    temperatures.needsUpdate = true;
  }

  private updateHeatGeometry(curve: THREE.CatmullRomCurve3): void {
    const heat = this.heat;
    if (!heat) return;

    const config = QUALITY[this.quality];
    const positions = heat.geometry.getAttribute('position') as THREE.BufferAttribute;
    const halfWidth = this.quality === 'low' ? 0.24 : 0.3;

    for (let index = 0; index <= config.heatSegments; index += 1) {
      const t = index / config.heatSegments;
      const point = curve.getPoint(t, this.pointScratch);
      const tangent = curve.getTangent(t, this.tangentScratch).normalize();
      const normal = this.normalScratch.set(-tangent.y, tangent.x, 0).normalize();
      const vertex = index * 2;

      positions.setXYZ(
        vertex,
        point.x - normal.x * halfWidth,
        point.y - normal.y * halfWidth,
        -0.12,
      );
      positions.setXYZ(
        vertex + 1,
        point.x + normal.x * halfWidth,
        point.y + normal.y * halfWidth,
        -0.12,
      );

      const temperature = this.yToTemperature(point.y);
      this.heatTargets[index] = clamp01(
        (temperature - HEAT_THRESHOLD) / (HEAT_CEILING - HEAT_THRESHOLD),
      );
    }

    positions.needsUpdate = true;
    heat.geometry.computeBoundingSphere();
  }

  private updateFrostGeometry(curve: THREE.CatmullRomCurve3): void {
    const frost = this.frost;
    if (!frost) return;

    const positions = frost.geometry.getAttribute('position') as THREE.BufferAttribute;
    for (let index = 0; index < this.frostU.length; index += 1) {
      const t = this.frostU[index];
      const point = curve.getPoint(t, this.pointScratch);
      const tangent = curve.getTangent(t, this.tangentScratch).normalize();
      const normal = this.normalScratch.set(-tangent.y, tangent.x, 0).normalize();
      const angle = this.frostAngle[index];
      const surfaceRadius = TUBE_RADIUS * (1.12 + hash(index, 8) * 0.34);
      const sideOffset = Math.cos(angle) * surfaceRadius;
      const depthOffset = Math.sin(angle) * surfaceRadius;

      positions.setXYZ(
        index,
        point.x + normal.x * sideOffset,
        point.y + normal.y * sideOffset,
        0.045 + Math.abs(depthOffset),
      );

      const temperature = this.yToTemperature(point.y);
      this.frostTargets[index] =
        temperature < 0 ? clamp01(0.34 + Math.abs(temperature) / 7) : 0;
    }

    positions.needsUpdate = true;
    frost.geometry.computeBoundingSphere();
  }

  private updateHandleGeometry(curve: THREE.CatmullRomCurve3): void {
    const handles = this.handles;
    if (!handles) return;

    const positions = handles.geometry.getAttribute('position') as THREE.BufferAttribute;
    for (let index = 0; index < HOURS; index += 1) {
      const point = curve.points[index];
      positions.setXYZ(index, point.x, point.y, 0.065);
    }
    positions.needsUpdate = true;
  }

  private updateThresholdFades(deltaSeconds: number): void {
    const blend = 1 - Math.exp(-deltaSeconds / PHASE_FADE_TAU);

    if (this.frost) {
      const opacity = this.frost.geometry.getAttribute('aOpacity') as THREE.BufferAttribute;
      let changed = false;
      for (let index = 0; index < this.frostVisibility.length; index += 1) {
        const previous = this.frostVisibility[index];
        const next = previous + (this.frostTargets[index] - previous) * blend;
        this.frostVisibility[index] =
          Math.abs(next - this.frostTargets[index]) < 0.001
            ? this.frostTargets[index]
            : next;
        opacity.setX(index, this.frostVisibility[index]);
        changed ||= Math.abs(previous - this.frostVisibility[index]) > 0.0001;
      }
      if (changed) opacity.needsUpdate = true;
    }

    if (this.heat) {
      const heatAttribute = this.heat.geometry.getAttribute('aHeat') as THREE.BufferAttribute;
      let changed = false;
      for (let index = 0; index < this.heatVisibility.length; index += 1) {
        const previous = this.heatVisibility[index];
        const next = previous + (this.heatTargets[index] - previous) * blend;
        this.heatVisibility[index] =
          Math.abs(next - this.heatTargets[index]) < 0.001 ? this.heatTargets[index] : next;
        heatAttribute.setX(index * 2, this.heatVisibility[index]);
        heatAttribute.setX(index * 2 + 1, this.heatVisibility[index]);
        changed ||= Math.abs(previous - this.heatVisibility[index]) > 0.0001;
      }
      if (changed) heatAttribute.needsUpdate = true;
    }
  }

  private primeThresholdVisibility(): void {
    if (this.frost) {
      this.frostVisibility.set(this.frostTargets);
      const opacity = this.frost.geometry.getAttribute('aOpacity') as THREE.BufferAttribute;
      for (let index = 0; index < this.frostVisibility.length; index += 1) {
        opacity.setX(index, this.frostVisibility[index]);
      }
      opacity.needsUpdate = true;
    }

    if (this.heat) {
      this.heatVisibility.set(this.heatTargets);
      const heatAttribute = this.heat.geometry.getAttribute('aHeat') as THREE.BufferAttribute;
      for (let index = 0; index < this.heatVisibility.length; index += 1) {
        heatAttribute.setX(index * 2, this.heatVisibility[index]);
        heatAttribute.setX(index * 2 + 1, this.heatVisibility[index]);
      }
      heatAttribute.needsUpdate = true;
    }
  }

  private stepSprings(deltaSeconds: number): boolean {
    const steps = Math.max(1, Math.ceil(deltaSeconds / (1 / 120)));
    const step = deltaSeconds / steps;
    let moving = false;

    for (let iteration = 0; iteration < steps; iteration += 1) {
      for (let index = 0; index < HOURS; index += 1) {
        const displacement = this.targetTemperatures[index] - this.visualTemperatures[index];
        const acceleration =
          SPRING_STIFFNESS * displacement - SPRING_DAMPING * this.temperatureVelocities[index];
        this.temperatureVelocities[index] += acceleration * step;
        this.visualTemperatures[index] += this.temperatureVelocities[index] * step;
      }
    }

    for (let index = 0; index < HOURS; index += 1) {
      const displacement = this.targetTemperatures[index] - this.visualTemperatures[index];
      if (
        Math.abs(displacement) < 0.001 &&
        Math.abs(this.temperatureVelocities[index]) < 0.001
      ) {
        this.visualTemperatures[index] = this.targetTemperatures[index];
        this.temperatureVelocities[index] = 0;
      } else {
        moving = true;
      }
    }

    return moving;
  }

  private updateTimeVisuals(): void {
    const t = this.timeMinutes / DAY_MINUTES;
    const curve = this.curve;
    let temperature = this.sampleLinearTemperature(t);

    if (curve) {
      const point = curve.getPoint(t, this.pointScratch);
      temperature = this.yToTemperature(point.y);

      if (this.bead) {
        this.bead.position.copy(point);
        this.bead.position.z = 0.115;
      }
      if (this.beadHalo) {
        const positions = this.beadHalo.geometry.getAttribute('position') as THREE.BufferAttribute;
        positions.setXYZ(0, point.x, point.y, 0.105);
        positions.needsUpdate = true;
      }
    }

    const pulse = this.reducedMotion ? 0.5 : 0.5 + 0.5 * Math.sin(Math.PI * this.elapsed);
    const color = interpolateTemperatureColor(temperature, this.colorScratch);

    if (this.bead) {
      this.bead.scale.setScalar(0.9 + pulse * 0.16);
      this.bead.material.color.copy(color).multiplyScalar(1.12 + pulse * 0.34);
    }
    if (this.beadHalo) {
      this.beadHalo.material.uniforms.uColor.value.copy(color);
      this.beadHalo.material.uniforms.uPulse.value = pulse;
    }

    if (this.readout) {
      const text = `${temperature.toFixed(1).replace('-', '−')}°`;
      if (this.readout.value !== text) this.readout.value = text;
      this.readout.setAttribute('aria-label', `当前时刻温度 ${text}C`);
    }
    this.root?.style.setProperty('--temperature-color', color.getStyle(THREE.SRGBColorSpace));
  }

  private sampleLinearTemperature(t: number): number {
    const hour = clamp01(t) * 24;
    const left = Math.min(23, Math.floor(hour));
    const amount = hour - left;
    return THREE.MathUtils.lerp(
      this.visualTemperatures[left],
      this.visualTemperatures[left + 1],
      amount,
    );
  }

  private temperatureToY(temperature: number): number {
    const camera = this.camera;
    if (!camera) {
      return THREE.MathUtils.lerp(-2.5, 2.5, (temperature - TEMPERATURE_MIN) / 60);
    }
    const cameraHeight = camera.top - camera.bottom;
    const padding = Math.min(0.2, cameraHeight * 0.045);
    return THREE.MathUtils.lerp(
      camera.bottom + padding,
      camera.top - padding,
      clamp01((temperature - TEMPERATURE_MIN) / (TEMPERATURE_MAX - TEMPERATURE_MIN)),
    );
  }

  private yToTemperature(y: number): number {
    const camera = this.camera;
    if (!camera) {
      return TEMPERATURE_MIN + ((y + 2.5) / 5) * (TEMPERATURE_MAX - TEMPERATURE_MIN);
    }
    const cameraHeight = camera.top - camera.bottom;
    const padding = Math.min(0.2, cameraHeight * 0.045);
    const bottom = camera.bottom + padding;
    const top = camera.top - padding;
    return TEMPERATURE_MIN + ((y - bottom) / Math.max(0.001, top - bottom)) * 60;
  }

  private resize = (): void => {
    const container = this.container;
    const plot = this.plotElement;
    const camera = this.camera;
    if (!container || !plot || !camera) return;

    const containerRect = container.getBoundingClientRect();
    const plotRect = plot.getBoundingClientRect();
    const width = Math.max(1, container.clientWidth);
    const height = Math.max(1, container.clientHeight);
    this.viewportX = clamp(plotRect.left - containerRect.left, 0, width - 1);
    this.viewportY = clamp(containerRect.bottom - plotRect.bottom, 0, height - 1);
    this.viewportWidth = Math.max(1, Math.min(plotRect.width, width - this.viewportX));
    this.viewportHeight = Math.max(1, Math.min(plotRect.height, height - this.viewportY));

    const aspect = this.viewportWidth / this.viewportHeight;
    const cameraWidth = CAMERA_X_MAX - CAMERA_X_MIN;
    const cameraHalfHeight = cameraWidth / Math.max(0.2, aspect) / 2;
    camera.left = CAMERA_X_MIN;
    camera.right = CAMERA_X_MAX;
    camera.top = cameraHalfHeight;
    camera.bottom = -cameraHalfHeight;
    camera.updateProjectionMatrix();

    const renderer = this.renderer;
    if (renderer) {
      const dpr = Math.min(window.devicePixelRatio || 1, QUALITY[this.quality].dpr, 2);
      renderer.setPixelRatio(dpr);
      renderer.setSize(width, height, false);
      this.updateDprUniforms(dpr);
      renderer.getDrawingBufferSize(this.sizeScratch);
      if (this.heat) {
        this.heat.material.uniforms.uResolution.value.copy(this.sizeScratch);
      }
    }

    this.resizeBackdrop(width, height);
    this.updateAxisLayout();
    this.geometryDirty = true;
    if (!this.renderer) {
      this.rebuildCurve();
      this.updateTimeVisuals();
      this.geometryDirty = false;
    }
  };

  private updateDprUniforms(dpr: number): void {
    if (this.halo) this.halo.material.uniforms.uDpr.value = dpr;
    if (this.frost) this.frost.material.uniforms.uDpr.value = dpr;
    if (this.handles) this.handles.material.uniforms.uDpr.value = dpr;
    if (this.beadHalo) this.beadHalo.material.uniforms.uDpr.value = dpr;
  }

  private resizeBackdrop(width: number, height: number): void {
    const canvas = this.backdropCanvas;
    if (!canvas) return;
    const targetWidth = QUALITY[this.quality].backdropWidth;
    const targetHeight = Math.max(2, Math.round((targetWidth * height) / Math.max(1, width)));
    if (canvas.width !== targetWidth || canvas.height !== targetHeight) {
      canvas.width = targetWidth;
      canvas.height = targetHeight;
      this.backdropTexture!.needsUpdate = true;
      if (this.heat) this.heat.material.uniforms.uHasBackdrop.value = 0;
      this.backdropFrame = QUALITY[this.quality].backdropEvery - 1;
    }
  }

  private updateAxisLayout(): void {
    const camera = this.camera;
    if (!camera || !this.xAxis || !this.yAxis) return;

    const xStart = this.worldXToPercent(hourToX(0));
    const xEnd = this.worldXToPercent(hourToX(24));
    const yTop = this.worldYToPercent(this.temperatureToY(TEMPERATURE_MAX));
    const yBottom = this.worldYToPercent(this.temperatureToY(TEMPERATURE_MIN));

    this.xAxis.style.left = `${xStart}%`;
    this.xAxis.style.width = `${xEnd - xStart}%`;
    this.xAxis.style.top = `${yBottom}%`;
    this.yAxis.style.left = `${xStart}%`;
    this.yAxis.style.top = `${yTop}%`;
    this.yAxis.style.height = `${yBottom - yTop}%`;

    for (const { hour, element } of this.xTicks) {
      element.style.left = `${this.worldXToPercent(hourToX(hour))}%`;
      element.style.top = `${yBottom}%`;
    }
    for (const { temperature, element } of this.yTicks) {
      element.style.left = `${xStart}%`;
      element.style.top = `${this.worldYToPercent(this.temperatureToY(temperature))}%`;
    }
    this.updateAnalysisOverlay();
  }

  private updateAnalysisOverlay(): void {
    if (!this.analysisRoot || !this.camera) return;

    const xStart = this.worldXToPercent(hourToX(0));
    const xEnd = this.worldXToPercent(hourToX(24));

    for (let index = 0; index < this.analysisGridLines.length; index += 1) {
      const temperature = Y_TICKS[index];
      const line = this.analysisGridLines[index];
      line.style.left = `${xStart}%`;
      line.style.width = `${xEnd - xStart}%`;
      line.style.top = `${this.worldYToPercent(this.temperatureToY(temperature))}%`;
    }

    let highIndex = 0;
    let lowIndex = 0;
    for (let hour = 0; hour < HOURS; hour += 1) {
      const temperature = this.visualTemperatures[hour];
      if (temperature > this.visualTemperatures[highIndex]) highIndex = hour;
      if (temperature < this.visualTemperatures[lowIndex]) lowIndex = hour;

      const label = this.analysisLabels[hour];
      if (!label) continue;
      const text = `${temperature.toFixed(1).replace('-', '−')}°`;
      if (label.textContent !== text) label.textContent = text;
      label.style.left = `${this.worldXToPercent(hourToX(hour))}%`;
      label.style.top = `${this.worldYToPercent(this.temperatureToY(temperature))}%`;
    }

    this.placeExtremaMarker(this.extremaHigh, this.extremaHighValue, highIndex, 'high');
    this.placeExtremaMarker(this.extremaLow, this.extremaLowValue, lowIndex, 'low');
  }

  private placeExtremaMarker(
    marker: HTMLElement | null,
    valueElement: HTMLElement | null,
    hour: number,
    kind: 'high' | 'low',
  ): void {
    if (!marker || !valueElement) return;
    const temperature = this.visualTemperatures[hour];
    const text = `${kind === 'high' ? '最高' : '最低'} ${temperature.toFixed(1).replace('-', '−')}°`;
    if (valueElement.textContent !== text) valueElement.textContent = text;
    marker.style.left = `${this.worldXToPercent(hourToX(hour))}%`;
    marker.style.top = `${this.worldYToPercent(this.temperatureToY(temperature))}%`;
  }

  private stepModeBlend(deltaSeconds: number): void {
    const target = this.mode === 'analysis' ? 1 : 0;
    if (Math.abs(this.modeBlend - target) < 0.001) {
      this.modeBlend = target;
      return;
    }
    const rate = this.reducedMotion ? 1 : deltaSeconds / (MODE_BLEND_MS / 1000);
    this.modeBlend = clamp(this.modeBlend + Math.sign(target - this.modeBlend) * rate, 0, 1);
    if (Math.abs(this.modeBlend - target) < 0.001) this.modeBlend = target;
    this.applyFeelDecorBlend();
  }

  private applyFeelDecorBlend(): void {
    const feel = 1 - this.modeBlend * 0.88;
    if (this.halo?.material.uniforms.uFeel) this.halo.material.uniforms.uFeel.value = feel;
    if (this.frost?.material.uniforms.uFeel) this.frost.material.uniforms.uFeel.value = feel;
    if (this.heat?.material.uniforms.uFeel) this.heat.material.uniforms.uFeel.value = feel;
    if (this.beadHalo?.material.uniforms.uFeel) {
      this.beadHalo.material.uniforms.uFeel.value = 0.35 + feel * 0.65;
    }
  }

  private worldXToPercent(x: number): number {
    const camera = this.camera;
    if (!camera) return 50;
    return ((x - camera.left) / (camera.right - camera.left)) * 100;
  }

  private worldYToPercent(y: number): number {
    const camera = this.camera;
    if (!camera) return 50;
    return ((camera.top - y) / (camera.top - camera.bottom)) * 100;
  }

  private captureBackdrop(): void {
    const heat = this.heat;
    const canvas = this.backdropCanvas;
    const context = this.backdropContext;
    const texture = this.backdropTexture;
    if (!heat || !canvas || !context || !texture) return;

    let maximumHeat = 0;
    for (const value of this.heatVisibility) maximumHeat = Math.max(maximumHeat, value);
    if (maximumHeat < 0.002) {
      heat.material.uniforms.uHasBackdrop.value = 0;
      return;
    }

    this.backdropFrame += 1;
    if (this.backdropFrame % QUALITY[this.quality].backdropEvery !== 0) return;

    const source = this.findBackdropCanvas();
    if (!source) {
      heat.material.uniforms.uHasBackdrop.value = 0;
      return;
    }

    try {
      context.clearRect(0, 0, canvas.width, canvas.height);
      context.drawImage(source, 0, 0, source.width, source.height, 0, 0, canvas.width, canvas.height);
      texture.needsUpdate = true;
      heat.material.uniforms.uHasBackdrop.value = 1;
    } catch {
      heat.material.uniforms.uHasBackdrop.value = 0;
    }
  }

  private findBackdropCanvas(): HTMLCanvasElement | null {
    const ownCanvas = this.renderer?.domElement;
    const searchRoot = this.container?.parentElement ?? this.container;
    if (!searchRoot) return null;

    let best: HTMLCanvasElement | null = null;
    let bestArea = 0;
    for (const canvas of searchRoot.querySelectorAll('canvas')) {
      if (canvas === ownCanvas || canvas.width < 2 || canvas.height < 2) continue;
      const area = canvas.clientWidth * canvas.clientHeight;
      if (area > bestArea) {
        best = canvas;
        bestArea = area;
      }
    }
    return best;
  }

  private start(): void {
    if (this.raf || document.hidden || !this.renderer) return;
    this.lastTimestamp = performance.now();
    this.raf = requestAnimationFrame(this.frame);
  }

  private stop(): void {
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
  }

  private frame = (timestamp: number): void => {
    this.raf = requestAnimationFrame(this.frame);
    const elapsedSeconds = clamp((timestamp - this.lastTimestamp) / 1000, 0, 1);
    this.lastTimestamp = timestamp;
    this.elapsed += elapsedSeconds;

    if (this.stepSprings(elapsedSeconds)) this.geometryDirty = true;
    if (this.geometryDirty) this.updateShapeGeometry();
    this.updateThresholdFades(elapsedSeconds);
    this.stepModeBlend(elapsedSeconds);
    this.updateAnimatedUniforms();
    this.updateTimeVisuals();
    if (this.modeBlend > 0.001 || this.mode === 'analysis') this.updateAnalysisOverlay();
    this.captureBackdrop();
    this.render();
  };

  private updateAnimatedUniforms(): void {
    const breath = this.reducedMotion ? 0 : 1;
    if (this.frost) {
      this.frost.material.uniforms.uElapsed.value = this.elapsed;
      this.frost.material.uniforms.uBreath.value = breath;
    }
    if (this.heat) this.heat.material.uniforms.uElapsed.value = this.elapsed;
  }

  private render(): void {
    const renderer = this.renderer;
    const scene = this.scene;
    const camera = this.camera;
    if (!renderer || !scene || !camera) return;

    renderer.setScissorTest(false);
    renderer.setViewport(0, 0, this.container?.clientWidth ?? 1, this.container?.clientHeight ?? 1);
    renderer.clear(true, true, true);

    renderer.setViewport(
      this.viewportX,
      this.viewportY,
      this.viewportWidth,
      this.viewportHeight,
    );
    renderer.setScissor(
      this.viewportX,
      this.viewportY,
      this.viewportWidth,
      this.viewportHeight,
    );
    renderer.setScissorTest(true);
    renderer.render(scene, camera);
    renderer.setScissorTest(false);
  }

  private pointerTemperature(event: PointerEvent): number {
    const rect = this.plotElement?.getBoundingClientRect();
    const camera = this.camera;
    if (!rect || !camera || rect.height <= 0) return 15;
    const ratio = clamp01((event.clientY - rect.top) / rect.height);
    const worldY = THREE.MathUtils.lerp(camera.top, camera.bottom, ratio);
    return this.yToTemperature(worldY);
  }

  private nearestHourIndex(event: PointerEvent): number {
    const curve = this.curve;
    const camera = this.camera;
    const rect = this.plotElement?.getBoundingClientRect();
    if (!curve || !camera || !rect) return -1;

    let nearest = -1;
    let nearestDistance = event.pointerType === 'touch' ? 30 : 19;
    for (let index = 0; index < HOURS; index += 1) {
      this.pointScratch.copy(curve.points[index]).project(camera);
      const x = rect.left + (this.pointScratch.x * 0.5 + 0.5) * rect.width;
      const y = rect.top + (-this.pointScratch.y * 0.5 + 0.5) * rect.height;
      const distance = Math.hypot(event.clientX - x, event.clientY - y);
      if (distance < nearestDistance) {
        nearest = index;
        nearestDistance = distance;
      }
    }
    return nearest;
  }

  private updateSelectedHandle(): void {
    const selected = this.handles?.geometry.getAttribute('aSelected') as
      | THREE.BufferAttribute
      | undefined;
    if (!selected) return;
    for (let index = 0; index < HOURS; index += 1) {
      selected.setX(index, index === this.dragIndex ? 1 : 0);
    }
    selected.needsUpdate = true;
  }

  private onPointerDown = (event: PointerEvent): void => {
    if (
      this.activePointerId !== null ||
      !event.isPrimary ||
      (event.pointerType === 'mouse' && event.button !== 0)
    ) {
      return;
    }

    const index = this.nearestHourIndex(event);
    if (index < 0 || !this.hitElement) return;

    event.preventDefault();
    this.activePointerId = event.pointerId;
    this.dragIndex = index;
    this.dragStartPointerTemperature = this.pointerTemperature(event);
    this.dragBaseTemperatures.set(this.targetTemperatures);
    this.hitElement.dataset.dragging = 'true';
    this.hitElement.setPointerCapture(event.pointerId);
    this.updateSelectedHandle();
  };

  private onPointerMove = (event: PointerEvent): void => {
    if (event.pointerId !== this.activePointerId || this.dragIndex < 0) {
      if (this.activePointerId === null && this.hitElement) {
        this.hitElement.style.cursor =
          this.nearestHourIndex(event) >= 0 ? 'ns-resize' : 'crosshair';
      }
      return;
    }

    event.preventDefault();
    const delta = this.pointerTemperature(event) - this.dragStartPointerTemperature;
    const sigma = 1.7;
    for (let index = 0; index < HOURS; index += 1) {
      const distance = Math.abs(index - this.dragIndex);
      const influence =
        distance > 5 ? 0 : Math.exp(-(distance * distance) / (2 * sigma * sigma));
      this.targetTemperatures[index] = clamp(
        this.dragBaseTemperatures[index] + delta * influence,
        TEMPERATURE_MIN,
        TEMPERATURE_MAX,
      );
    }
    this.geometryDirty = true;
  };

  private onPointerUp = (event: PointerEvent): void => {
    if (event.pointerId !== this.activePointerId) return;
    this.finishDrag(true);
  };

  private onPointerCancel = (event: PointerEvent): void => {
    if (event.pointerId !== this.activePointerId) return;
    this.finishDrag(false);
  };

  private onLostPointerCapture = (event: PointerEvent): void => {
    if (event.pointerId !== this.activePointerId) return;
    this.finishDrag(true, false);
  };

  private onPointerLeave = (): void => {
    if (this.activePointerId === null && this.hitElement) {
      this.hitElement.style.cursor = 'crosshair';
    }
  };

  private finishDrag(commit: boolean, releaseCapture = true): void {
    const pointerId = this.activePointerId;
    if (!commit) {
      this.targetTemperatures.set(this.dragBaseTemperatures);
    } else {
      for (let index = 0; index < HOURS; index += 1) {
        const value = Math.round(this.targetTemperatures[index] * 100) / 100;
        this.targetTemperatures[index] = value;
        if (this.data) this.data.temperature[index] = value;
      }
    }

    this.activePointerId = null;
    this.dragIndex = -1;
    if (this.hitElement) {
      this.hitElement.dataset.dragging = 'false';
      this.hitElement.style.cursor = 'crosshair';
      if (
        releaseCapture &&
        pointerId !== null &&
        this.hitElement.hasPointerCapture(pointerId)
      ) {
        this.hitElement.releasePointerCapture(pointerId);
      }
    }
    this.updateSelectedHandle();
    this.geometryDirty = true;
  }

  private releasePointerCapture(): void {
    if (
      this.activePointerId !== null &&
      this.hitElement?.hasPointerCapture(this.activePointerId)
    ) {
      this.hitElement.releasePointerCapture(this.activePointerId);
    }
    this.activePointerId = null;
    this.dragIndex = -1;
  }

  private onVisibility = (): void => {
    if (document.hidden) this.stop();
    else this.start();
  };

  private onContextLost = (event: Event): void => {
    event.preventDefault();
    this.stop();
  };

  private onContextRestored = (): void => {
    this.resize();
    this.geometryDirty = true;
    this.start();
  };
}
