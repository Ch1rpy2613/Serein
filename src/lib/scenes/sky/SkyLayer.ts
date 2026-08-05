/**
 * SkyLayer —— 天空引擎：App 常驻背景层。
 *
 * 一个物理感的大气渲染层，时间 / 云量 / 气溶胶全部真实驱动：
 *   · 太阳位置：NOAA 近似算法（见 `src/lib/astro/sun.ts`，本目录兼容 re-export），输入当前城市经纬度、
 *     DayData.date 与当前分钟数，逐帧输出高度角 / 方位角；
 *   · 大气：简化单次散射模型（Rayleigh β=(5.5,13.0,22.4)e-6，
 *     Mie β=21e-6·(turbidity/2)），Preetham 风格解析近似，无 ray marching；
 *   · 云量：DayData.cloudCover 逐时插值 → uCloud，压暗辉光、去饱和、
 *     并驱动一层 2D fbm 噪声云（覆盖度 = uCloud，缓慢漂移）；
 *   · 气溶胶：DayData.aod → uTurbidity 映射 1.5–8。
 *
 * 渲染：全屏三角形 + 单个 fragment shader，一次 draw call，无外部资源。
 */

import { get } from 'svelte/store';
import type { DayData, WeatherLayer } from '../../contracts';
import { getPrefersReducedMotion, particleBudget, subscribeReducedMotion } from '../../motion';
import { currentCity } from '../../stores/app';
import { solarPosition } from './solarPosition';

export { solarPosition } from './solarPosition';

type Quality = 'low' | 'medium' | 'high';

/** 目标星点数；实际概率会按画布宽高比换算 */
const STAR_COUNT: Record<Quality, number> = { high: 2000, medium: 800, low: 300 };
/** 云 fbm 倍频数；low 档同时采用更便宜的大气视程近似 */
const CLOUD_OCTAVES: Record<Quality, number> = { high: 5, medium: 4, low: 2 };
const QUALITY_LEVEL: Record<Quality, number> = { high: 2, medium: 1, low: 0 };
const DPR_CAP: Record<Quality, number> = { high: 2, medium: 2, low: 1.5 };

const VERT = `
attribute vec2 aPos;
void main() { gl_Position = vec4(aPos, 0.0, 1.0); }
`;

