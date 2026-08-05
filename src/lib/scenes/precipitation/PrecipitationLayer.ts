/**
 * Required Notice: Rainform / 数据成雨 © 2026 afterimage
 * https://rainform.pages.dev/
 *
 * This WeatherLayer is a contract-oriented refactor of Rainform.  The original
 * deterministic curtain composition, mercury-like drops, peak downpour,
 * waterline haze, ripples, orbit interaction, editable curve and WebAudio rain
 * bed are retained, while ownership and lifetime are contained by the layer.
 */

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import {
  getMasterGain,
  releaseAudioNodes,
  resumeSharedAudio,
} from '../../audio';
import { particleBudget, subscribeReducedMotion } from '../../motion';
import type { DayData, WeatherLayer } from '../../contracts';

type Quality = 'low' | 'medium' | 'high';

interface ParticleState {
  points: THREE.Points<THREE.BufferGeometry, THREE.ShaderMaterial>;
  hours: Float32Array;
  phaseSeed: Float32Array;
  phaseFrom: Float32Array;
  phaseTo: Float32Array;
  rain: Float32Array;
  top: Float32Array;
}

interface WaterfallState {
  group: THREE.Group;
  body: THREE.Mesh<THREE.BufferGeometry, THREE.ShaderMaterial>;
  filaments: THREE.Mesh<THREE.InstancedBufferGeometry, THREE.ShaderMaterial>;
  filamentHours: Float32Array;
  filamentPhaseSeed: Float32Array;
  filamentPhaseFrom: Float32Array;
  filamentPhaseTo: Float32Array;
  filamentStorm: Float32Array;
  filamentHeight: Float32Array;
}

interface RippleState {
  rings: THREE.Mesh<THREE.InstancedBufferGeometry, THREE.ShaderMaterial>;
  centers: Float32Array;
  starts: Float32Array;
  strengths: Float32Array;
  seeds: Float32Array;
  capacity: number;
  cursor: number;
}

interface AudioGraph {
  context: AudioContext;
  source: AudioBufferSourceNode;
  filter: BiquadFilterNode;
  gain: GainNode;
}

interface CurveDrag {
  pointerId: number;
  hour: number;
}

const HOURS = 25;
const DAY_MINUTES = 1440;
const WATER_LEVEL = -0.14;
const PLOT_WIDTH = 17;
const PLOT_HEIGHT = 6.6;
const X_MIN = -PLOT_WIDTH / 2;
const X_MAX = PLOT_WIDTH / 2;
const CURVE_Z = 1.12;
const BASE_AXIS_MAX = 12.8;
const PHASE_TRANSITION_SECONDS = 0.8;
const RAIN_REFERENCE = 10;
const RAIN_SEED = 0x6d2b79f5;

/** Contract-required precipitation-particle budgets. */
const PARTICLE_COUNT: Record<Quality, number> = {
  high: 60_000,
  medium: 30_000,
  low: 12_000,
};

const WATERFALL_COUNT: Record<Quality, number> = {
  high: 1_800,
  medium: 900,
  low: 360,
};

const RIPPLE_COUNT: Record<Quality, number> = {
  high: 48,
  medium: 28,
  low: 16,
};

const DPR_CAP: Record<Quality, number> = {
  high: 1.75,
  medium: 1.5,
  low: 1.25,
};

const DEFAULT_RAINFALL = [
  2.1, 3.8, 4.6, 3.2, 2.5, 5.2, 7.7, 7.4, 9.3, 9.8, 10, 6.7, 6.3,
  1.6, 2.2, 3.8, 5.9, 7.4, 9.1, 10, 8.8, 5.3, 3.1, 1.8, 1.2,
] as const;

const LAYER_CSS = `
.serein-precipitation-layer {
  position: absolute;
  inset: 0;
  overflow: hidden;
  background: transparent;
  color: var(--fg-1, rgba(255,255,255,.92));
  font-family: -apple-system, "SF Pro", Inter, "PingFang SC", sans-serif;
  font-variant-numeric: tabular-nums;
  isolation: isolate;
  user-select: none;
  -webkit-user-select: none;
}
.serein-precipitation-canvas {
  position: absolute;
  inset: 0;
  z-index: 0;
  display: block;
  width: 100%;
  height: 100%;
  cursor: grab;
  touch-action: none;
}
.serein-precipitation-canvas:active {
  cursor: grabbing;
}
.serein-precipitation-canvas[data-curve-hover="true"],
.serein-precipitation-canvas[data-curve-dragging="true"] {
  cursor: ns-resize;
}
.serein-precipitation-header {
  position: absolute;
  top: max(28px, env(safe-area-inset-top));
  left: max(28px, env(safe-area-inset-left));
  z-index: 3;
  display: grid;
  gap: 8px;
  pointer-events: none;
}
.serein-precipitation-heading {
  display: flex;
  align-items: baseline;
  gap: 11px;
}
.serein-precipitation-heading h2,
.serein-precipitation-heading p,
.serein-precipitation-readout,
.serein-precipitation-phase {
  margin: 0;
}
.serein-precipitation-heading h2 {
  font-size: 17px;
  font-weight: 560;
  letter-spacing: .02em;
}
.serein-precipitation-heading p {
  color: var(--fg-2, rgba(255,255,255,.45));
  font-size: 11px;
  font-weight: 500;
  letter-spacing: .08em;
}
.serein-precipitation-current {
  display: flex;
  align-items: baseline;
  gap: 7px;
}
.serein-precipitation-readout {
  color: var(--fg-1, rgba(255,255,255,.92));
  font-size: 38px;
  font-weight: 330;
  letter-spacing: -.045em;
  line-height: .95;
  text-shadow: 0 0 24px rgba(126,200,255,.14);
}
.serein-precipitation-readout span {
  margin-left: 4px;
  color: var(--fg-2, rgba(255,255,255,.45));
  font-size: 11px;
  font-weight: 500;
  letter-spacing: .02em;
}
.serein-precipitation-phase {
  padding: 3px 7px;
  border: 1px solid color-mix(in srgb, var(--accent, #7ec8ff) 20%, transparent);
  border-radius: 999px;
  background: color-mix(in srgb, var(--accent, #7ec8ff) 7%, transparent);
  color: color-mix(in srgb, var(--accent, #7ec8ff) 74%, white);
  font-size: 10px;
  letter-spacing: .06em;
}
.serein-precipitation-toolbar {
  position: absolute;
  top: max(18px, env(safe-area-inset-top));
  right: max(18px, env(safe-area-inset-right));
  z-index: 5;
  display: inline-flex;
  padding: 3px;
  gap: 3px;
  border: 1px solid rgba(255,255,255,.14);
  border-radius: 999px;
  background: rgba(5,7,10,.28);
  box-shadow: inset 0 1px rgba(255,255,255,.08), 0 10px 34px rgba(0,0,0,.2);
  backdrop-filter: blur(22px) saturate(135%);
  -webkit-backdrop-filter: blur(22px) saturate(135%);
}
.serein-precipitation-tool {
  position: relative;
  display: grid;
  width: 44px;
  height: 44px;
  padding: 0;
  place-items: center;
  border: 0;
  border-radius: 50%;
  background: transparent;
  color: rgba(180,205,230,.72);
  cursor: pointer;
  transition: color 160ms ease, background-color 160ms ease;
}
.serein-precipitation-tool + .serein-precipitation-tool::before {
  position: absolute;
  top: 10px;
  bottom: 10px;
  left: -2px;
  width: 1px;
  background: rgba(255,255,255,.1);
  content: "";
}
.serein-precipitation-tool:hover,
.serein-precipitation-tool[aria-pressed="true"] {
  background: rgba(126,200,255,.08);
  color: rgba(220,239,255,.94);
}
.serein-precipitation-tool:focus-visible,
.serein-precipitation-editor button:focus-visible,
.serein-precipitation-editor input:focus-visible {
  outline: 2px solid var(--accent, #7ec8ff);
  outline-offset: 2px;
}
.serein-precipitation-tool svg {
  width: 19px;
  height: 19px;
  overflow: visible;
}
.serein-precipitation-tool path,
.serein-precipitation-tool polyline {
  fill: none;
  stroke: currentColor;
  stroke-linecap: round;
  stroke-linejoin: round;
  stroke-width: 1.65;
}
.serein-precipitation-tool circle {
  fill: currentColor;
}
.serein-precipitation-editor {
  position: absolute;
  top: 0;
  right: 0;
  bottom: 0;
  z-index: 8;
  display: flex;
  box-sizing: border-box;
  width: min(440px, calc(100% - 36px));
  padding-top: env(safe-area-inset-top);
  padding-bottom: env(safe-area-inset-bottom);
  flex-direction: column;
  border-left: 1px solid rgba(255,255,255,.14);
  background:
    radial-gradient(circle at 88% 0%, rgba(126,200,255,.08), transparent 30%),
    linear-gradient(180deg, rgba(19,25,35,.78), rgba(4,6,10,.86));
  box-shadow: -26px 0 84px rgba(0,0,0,.4);
  backdrop-filter: blur(40px) saturate(140%);
  -webkit-backdrop-filter: blur(40px) saturate(140%);
  opacity: 0;
  pointer-events: none;
  transform: translateX(calc(100% + 24px));
  transition: opacity 220ms ease, transform 280ms cubic-bezier(.22,1,.36,1);
  visibility: hidden;
}
.serein-precipitation-editor[data-open="true"] {
  opacity: 1;
  pointer-events: auto;
  transform: translateX(0);
  visibility: visible;
}
.serein-precipitation-editor-header {
  display: flex;
  padding: 25px 22px 19px;
  align-items: flex-start;
  justify-content: space-between;
  gap: 18px;
  border-bottom: 1px solid rgba(255,255,255,.1);
}
.serein-precipitation-editor-header p,
.serein-precipitation-editor-header h3 {
  margin: 0;
}
.serein-precipitation-editor-eyebrow {
  margin-bottom: 7px !important;
  color: var(--fg-2, rgba(255,255,255,.45));
  font-size: 10px;
  font-weight: 600;
  letter-spacing: .16em;
}
.serein-precipitation-editor-header h3 {
  font-size: 21px;
  font-weight: 570;
}
.serein-precipitation-editor-description {
  margin-top: 8px !important;
  color: var(--fg-2, rgba(255,255,255,.45));
  font-size: 12px;
  line-height: 1.6;
}
.serein-precipitation-editor-close {
  position: relative;
  display: grid;
  width: 42px;
  height: 42px;
  flex: none;
  place-items: center;
  border: 1px solid rgba(255,255,255,.14);
  border-radius: 50%;
  background: rgba(255,255,255,.05);
  color: var(--fg-2, rgba(255,255,255,.45));
  font-size: 20px;
  cursor: pointer;
}
.serein-precipitation-editor-scroll {
  min-height: 0;
  padding: 18px 20px 24px;
  flex: 1;
  overflow-y: auto;
  overscroll-behavior: contain;
}
.serein-precipitation-editor-section {
  display: flex;
  margin-bottom: 12px;
  align-items: baseline;
  justify-content: space-between;
}
.serein-precipitation-editor-section h4 {
  margin: 0;
  font-size: 13px;
  font-weight: 560;
}
.serein-precipitation-editor-section span {
  color: var(--fg-2, rgba(255,255,255,.45));
  font-size: 10px;
}
.serein-precipitation-chart-card {
  position: relative;
  padding: 12px 12px 10px;
  overflow: hidden;
  border: 1px solid rgba(255,255,255,.12);
  border-radius: 14px;
  background: linear-gradient(145deg, rgba(255,255,255,.06), rgba(5,7,10,.24));
}
.serein-precipitation-chart-readout {
  position: absolute;
  top: 12px;
  right: 14px;
  z-index: 2;
  display: flex;
  align-items: baseline;
  gap: 4px;
  color: var(--fg-2, rgba(255,255,255,.45));
  font-size: 9px;
  pointer-events: none;
}
.serein-precipitation-chart-readout strong {
  color: var(--fg-1, rgba(255,255,255,.92));
  font-size: 17px;
}
.serein-precipitation-chart {
  display: block;
  width: 100%;
  min-height: 172px;
  cursor: crosshair;
  touch-action: none;
}
.serein-precipitation-chart-grid {
  stroke: var(--line, rgba(255,255,255,.22));
  stroke-width: 1;
  vector-effect: non-scaling-stroke;
}
.serein-precipitation-chart-label {
  fill: var(--axis-tick-color, var(--fg-2, rgba(255,255,255,.45)));
  font: var(--axis-tick-size, 11px)/1 -apple-system, "SF Pro", Inter, "PingFang SC", sans-serif;
  font-variant-numeric: tabular-nums;
}
.serein-precipitation-chart-area {
  fill: url(#serein-precipitation-area-gradient);
  pointer-events: none;
}
.serein-precipitation-chart-line {
  fill: none;
  stroke: rgba(226,232,244,.9);
  stroke-linecap: round;
  stroke-linejoin: round;
  stroke-width: 2;
  vector-effect: non-scaling-stroke;
  pointer-events: none;
}
.serein-precipitation-chart-point circle:first-child {
  fill: rgba(126,200,255,.14);
  opacity: 0;
}
.serein-precipitation-chart-point circle:nth-child(2) {
  fill: #c2cbdb;
  stroke: rgba(4,7,12,.94);
  stroke-width: 1.5;
  vector-effect: non-scaling-stroke;
}
.serein-precipitation-chart-point circle:last-child {
  fill: transparent;
  cursor: ns-resize;
}
.serein-precipitation-chart-point:hover circle:first-child,
.serein-precipitation-chart-point:focus circle:first-child,
.serein-precipitation-chart-point[data-active="true"] circle:first-child {
  opacity: 1;
}
.serein-precipitation-chart-point:focus {
  outline: none;
}
.serein-precipitation-chart-hours {
  display: flex;
  margin: -1px 7px 0 24px;
  justify-content: space-between;
  color: rgba(255,255,255,.4);
  font-size: 9px;
}
.serein-precipitation-chart-hint {
  margin: 10px 2px 0;
  color: rgba(255,255,255,.42);
  font-size: 9px;
  line-height: 1.5;
  text-align: center;
}
.serein-precipitation-details {
  margin-top: 12px;
  overflow: hidden;
  border: 1px solid rgba(255,255,255,.12);
  border-radius: 14px;
  background: rgba(5,7,10,.2);
}
.serein-precipitation-details summary {
  padding: 13px 12px;
  color: rgba(255,255,255,.72);
  font-size: 13px;
  cursor: pointer;
}
.serein-precipitation-input-grid {
  display: grid;
  padding: 0 9px 10px;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 8px;
}
.serein-precipitation-input-grid label {
  display: grid;
  min-width: 0;
  grid-template-columns: auto minmax(0, 1fr);
  align-items: center;
  gap: 7px;
  color: var(--fg-2, rgba(255,255,255,.45));
  font-size: 10px;
}
.serein-precipitation-input-grid input {
  min-width: 0;
  height: 34px;
  padding: 0 7px;
  border: 1px solid rgba(255,255,255,.12);
  border-radius: 7px;
  background: rgba(255,255,255,.05);
  color: var(--fg-1, rgba(255,255,255,.92));
  font: 500 12px/1 ui-monospace, SFMono-Regular, Menlo, monospace;
}
.serein-precipitation-editor-actions {
  display: flex;
  padding: 14px 18px max(16px, env(safe-area-inset-bottom));
  justify-content: flex-end;
  border-top: 1px solid rgba(255,255,255,.1);
}
.serein-precipitation-restore {
  min-height: 40px;
  padding: 0 14px;
  border: 1px solid rgba(255,255,255,.14);
  border-radius: 9px;
  background: rgba(255,255,255,.06);
  color: rgba(255,255,255,.78);
  font-size: 12px;
  cursor: pointer;
}
.serein-precipitation-fallback {
  position: absolute;
  top: 50%;
  left: 50%;
  z-index: 4;
  padding: 12px 16px;
  border: 1px solid var(--line, rgba(255,255,255,.22));
  border-radius: 10px;
  background: rgba(5,7,10,.5);
  color: var(--fg-2, rgba(255,255,255,.45));
  font-size: 12px;
  transform: translate(-50%, -50%);
}
@media (max-width: 760px) {
  .serein-precipitation-header {
    top: max(18px, env(safe-area-inset-top));
    left: max(18px, env(safe-area-inset-left));
  }
  .serein-precipitation-current {
    display: none;
  }
  .serein-precipitation-toolbar {
    top: max(12px, env(safe-area-inset-top));
    right: max(12px, env(safe-area-inset-right));
  }
  .serein-precipitation-editor {
    top: auto;
    left: 0;
    width: 100%;
    max-height: min(88svh, 760px);
    padding-top: 0;
    border-top: 1px solid rgba(255,255,255,.14);
    border-left: 0;
    border-radius: 20px 20px 0 0;
    transform: translateY(calc(100% + 24px));
  }
  .serein-precipitation-editor[data-open="true"] {
    transform: translateY(0);
  }
}
@media (max-width: 760px), (max-height: 500px) {
  .serein-precipitation-details,
  .serein-precipitation-editor-actions {
    display: none;
  }
}
@media (prefers-reduced-motion: reduce) {
  .serein-precipitation-editor,
  .serein-precipitation-tool {
    transition: none;
  }
}
`;