const FRAG = `
#ifdef GL_FRAGMENT_PRECISION_HIGH
precision highp float;
#else
precision mediump float;
#endif

uniform vec2  uRes;
uniform float uTime;       // 连续缓动后的当地分钟 0–1440
uniform float uElapsed;    // 秒：星点闪烁 + 云漂移
uniform vec3  uSunDir;     // 太阳方向（x=东 y=上 z=北，地平时 y=0）
uniform float uCloud;      // 0–1 云量
uniform float uTurbidity;  // 1.5–8 浑浊度（由 aod 映射）
uniform float uDim;        // 0–1 整体压暗（供其他场景 preferredSkyDim）
uniform float uStarProb;   // 每格出星概率（画质档）
uniform float uBreath;     // 0–1，reduced-motion 时关闭星点呼吸闪烁

const float PI = 3.14159265358979;
const vec3 BETA_R = vec3(5.5e-6, 13.0e-6, 22.4e-6);
const float HR = 8000.0;   // Rayleigh 标高（m）
const float HM = 1200.0;   // Mie 标高（m）
const vec3 NIGHT = vec3(0.0196, 0.0275, 0.0392); // #05070a

vec3 hash33(vec3 p3) {
  p3 = fract(p3 * vec3(0.1031, 0.1030, 0.0973));
  p3 += dot(p3, p3.yxz + 33.33);
  return fract((p3.xxy + p3.yxx) * p3.zyx);
}
float hash21(vec2 p) {
  p = fract(p * vec2(123.34, 345.45));
  p += dot(p, p + 34.345);
  return fract(p.x * p.y);
}
float vnoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(
    mix(hash21(i), hash21(i + vec2(1.0, 0.0)), u.x),
    mix(hash21(i + vec2(0.0, 1.0)), hash21(i + vec2(1.0, 1.0)), u.x),
    u.y);
}
float fbm(vec2 p) {
  float s = 0.0;
  float a = 0.5;
  for (int i = 0; i < CLOUD_OCTAVES; i++) {
    s += a * vnoise(p);
    p = p * 2.03 + vec2(17.3, 9.1);
    a *= 0.5;
  }
  return s;
}

/* 固定的全天穹全景相机：下缘为地平线，横向覆盖完整方位角。 */
vec3 viewDir(vec2 uv) {
  float az = uv.x * 2.0 * PI; // 0=北，1/4=东，1/2=南，3/4=西
  float el = uv.y * radians(87.0);
  float ce = cos(el);
  return vec3(ce * sin(az), sin(el), ce * cos(az));
}

/* Kasten-Young 大气质量解析近似；low 使用便宜的有理式。 */
float airMass(float mu) {
  mu = clamp(mu, 0.0, 1.0);
#if SKY_QUALITY == 0
  return 1.0 / (mu + 0.04);
#else
  float zenith = degrees(acos(mu));
  return 1.0 / (mu + 0.15 * pow(max(93.885 - zenith, 0.01), -1.253));
#endif
}

/* 简化单次散射：解析光学深度 + Rayleigh / Henyey-Greenstein 相函数。
 * 无 ray marching；太阳位于地平线附近时用 softplus 保持暮光连续。 */
vec3 scatter(vec3 dir, vec3 sun, out vec3 sunTrans, out float cosT) {
  float muV = max(dir.y, 0.001);
  float muS = sun.y;
  cosT = dot(dir, sun);

  vec3 betaM = vec3(21e-6 * uTurbidity * 0.5);
  vec3 tauR = BETA_R * HR;
  vec3 tauM = betaM * HM;
  vec3 tau = tauR + tauM;

  float softSun = max(muS, 0.0)
    + 0.025 * log(1.0 + exp(-abs(muS) / 0.025));
  float Xv = airMass(muV);
  float Xs = airMass(softSun);
  vec3 viewTrans = exp(-tau * Xv);
  sunTrans = exp(-tau * Xs);

  float phaseR = 3.0 / (16.0 * PI) * (1.0 + cosT * cosT);
  float g = 0.76;
  float phaseBase = max(1.0 + g * g - 2.0 * g * cosT, 0.001);
#if SKY_QUALITY == 0
  float phaseM = (1.0 - g * g) / (4.0 * PI * phaseBase * sqrt(phaseBase));
#else
  float phaseM = (1.0 - g * g) / (4.0 * PI * pow(phaseBase, 1.5));
#endif

  vec3 phase = tauR / tau * phaseR * 1.45 + tauM / tau * phaseM * 0.18;
  float sunsetBoost = mix(1.0, 8.0, 1.0 - smoothstep(0.0, 0.25, muS));
  float atmosphere = smoothstep(-0.3090, -0.0872, muS); // -18° → -5°
  vec3 col = phase * (1.0 - viewTrans) * sunTrans * 12.0 * sunsetBoost * atmosphere;

  // 民用昏影后的残余蓝光；-18° 时严格归零。
  float twilight = smoothstep(-0.3090, -0.1045, muS)
    * (1.0 - smoothstep(-0.08, 0.16, muS));
  col += vec3(0.008, 0.022, 0.070)
    * twilight
    * mix(1.0, 0.35, dir.y);

  // 经消光后的太阳色在近地平线处形成定向橙红暮光。
  float sunset = (1.0 - smoothstep(0.04, 0.28, muS))
    * smoothstep(-0.3090, -0.03, muS);
  float maxSunTrans = max(max(sunTrans.r, sunTrans.g), max(sunTrans.b, 0.0001));
  vec3 sunsetColor = mix(vec3(1.0, 0.28, 0.045), sunTrans / maxSunTrans, 0.35);
  float horizonGlow = pow(max(1.0 - dir.y, 0.0), 2.0)
    * (0.035 + 0.48 * pow(max(cosT, 0.0), 6.0));
  col += sunsetColor * sunset * horizonGlow;
  return col;
}

/* 星野：等屏幕尺度 hash 网格，避免天顶处全景投影把星点拉成长线。 */
vec3 stars(vec2 uv) {
  float aspect = uRes.x / uRes.y;
  vec2 cells = vec2(floor(80.0 * aspect), 80.0);
  vec2 p = uv * cells;
  p.x += uTime / 1440.0 * cells.x;
  vec2 id = floor(p);
  id.x = mod(id.x, cells.x);
  vec3 h = hash33(vec3(id, 19.17));
  if (h.z > uStarProb) return vec3(0.0);
  vec2 sp = 0.28 + 0.44 * hash33(vec3(id, 7.31)).xy;
  float d = length(fract(p) - sp);
  float mag = pow(hash21(id + 11.7), 7.0);              // 少数亮星，多数暗星
  float tw = mix(1.0, 0.78 + 0.22 * sin(uElapsed * (0.08 + h.x * 0.14) + h.y * 6.2831), uBreath);
  float core = smoothstep(0.15, 0.025, d);
  float halo = smoothstep(0.26, 0.0, d);
  vec3 tint = mix(vec3(0.75, 0.85, 1.0), vec3(1.0, 0.9, 0.75), h.x);
  return tint * (core * 1.5 + halo * 0.10) * (0.02 + 1.20 * mag) * tw;
}

/* 云：一层 2D fbm 噪声云，投影到水平云面，覆盖度 = uCloud，缓慢漂移 */
vec4 clouds(vec3 dir, vec3 sun, float cosT) {
  vec2 q = dir.xz / (dir.y + 0.11) * 1.55;
  q += vec2(uElapsed * 0.0038, uElapsed * 0.0015);
  float f = fbm(q);
  float threshold = mix(0.84, 0.28, uCloud);
  float alpha = smoothstep(threshold, threshold + 0.22, f)
    * min(uCloud * 1.55, 1.0)
    * smoothstep(0.0, 0.045, dir.y);

  float daylight = smoothstep(-0.16, 0.08, sun.y);
  float warm = (1.0 - smoothstep(0.02, 0.28, sun.y))
    * smoothstep(-0.16, -0.01, sun.y);
  float shade = vnoise(q * 1.65 + vec2(0.35));
  vec3 nightCloud = vec3(0.0002, 0.00035, 0.0007);
  vec3 dayCloud = vec3(0.56, 0.61, 0.68) * (0.72 + 0.28 * shade);
  vec3 col = mix(nightCloud, dayCloud, daylight);
  col = mix(col, col * vec3(1.15, 0.58, 0.30), warm * 0.72);
  col += vec3(1.0, 0.48, 0.20)
    * pow(max(cosT, 0.0), 10.0)
    * 0.16
    * warm;
  return vec4(col, alpha);
}

void main() {
  vec2 uv = gl_FragCoord.xy / uRes;
  vec3 dir = viewDir(uv);
  vec3 sun = uSunDir;
  float muS = sun.y;

  vec3 sunTrans;
  float cosT;
  vec3 col = scatter(dir, sun, sunTrans, cosT);

  // 白昼强化 Rayleigh 色分离；云量再去饱和并降亮度。
  float lum = dot(col, vec3(0.2126, 0.7152, 0.0722));
  float daySaturation = 1.0
    + 0.8 * smoothstep(-0.02, 0.25, muS) * (1.0 - uCloud);
  col = max(mix(vec3(lum), col, daySaturation), vec3(0.0));
  lum = dot(col, vec3(0.2126, 0.7152, 0.0722));
  col = mix(col, vec3(lum), uCloud * 0.82);
  col *= 1.0 - uCloud * 0.22;

  // 太阳圆盘 + 辉光；全云量时严格消失。
  float sunVis = (1.0 - uCloud) * (1.0 - uCloud)
    * smoothstep(-0.3090, -0.26, muS);
  float disc = smoothstep(0.999979, 0.999993, cosT);
  float glow = pow(max(cosT, 0.0), 350.0);
  float maxTrans = max(max(sunTrans.r, sunTrans.g), max(sunTrans.b, 0.0001));
  vec3 sunColor = sunTrans / maxTrans;
  col += sunColor * (disc * 14.0 + glow * 1.1) * sunVis;

  // 星野：高度角 < -6° 淡入，地平线以下遮蔽，云遮蔽
  vec4 cloud = clouds(dir, sun, cosT);
  float starFade = 1.0 - smoothstep(-0.2079, -0.1045, muS);
  col += stars(uv)
    * starFade
    * smoothstep(0.0, 0.045, dir.y)
    * (1.0 - uCloud * 0.85)
    * (1.0 - cloud.a);

  // 云层覆盖
  col = mix(col, cloud.rgb, cloud.a);

  // 曝光 / gamma；天文昏影后保留 #05070a 夜空地板。
  col = 1.0 - exp(-col * 1.2);
  col = pow(max(col, vec3(0.0)), vec3(0.4545));
  col = max(col, NIGHT);
  col *= 1.0 - uDim * 0.85;

  gl_FragColor = vec4(col, 1.0);
}
`;

/** DayData.cloudCover 在分钟 m 处的逐时线性插值 */
function sampleCloud(data: DayData, minutes: number): number {
  const h = Math.min(24, Math.max(0, minutes / 60));
  const i = Math.min(23, Math.floor(h));
  const f = h - i;
  const c = data.cloudCover;
  return Math.min(1, Math.max(0, c[i] * (1 - f) + c[i + 1] * f));
}

const clamp01 = (x: number): number => Math.min(1, Math.max(0, x));

export class SkyLayer implements WeatherLayer {
  readonly id = 'sky';
  readonly name = '天空';
  readonly preferredSkyDim = 0;

  private container: HTMLElement | null = null;
  private canvas: HTMLCanvasElement | null = null;
  private gl: WebGLRenderingContext | null = null;
  private program: WebGLProgram | null = null;
  private buffer: WebGLBuffer | null = null;
  private uni: Record<string, WebGLUniformLocation | null> = {};

  private raf = 0;
  private lastTs = 0;
  private elapsed = 0;
  private ro: ResizeObserver | null = null;
  private loseContext: WEBGL_lose_context | null = null;

  private quality: Quality = 'high';
  private data: DayData | null = null;
  private date = new Date().toISOString().slice(0, 10);

  /** 缓动状态：时间常数 100ms ≈ 300ms 收敛 95%，避免任何跳变 */
  private timeCur = 480;
  private timeTgt = 480;
  private cloudCur = 0.3;
  private cloudTgt = 0.3;
  private turbCur = 3;
  private turbTgt = 3;
  private dimCur = 0;
  private dimTgt = 0;
  private reducedMotion = getPrefersReducedMotion();
  private unsubscribeReducedMotion: (() => void) | null = null;