const PARTICLE_VERTEX = `
uniform float uElapsed;
uniform float uPixelRatio;
uniform float uPhaseProgress;
attribute vec4 aSeed;
attribute float aRain;
attribute float aTop;
attribute float aSize;
attribute float aPhaseFrom;
attribute float aPhaseTo;
varying float vAlpha;
varying float vSnow;
varying float vAngle;
varying float vHighlight;
varying float vFogDepth;

void main() {
  float phaseProgress = smoothstep(0.0, 1.0, uPhaseProgress);
  float snow = mix(aPhaseFrom, aPhaseTo, phaseProgress);
  float strength = clamp(aRain / 10.0, 0.0, 2.0);
  float capacity = strength <= 0.0
    ? 0.0
    : min(1.0, 0.05 + pow(min(strength, 1.0), 0.62) * 0.95);
  float visibility = 1.0 - step(capacity, aSeed.w);
  float column = max(0.18, aTop - ${WATER_LEVEL.toFixed(2)});
  float rainSpeed = 1.45 + strength * 2.35 + aSeed.y * 0.7;
  float snowSpeed = rainSpeed * 0.25;
  float rainCycle = fract(aSeed.x - uElapsed * rainSpeed / (column + 0.7));
  float snowCycle = fract(aSeed.x - uElapsed * snowSpeed / (column + 0.7));
  float rainY = ${WATER_LEVEL.toFixed(2)} + rainCycle * column;
  float snowY = ${WATER_LEVEL.toFixed(2)} + snowCycle * column;

  vec3 transformed = position;
  transformed.y = mix(rainY, snowY, snow);
  float snowDrift = sin(uElapsed * (0.45 + aSeed.z * 0.65) + aSeed.x * 31.4)
    * (0.09 + aSeed.y * 0.12);
  snowDrift += sin(uElapsed * 0.19 + aSeed.z * 19.0) * 0.045;
  transformed.x += mix(
    sin(uElapsed * 0.55 + aSeed.z * 15.0) * 0.008,
    snowDrift,
    snow
  );
  transformed.z += mix(
    cos(uElapsed * 0.41 + aSeed.y * 11.0) * 0.006,
    cos(uElapsed * (0.28 + aSeed.y * 0.35) + aSeed.x * 17.0) * 0.08,
    snow
  );

  vec4 mvPosition = modelViewMatrix * vec4(transformed, 1.0);
  float depthScale = clamp(18.0 / max(5.0, -mvPosition.z), 0.72, 2.1);
  float rainSize = aSize * (1.2 + strength * 0.26);
  float snowSize = aSize * (3.7 + aSeed.z * 2.4);
  gl_PointSize = clamp(
    mix(rainSize, snowSize, snow) * uPixelRatio * depthScale,
    1.0 * uPixelRatio,
    11.0 * uPixelRatio
  );
  gl_Position = projectionMatrix * mvPosition;

  float heightRatio = clamp((transformed.y - ${WATER_LEVEL.toFixed(2)}) / column, 0.0, 1.0);
  float topFade = 1.0 - smoothstep(0.93, 1.0, heightRatio);
  float waterFade = smoothstep(0.0, 0.045, transformed.y - ${WATER_LEVEL.toFixed(2)});
  vAlpha = visibility
    * (0.08 + pow(min(strength, 1.0), 0.58) * 0.9)
    * topFade
    * waterFade
    * (0.52 + aSeed.y * 0.48);
  vSnow = snow;
  vAngle = aSeed.z * 6.2831853 + uElapsed * mix(0.35, 1.35, aSeed.y);
  vHighlight = aSeed.y;
  vFogDepth = -mvPosition.z;
}
`;

const PARTICLE_FRAGMENT = `
uniform float uElapsed;
varying float vAlpha;
varying float vSnow;
varying float vAngle;
varying float vHighlight;
varying float vFogDepth;

float lineDistance(vec2 p, vec2 direction) {
  return abs(p.x * direction.y - p.y * direction.x);
}

void main() {
  vec2 p = gl_PointCoord - vec2(0.5);

  vec2 rainPoint = vec2(p.x * 2.45, p.y * 0.78);
  float rainRadius = length(rainPoint);
  float rainShape = 1.0 - smoothstep(0.39, 0.5, rainRadius);
  float rainBody = exp(-dot(rainPoint, rainPoint) * 5.2);
  vec2 sheenPoint = rainPoint - vec2(-0.12, 0.18);
  float rainSheen = exp(-dot(sheenPoint, sheenPoint) * 36.0);

  float c = cos(vAngle);
  float s = sin(vAngle);
  vec2 snowPoint = mat2(c, -s, s, c) * p;
  float snowRadius = length(snowPoint);
  float armA = exp(-lineDistance(snowPoint, vec2(1.0, 0.0)) * 44.0);
  float armB = exp(-lineDistance(snowPoint, vec2(0.5, 0.8660254)) * 44.0);
  float armC = exp(-lineDistance(snowPoint, vec2(-0.5, 0.8660254)) * 44.0);
  float snowCore = exp(-snowRadius * snowRadius * 52.0);
  float snowShape = max(max(armA, armB), armC)
    * (1.0 - smoothstep(0.18, 0.5, snowRadius));
  float snowHalo = (1.0 - smoothstep(0.18, 0.48, snowRadius)) * 0.2;
  snowShape = max(max(snowShape * 0.96, snowCore), snowHalo);

  float shape = mix(rainShape, snowShape, vSnow);
  if (shape < 0.008 || vAlpha < 0.001) discard;

  float reflection = 0.5 + 0.5 * sin(
    rainPoint.y * 7.0 + rainPoint.x * 2.4 - uElapsed * 2.55
  );
  vec3 rainDark = vec3(0.055, 0.075, 0.1);
  vec3 rainMid = vec3(0.62, 0.7, 0.79);
  vec3 rainBright = vec3(0.98, 0.99, 1.0);
  vec3 rainColor = mix(rainDark, rainMid, smoothstep(0.28, 0.84, reflection));
  rainColor = mix(
    rainColor,
    rainBright,
    clamp(rainSheen * (0.42 + vHighlight * 0.48) + rainBody * 0.18, 0.0, 1.0)
  );
  vec3 snowColor = mix(
    vec3(0.53, 0.69, 0.86),
    vec3(0.91, 0.97, 1.0),
    snowCore + vHighlight * 0.28
  );
  vec3 color = mix(rainColor, snowColor, vSnow);
  float fog = 1.0 - exp(-0.00052 * vFogDepth * vFogDepth);
  color = mix(color, vec3(0.0), fog * 0.45);
  float alpha = shape * vAlpha * mix(1.05 + rainBody * 0.2, 1.18, vSnow)
    * (1.0 - fog * 0.3);
  gl_FragColor = vec4(color, min(alpha, 0.94));
}
`;

const WATERFALL_VERTEX = `
uniform float uElapsed;
uniform float uPhaseProgress;
attribute vec3 aAnchor;
attribute vec2 aDimensions;
attribute float aSeed;
attribute float aStorm;
attribute float aPhaseFrom;
attribute float aPhaseTo;
varying vec2 vUv;
varying float vAlpha;
varying float vSeed;
varying float vFogDepth;

void main() {
  float snow = mix(
    aPhaseFrom,
    aPhaseTo,
    smoothstep(0.0, 1.0, uPhaseProgress)
  );
  vec3 transformed = aAnchor;
  transformed.x += position.x * aDimensions.x;
  transformed.y += position.y * aDimensions.y;
  transformed.x += sin(
    position.y * 13.0 + aSeed * 17.0 - uElapsed * 1.9
  ) * 0.025 * aStorm;
  transformed.z += sin(position.y * 7.0 + aSeed * 9.0) * 0.018;
  vec4 mvPosition = modelViewMatrix * vec4(transformed, 1.0);
  gl_Position = projectionMatrix * mvPosition;
  vUv = uv;
  vAlpha = aStorm * (1.0 - snow);
  vSeed = aSeed;
  vFogDepth = -mvPosition.z;
}
`;

const WATERFALL_FRAGMENT = `
uniform float uElapsed;
varying vec2 vUv;
varying float vAlpha;
varying float vSeed;
varying float vFogDepth;

float hash(float n) { return fract(sin(n) * 43758.5453123); }

void main() {
  float center = abs(vUv.x - 0.5) * 2.0;
  float ragged = hash(floor(vUv.y * 19.0 - uElapsed * 7.0) + vSeed * 31.0);
  float core = 1.0 - smoothstep(0.08, 0.72 + ragged * 0.18, center);
  float breaks = smoothstep(
    0.25,
    0.66,
    0.5 + 0.5 * sin(vUv.y * (19.0 + vSeed * 13.0) + vSeed * 17.0 - uElapsed * 5.0)
  );
  float ends = smoothstep(0.0, 0.08, vUv.y)
    * (1.0 - smoothstep(0.82, 1.0, vUv.y));
  float alpha = core * mix(0.28, 1.0, breaks) * ends * vAlpha * 0.54;
  float fog = 1.0 - exp(-0.0005 * vFogDepth * vFogDepth);
  vec3 color = mix(
    vec3(0.03, 0.05, 0.08),
    vec3(0.85, 0.91, 0.98),
    breaks * 0.74 + core * 0.16
  );
  color = mix(color, vec3(0.0), fog * 0.48);
  if (alpha < 0.002) discard;
  gl_FragColor = vec4(color, alpha * (1.0 - fog * 0.35));
}
`;

const WATERFALL_BODY_VERTEX = `
uniform float uElapsed;
attribute vec2 aLocal;
attribute float aStorm;
attribute float aLiquid;
varying vec2 vLocal;
varying float vStorm;
varying float vLiquid;
varying vec3 vWorld;

void main() {
  vec3 transformed = position;
  transformed.x += sin(position.y * 2.8 - uElapsed * 1.3 + position.x) * 0.035 * aStorm;
  vec4 worldPosition = modelMatrix * vec4(transformed, 1.0);
  vLocal = aLocal;
  vStorm = aStorm;
  vLiquid = aLiquid;
  vWorld = worldPosition.xyz;
  gl_Position = projectionMatrix * viewMatrix * worldPosition;
}
`;

const WATERFALL_BODY_FRAGMENT = `
uniform float uElapsed;
varying vec2 vLocal;
varying float vStorm;
varying float vLiquid;
varying vec3 vWorld;

float hash(vec2 p) {
  return fract(sin(dot(p, vec2(41.21, 289.7))) * 43758.5453);
}

void main() {
  float edge = smoothstep(0.0, 0.09, vLocal.x)
    * smoothstep(0.0, 0.09, 1.0 - vLocal.x);
  float bottom = smoothstep(0.0, 0.06, vLocal.y);
  float top = 1.0 - smoothstep(0.58, 1.0, vLocal.y);
  float broad = 0.5 + 0.5 * sin(vWorld.x * 5.4 - vLocal.y * 2.1 + uElapsed * 1.1);
  float fine = pow(
    0.5 + 0.5 * sin(vWorld.x * 29.0 + hash(floor(vWorld.xy * 4.0)) * 5.0),
    4.0
  );
  float volume = (0.32 + (1.0 - vLocal.y) * 0.72)
    * mix(0.2, 1.0, broad * 0.58 + fine * 0.42);
  float alpha = volume * edge * bottom * top * vStorm * vLiquid * 0.28;
  vec3 color = mix(vec3(0.0), vec3(0.76, 0.84, 0.92), broad * 0.72 + fine * 0.36);
  if (alpha < 0.002) discard;
  gl_FragColor = vec4(color, alpha);
}
`;