  // ------------------------------------------------------------------ 契约

  mount(container: HTMLElement): void {
    if (this.canvas) return;
    this.container = container;
    const canvas = document.createElement('canvas');
    canvas.setAttribute('aria-hidden', 'true');
    canvas.style.cssText =
      'position:absolute;inset:0;width:100%;height:100%;display:block;pointer-events:none;';
    container.appendChild(canvas);
    this.canvas = canvas;
    canvas.addEventListener('webglcontextlost', this.onContextLost);
    canvas.addEventListener('webglcontextrestored', this.onContextRestored);

    this.unsubscribeReducedMotion = subscribeReducedMotion((reduced) => {
      this.reducedMotion = reduced;
    });

    if (!this.initGL()) {
      console.warn('[SkyLayer] WebGL 不可用，天空层退化为纯色背景');
      canvas.style.background = '#05070a';
      return;
    }
    this.ro = new ResizeObserver(() => this.resize());
    this.ro.observe(container);
    this.resize();
    document.addEventListener('visibilitychange', this.onVisibility);
    this.start();
  }

  unmount(): void {
    this.stop();
    this.unsubscribeReducedMotion?.();
    this.unsubscribeReducedMotion = null;
    document.removeEventListener('visibilitychange', this.onVisibility);
    this.ro?.disconnect();
    this.ro = null;
    if (this.canvas) {
      this.canvas.removeEventListener('webglcontextlost', this.onContextLost);
      this.canvas.removeEventListener('webglcontextrestored', this.onContextRestored);
    }
    const gl = this.gl;
    if (gl) {
      if (this.buffer) gl.deleteBuffer(this.buffer);
      if (this.program) gl.deleteProgram(this.program);
      this.loseContext = gl.getExtension('WEBGL_lose_context');
      this.loseContext?.loseContext();
    }
    this.canvas?.remove();
    this.canvas = null;
    this.gl = null;
    this.program = null;
    this.buffer = null;
    this.uni = {};
    this.container = null;
  }

  setTime(minutes: number): void {
    this.timeTgt = Math.min(1440, Math.max(0, minutes));
  }

  setData(data: DayData): void {
    this.data = data;
    if (data.date) this.date = data.date;
    this.turbTgt = 1.5 + clamp01(data.aod) * 6.5; // aod 0–1 → turbidity 1.5–8
    this.cloudTgt = sampleCloud(data, this.timeCur);
  }

  setQuality(q: Quality): void {
    if (q === this.quality) return;
    const rebuild = CLOUD_OCTAVES[q] !== CLOUD_OCTAVES[this.quality];
    this.quality = q;
    if (rebuild && this.gl) this.buildProgram();
    this.resize();
  }

  /** 供 App 根据其他场景的 preferredSkyDim 压暗天空（契约外的附加钩子） */
  setDim(d: number): void {
    this.dimTgt = clamp01(d);
  }

  /** Uses the extension captured while the context was healthy. */
  restoreContext(): void {
    if (this.gl?.isContextLost()) this.loseContext?.restoreContext();
  }

  // ------------------------------------------------------------------ GL

  private initGL(): boolean {
    const canvas = this.canvas;
    if (!canvas) return false;
    const gl = canvas.getContext('webgl', {
      alpha: false,
      depth: false,
      stencil: false,
      antialias: false,
      preserveDrawingBuffer: true,
      powerPreference: 'high-performance',
    });
    if (!gl) return false;
    this.gl = gl;
    this.loseContext = gl.getExtension('WEBGL_lose_context');

    const buffer = gl.createBuffer();
    if (!buffer) return false;
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    this.buffer = buffer;

    return this.buildProgram();
  }