const WATER_VERTEX = `
uniform float uElapsed;
attribute float aRain;
varying vec2 vUv;
varying vec3 vWorld;
varying float vRain;
varying float vWave;

void main() {
  vec3 transformed = position;
  float wave = sin(uElapsed * 1.2 + position.x * 0.55 + position.z * 0.34) * 0.012;
  wave += sin(-uElapsed * 0.86 + position.x * 0.18 - position.z * 0.9) * 0.006;
  transformed.y += wave;
  vec4 world = modelMatrix * vec4(transformed, 1.0);
  vUv = uv;
  vWorld = world.xyz;
  vRain = aRain;
  vWave = wave;
  gl_Position = projectionMatrix * viewMatrix * world;
}
`;

const WATER_FRAGMENT = `
uniform float uElapsed;
varying vec2 vUv;
varying vec3 vWorld;
varying float vRain;
varying float vWave;

void main() {
  vec3 viewDirection = normalize(cameraPosition - vWorld);
  float fresnel = pow(1.0 - max(viewDirection.y, 0.0), 3.2);
  float shimmer = 0.5 + 0.5 * sin(
    vWorld.x * 2.2 + vWorld.z * 4.1 - uElapsed * 1.3 + vWave * 90.0
  );
  float reflection = pow(clamp(vRain / 10.0, 0.0, 1.4), 1.15)
    * (0.35 + shimmer * 0.65)
    * exp(-pow((vWorld.z - 0.8) * 0.32, 2.0));
  vec3 color = mix(vec3(0.008, 0.014, 0.024), vec3(0.12, 0.19, 0.28), fresnel * 0.55);
  color += vec3(0.38, 0.52, 0.67) * reflection * 0.22;
  float side = smoothstep(0.0, 0.13, vUv.x)
    * smoothstep(0.0, 0.13, 1.0 - vUv.x);
  float front = smoothstep(0.0, 0.1, vUv.y);
  float back = smoothstep(0.0, 0.18, 1.0 - vUv.y);
  float alpha = (0.17 + fresnel * 0.22 + reflection * 0.08) * side * front * back;
  if (alpha < 0.002) discard;
  gl_FragColor = vec4(color, alpha);
}
`;

const MIST_VERTEX = `
attribute float aRain;
varying vec2 vUv;
varying float vRain;
void main() {
  vUv = uv;
  vRain = aRain;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const MIST_FRAGMENT = `
uniform float uElapsed;
varying vec2 vUv;
varying float vRain;
float hash(vec2 p) {
  return fract(sin(dot(p, vec2(41.21, 289.7))) * 43758.5453);
}
void main() {
  float strength = pow(clamp(vRain / 10.0, 0.0, 1.4), 0.7);
  float core = exp(-pow((vUv.y - 0.15) * 7.2, 2.0));
  float haze = exp(-pow((vUv.y - 0.24) * 2.6, 2.0)) * 0.42;
  float lowerCut = smoothstep(0.045, 0.14, vUv.y);
  float drift = 0.86 + 0.14 * sin(uElapsed * 0.5 + vUv.x * 7.3);
  float grain = 0.9 + 0.1 * hash(floor(vUv * vec2(120.0, 92.0)) + floor(uElapsed * 1.3));
  float side = smoothstep(0.0, 0.06, vUv.x)
    * smoothstep(0.0, 0.06, 1.0 - vUv.x);
  float alpha = strength * (core + haze) * lowerCut * drift * grain * side * 0.24;
  if (alpha < 0.002) discard;
  gl_FragColor = vec4(vec3(0.56, 0.66, 0.76) * (0.7 + strength * 0.35), alpha);
}
`;

const RIPPLE_VERTEX = `
uniform float uElapsed;
attribute vec3 aCenter;
attribute float aStart;
attribute float aStrength;
attribute float aSeed;
varying float vAge;
varying float vStrength;
varying vec2 vUv;

void main() {
  float age = uElapsed - aStart;
  float scale = max(0.001, age) * (0.62 + aStrength * 0.52);
  vec3 transformed = vec3(
    aCenter.x + position.x * scale,
    ${WATER_LEVEL.toFixed(2)} + 0.018 + sin(aSeed * 17.0 + age * 3.0) * 0.002,
    aCenter.z + position.y * scale
  );
  vAge = age;
  vStrength = aStrength;
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(transformed, 1.0);
}
`;

const RIPPLE_FRAGMENT = `
varying float vAge;
varying float vStrength;
varying vec2 vUv;
void main() {
  float lifetime = step(0.0, vAge) * (1.0 - smoothstep(1.25, 2.4, vAge));
  float edge = sin(vUv.y * 3.14159265);
  float alpha = lifetime * edge * exp(-max(vAge, 0.0) * 0.9) * vStrength * 0.48;
  if (alpha < 0.002) discard;
  gl_FragColor = vec4(vec3(0.58, 0.74, 0.9), alpha);
}
`;

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function clamp01(value: number): number {
  return clamp(value, 0, 1);
}

function lerp(from: number, to: number, amount: number): number {
  return from + (to - from) * amount;
}

function smoothstep(edge0: number, edge1: number, value: number): number {
  const amount = clamp01((value - edge0) / Math.max(0.000001, edge1 - edge0));
  return amount * amount * (3 - 2 * amount);
}

function hourToX(hour: number): number {
  return lerp(X_MIN, X_MAX, clamp(hour, 0, 24) / 24);
}

function xToHour(x: number): number {
  return clamp(((x - X_MIN) / PLOT_WIDTH) * 24, 0, 24);
}

function createSeededRandom(seed: number): () => number {
  let value = seed >>> 0;
  return () => {
    value += 0x6d2b79f5;
    let result = value;
    result = Math.imul(result ^ (result >>> 15), result | 1);
    result ^= result + Math.imul(result ^ (result >>> 7), result | 61);
    return ((result ^ (result >>> 14)) >>> 0) / 4294967296;
  };
}

function normalizeSeries(
  values: readonly number[] | undefined,
  fallbackValue: number,
  minimum: number,
  maximum: number,
): Float32Array {
  const result = new Float32Array(HOURS);
  let fallback = fallbackValue;
  for (let index = 0; index < HOURS; index += 1) {
    const candidate = values?.[index];
    if (Number.isFinite(candidate)) fallback = Number(candidate);
    result[index] = clamp(fallback, minimum, maximum);
  }
  return result;
}

function sampleSeries(values: ArrayLike<number>, hour: number): number {
  const safeHour = clamp(hour, 0, 24);
  const left = Math.min(23, Math.floor(safeHour));
  const amount = safeHour - left;
  return lerp(values[left], values[left + 1], amount);
}

function niceAxisCeiling(value: number): number {
  if (!Number.isFinite(value) || value <= BASE_AXIS_MAX) return BASE_AXIS_MAX;
  const exponent = Math.floor(Math.log10(value));
  const scale = 10 ** exponent;
  const fraction = value / scale;
  const niceFraction = fraction <= 1 ? 1 : fraction <= 2 ? 2 : fraction <= 5 ? 5 : 10;
  return niceFraction * scale;
}

function formatTick(value: number): string {
  if (value >= 1_000) return value.toLocaleString('zh-CN', { maximumFractionDigits: 1 });
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}

/** Snow probability: rain at >=2°C, snow at <=0°C, linear mixture between. */
function snowFraction(temperature: number): number {
  return clamp01((2 - temperature) / 2);
}

function phaseName(temperature: number): string {
  if (temperature <= 0) return '雪';
  if (temperature >= 2) return '雨';
  return '雨夹雪';
}

export class PrecipitationLayer implements WeatherLayer {
  readonly id = 'precipitation';
  readonly name = '降水';
  readonly preferredSkyDim = 0.85;

  private container: HTMLElement | null = null;
  private root: HTMLElement | null = null;
  private headerReadout: HTMLElement | null = null;
  private phaseReadout: HTMLElement | null = null;
  private soundButton: HTMLButtonElement | null = null;
  private editor: HTMLElement | null = null;
  private chart: SVGSVGElement | null = null;
  private chartLine: SVGPolylineElement | null = null;
  private chartArea: SVGPathElement | null = null;
  private chartGrid: SVGGElement | null = null;
  private chartPoints: SVGGElement[] = [];
  private editorInputs: HTMLInputElement[] = [];
  private chartTime: HTMLElement | null = null;
  private chartValue: HTMLElement | null = null;
  private chartSelectedHour = 0;
  private chartDragPointer: number | null = null;
  private chartDragHour = -1;

  private renderer: THREE.WebGLRenderer | null = null;
  private scene: THREE.Scene | null = null;
  private camera: THREE.PerspectiveCamera | null = null;
  private controls: OrbitControls | null = null;
  private world: THREE.Group | null = null;
  private axisGroup: THREE.Group | null = null;
  private currentMarker: THREE.Line | null = null;
  private currentBead: THREE.Mesh<THREE.SphereGeometry, THREE.MeshBasicMaterial> | null = null;
  private curveLine: THREE.Line<THREE.BufferGeometry, THREE.LineBasicMaterial> | null = null;
  private water: THREE.Mesh<THREE.BufferGeometry, THREE.ShaderMaterial> | null = null;
  private mist: THREE.Mesh<THREE.BufferGeometry, THREE.ShaderMaterial> | null = null;
  private particles: ParticleState | null = null;
  private waterfall: WaterfallState | null = null;
  private ripples: RippleState | null = null;

  private data: DayData | null = null;
  private quality: Quality = 'high';
  private hasExternalData = false;
  private precipitationTarget = Float32Array.from(DEFAULT_RAINFALL);
  private precipitationVisual = Float32Array.from(DEFAULT_RAINFALL);
  private baselinePrecipitation = Float32Array.from(DEFAULT_RAINFALL);
  private temperatures = new Float32Array(HOURS).fill(10);
  private temperatureSnapshot = new Float32Array(HOURS).fill(10);
  private phaseFractionFrom = new Float32Array(HOURS);
  private phaseFractionTo = new Float32Array(HOURS);
  private phaseTransitionStart = -PHASE_TRANSITION_SECONDS;
  private phaseProgress = 1;
  private axisMax = BASE_AXIS_MAX;
  private timeMinutes = 480;

  private abortController: AbortController | null = null;
  private resizeObserver: ResizeObserver | null = null;
  private raf = 0;
  private lastTimestamp = 0;
  private elapsed = 0;
  private rainDirty = true;
  private phaseBodyDirty = true;
  private rippleAccumulator = 0;
  private curveDrag: CurveDrag | null = null;
  private raycaster = new THREE.Raycaster();
  private pointer = new THREE.Vector2();
  private pointerPlane = new THREE.Plane(new THREE.Vector3(0, 0, 1), -CURVE_Z);
  private pointerWorld = new THREE.Vector3();
  private waterPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), -WATER_LEVEL);
  private audio: AudioGraph | null = null;
  private soundEnabled = true;
  private audioGeneration = 0;
  private unsubscribeReducedMotion: (() => void) | null = null;

  mount(container: HTMLElement): void {
    if (this.root) return;

    this.container = container;
    this.abortController = new AbortController();
    this.createDom();
    this.updatePhaseDatasets();
    this.attachDomEvents();

    try {
      this.createRenderer();
      this.createScene();
      this.resizeObserver = new ResizeObserver(this.resize);
      this.resizeObserver.observe(container);
      document.addEventListener('visibilitychange', this.onVisibility, {
        signal: this.abortController.signal,
      });
      window.addEventListener('resize', this.resize, {
        passive: true,
        signal: this.abortController.signal,
      });
      window.visualViewport?.addEventListener('resize', this.resize, {
        passive: true,
        signal: this.abortController.signal,
      });
      this.unsubscribeReducedMotion = subscribeReducedMotion(() => {
        if (this.renderer && this.world) this.rebuildQualityResources();
      });
      this.resize();
      this.updateAllRainGeometry();
      this.updateCurrentVisuals();
      this.start();
    } catch (error) {
      console.warn('[PrecipitationLayer] WebGL 不可用，仅保留数据编辑界面', error);
      this.renderer?.dispose();
      this.renderer?.domElement.remove();
      this.renderer = null;
      const fallback = document.createElement('p');
      fallback.className = 'serein-precipitation-fallback';
      fallback.textContent = 'WebGL 不可用';
      (this.root as HTMLElement | null)?.appendChild(fallback);
    }
  }

  unmount(): void {
    this.stop();
    this.audioGeneration += 1;
    this.closeAudio();
    this.releaseCurveDrag();
    this.abortController?.abort();
    this.abortController = null;
    this.unsubscribeReducedMotion?.();
    this.unsubscribeReducedMotion = null;
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    this.controls?.dispose();
    this.controls = null;

    if (this.scene) this.disposeObject3D(this.scene);
    this.renderer?.renderLists.dispose();
    this.renderer?.dispose();
    this.renderer?.forceContextLoss();
    this.renderer?.domElement.remove();

    this.renderer = null;
    this.scene = null;
    this.camera = null;
    this.world = null;
    this.axisGroup = null;
    this.currentMarker = null;
    this.currentBead = null;
    this.curveLine = null;
    this.water = null;
    this.mist = null;
    this.particles = null;
    this.waterfall = null;
    this.ripples = null;

    this.root?.remove();
    this.root = null;
    this.container = null;
    this.headerReadout = null;
    this.phaseReadout = null;
    this.soundButton = null;
    this.editor = null;
    this.chart = null;
    this.chartLine = null;
    this.chartArea = null;
    this.chartGrid = null;
    this.chartPoints = [];
    this.editorInputs = [];
    this.chartTime = null;
    this.chartValue = null;
    this.chartDragPointer = null;
    this.chartDragHour = -1;
  }

  setTime(minutes: number): void {
    this.timeMinutes = clamp(Number.isFinite(minutes) ? minutes : 0, 0, DAY_MINUTES);
    this.updateCurrentVisuals();
    this.updateAudioGain();
  }

  setData(data: DayData): void {
    const nextRain = normalizeSeries(data.precipitation, 0, 0, 10_000);
    const nextTemperatures = normalizeSeries(data.temperature, 10, -100, 100);
    const hadData = this.hasExternalData;

    this.data = data;
    this.baselinePrecipitation.set(nextRain);
    this.precipitationTarget.set(nextRain);
    if (!hadData || !this.renderer) this.precipitationVisual.set(nextRain);

    if (hadData) {
      this.beginPhaseTransition(nextTemperatures);
    } else {
      this.temperatures.set(nextTemperatures);
      for (let index = 0; index < HOURS; index += 1) {
        const fraction = snowFraction(nextTemperatures[index]);
        this.phaseFractionFrom[index] = fraction;
        this.phaseFractionTo[index] = fraction;
      }
      this.phaseProgress = 1;
      this.applyPhaseImmediately(nextTemperatures);
      this.updatePhaseDatasets(nextTemperatures);
      if (this.world) this.rebuildAxis();
    }

    this.temperatureSnapshot.set(nextTemperatures);
    this.temperatures.set(nextTemperatures);
    this.hasExternalData = true;
    this.recalculateAxis();
    this.rainDirty = true;
    this.phaseBodyDirty = true;
    this.syncEditorFromData();
    this.updateAllRainGeometry();
    this.updateCurrentVisuals();
    this.updateAudioGain();
  }

  setQuality(quality: Quality): void {
    if (quality === this.quality) return;
    this.quality = quality;
    if (!this.renderer || !this.world) return;

    this.resize();
    this.rebuildQualityResources();
    this.updateAllRainGeometry();
  }

  private createDom(): void {
    const root = document.createElement('section');
    root.className = 'serein-precipitation-layer';
    root.setAttribute('aria-label', '逐时降水粒子雨幕');
    root.innerHTML = `
      <style>${LAYER_CSS}</style>
      <header class="serein-precipitation-header">
        <div class="serein-precipitation-heading">
          <h2>降雨强度</h2>
          <p>逐时降水 · mm/h</p>
        </div>
        <div class="serein-precipitation-current">
          <output class="serein-precipitation-readout" aria-label="当前时刻降水"></output>
          <span class="serein-precipitation-phase"></span>
        </div>
      </header>
      <nav class="serein-precipitation-toolbar" aria-label="降水图表工具">
        <button class="serein-precipitation-tool" type="button" data-action="edit"
          aria-label="编辑降水数据" aria-expanded="false">
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <polyline points="3.5,17.5 8.2,12 12.3,15.1 17.7,6.9 20.5,9.1"></polyline>
            <circle cx="3.5" cy="17.5" r="1.2"></circle>
            <circle cx="8.2" cy="12" r="1.2"></circle>
            <circle cx="12.3" cy="15.1" r="1.2"></circle>
            <circle cx="17.7" cy="6.9" r="1.2"></circle>
          </svg>
        </button>
        <button class="serein-precipitation-tool" type="button" data-action="sound"
          aria-label="关闭雨声" aria-pressed="true">
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M4.5 9.2h3.1l4-3.4v12.4l-4-3.4H4.5z"></path>
            <path d="M15 9.2c1.5 1.5 1.5 4.1 0 5.6"></path>
            <path d="M17.8 6.6c3 3 3 7.8 0 10.8"></path>
          </svg>
        </button>
      </nav>
      <aside class="serein-precipitation-editor" data-open="false" aria-hidden="true"
        aria-label="编辑降水数据" inert>
        <header class="serein-precipitation-editor-header">
          <div>
            <p class="serein-precipitation-editor-eyebrow">00:00–24:00</p>
            <h3>编辑降水数据</h3>
            <p class="serein-precipitation-editor-description">
              拖动折线节点即可实时重塑雨幕；也可以展开逐时输入进行精确编辑。
            </p>
          </div>
          <button class="serein-precipitation-editor-close" type="button"
            data-action="close" aria-label="关闭">×</button>
        </header>
        <div class="serein-precipitation-editor-scroll">
          <div class="serein-precipitation-editor-section">
            <h4>逐时降雨曲线</h4><span>实时保存</span>
          </div>
          <section class="serein-precipitation-chart-card" aria-label="可拖拽降水折线图">
            <div class="serein-precipitation-chart-readout">
              <span data-chart-time>08:00</span>
              <strong data-chart-value>0.0</strong>
              <span>mm/h</span>
            </div>
            <svg class="serein-precipitation-chart" viewBox="0 0 720 280"
              role="group" aria-label="00:00 至 24:00 降水量折线"></svg>
            <div class="serein-precipitation-chart-hours" aria-hidden="true">
              <span>00</span><span>06</span><span>12</span><span>18</span><span>24</span>
            </div>
            <p class="serein-precipitation-chart-hint">
              上下拖动节点调整雨量 · 方向键微调 · Shift + 方向键快速调整
            </p>
          </section>
          <details class="serein-precipitation-details">
            <summary>精确输入 25 个时间点 · mm/h</summary>
            <div class="serein-precipitation-input-grid"></div>
          </details>
        </div>
        <footer class="serein-precipitation-editor-actions">
          <button class="serein-precipitation-restore" type="button"
            data-action="restore">恢复初始数据</button>
        </footer>
      </aside>
    `;

    this.container?.appendChild(root);
    this.root = root;
    this.headerReadout = root.querySelector('.serein-precipitation-readout');
    this.phaseReadout = root.querySelector('.serein-precipitation-phase');
    this.soundButton = root.querySelector('[data-action="sound"]');
    this.editor = root.querySelector('.serein-precipitation-editor');
    this.chart = root.querySelector('.serein-precipitation-chart');
    this.chartTime = root.querySelector('[data-chart-time]');
    this.chartValue = root.querySelector('[data-chart-value]');
    this.createEditorChart();
    this.createEditorInputs();
    this.syncSoundButton();
  }

  private createEditorChart(): void {
    const chart = this.chart;
    if (!chart) return;
    const svgNamespace = 'http://www.w3.org/2000/svg';
    const make = <K extends keyof SVGElementTagNameMap>(
      tag: K,
      attributes: Record<string, string | number> = {},
    ): SVGElementTagNameMap[K] => {
      const element = document.createElementNS(svgNamespace, tag);
      for (const [key, value] of Object.entries(attributes)) {
        element.setAttribute(key, String(value));
      }
      return element;
    };

    const definitions = make('defs');
    const gradient = make('linearGradient', {
      id: 'serein-precipitation-area-gradient',
      x1: 0,
      y1: 0,
      x2: 0,
      y2: 1,
    });
    gradient.append(
      make('stop', { offset: '0%', 'stop-color': '#c2cbdb', 'stop-opacity': 0.28 }),
      make('stop', { offset: '100%', 'stop-color': '#687a96', 'stop-opacity': 0.015 }),
    );
    definitions.appendChild(gradient);
    this.chartGrid = make('g');
    this.chartArea = make('path', { class: 'serein-precipitation-chart-area' });
    this.chartLine = make('polyline', { class: 'serein-precipitation-chart-line' });
    const pointLayer = make('g');

    for (let hour = 0; hour < HOURS; hour += 1) {
      const point = make('g', {
        class: 'serein-precipitation-chart-point',
        'data-hour': hour,
        tabindex: 0,
        role: 'slider',
        'aria-orientation': 'vertical',
        'aria-valuemin': 0,
      });
      point.append(
        make('circle', { r: 13 }),
        make('circle', { r: 4.2 }),
        make('circle', { r: 14 }),
      );
      pointLayer.appendChild(point);
      this.chartPoints.push(point);
    }

    chart.append(definitions, this.chartGrid, this.chartArea, this.chartLine, pointLayer);
  }

  private createEditorInputs(): void {
    const grid = this.root?.querySelector('.serein-precipitation-input-grid');
    if (!grid) return;
    for (let hour = 0; hour < HOURS; hour += 1) {
      const label = document.createElement('label');
      const caption = document.createElement('span');
      caption.textContent = `${String(hour).padStart(2, '0')}:00`;
      const input = document.createElement('input');
      input.type = 'number';
      input.min = '0';
      input.step = '0.1';
      input.inputMode = 'decimal';
      input.dataset.hour = String(hour);
      input.setAttribute('aria-label', `${caption.textContent} 降水量，毫米每小时`);
      label.append(caption, input);
      grid.appendChild(label);
      this.editorInputs.push(input);
    }
  }

  private attachDomEvents(): void {
    const root = this.root;
    const signal = this.abortController?.signal;
    if (!root || !signal) return;

    root.querySelector('[data-action="edit"]')?.addEventListener(
      'click',
      () => this.setEditorOpen(true),
      { signal },
    );
    root.querySelector('[data-action="close"]')?.addEventListener(
      'click',
      () => this.setEditorOpen(false),
      { signal },
    );
    root.querySelector('[data-action="restore"]')?.addEventListener(
      'click',
      () => {
        this.precipitationTarget.set(this.baselinePrecipitation);
        this.commitPrecipitationToData();
        this.onPrecipitationEdited();
      },
      { signal },
    );
    this.soundButton?.addEventListener('click', this.onSoundToggle, { signal });
    root.addEventListener('pointerdown', this.onFirstAudioGesture, {
      capture: true,
      signal,
    });
    document.addEventListener('pointerdown', this.onDocumentPointerDown, {
      capture: true,
      signal,
    });

    const chart = this.chart;
    chart?.addEventListener('pointerdown', this.onChartPointerDown, { signal });
    chart?.addEventListener('pointermove', this.onChartPointerMove, { signal });
    chart?.addEventListener('pointerup', this.onChartPointerUp, { signal });
    chart?.addEventListener('pointercancel', this.onChartPointerUp, { signal });
    chart?.addEventListener('focusin', this.onChartFocus, { signal });
    chart?.addEventListener('keydown', this.onChartKeyDown, { signal });

    for (const input of this.editorInputs) {
      input.addEventListener(
        'input',
        () => {
          const hour = Number(input.dataset.hour);
          const value = Number(input.value);
          if (Number.isFinite(value) && value >= 0) {
            this.setPrecipitationPoint(hour, value);
          }
        },
        { signal },
      );
      input.addEventListener(
        'change',
        () => {
          const hour = Number(input.dataset.hour);
          const value = Number(input.value);
          if (!Number.isFinite(value) || value < 0) {
            input.value = this.precipitationTarget[hour].toFixed(1);
            return;
          }
          this.setPrecipitationPoint(hour, value);
        },
        { signal },
      );
    }
  }

  private createRenderer(): void {
    const root = this.root;
    if (!root) throw new Error('Layer root is unavailable');

    const renderer = new THREE.WebGLRenderer({
      alpha: true,
      antialias: true,
      premultipliedAlpha: false,
      preserveDrawingBuffer: false,
      powerPreference: 'high-performance',
    });
    renderer.setClearColor(0x000000, 0);
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.domElement.className = 'serein-precipitation-canvas';
    renderer.domElement.setAttribute('aria-label', '可交互的逐时降水粒子图');
    renderer.domElement.setAttribute('data-curve-hover', 'false');
    renderer.domElement.setAttribute('data-curve-dragging', 'false');
    root.prepend(renderer.domElement);
    this.renderer = renderer;

    const signal = this.abortController?.signal;
    if (!signal) return;
    renderer.domElement.addEventListener('webglcontextlost', this.onContextLost, {
      signal,
    });
    renderer.domElement.addEventListener('webglcontextrestored', this.onContextRestored, {
      signal,
    });
    renderer.domElement.addEventListener('pointerdown', this.onCanvasPointerDown, {
      capture: true,
      signal,
    });
    renderer.domElement.addEventListener('pointermove', this.onCanvasPointerMove, {
      capture: true,
      signal,
    });
    renderer.domElement.addEventListener('pointerup', this.onCanvasPointerUp, {
      capture: true,
      signal,
    });
    renderer.domElement.addEventListener('pointercancel', this.onCanvasPointerUp, {
      capture: true,
      signal,
    });
    renderer.domElement.addEventListener('click', this.onCanvasClick, { signal });
    renderer.domElement.addEventListener('dblclick', this.resetView, { signal });
  }

  private createScene(): void {
    const renderer = this.renderer;
    if (!renderer) return;

    const scene = new THREE.Scene();
    scene.fog = new THREE.FogExp2(0x000000, 0.021);
    this.scene = scene;

    const camera = new THREE.PerspectiveCamera(35, 1, 0.1, 100);
    camera.up.set(0, 1, 0);
    this.camera = camera;

    const world = new THREE.Group();
    world.name = 'serein-precipitation-world';
    scene.add(world);
    this.world = world;

    this.createWater();
    this.createMist();
    this.createCurve();
    this.rebuildAxis();
    this.createParticles();
    this.createWaterfall();
    this.createRipples();

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.075;
    controls.enablePan = false;
    controls.enableZoom = true;
    controls.rotateSpeed = 0.55;
    controls.zoomSpeed = 0.8;
    controls.minDistance = 12;
    controls.maxDistance = 34;
    controls.minPolarAngle = THREE.MathUtils.degToRad(69);
    controls.maxPolarAngle = THREE.MathUtils.degToRad(88);
    controls.minAzimuthAngle = -THREE.MathUtils.degToRad(27);
    controls.maxAzimuthAngle = THREE.MathUtils.degToRad(27);
    this.controls = controls;
    this.applyCameraPreset();
  }

  private createParticles(): void {
    const world = this.world;
    if (!world) return;

    const count = particleBudget(PARTICLE_COUNT[this.quality]);
    const random = createSeededRandom(RAIN_SEED);
    const positions = new Float32Array(count * 3);
    const seeds = new Float32Array(count * 4);
    const hours = new Float32Array(count);
    const phaseSeed = new Float32Array(count);
    const phaseFrom = new Float32Array(count);
    const phaseTo = new Float32Array(count);
    const rain = new Float32Array(count);
    const top = new Float32Array(count);
    const sizes = new Float32Array(count);

    for (let index = 0; index < count; index += 1) {
      const positionIndex = index * 3;
      const seedIndex = index * 4;
      const hour = clamp(((index + random()) / count) * 24, 0.001, 23.999);
      const seedX = random();
      const seedY = random();
      const seedZ = random();
      const seedW = random();
      const phasePick = random();
      const near = Math.pow(random(), 0.72);
      const targetSnow = phasePick < snowFraction(sampleSeries(this.temperatures, hour)) ? 1 : 0;

      hours[index] = hour;
      phaseSeed[index] = phasePick;
      phaseFrom[index] = targetSnow;
      phaseTo[index] = targetSnow;
      positions[positionIndex] = hourToX(hour) + (random() - 0.5) * 0.24;
      positions[positionIndex + 1] = 0;
      positions[positionIndex + 2] = lerp(-0.72, 0.98, near) + (random() - 0.5) * 0.16;
      seeds[seedIndex] = seedX;
      seeds[seedIndex + 1] = seedY;
      seeds[seedIndex + 2] = seedZ;
      seeds[seedIndex + 3] = seedW;
      sizes[index] = 0.86 + near * 1.08 + random() * 0.38;
    }

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute('aSeed', new THREE.BufferAttribute(seeds, 4));
    geometry.setAttribute(
      'aRain',
      new THREE.BufferAttribute(rain, 1).setUsage(THREE.DynamicDrawUsage),
    );
    geometry.setAttribute(
      'aTop',
      new THREE.BufferAttribute(top, 1).setUsage(THREE.DynamicDrawUsage),
    );
    geometry.setAttribute('aSize', new THREE.BufferAttribute(sizes, 1));
    geometry.setAttribute(
      'aPhaseFrom',
      new THREE.BufferAttribute(phaseFrom, 1).setUsage(THREE.DynamicDrawUsage),
    );
    geometry.setAttribute(
      'aPhaseTo',
      new THREE.BufferAttribute(phaseTo, 1).setUsage(THREE.DynamicDrawUsage),
    );

    const material = new THREE.ShaderMaterial({
      uniforms: {
        uElapsed: { value: this.elapsed },
        uPixelRatio: { value: this.renderer?.getPixelRatio() ?? 1 },
        uPhaseProgress: { value: this.phaseProgress },
      },
      vertexShader: PARTICLE_VERTEX,
      fragmentShader: PARTICLE_FRAGMENT,
      transparent: true,
      depthWrite: false,
      depthTest: true,
      blending: THREE.AdditiveBlending,
    });
    const points = new THREE.Points(geometry, material);
    points.name = 'rain-snow-particles';
    points.frustumCulled = false;
    points.renderOrder = 3;
    world.add(points);

    this.particles = {
      points,
      hours,
      phaseSeed,
      phaseFrom,
      phaseTo,
      rain,
      top,
    };
    this.root?.setAttribute('data-particle-count', String(count));
    this.root?.setAttribute('data-quality', this.quality);
    this.updateParticleRainAttributes();
  }

  private createWaterfall(): void {
    const world = this.world;
    if (!world) return;

    const group = new THREE.Group();
    group.name = 'peak-waterfall';

    const body = this.createWaterfallBody();
    group.add(body);

    const count = particleBudget(WATERFALL_COUNT[this.quality]);
    const base = new THREE.PlaneGeometry(1, 1, 1, 12);
    base.translate(0, 0.5, 0);
    const geometry = new THREE.InstancedBufferGeometry();
    geometry.index = base.index;
    geometry.setAttribute('position', base.getAttribute('position'));
    geometry.setAttribute('uv', base.getAttribute('uv'));
    base.dispose();

    const anchors = new Float32Array(count * 3);
    const dimensions = new Float32Array(count * 2);
    const seeds = new Float32Array(count);
    const storms = new Float32Array(count);
    const hours = new Float32Array(count);
    const phaseSeed = new Float32Array(count);
    const phaseFrom = new Float32Array(count);
    const phaseTo = new Float32Array(count);
    const heights = new Float32Array(count);
    const random = createSeededRandom(RAIN_SEED ^ 0x31c7af59);

    for (let index = 0; index < count; index += 1) {
      const hour = clamp(((index + random()) / count) * 24, 0.001, 23.999);
      const seed = random();
      const phasePick = random();
      const anchorIndex = index * 3;
      const dimensionIndex = index * 2;
      const targetSnow = phasePick < snowFraction(sampleSeries(this.temperatures, hour)) ? 1 : 0;
      hours[index] = hour;
      phaseSeed[index] = phasePick;
      phaseFrom[index] = targetSnow;
      phaseTo[index] = targetSnow;
      seeds[index] = seed;
      anchors[anchorIndex] = hourToX(hour) + (random() - 0.5) * 0.16;
      anchors[anchorIndex + 1] = WATER_LEVEL;
      anchors[anchorIndex + 2] = -0.42 + random() * 1.08;
      dimensions[dimensionIndex] = 0.018 + random() * 0.065;
      dimensions[dimensionIndex + 1] = 1;
    }

    geometry.setAttribute('aAnchor', new THREE.InstancedBufferAttribute(anchors, 3));
    geometry.setAttribute('aDimensions', new THREE.InstancedBufferAttribute(dimensions, 2));
    geometry.setAttribute('aSeed', new THREE.InstancedBufferAttribute(seeds, 1));
    geometry.setAttribute(
      'aStorm',
      new THREE.InstancedBufferAttribute(storms, 1).setUsage(THREE.DynamicDrawUsage),
    );
    geometry.setAttribute(
      'aPhaseFrom',
      new THREE.InstancedBufferAttribute(phaseFrom, 1).setUsage(THREE.DynamicDrawUsage),
    );
    geometry.setAttribute(
      'aPhaseTo',
      new THREE.InstancedBufferAttribute(phaseTo, 1).setUsage(THREE.DynamicDrawUsage),
    );
    geometry.instanceCount = count;

    const material = new THREE.ShaderMaterial({
      uniforms: {
        uElapsed: { value: this.elapsed },
        uPhaseProgress: { value: this.phaseProgress },
      },
      vertexShader: WATERFALL_VERTEX,
      fragmentShader: WATERFALL_FRAGMENT,
      transparent: true,
      depthWrite: false,
      depthTest: true,
      side: THREE.DoubleSide,
      blending: THREE.NormalBlending,
    });
    const filaments = new THREE.Mesh(geometry, material);
    filaments.frustumCulled = false;
    filaments.renderOrder = 2;
    group.add(filaments);
    world.add(group);

    this.waterfall = {
      group,
      body,
      filaments,
      filamentHours: hours,
      filamentPhaseSeed: phaseSeed,
      filamentPhaseFrom: phaseFrom,
      filamentPhaseTo: phaseTo,
      filamentStorm: storms,
      filamentHeight: heights,
    };
    this.updateWaterfallGeometry();
  }

  private createWaterfallBody(): THREE.Mesh<THREE.BufferGeometry, THREE.ShaderMaterial> {
    const xSegments = 96;
    const ySegments = 16;
    const vertexCount = (xSegments + 1) * (ySegments + 1);
    const positions = new Float32Array(vertexCount * 3);
    const local = new Float32Array(vertexCount * 2);
    const storm = new Float32Array(vertexCount);
    const liquid = new Float32Array(vertexCount);
    const indices = new Uint32Array(xSegments * ySegments * 6);
    let cursor = 0;
    for (let xIndex = 0; xIndex <= xSegments; xIndex += 1) {
      for (let yIndex = 0; yIndex <= ySegments; yIndex += 1) {
        const vertex = xIndex * (ySegments + 1) + yIndex;
        local[vertex * 2] = xIndex / xSegments;
        local[vertex * 2 + 1] = yIndex / ySegments;
      }
    }
    for (let xIndex = 0; xIndex < xSegments; xIndex += 1) {
      for (let yIndex = 0; yIndex < ySegments; yIndex += 1) {
        const a = xIndex * (ySegments + 1) + yIndex;
        const b = a + ySegments + 1;
        indices.set([a, b, a + 1, b, b + 1, a + 1], cursor);
        cursor += 6;
      }
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setIndex(new THREE.BufferAttribute(indices, 1));
    geometry.setAttribute(
      'position',
      new THREE.BufferAttribute(positions, 3).setUsage(THREE.DynamicDrawUsage),
    );
    geometry.setAttribute('aLocal', new THREE.BufferAttribute(local, 2));
    geometry.setAttribute(
      'aStorm',
      new THREE.BufferAttribute(storm, 1).setUsage(THREE.DynamicDrawUsage),
    );
    geometry.setAttribute(
      'aLiquid',
      new THREE.BufferAttribute(liquid, 1).setUsage(THREE.DynamicDrawUsage),
    );
    geometry.userData.xSegments = xSegments;
    geometry.userData.ySegments = ySegments;
    const material = new THREE.ShaderMaterial({
      uniforms: { uElapsed: { value: this.elapsed } },
      vertexShader: WATERFALL_BODY_VERTEX,
      fragmentShader: WATERFALL_BODY_FRAGMENT,
      transparent: true,
      depthWrite: false,
      depthTest: true,
      side: THREE.DoubleSide,
      blending: THREE.NormalBlending,
    });
    const body = new THREE.Mesh(geometry, material);
    body.frustumCulled = false;
    body.renderOrder = 1;
    return body;
  }

  private createWater(): void {
    const world = this.world;
    if (!world) return;
    const geometry = new THREE.PlaneGeometry(22.5, 13.8, 96, 28);
    geometry.rotateX(-Math.PI / 2);
    geometry.translate(0, WATER_LEVEL, 1.25);
    geometry.setAttribute(
      'aRain',
      new THREE.BufferAttribute(new Float32Array(geometry.getAttribute('position').count), 1)
        .setUsage(THREE.DynamicDrawUsage),
    );
    const material = new THREE.ShaderMaterial({
      uniforms: { uElapsed: { value: this.elapsed } },
      vertexShader: WATER_VERTEX,
      fragmentShader: WATER_FRAGMENT,
      transparent: true,
      depthWrite: false,
      depthTest: true,
      side: THREE.DoubleSide,
      blending: THREE.NormalBlending,
    });
    const water = new THREE.Mesh(geometry, material);
    water.name = 'rain-water-surface';
    water.renderOrder = 0;
    world.add(water);
    this.water = water;
  }

  private createMist(): void {
    const world = this.world;
    if (!world) return;
    const geometry = new THREE.PlaneGeometry(PLOT_WIDTH * 1.015, 2.7, 96, 1);
    geometry.translate(0, WATER_LEVEL + 0.92, 1.02);
    geometry.setAttribute(
      'aRain',
      new THREE.BufferAttribute(new Float32Array(geometry.getAttribute('position').count), 1)
        .setUsage(THREE.DynamicDrawUsage),
    );
    const material = new THREE.ShaderMaterial({
      uniforms: { uElapsed: { value: this.elapsed } },
      vertexShader: MIST_VERTEX,
      fragmentShader: MIST_FRAGMENT,
      transparent: true,
      depthWrite: false,
      depthTest: true,
      blending: THREE.AdditiveBlending,
    });
    const mist = new THREE.Mesh(geometry, material);
    mist.name = 'rain-waterline-mist';
    mist.frustumCulled = false;
    mist.renderOrder = 1;
    world.add(mist);
    this.mist = mist;
  }

  private createCurve(): void {
    const world = this.world;
    if (!world) return;
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute(
      'position',
      new THREE.BufferAttribute(new Float32Array(193 * 3), 3).setUsage(THREE.DynamicDrawUsage),
    );
    const material = new THREE.LineBasicMaterial({
      color: 0xc5d5e3,
      transparent: true,
      opacity: 0.16,
      depthWrite: false,
      depthTest: false,
    });
    const curve = new THREE.Line(geometry, material);
    curve.name = 'rainfall-envelope';
    curve.renderOrder = 5;
    world.add(curve);
    this.curveLine = curve;
  }

  private createRipples(): void {
    const world = this.world;
    if (!world) return;
    const capacity = particleBudget(RIPPLE_COUNT[this.quality]);
    const base = new THREE.RingGeometry(0.82, 1, 48, 1);
    const geometry = new THREE.InstancedBufferGeometry();
    geometry.index = base.index;
    geometry.setAttribute('position', base.getAttribute('position'));
    geometry.setAttribute('uv', base.getAttribute('uv'));
    base.dispose();

    const centers = new Float32Array(capacity * 3);
    const starts = new Float32Array(capacity).fill(-100);
    const strengths = new Float32Array(capacity);
    const seeds = new Float32Array(capacity);
    const random = createSeededRandom(RAIN_SEED ^ 0x4c8f6e27);
    for (let index = 0; index < capacity; index += 1) seeds[index] = random();

    geometry.setAttribute(
      'aCenter',
      new THREE.InstancedBufferAttribute(centers, 3).setUsage(THREE.DynamicDrawUsage),
    );
    geometry.setAttribute(
      'aStart',
      new THREE.InstancedBufferAttribute(starts, 1).setUsage(THREE.DynamicDrawUsage),
    );
    geometry.setAttribute(
      'aStrength',
      new THREE.InstancedBufferAttribute(strengths, 1).setUsage(THREE.DynamicDrawUsage),
    );
    geometry.setAttribute('aSeed', new THREE.InstancedBufferAttribute(seeds, 1));
    geometry.instanceCount = capacity;
    const material = new THREE.ShaderMaterial({
      uniforms: { uElapsed: { value: this.elapsed } },
      vertexShader: RIPPLE_VERTEX,
      fragmentShader: RIPPLE_FRAGMENT,
      transparent: true,
      depthWrite: false,
      depthTest: true,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
    });
    const rings = new THREE.Mesh(geometry, material);
    rings.name = 'rain-ripple-field';
    rings.frustumCulled = false;
    rings.renderOrder = 4;
    world.add(rings);
    this.ripples = {
      rings,
      centers,
      starts,
      strengths,
      seeds,
      capacity,
      cursor: 0,
    };
  }

  private rebuildAxis(): void {
    const world = this.world;
    if (!world) return;
    if (this.axisGroup) {
      world.remove(this.axisGroup);
      this.disposeObject3D(this.axisGroup);
    }

    const group = new THREE.Group();
    group.name = 'precipitation-axis';
    const lineMaterial = new THREE.LineBasicMaterial({
      color: 0xffffff,
      transparent: true,
      opacity: 0.22,
      depthWrite: false,
      depthTest: false,
    });
    group.add(
      this.makeLine(
        [new THREE.Vector3(X_MIN, WATER_LEVEL, CURVE_Z), new THREE.Vector3(X_MAX, WATER_LEVEL, CURVE_Z)],
        lineMaterial,
      ),
      this.makeLine(
        [
          new THREE.Vector3(X_MIN, WATER_LEVEL, CURVE_Z),
          new THREE.Vector3(X_MIN, WATER_LEVEL + PLOT_HEIGHT, CURVE_Z),
        ],
        lineMaterial,
      ),
    );

    for (let hour = 0; hour <= 24; hour += 2) {
      const x = hourToX(hour);
      group.add(
        this.makeLine(
          [
            new THREE.Vector3(x, WATER_LEVEL, CURVE_Z),
            new THREE.Vector3(x, WATER_LEVEL - 0.075, CURVE_Z),
          ],
          lineMaterial,
        ),
      );
      const label = this.makeTextSprite(`${String(hour).padStart(2, '0')}:00`, 22, 0.45);
      label.position.set(x, WATER_LEVEL - 0.27, CURVE_Z);
      label.scale.set(0.7, 0.175, 1);
      group.add(label);
    }

    for (const ratio of [0, 0.5, 1]) {
      const y = WATER_LEVEL + PLOT_HEIGHT * ratio;
      group.add(
        this.makeLine(
          [
            new THREE.Vector3(X_MIN - 0.075, y, CURVE_Z),
            new THREE.Vector3(X_MIN + 0.075, y, CURVE_Z),
          ],
          lineMaterial,
        ),
      );
      const label = this.makeTextSprite(formatTick(this.axisMax * ratio), 22, 0.45, 'right');
      label.position.set(X_MIN - 0.45, y, CURVE_Z);
      label.scale.set(0.72, 0.18, 1);
      group.add(label);
    }

    const unit = this.makeTextSprite('mm/h', 27, 0.36, 'right');
    unit.position.set(X_MIN - 0.45, WATER_LEVEL - 0.12, CURVE_Z);
    unit.scale.set(0.62, 0.15, 1);
    group.add(unit);
    this.addFreezingGuides(group);

    const markerGeometry = new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(0, WATER_LEVEL, CURVE_Z + 0.015),
      new THREE.Vector3(0, WATER_LEVEL + PLOT_HEIGHT, CURVE_Z + 0.015),
    ]);
    const markerMaterial = new THREE.LineDashedMaterial({
      color: 0x7ec8ff,
      transparent: true,
      opacity: 0.22,
      dashSize: 0.075,
      gapSize: 0.065,
      depthWrite: false,
      depthTest: false,
    });
    const marker = new THREE.Line(markerGeometry, markerMaterial);
    marker.computeLineDistances();
    marker.renderOrder = 7;
    group.add(marker);
    this.currentMarker = marker;

    const bead = new THREE.Mesh(
      new THREE.SphereGeometry(0.065, 12, 8),
      new THREE.MeshBasicMaterial({
        color: 0x9bd7ff,
        transparent: true,
        opacity: 0.86,
        depthWrite: false,
        depthTest: false,
      }),
    );
    bead.renderOrder = 8;
    group.add(bead);
    this.currentBead = bead;

    group.renderOrder = 6;
    world.add(group);
    this.axisGroup = group;
    this.updateCurrentMarker();
  }

  private addFreezingGuides(group: THREE.Group): void {
    const crossings = this.freezingCrossings();
    for (let index = 0; index < crossings.length; index += 1) {
      const x = hourToX(crossings[index]);
      const material = new THREE.LineDashedMaterial({
        color: 0xb7ddff,
        transparent: true,
        opacity: 0.1,
        dashSize: 0.055,
        gapSize: 0.085,
        depthWrite: false,
        depthTest: false,
      });
      const line = this.makeLine(
        [
          new THREE.Vector3(x, WATER_LEVEL, CURVE_Z + 0.008),
          new THREE.Vector3(x, WATER_LEVEL + PLOT_HEIGHT, CURVE_Z + 0.008),
        ],
        material,
      );
      line.computeLineDistances();
      group.add(line);
      if (index === 0) {
        const label = this.makeTextSprite('冰点', 28, 0.26);
        label.position.set(x, WATER_LEVEL + PLOT_HEIGHT + 0.18, CURVE_Z);
        label.scale.set(0.52, 0.15, 1);
        group.add(label);
      }
    }
  }

  private freezingCrossings(): number[] {
    const result: number[] = [];
    let allZero = true;
    for (let hour = 0; hour < 24; hour += 1) {
      const left = this.temperatures[hour];
      const right = this.temperatures[hour + 1];
      allZero &&= left === 0 && right === 0;
      if (left === 0 && (hour === 0 || this.temperatures[hour - 1] !== 0)) {
        result.push(hour);
      } else if (left * right < 0) {
        result.push(hour + -left / (right - left));
      }
    }
    if (this.temperatures[24] === 0 && this.temperatures[23] !== 0) result.push(24);
    if (allZero) return [12];
    return result.filter((hour, index) => index === 0 || Math.abs(hour - result[index - 1]) > 0.15);
  }

  private makeLine(
    points: THREE.Vector3[],
    material: THREE.LineBasicMaterial | THREE.LineDashedMaterial,
  ): THREE.Line {
    return new THREE.Line(new THREE.BufferGeometry().setFromPoints(points), material);
  }

  private makeTextSprite(
    text: string,
    fontSize: number,
    opacity: number,
    align: CanvasTextAlign = 'center',
  ): THREE.Sprite {
    const canvas = document.createElement('canvas');
    canvas.width = 512;
    canvas.height = 128;
    const context = canvas.getContext('2d');
    if (context) {
      context.clearRect(0, 0, canvas.width, canvas.height);
      context.fillStyle = `rgba(255,255,255,${opacity})`;
      context.font = `500 ${fontSize}px -apple-system, "SF Pro", Inter, "PingFang SC", sans-serif`;
      const canvasContext = context as CanvasRenderingContext2D & {
        fontVariantNumeric?: string;
      };
      canvasContext.fontVariantNumeric = 'tabular-nums';
      context.textAlign = align;
      context.textBaseline = 'middle';
      const x = align === 'right' ? canvas.width - 8 : align === 'left' ? 8 : canvas.width / 2;
      context.fillText(text, x, canvas.height / 2);
    }
    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.minFilter = THREE.LinearFilter;
    texture.generateMipmaps = false;
    const material = new THREE.SpriteMaterial({
      map: texture,
      transparent: true,
      depthWrite: false,
      depthTest: false,
    });
    const sprite = new THREE.Sprite(material);
    sprite.renderOrder = 8;
    return sprite;
  }

  private updateAllRainGeometry(): void {
    if (!this.renderer) return;
    this.updateParticleRainAttributes();
    this.updateWaterfallGeometry();
    this.updateCurveGeometry();
    this.updateWaterRainAttributes();
    this.updateMistRainAttributes();
    this.updateCurrentVisuals();
    this.rainDirty = false;
  }

  private updateParticleRainAttributes(): void {
    const state = this.particles;
    if (!state) return;
    for (let index = 0; index < state.hours.length; index += 1) {
      const rainfall = sampleSeries(this.precipitationVisual, state.hours[index]);
      state.rain[index] = rainfall;
      state.top[index] = this.rainfallToY(rainfall);
    }
    (state.points.geometry.getAttribute('aRain') as THREE.BufferAttribute).needsUpdate = true;
    (state.points.geometry.getAttribute('aTop') as THREE.BufferAttribute).needsUpdate = true;
  }

  private updateWaterfallGeometry(): void {
    const state = this.waterfall;
    if (!state) return;
    const dimensions = state.filaments.geometry.getAttribute(
      'aDimensions',
    ) as THREE.InstancedBufferAttribute;
    for (let index = 0; index < state.filamentHours.length; index += 1) {
      const rain = sampleSeries(this.precipitationVisual, state.filamentHours[index]);
      const storm = smoothstep(5.8, 7.8, rain);
      const height = Math.max(0.5, this.rainfallToY(rain) - WATER_LEVEL);
      state.filamentStorm[index] = storm;
      state.filamentHeight[index] = height;
      dimensions.setY(index, height * lerp(0.62, 1.05, state.filamentPhaseSeed[index]));
    }
    dimensions.needsUpdate = true;
    (state.filaments.geometry.getAttribute('aStorm') as THREE.InstancedBufferAttribute)
      .needsUpdate = true;
    this.updateWaterfallBodyGeometry();
  }

  private updateWaterfallBodyGeometry(): void {
    const state = this.waterfall;
    if (!state) return;
    const geometry = state.body.geometry;
    const xSegments = Number(geometry.userData.xSegments);
    const ySegments = Number(geometry.userData.ySegments);
    const positions = geometry.getAttribute('position') as THREE.BufferAttribute;
    const storm = geometry.getAttribute('aStorm') as THREE.BufferAttribute;
    const liquid = geometry.getAttribute('aLiquid') as THREE.BufferAttribute;

    for (let xIndex = 0; xIndex <= xSegments; xIndex += 1) {
      const hour = (xIndex / xSegments) * 24;
      const rain = sampleSeries(this.precipitationVisual, hour);
      const top = this.rainfallToY(rain);
      const stormValue = smoothstep(5.8, 7.8, rain);
      const liquidValue = 1 - this.currentSnowFractionAt(hour);
      for (let yIndex = 0; yIndex <= ySegments; yIndex += 1) {
        const vertex = xIndex * (ySegments + 1) + yIndex;
        const progress = yIndex / ySegments;
        positions.setXYZ(
          vertex,
          hourToX(hour),
          lerp(WATER_LEVEL, top, progress),
          0.14 + Math.sin(hour * 1.7 + progress * 4.2) * 0.025,
        );
        storm.setX(vertex, stormValue);
        liquid.setX(vertex, liquidValue);
      }
    }
    positions.needsUpdate = true;
    storm.needsUpdate = true;
    liquid.needsUpdate = true;
    geometry.computeBoundingSphere();
    this.phaseBodyDirty = false;
  }

  private updateCurveGeometry(): void {
    const curve = this.curveLine;
    if (!curve) return;
    const positions = curve.geometry.getAttribute('position') as THREE.BufferAttribute;
    for (let index = 0; index < positions.count; index += 1) {
      const hour = (index / (positions.count - 1)) * 24;
      positions.setXYZ(
        index,
        hourToX(hour),
        this.rainfallToY(sampleSeries(this.precipitationVisual, hour)),
        CURVE_Z,
      );
    }
    positions.needsUpdate = true;
    curve.geometry.computeBoundingSphere();
  }

  private updateWaterRainAttributes(): void {
    const water = this.water;
    if (!water) return;
    const positions = water.geometry.getAttribute('position') as THREE.BufferAttribute;
    const rain = water.geometry.getAttribute('aRain') as THREE.BufferAttribute;
    for (let index = 0; index < positions.count; index += 1) {
      rain.setX(index, sampleSeries(this.precipitationVisual, xToHour(positions.getX(index))));
    }
    rain.needsUpdate = true;
  }

  private updateMistRainAttributes(): void {
    const mist = this.mist;
    if (!mist) return;
    const positions = mist.geometry.getAttribute('position') as THREE.BufferAttribute;
    const rain = mist.geometry.getAttribute('aRain') as THREE.BufferAttribute;
    for (let index = 0; index < positions.count; index += 1) {
      rain.setX(index, sampleSeries(this.precipitationVisual, xToHour(positions.getX(index))));
    }
    rain.needsUpdate = true;
  }

  private rainfallToY(value: number): number {
    return WATER_LEVEL + clamp01(value / Math.max(0.001, this.axisMax)) * PLOT_HEIGHT;
  }

  private recalculateAxis(): void {
    let maximum = 0;
    for (const value of this.precipitationTarget) maximum = Math.max(maximum, value);
    const next = niceAxisCeiling(maximum);
    if (Math.abs(next - this.axisMax) < 0.001) return;
    this.axisMax = next;
    if (this.world) this.rebuildAxis();
  }

  private beginPhaseTransition(nextTemperatures: Float32Array): void {
    const previousProgress = this.phaseProgress;
    for (let hour = 0; hour < HOURS; hour += 1) {
      const currentFraction = lerp(
        this.phaseFractionFrom[hour],
        this.phaseFractionTo[hour],
        smoothstep(0, 1, previousProgress),
      );
      this.phaseFractionFrom[hour] = currentFraction;
      this.phaseFractionTo[hour] = snowFraction(nextTemperatures[hour]);
    }

    if (this.particles) {
      const state = this.particles;
      for (let index = 0; index < state.hours.length; index += 1) {
        const current = lerp(
          state.phaseFrom[index],
          state.phaseTo[index],
          smoothstep(0, 1, previousProgress),
        );
        const targetFraction = snowFraction(sampleSeries(nextTemperatures, state.hours[index]));
        state.phaseFrom[index] = current;
        state.phaseTo[index] = state.phaseSeed[index] < targetFraction ? 1 : 0;
      }
      (state.points.geometry.getAttribute('aPhaseFrom') as THREE.BufferAttribute).needsUpdate = true;
      (state.points.geometry.getAttribute('aPhaseTo') as THREE.BufferAttribute).needsUpdate = true;
    }

    if (this.waterfall) {
      const state = this.waterfall;
      for (let index = 0; index < state.filamentHours.length; index += 1) {
        const current = lerp(
          state.filamentPhaseFrom[index],
          state.filamentPhaseTo[index],
          smoothstep(0, 1, previousProgress),
        );
        const targetFraction = snowFraction(
          sampleSeries(nextTemperatures, state.filamentHours[index]),
        );
        state.filamentPhaseFrom[index] = current;
        state.filamentPhaseTo[index] =
          state.filamentPhaseSeed[index] < targetFraction ? 1 : 0;
      }
      (
        state.filaments.geometry.getAttribute('aPhaseFrom') as THREE.InstancedBufferAttribute
      ).needsUpdate = true;
      (
        state.filaments.geometry.getAttribute('aPhaseTo') as THREE.InstancedBufferAttribute
      ).needsUpdate = true;
    }

    this.phaseTransitionStart = this.elapsed;
    this.phaseProgress = 0;
    this.phaseBodyDirty = true;
    this.root?.setAttribute('data-phase-transition-ms', '800');
    this.updatePhaseDatasets(nextTemperatures);
    if (this.world) this.rebuildAxis();
  }

  private applyPhaseImmediately(temperatures: Float32Array): void {
    if (this.particles) {
      const state = this.particles;
      for (let index = 0; index < state.hours.length; index += 1) {
        const fraction = snowFraction(sampleSeries(temperatures, state.hours[index]));
        const phase = state.phaseSeed[index] < fraction ? 1 : 0;
        state.phaseFrom[index] = phase;
        state.phaseTo[index] = phase;
      }
      (state.points.geometry.getAttribute('aPhaseFrom') as THREE.BufferAttribute).needsUpdate = true;
      (state.points.geometry.getAttribute('aPhaseTo') as THREE.BufferAttribute).needsUpdate = true;
      state.points.material.uniforms.uPhaseProgress.value = 1;
    }
    if (this.waterfall) {
      const state = this.waterfall;
      for (let index = 0; index < state.filamentHours.length; index += 1) {
        const fraction = snowFraction(sampleSeries(temperatures, state.filamentHours[index]));
        const phase = state.filamentPhaseSeed[index] < fraction ? 1 : 0;
        state.filamentPhaseFrom[index] = phase;
        state.filamentPhaseTo[index] = phase;
      }
      (
        state.filaments.geometry.getAttribute('aPhaseFrom') as THREE.InstancedBufferAttribute
      ).needsUpdate = true;
      (
        state.filaments.geometry.getAttribute('aPhaseTo') as THREE.InstancedBufferAttribute
      ).needsUpdate = true;
      state.filaments.material.uniforms.uPhaseProgress.value = 1;
    }
    this.phaseBodyDirty = true;
  }

  private currentSnowFractionAt(hour: number): number {
    return lerp(
      sampleSeries(this.phaseFractionFrom, hour),
      sampleSeries(this.phaseFractionTo, hour),
      smoothstep(0, 1, this.phaseProgress),
    );
  }

  private updatePhaseDatasets(temperatures: ArrayLike<number> = this.temperatures): void {
    let average = 0;
    for (let index = 0; index < HOURS; index += 1) {
      average += snowFraction(temperatures[index]) / HOURS;
    }
    this.root?.setAttribute('data-target-snow-ratio', average.toFixed(3));
    this.root?.setAttribute(
      'data-phase',
      average >= 0.999 ? 'snow' : average <= 0.001 ? 'rain' : 'mixed',
    );
  }

  private detectTemperatureMutation(): void {
    const source = this.data?.temperature;
    if (!source) return;
    const next = normalizeSeries(source, 10, -100, 100);
    let changed = false;
    for (let index = 0; index < HOURS; index += 1) {
      if (Math.abs(next[index] - this.temperatureSnapshot[index]) > 0.0001) {
        changed = true;
        break;
      }
    }
    if (!changed) return;
    this.beginPhaseTransition(next);
    this.temperatures.set(next);
    this.temperatureSnapshot.set(next);
    this.updateCurrentVisuals();
  }

  private stepRainfall(deltaSeconds: number): void {
    const blend = 1 - Math.exp(-deltaSeconds / 0.11);
    let changed = false;
    for (let index = 0; index < HOURS; index += 1) {
      const previous = this.precipitationVisual[index];
      const next = previous + (this.precipitationTarget[index] - previous) * blend;
      if (Math.abs(next - this.precipitationTarget[index]) < 0.001) {
        this.precipitationVisual[index] = this.precipitationTarget[index];
      } else {
        this.precipitationVisual[index] = next;
      }
      changed ||= Math.abs(previous - this.precipitationVisual[index]) > 0.0001;
    }
    if (changed) this.rainDirty = true;
  }

  private updateCurrentVisuals(): void {
    const hour = this.timeMinutes / 60;
    const rainfall = sampleSeries(this.precipitationVisual, hour);
    const temperature = sampleSeries(this.temperatures, hour);
    if (this.headerReadout) {
      this.headerReadout.innerHTML = `${rainfall.toFixed(1)}<span>mm/h</span>`;
      this.headerReadout.setAttribute(
        'aria-label',
        `当前时刻降水 ${rainfall.toFixed(1)} 毫米每小时`,
      );
    }
    if (this.phaseReadout) this.phaseReadout.textContent = phaseName(temperature);
    this.root?.setAttribute('data-current-minutes', this.timeMinutes.toFixed(2));
    this.root?.setAttribute('data-current-phase', phaseName(temperature));
    this.updateCurrentMarker();
  }

  private updateCurrentMarker(): void {
    const hour = this.timeMinutes / 60;
    const x = hourToX(hour);
    const y = this.rainfallToY(sampleSeries(this.precipitationVisual, hour));
    if (this.currentMarker) this.currentMarker.position.x = x;
    if (this.currentBead) this.currentBead.position.set(x, y, CURVE_Z + 0.04);
  }

  private rebuildQualityResources(): void {
    const world = this.world;
    if (!world) return;
    for (const object of [
      this.particles?.points,
      this.waterfall?.group,
      this.ripples?.rings,
    ]) {
      if (!object) continue;
      world.remove(object);
      this.disposeObject3D(object);
    }
    this.particles = null;
    this.waterfall = null;
    this.ripples = null;
    this.createParticles();
    this.createWaterfall();
    this.createRipples();
  }

  private applyCameraPreset(): void {
    const camera = this.camera;
    const controls = this.controls;
    const container = this.container;
    if (!camera || !controls || !container) return;
    const aspect = Math.max(0.2, container.clientWidth / Math.max(1, container.clientHeight));
    camera.aspect = aspect;
    camera.fov = aspect < 1 ? 43 : aspect < 1.55 ? 39 : 35;
    const verticalFov = THREE.MathUtils.degToRad(camera.fov);
    const distanceForHeight = 4.7 / Math.tan(verticalFov / 2);
    const distanceForWidth = 9.7 / (Math.tan(verticalFov / 2) * aspect);
    const distance = Math.max(14.8, distanceForHeight, distanceForWidth);
    const target = new THREE.Vector3(0, 2.72, 0.2);
    camera.position.set(-0.18, 3.75, target.z + distance);
    camera.lookAt(target);
    camera.updateProjectionMatrix();
    controls.target.copy(target);
    controls.minDistance = Math.max(10, distance * 0.72);
    controls.maxDistance = Math.max(32, distance * 1.65);
    controls.update();
  }

  private resize = (): void => {
    const renderer = this.renderer;
    const container = this.container;
    if (!renderer || !container) return;
    const width = Math.max(1, container.clientWidth);
    const height = Math.max(1, container.clientHeight);
    const dpr = Math.min(window.devicePixelRatio || 1, DPR_CAP[this.quality]);
    renderer.setPixelRatio(dpr);
    renderer.setSize(width, height, false);
    if (this.particles) this.particles.points.material.uniforms.uPixelRatio.value = dpr;
    this.applyCameraPreset();
    this.root?.setAttribute('data-renderer-pixel-ratio', dpr.toFixed(2));
  };

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
    this.raf = 0;
    const renderer = this.renderer;
    const scene = this.scene;
    const camera = this.camera;
    if (!renderer || !scene || !camera || document.hidden) return;

    const deltaSeconds = clamp((timestamp - this.lastTimestamp) / 1000, 0, 0.05);
    this.lastTimestamp = timestamp;
    this.elapsed += deltaSeconds;
    this.detectTemperatureMutation();
    this.stepRainfall(deltaSeconds);

    const previousPhaseProgress = this.phaseProgress;
    this.phaseProgress = clamp01(
      (this.elapsed - this.phaseTransitionStart) / PHASE_TRANSITION_SECONDS,
    );
    if (Math.abs(previousPhaseProgress - this.phaseProgress) > 0.0001) {
      this.phaseBodyDirty = true;
    }

    if (this.rainDirty) this.updateAllRainGeometry();
    if (this.phaseBodyDirty) this.updateWaterfallBodyGeometry();
    this.updateAnimatedUniforms();
    this.emitAutomaticRipples(deltaSeconds);
    this.controls?.update();
    renderer.render(scene, camera);
    this.raf = requestAnimationFrame(this.frame);
  };

  private updateAnimatedUniforms(): void {
    if (this.particles) {
      this.particles.points.material.uniforms.uElapsed.value = this.elapsed;
      this.particles.points.material.uniforms.uPhaseProgress.value = this.phaseProgress;
    }
    if (this.waterfall) {
      this.waterfall.body.material.uniforms.uElapsed.value = this.elapsed;
      this.waterfall.filaments.material.uniforms.uElapsed.value = this.elapsed;
      this.waterfall.filaments.material.uniforms.uPhaseProgress.value = this.phaseProgress;
    }
    if (this.water) this.water.material.uniforms.uElapsed.value = this.elapsed;
    if (this.mist) this.mist.material.uniforms.uElapsed.value = this.elapsed;
    if (this.ripples) this.ripples.rings.material.uniforms.uElapsed.value = this.elapsed;
  }

  private emitAutomaticRipples(deltaSeconds: number): void {
    const state = this.ripples;
    if (!state) return;
    let mean = 0;
    for (const value of this.precipitationVisual) mean += value / HOURS;
    const rate = clamp(mean / RAIN_REFERENCE, 0, 1.5)
      * (this.quality === 'high' ? 22 : this.quality === 'medium' ? 14 : 8);
    this.rippleAccumulator += deltaSeconds * rate;
    const random = createSeededRandom(
      RAIN_SEED ^ Math.floor(this.elapsed * 24) ^ state.cursor * 0x9e3779b1,
    );
    while (this.rippleAccumulator >= 1) {
      this.rippleAccumulator -= 1;
      const hour = this.sampleRainWeightedHour(random);
      const rainfall = sampleSeries(this.precipitationVisual, hour);
      const snow = this.currentSnowFractionAt(hour);
      this.addRipple(
        hourToX(hour) + (random() - 0.5) * (0.25 + rainfall * 0.045),
        -0.2 + random() * 4.8,
        (0.26 + clamp01(rainfall / RAIN_REFERENCE) * 0.52) * (1 - snow * 0.78),
      );
    }
  }

  private sampleRainWeightedHour(random: () => number): number {
    let total = 0;
    for (let index = 0; index < 24; index += 1) {
      total += Math.pow(Math.max(0, this.precipitationVisual[index]), 0.7);
    }
    if (total <= 0) return random() * 24;
    let pick = random() * total;
    for (let index = 0; index < 24; index += 1) {
      pick -= Math.pow(Math.max(0, this.precipitationVisual[index]), 0.7);
      if (pick <= 0) return index + random();
    }
    return 24;
  }

  private addRipple(x: number, z: number, strength: number): void {
    const state = this.ripples;
    if (!state || strength <= 0.002) return;
    const index = state.cursor;
    state.cursor = (state.cursor + 1) % state.capacity;
    state.centers[index * 3] = x;
    state.centers[index * 3 + 1] = WATER_LEVEL;
    state.centers[index * 3 + 2] = z;
    state.starts[index] = this.elapsed;
    state.strengths[index] = strength;
    (
      state.rings.geometry.getAttribute('aCenter') as THREE.InstancedBufferAttribute
    ).needsUpdate = true;
    (
      state.rings.geometry.getAttribute('aStart') as THREE.InstancedBufferAttribute
    ).needsUpdate = true;
    (
      state.rings.geometry.getAttribute('aStrength') as THREE.InstancedBufferAttribute
    ).needsUpdate = true;
  }

  private setPrecipitationPoint(hour: number, rawValue: number): void {
    const index = clamp(Math.round(hour), 0, 24);
    const value = Math.round(clamp(rawValue, 0, 10_000) * 10) / 10;
    this.precipitationTarget[index] = value;
    this.chartSelectedHour = index;
    this.commitPrecipitationToData();
    this.onPrecipitationEdited();
  }

  private onPrecipitationEdited(): void {
    this.recalculateAxis();
    this.rainDirty = true;
    this.syncEditorFromData();
    this.updateAudioGain();
    this.root?.dispatchEvent(
      new CustomEvent('weatherlayerdatachange', {
        bubbles: true,
        detail: {
          layer: this.id,
          field: 'precipitation',
          values: Array.from(this.precipitationTarget),
        },
      }),
    );
  }

  private commitPrecipitationToData(): void {
    if (!this.data) return;
    for (let index = 0; index < HOURS; index += 1) {
      try {
        this.data.precipitation[index] = this.precipitationTarget[index];
      } catch {
        break;
      }
    }
  }

  private syncEditorFromData(): void {
    for (let index = 0; index < this.editorInputs.length; index += 1) {
      const value = this.precipitationTarget[index].toFixed(1);
      if (document.activeElement !== this.editorInputs[index]) {
        this.editorInputs[index].value = value;
      }
    }
    this.renderEditorChart();
  }

  private renderEditorChart(): void {
    const chart = this.chart;
    const grid = this.chartGrid;
    const line = this.chartLine;
    const area = this.chartArea;
    if (!chart || !grid || !line || !area) return;
    const bounds = { width: 720, height: 280, left: 42, right: 18, top: 24, bottom: 258 };
    const width = bounds.width - bounds.left - bounds.right;
    const height = bounds.bottom - bounds.top;
    let maximum = 0;
    for (const value of this.precipitationTarget) maximum = Math.max(maximum, value);
    const chartMax = Math.max(20, niceAxisCeiling(maximum * 1.25));
    const namespace = 'http://www.w3.org/2000/svg';
    grid.replaceChildren();

    for (const ratio of [0, 0.5, 1]) {
      const y = bounds.bottom - ratio * height;
      const horizontal = document.createElementNS(namespace, 'line');
      horizontal.setAttribute('class', 'serein-precipitation-chart-grid');
      horizontal.setAttribute('x1', String(bounds.left));
      horizontal.setAttribute('x2', String(bounds.width - bounds.right));
      horizontal.setAttribute('y1', String(y));
      horizontal.setAttribute('y2', String(y));
      const label = document.createElementNS(namespace, 'text');
      label.setAttribute('class', 'serein-precipitation-chart-label');
      label.setAttribute('x', String(bounds.left - 9));
      label.setAttribute('y', String(y + 6));
      label.setAttribute('text-anchor', 'end');
      label.textContent = formatTick(chartMax * ratio);
      grid.append(horizontal, label);
    }
    for (const hour of [0, 6, 12, 18, 24]) {
      const x = bounds.left + (hour / 24) * width;
      const vertical = document.createElementNS(namespace, 'line');
      vertical.setAttribute('class', 'serein-precipitation-chart-grid');
      vertical.setAttribute('x1', String(x));
      vertical.setAttribute('x2', String(x));
      vertical.setAttribute('y1', String(bounds.top));
      vertical.setAttribute('y2', String(bounds.bottom));
      grid.appendChild(vertical);
    }

    const positions = Array.from(this.precipitationTarget, (value, hour) => ({
      x: bounds.left + (hour / 24) * width,
      y: bounds.bottom - clamp01(value / chartMax) * height,
    }));
    line.setAttribute('points', positions.map(({ x, y }) => `${x},${y}`).join(' '));
    area.setAttribute(
      'd',
      `M ${positions[0].x} ${bounds.bottom} L ${
        positions.map(({ x, y }) => `${x} ${y}`).join(' L ')
      } L ${positions.at(-1)?.x ?? bounds.width - bounds.right} ${bounds.bottom} Z`,
    );
    for (let hour = 0; hour < this.chartPoints.length; hour += 1) {
      const point = this.chartPoints[hour];
      point.setAttribute('transform', `translate(${positions[hour].x} ${positions[hour].y})`);
      point.setAttribute('data-active', String(hour === this.chartSelectedHour));
      point.setAttribute('aria-label', `${String(hour).padStart(2, '0')}:00 降水量`);
      point.setAttribute('aria-valuemax', String(chartMax));
      point.setAttribute('aria-valuenow', String(this.precipitationTarget[hour]));
    }
    if (this.chartTime) {
      this.chartTime.textContent = `${String(this.chartSelectedHour).padStart(2, '0')}:00`;
    }
    if (this.chartValue) {
      this.chartValue.textContent = this.precipitationTarget[this.chartSelectedHour].toFixed(1);
    }
    chart.dataset.maximum = String(chartMax);
  }

  private chartValueFromPointer(event: PointerEvent): number {
    const chart = this.chart;
    if (!chart) return 0;
    const rect = chart.getBoundingClientRect();
    const y = ((event.clientY - rect.top) / Math.max(1, rect.height)) * 280;
    const ratio = (258 - y) / (258 - 24);
    const maximum = Number(chart.dataset.maximum) || 20;
    return clamp01(ratio) * maximum;
  }

  private setEditorOpen(open: boolean): void {
    const editor = this.editor;
    const toggle = this.root?.querySelector<HTMLElement>('[data-action="edit"]');
    if (!editor) return;
    editor.dataset.open = String(open);
    editor.setAttribute('aria-hidden', String(!open));
    toggle?.setAttribute('aria-expanded', String(open));
    if (open) {
      editor.removeAttribute('inert');
      this.syncEditorFromData();
      queueMicrotask(() => {
        if (this.root && editor.dataset.open === 'true') {
          editor.querySelector<HTMLElement>('[data-action="close"]')?.focus();
        }
      });
    } else {
      editor.setAttribute('inert', '');
      toggle?.focus();
    }
  }

  private onChartPointerDown = (event: PointerEvent): void => {
    const target = event.target instanceof Element
      ? event.target.closest<SVGGElement>('.serein-precipitation-chart-point')
      : null;
    if (!target || !this.chart) return;
    event.preventDefault();
    this.chartDragHour = Number(target.dataset.hour);
    this.chartDragPointer = event.pointerId;
    this.chart.setPointerCapture(event.pointerId);
    this.setPrecipitationPoint(this.chartDragHour, this.chartValueFromPointer(event));
  };

  private onChartPointerMove = (event: PointerEvent): void => {
    if (event.pointerId !== this.chartDragPointer || this.chartDragHour < 0) return;
    event.preventDefault();
    this.setPrecipitationPoint(this.chartDragHour, this.chartValueFromPointer(event));
  };

  private onChartPointerUp = (event: PointerEvent): void => {
    if (event.pointerId !== this.chartDragPointer) return;
    if (this.chart?.hasPointerCapture(event.pointerId)) {
      this.chart.releasePointerCapture(event.pointerId);
    }
    this.chartDragPointer = null;
    this.chartDragHour = -1;
  };

  private onChartFocus = (event: FocusEvent): void => {
    const target = event.target instanceof Element
      ? event.target.closest<SVGGElement>('.serein-precipitation-chart-point')
      : null;
    if (!target) return;
    this.chartSelectedHour = Number(target.dataset.hour);
    this.renderEditorChart();
  };

  private onChartKeyDown = (event: KeyboardEvent): void => {
    const target = event.target instanceof Element
      ? event.target.closest<SVGGElement>('.serein-precipitation-chart-point')
      : null;
    if (!target) return;
    const hour = Number(target.dataset.hour);
    const amount = event.shiftKey ? 1 : 0.1;
    let next: number | null = null;
    if (event.key === 'ArrowUp') next = this.precipitationTarget[hour] + amount;
    if (event.key === 'ArrowDown') next = this.precipitationTarget[hour] - amount;
    if (event.key === 'Home') next = 0;
    if (event.key === 'End') next = Number(this.chart?.dataset.maximum) || 20;
    if (next === null) return;
    event.preventDefault();
    this.setPrecipitationPoint(hour, next);
  };

  private onDocumentPointerDown = (event: PointerEvent): void => {
    const editor = this.editor;
    if (!editor || editor.dataset.open !== 'true') return;
    const target = event.target;
    if (!(target instanceof Node)) return;
    if (editor.contains(target) || this.root?.querySelector('[data-action="edit"]')?.contains(target)) {
      return;
    }
    this.setEditorOpen(false);
  };

  private pointerCoordinates(event: PointerEvent | MouseEvent): void {
    const canvas = this.renderer?.domElement;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    this.pointer.set(
      ((event.clientX - rect.left) / Math.max(1, rect.width)) * 2 - 1,
      -((event.clientY - rect.top) / Math.max(1, rect.height)) * 2 + 1,
    );
  }

  private nearestCurveHour(event: PointerEvent): { hour: number; distance: number } {
    const camera = this.camera;
    const canvas = this.renderer?.domElement;
    if (!camera || !canvas) return { hour: -1, distance: Infinity };
    const rect = canvas.getBoundingClientRect();
    const scratch = new THREE.Vector3();
    let nearestHour = -1;
    let nearestDistance = Infinity;
    for (let hour = 0; hour < HOURS; hour += 1) {
      scratch
        .set(hourToX(hour), this.rainfallToY(this.precipitationVisual[hour]), CURVE_Z)
        .project(camera);
      const x = rect.left + (scratch.x * 0.5 + 0.5) * rect.width;
      const y = rect.top + (-scratch.y * 0.5 + 0.5) * rect.height;
      const distance = Math.hypot(event.clientX - x, event.clientY - y);
      if (distance < nearestDistance) {
        nearestDistance = distance;
        nearestHour = hour;
      }
    }
    return { hour: nearestHour, distance: nearestDistance };
  }

  private onCanvasPointerDown = (event: PointerEvent): void => {
    if (
      this.curveDrag ||
      !event.isPrimary ||
      (event.pointerType === 'mouse' && event.button !== 0)
    ) return;
    const nearest = this.nearestCurveHour(event);
    const threshold = event.pointerType === 'touch' ? 28 : 17;
    if (nearest.distance > threshold) return;
    event.preventDefault();
    event.stopPropagation();
    this.curveDrag = { pointerId: event.pointerId, hour: nearest.hour };
    this.controls && (this.controls.enabled = false);
    this.renderer?.domElement.setPointerCapture(event.pointerId);
    this.renderer?.domElement.setAttribute('data-curve-dragging', 'true');
    this.updateCurveDrag(event);
  };

  private onCanvasPointerMove = (event: PointerEvent): void => {
    if (this.curveDrag) {
      if (event.pointerId !== this.curveDrag.pointerId) return;
      event.preventDefault();
      event.stopPropagation();
      this.updateCurveDrag(event);
      return;
    }
    const nearest = this.nearestCurveHour(event);
    const threshold = event.pointerType === 'touch' ? 28 : 17;
    this.renderer?.domElement.setAttribute(
      'data-curve-hover',
      String(nearest.distance <= threshold),
    );
  };

  private onCanvasPointerUp = (event: PointerEvent): void => {
    if (!this.curveDrag || event.pointerId !== this.curveDrag.pointerId) return;
    event.preventDefault();
    event.stopPropagation();
    this.releaseCurveDrag();
  };

  private updateCurveDrag(event: PointerEvent): void {
    const camera = this.camera;
    const drag = this.curveDrag;
    if (!camera || !drag) return;
    this.pointerCoordinates(event);
    this.raycaster.setFromCamera(this.pointer, camera);
    if (!this.raycaster.ray.intersectPlane(this.pointerPlane, this.pointerWorld)) return;
    const value = ((this.pointerWorld.y - WATER_LEVEL) / PLOT_HEIGHT) * this.axisMax;
    this.setPrecipitationPoint(drag.hour, value);
  }

  private releaseCurveDrag(): void {
    const drag = this.curveDrag;
    const canvas = this.renderer?.domElement;
    if (drag && canvas?.hasPointerCapture(drag.pointerId)) {
      canvas.releasePointerCapture(drag.pointerId);
    }
    this.curveDrag = null;
    if (this.controls) this.controls.enabled = true;
    canvas?.setAttribute('data-curve-dragging', 'false');
  }

  private onCanvasClick = (event: MouseEvent): void => {
    const camera = this.camera;
    if (!camera || this.curveDrag) return;
    this.pointerCoordinates(event);
    this.raycaster.setFromCamera(this.pointer, camera);
    if (this.raycaster.ray.intersectPlane(this.waterPlane, this.pointerWorld)) {
      this.addRipple(this.pointerWorld.x, this.pointerWorld.z, 1);
    }
  };

  private resetView = (): void => {
    this.applyCameraPreset();
  };

  private onVisibility = (): void => {
    if (document.hidden) {
      this.stop();
      this.updateAudioGain();
    } else {
      void resumeSharedAudio().then(() => this.updateAudioGain());
      this.start();
    }
  };

  private onContextLost = (event: Event): void => {
    event.preventDefault();
    this.stop();
    this.root?.setAttribute('data-webgl-status', 'lost');
  };

  private onContextRestored = (): void => {
    this.root?.setAttribute('data-webgl-status', 'ready');
    this.resize();
    this.start();
  };

  private onFirstAudioGesture = (event: Event): void => {
    if (!this.soundEnabled || this.audio) return;
    const target = event.target;
    if (target instanceof Element && target.closest('[data-action="sound"]')) return;
    void this.ensureAudio();
  };

  private onSoundToggle = (): void => {
    this.soundEnabled = !this.soundEnabled;
    this.syncSoundButton();
    if (this.soundEnabled) {
      void this.ensureAudio();
    } else {
      this.updateAudioGain();
    }
  };

  private syncSoundButton(): void {
    const button = this.soundButton;
    if (!button) return;
    button.setAttribute('aria-pressed', String(this.soundEnabled));
    button.setAttribute('aria-label', this.soundEnabled ? '关闭雨声' : '开启雨声');
    button.title = this.soundEnabled ? '关闭雨声' : '开启雨声';
    this.root?.setAttribute('data-rain-sound', this.soundEnabled ? 'on' : 'off');
  }

  private async ensureAudio(): Promise<void> {
    if (this.audio || !this.root) {
      if (this.audio) {
        await resumeSharedAudio();
        this.updateAudioGain();
      }
      return;
    }
    const generation = ++this.audioGeneration;
    const context = await resumeSharedAudio();
    const masterGain = getMasterGain();
    if (!context || !masterGain) {
      this.soundEnabled = false;
      this.syncSoundButton();
      return;
    }

    const seconds = 4;
    const buffer = context.createBuffer(1, context.sampleRate * seconds, context.sampleRate);
    const channel = buffer.getChannelData(0);
    const random = createSeededRandom(RAIN_SEED ^ 0x7a4d31c9);
    let pink = 0;
    let low = 0;
    for (let index = 0; index < channel.length; index += 1) {
      const white = random() * 2 - 1;
      pink = pink * 0.985 + white * 0.15;
      low = low * 0.9985 + white * 0.018;
      const drop = random() > 0.9991 ? (random() * 2 - 1) * 0.5 : 0;
      channel[index] = clamp(pink * 0.34 + low * 0.22 + drop, -1, 1);
    }
    const source = context.createBufferSource();
    const filter = context.createBiquadFilter();
    const gain = context.createGain();
    source.buffer = buffer;
    source.loop = true;
    filter.type = 'lowpass';
    filter.frequency.value = 5_600;
    filter.Q.value = 0.35;
    gain.gain.value = 0;
    source.connect(filter);
    filter.connect(gain);
    gain.connect(masterGain);
    source.start();

    if (generation !== this.audioGeneration || !this.root) {
      releaseAudioNodes(source, filter, gain);
      return;
    }
    this.audio = { context, source, filter, gain };
    this.root.setAttribute('data-audio-engine', 'procedural-buffer-loop');
    this.updateAudioGain();
  }

  private updateAudioGain(): void {
    const audio = this.audio;
    if (!audio) return;
    const rainfall = sampleSeries(this.precipitationVisual, this.timeMinutes / 60);
    const strength = clamp01(rainfall / RAIN_REFERENCE);
    const target = this.soundEnabled && !document.hidden
      ? (strength > 0 ? 0.018 + Math.pow(strength, 0.62) * 0.19 : 0)
      : 0;
    const now = audio.context.currentTime;
    audio.gain.gain.cancelScheduledValues(now);
    audio.gain.gain.setValueAtTime(audio.gain.gain.value, now);
    audio.gain.gain.linearRampToValueAtTime(target, now + 0.12);
    audio.filter.frequency.setTargetAtTime(2_800 + strength * 5_200, now, 0.08);
    this.root?.setAttribute('data-rain-sound-gain', target.toFixed(3));
  }

  private closeAudio(): void {
    const audio = this.audio;
    this.audio = null;
    if (!audio) return;
    releaseAudioNodes(audio.source, audio.filter, audio.gain);
  }

  private disposeObject3D(object: THREE.Object3D): void {
    const geometries = new Set<THREE.BufferGeometry>();
    const materials = new Set<THREE.Material>();
    const textures = new Set<THREE.Texture>();
    object.traverse((node) => {
      const renderable = node as THREE.Object3D & {
        geometry?: THREE.BufferGeometry;
        material?: THREE.Material | THREE.Material[];
      };
      if (renderable.geometry) geometries.add(renderable.geometry);
      const nodeMaterials = Array.isArray(renderable.material)
        ? renderable.material
        : renderable.material
          ? [renderable.material]
          : [];
      for (const material of nodeMaterials) materials.add(material);
    });
    for (const material of materials) {
      for (const value of Object.values(material)) {
        if (value instanceof THREE.Texture) textures.add(value);
      }
      const uniforms = (material as THREE.ShaderMaterial).uniforms;
      if (uniforms) {
        for (const uniform of Object.values(uniforms)) {
          if (uniform.value instanceof THREE.Texture) textures.add(uniform.value);
        }
      }
    }
    for (const texture of textures) texture.dispose();
    for (const geometry of geometries) geometry.dispose();
    for (const material of materials) material.dispose();
  }
}