  private buildProgram(): boolean {
    const gl = this.gl;
    if (!gl) return false;
    const src =
      `#define CLOUD_OCTAVES ${CLOUD_OCTAVES[this.quality]}\n` +
      `#define SKY_QUALITY ${QUALITY_LEVEL[this.quality]}\n${FRAG}`;
    const vs = this.compile(gl.VERTEX_SHADER, VERT);
    const fs = this.compile(gl.FRAGMENT_SHADER, src);
    if (!vs || !fs) {
      if (vs) gl.deleteShader(vs);
      if (fs) gl.deleteShader(fs);
      return false;
    }
    const program = gl.createProgram();
    if (!program) {
      gl.deleteShader(vs);
      gl.deleteShader(fs);
      return false;
    }
    gl.attachShader(program, vs);
    gl.attachShader(program, fs);
    gl.bindAttribLocation(program, 0, 'aPos');
    gl.linkProgram(program);
    gl.deleteShader(vs);
    gl.deleteShader(fs);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      console.error('[SkyLayer] 链接着色器失败:', gl.getProgramInfoLog(program));
      gl.deleteProgram(program);
      return false;
    }
    if (this.program) gl.deleteProgram(this.program);
    this.program = program;
    this.uni = {};
    for (const name of [
      'uRes',
      'uTime',
      'uElapsed',
      'uSunDir',
      'uCloud',
      'uTurbidity',
      'uDim',
      'uStarProb',
      'uBreath',
    ]) {
      this.uni[name] = gl.getUniformLocation(program, name);
    }
    return true;
  }

  private compile(type: number, source: string): WebGLShader | null {
    const gl = this.gl;
    if (!gl) return null;
    const shader = gl.createShader(type);
    if (!shader) return null;
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      console.error('[SkyLayer] 编译着色器失败:', gl.getShaderInfoLog(shader));
      gl.deleteShader(shader);
      return null;
    }
    return shader;
  }

  private resize(): void {
    const { gl, canvas, container } = this;
    if (!gl || !canvas || !container) return;
    const dpr = Math.min(window.devicePixelRatio || 1, DPR_CAP[this.quality]);
    const w = Math.max(1, Math.round(container.clientWidth * dpr));
    const h = Math.max(1, Math.round(container.clientHeight * dpr));
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
    }
    gl.viewport(0, 0, w, h);
  }

  // ------------------------------------------------------------------ 帧循环

  private start(): void {
    if (this.raf || document.hidden || !this.gl) return;
    this.lastTs = performance.now();
    this.raf = requestAnimationFrame(this.frame);
  }

  private stop(): void {
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
  }

  private frame = (ts: number): void => {
    this.raf = requestAnimationFrame(this.frame);
    const dt = Math.min(0.1, Math.max(0, (ts - this.lastTs) / 1000));
    this.lastTs = ts;
    this.elapsed += dt;

    // 全部连续量 300ms 指数缓动，杜绝跳变
    const k = 1 - Math.exp(-dt / 0.1);
    this.timeCur += (this.timeTgt - this.timeCur) * k;
    if (Math.abs(this.timeTgt - this.timeCur) < 0.005) this.timeCur = this.timeTgt;
    if (this.data) this.cloudTgt = sampleCloud(this.data, this.timeCur);
    this.cloudCur += (this.cloudTgt - this.cloudCur) * k;
    this.turbCur += (this.turbTgt - this.turbCur) * k;
    this.dimCur += (this.dimTgt - this.dimCur) * k;

    this.render();
  };

  private render(): void {
    const { gl, program, buffer, canvas } = this;
    if (!gl || !program || !buffer || !canvas) return;

    const city = get(currentCity);
    const { elevation, azimuth } = solarPosition(this.date, this.timeCur, city.lat, city.lon);
    const el = (elevation * Math.PI) / 180;
    const az = (azimuth * Math.PI) / 180;
    const ce = Math.cos(el);
    const starColumns = Math.max(1, Math.floor((80 * canvas.width) / canvas.height));
    const starCount = particleBudget(STAR_COUNT[this.quality], this.reducedMotion);
    const starProb = Math.min(1, starCount / (starColumns * 80));

    gl.useProgram(program);
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

    gl.uniform2f(this.uni.uRes, canvas.width, canvas.height);
    gl.uniform1f(this.uni.uTime, this.timeCur);
    gl.uniform1f(this.uni.uElapsed, this.elapsed);
    gl.uniform3f(this.uni.uSunDir, ce * Math.sin(az), Math.sin(el), ce * Math.cos(az));
    gl.uniform1f(this.uni.uCloud, this.cloudCur);
    gl.uniform1f(this.uni.uTurbidity, this.turbCur);
    gl.uniform1f(this.uni.uDim, this.dimCur);
    gl.uniform1f(this.uni.uStarProb, starProb);
    gl.uniform1f(this.uni.uBreath, this.reducedMotion ? 0 : 1);

    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  // ------------------------------------------------------------------ 事件

  private onVisibility = (): void => {
    if (document.hidden) this.stop();
    else this.start();
  };

  private onContextLost = (e: Event): void => {
    e.preventDefault();
    this.stop();
  };

  private onContextRestored = (): void => {
    if (this.initGL()) {
      this.resize();
      this.start();
    }
  };
}
