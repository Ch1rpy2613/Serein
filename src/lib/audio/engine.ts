import { writable, get } from 'svelte/store';

/**
 * Unified WebAudio engine — shared context, rain/wind/thunder channels,
 * scene vs white-noise modes. Layers must never close the context.
 */

export const AUDIO_LIMITS = {
  /** CAPE 阈值：高于此才可能打雷 */
  THUNDER_CAPE_MIN: 1000,
  /** 降水阈值 (mm/h)：配合 CAPE 触发雷声 */
  THUNDER_PRECIP_MIN_MMH: 2,
  THUNDER_INTERVAL_MIN_S: 8,
  THUNDER_INTERVAL_MAX_S: 20,
  THUNDER_GAIN_MAX: 0.32,
  /** 音量按 cape / CAPE_REF 缩放并封顶 */
  THUNDER_CAPE_REF: 3500,
  /** 睡眠定时结束时主增益淡出秒数 */
  FADE_OUT_S: 3,
} as const;

export const muted = writable(false);
export const masterVolume = writable(1);
export const whiteNoiseActive = writable(false);
/** 白噪音是否正在出声（定时结束 / Media Session 暂停后为 false） */
export const whiteNoisePlaying = writable(false);
export const channelLevels = writable({ rain: 0, wind: 0, thunder: 0 });

type AudioMode = 'scene' | 'whitenoise';

const RAIN_SEED = 0x6d2b79f5;
const WIND_SEED = 0x7a31c9d5;
const RAIN_REFERENCE = 10;
const WIND_REFERENCE = 12;

let context: AudioContext | null = null;
let masterGain: GainNode | null = null;
let rainGain: GainNode | null = null;
let windGain: GainNode | null = null;
let thunderGain: GainNode | null = null;

let rainSource: AudioBufferSourceNode | null = null;
let rainFilter: BiquadFilterNode | null = null;
let windSource: AudioBufferSourceNode | null = null;
let windFilter: BiquadFilterNode | null = null;

let channelsReady = false;
let masterUnsubscribe: (() => void) | null = null;
let visibilityBound = false;

let mode: AudioMode = 'scene';
let sceneRainPref = true;
let sceneWindPref = false;
let sceneRainEnabled = true;
let sceneWindEnabled = false;

let lastPrecipMmH = 0;
let lastWindMs = 0;
let lastCape: number | null = null;

let thunderTimer: ReturnType<typeof setTimeout> | null = null;
let sleepTimer: ReturnType<typeof setTimeout> | null = null;
let sleepFadeTimer: ReturnType<typeof setTimeout> | null = null;
let pauseFadeTimer: ReturnType<typeof setTimeout> | null = null;

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function clamp01(value: number): number {
  return clamp(value, 0, 1);
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

function AudioContextConstructor(): typeof AudioContext | null {
  if (typeof window === 'undefined') return null;
  return (
    window.AudioContext ??
    (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext ??
    null
  );
}

function effectiveMasterTarget(): number {
  return get(muted) ? 0 : clamp01(get(masterVolume));
}

function applyMasterGain(immediate = false): void {
  if (!masterGain || !context || context.state === 'closed') return;
  const now = context.currentTime;
  const target = effectiveMasterTarget();
  masterGain.gain.cancelScheduledValues(now);
  if (immediate) {
    masterGain.gain.setValueAtTime(target, now);
  } else {
    masterGain.gain.setTargetAtTime(target, now, 0.04);
  }
}

function bindMasterStore(): void {
  if (masterUnsubscribe) return;
  const sync = () => applyMasterGain();
  const unsubMute = muted.subscribe(sync);
  const unsubVol = masterVolume.subscribe(sync);
  masterUnsubscribe = () => {
    unsubMute();
    unsubVol();
  };
}

function ensureVisibilityListener(): void {
  if (visibilityBound || typeof document === 'undefined') return;
  visibilityBound = true;
  document.addEventListener('visibilitychange', () => {
    if (mode !== 'scene') return;
    if (document.hidden) {
      applyRainMix(0, lastPrecipMmH, false);
      applyWindMix(0, lastWindMs, false);
    } else {
      if (sceneRainEnabled) applyRainMix(lastPrecipMmH, lastPrecipMmH, true);
      if (sceneWindEnabled) applyWindMix(lastWindMs, lastWindMs, true);
    }
  });
}

export function getSharedAudioContext(): AudioContext | null {
  if (context && context.state !== 'closed') return context;

  const Constructor = AudioContextConstructor();
  if (!Constructor) return null;

  try {
    context = new Constructor({ latencyHint: 'interactive' });
  } catch {
    try {
      context = new Constructor();
    } catch {
      context = null;
      return null;
    }
  }

  masterGain = context.createGain();
  masterGain.gain.value = effectiveMasterTarget();
  masterGain.connect(context.destination);

  rainGain = context.createGain();
  windGain = context.createGain();
  thunderGain = context.createGain();
  rainGain.gain.value = 0;
  windGain.gain.value = 0;
  thunderGain.gain.value = 1;
  rainGain.connect(masterGain);
  windGain.connect(masterGain);
  thunderGain.connect(masterGain);

  channelsReady = false;
  rainSource = null;
  rainFilter = null;
  windSource = null;
  windFilter = null;

  bindMasterStore();
  ensureVisibilityListener();

  return context;
}

/** Master bus — layers should connect their output here, not to destination. */
export function getMasterGain(): GainNode | null {
  if (!getSharedAudioContext()) return null;
  return masterGain;
}

export async function resumeSharedAudio(): Promise<AudioContext | null> {
  const audio = getSharedAudioContext();
  if (!audio) return null;
  if (audio.state === 'suspended') {
    await audio.resume().catch(() => undefined);
  }
  return audio;
}

export function setMuted(next: boolean): void {
  muted.set(next);
}

export function toggleMuted(): boolean {
  const next = !get(muted);
  muted.set(next);
  return next;
}

export type AudioPrefs = {
  muted: boolean;
  masterVolume: number;
  sceneRain: boolean;
  sceneWind: boolean;
};

/** 场景声偏好（含白噪音模式下冻结的 pref） */
export function getAudioPrefs(): AudioPrefs {
  return {
    muted: get(muted),
    masterVolume: get(masterVolume),
    sceneRain: sceneRainPref,
    sceneWind: sceneWindPref,
  };
}

/** 跨设备恢复音频偏好；白噪音模式下只写 pref，退出后生效 */
export function applyAudioPrefs(prefs: AudioPrefs): void {
  setMuted(!!prefs.muted);
  setMasterVolume(
    typeof prefs.masterVolume === 'number' && Number.isFinite(prefs.masterVolume)
      ? prefs.masterVolume
      : 1,
  );
  sceneRainPref = !!prefs.sceneRain;
  sceneWindPref = !!prefs.sceneWind;
  if (mode === 'whitenoise') return;
  sceneRainEnabled = sceneRainPref;
  sceneWindEnabled = sceneWindPref;
  if (sceneRainEnabled) updateSceneRain(lastPrecipMmH);
  else applyRainMix(0, lastPrecipMmH, false);
  if (sceneWindEnabled) updateSceneWind(lastWindMs);
  else applyWindMix(0, lastWindMs, false);
  syncSceneLevels();
}

/** Disconnect layer nodes without closing the shared context. */
export function releaseAudioNodes(
  ...nodes: Array<AudioNode | AudioBufferSourceNode | null | undefined>
): void {
  for (const node of nodes) {
    if (!node) continue;
    try {
      if ('stop' in node && typeof node.stop === 'function') {
        node.stop();
      }
    } catch {
      // Already stopped after an interruption.
    }
    try {
      node.disconnect();
    } catch {
      // Already disconnected.
    }
  }
}

function buildRainBuffer(audio: AudioContext): AudioBuffer {
  const seconds = 4;
  const buffer = audio.createBuffer(1, audio.sampleRate * seconds, audio.sampleRate);
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
  return buffer;
}

function buildWindBuffer(audio: AudioContext): AudioBuffer {
  const seconds = 2;
  const buffer = audio.createBuffer(1, audio.sampleRate * seconds, audio.sampleRate);
  const channel = buffer.getChannelData(0);
  let noiseState = (WIND_SEED ^ 0x51f2a63b) >>> 0;
  for (let index = 0; index < channel.length; index += 1) {
    noiseState ^= noiseState << 13;
    noiseState ^= noiseState >>> 17;
    noiseState ^= noiseState << 5;
    channel[index] = ((noiseState >>> 0) / 2147483648 - 1) * 0.82;
  }
  return buffer;
}

/** Lazy-create rain/wind loop graphs once; never recreate on mode switch. */
export function ensureChannels(): void {
  const audio = getSharedAudioContext();
  if (!audio || !rainGain || !windGain || channelsReady) return;
  if (rainSource && windSource) {
    channelsReady = true;
    return;
  }

  const rainBuffer = buildRainBuffer(audio);
  const rSource = audio.createBufferSource();
  const rFilter = audio.createBiquadFilter();
  rSource.buffer = rainBuffer;
  rSource.loop = true;
  rFilter.type = 'lowpass';
  rFilter.frequency.value = 5_600;
  rFilter.Q.value = 0.35;
  rSource.connect(rFilter);
  rFilter.connect(rainGain);
  rSource.start();
  rainSource = rSource;
  rainFilter = rFilter;

  const windBuffer = buildWindBuffer(audio);
  const wSource = audio.createBufferSource();
  const wFilter = audio.createBiquadFilter();
  wSource.buffer = windBuffer;
  wSource.loop = true;
  wFilter.type = 'bandpass';
  wFilter.frequency.value = 400;
  wFilter.Q.value = 0.72;
  wSource.connect(wFilter);
  wFilter.connect(windGain);
  wSource.start();
  windSource = wSource;
  windFilter = wFilter;

  channelsReady = true;
}

function rainGainForStrength(strength: number): number {
  return strength > 0 ? 0.018 + Math.pow(strength, 0.62) * 0.19 : 0;
}

function windGainFor(strength: number, windMs: number): number {
  return windMs > 0.05 ? strength * 0.18 : 0;
}

function applyRainMix(precipMmH: number, strengthSource: number, audible: boolean): void {
  ensureChannels();
  if (!context || !rainGain || !rainFilter) return;
  const strength = clamp01(strengthSource / RAIN_REFERENCE);
  const target = audible ? rainGainForStrength(strength) : 0;
  const now = context.currentTime;
  rainGain.gain.cancelScheduledValues(now);
  rainGain.gain.setValueAtTime(rainGain.gain.value, now);
  rainGain.gain.linearRampToValueAtTime(target, now + 0.12);
  rainFilter.frequency.setTargetAtTime(2_800 + strength * 5_200, now, 0.08);
}

function applyWindMix(windMs: number, strengthSource: number, audible: boolean): void {
  ensureChannels();
  if (!context || !windGain || !windFilter) return;
  const strength = clamp01(strengthSource / WIND_REFERENCE);
  const target = audible ? windGainFor(strength, windMs) : 0;
  const frequency = 200 + strength * 1000;
  const now = context.currentTime;
  windGain.gain.cancelScheduledValues(now);
  windGain.gain.setTargetAtTime(target, now, 0.08);
  windFilter.frequency.setTargetAtTime(frequency, now, 0.1);
}

function thunderLevelFromCape(cape: number | null, precipMmH: number): number {
  if (cape == null || cape <= AUDIO_LIMITS.THUNDER_CAPE_MIN) return 0;
  if (precipMmH <= AUDIO_LIMITS.THUNDER_PRECIP_MIN_MMH) return 0;
  return clamp01(cape / AUDIO_LIMITS.THUNDER_CAPE_REF);
}

function publishChannelLevels(rainStrength: number, windStrength: number, thunderLevel: number): void {
  channelLevels.set({
    rain: clamp01(rainStrength),
    wind: clamp01(windStrength),
    thunder: clamp01(thunderLevel),
  });
}

function syncSceneLevels(): void {
  if (mode === 'whitenoise') {
    publishChannelLevels(
      clamp01(lastPrecipMmH / RAIN_REFERENCE),
      clamp01(lastWindMs / WIND_REFERENCE),
      thunderLevelFromCape(lastCape, lastPrecipMmH),
    );
    return;
  }
  const hidden = typeof document !== 'undefined' && document.hidden;
  publishChannelLevels(
    sceneRainEnabled && !hidden ? clamp01(lastPrecipMmH / RAIN_REFERENCE) : 0,
    sceneWindEnabled && !hidden ? clamp01(lastWindMs / WIND_REFERENCE) : 0,
    0,
  );
}

export function setSceneRainEnabled(enabled: boolean): void {
  // 白噪音模式冻结场景偏好，避免切场 unmount 改写退出后的恢复状态
  if (mode === 'whitenoise') return;
  sceneRainPref = enabled;
  sceneRainEnabled = enabled;
  if (!enabled) {
    applyRainMix(0, lastPrecipMmH, false);
  } else {
    updateSceneRain(lastPrecipMmH);
  }
  syncSceneLevels();
}

export function setSceneWindEnabled(enabled: boolean): void {
  if (mode === 'whitenoise') return;
  sceneWindPref = enabled;
  sceneWindEnabled = enabled;
  if (!enabled) {
    applyWindMix(0, lastWindMs, false);
  } else {
    updateSceneWind(lastWindMs);
  }
  syncSceneLevels();
}

export function getSceneRainEnabled(): boolean {
  return mode === 'whitenoise' ? false : sceneRainEnabled;
}

export function getSceneWindEnabled(): boolean {
  return mode === 'whitenoise' ? false : sceneWindEnabled;
}

export function updateSceneRain(precipMmH: number): void {
  // 白噪音模式由 setWeatherMix 独占驱动，场景层推送忽略（避免改写 last*）
  if (mode === 'whitenoise') return;
  lastPrecipMmH = precipMmH;
  if (!sceneRainEnabled || (typeof document !== 'undefined' && document.hidden)) {
    applyRainMix(0, precipMmH, false);
    syncSceneLevels();
    return;
  }
  applyRainMix(precipMmH, precipMmH, true);
  syncSceneLevels();
}

export function updateSceneWind(windMs: number): void {
  if (mode === 'whitenoise') return;
  lastWindMs = windMs;
  if (!sceneWindEnabled || (typeof document !== 'undefined' && document.hidden)) {
    applyWindMix(0, windMs, false);
    syncSceneLevels();
    return;
  }
  applyWindMix(windMs, windMs, true);
  syncSceneLevels();
}

function thunderEligible(): boolean {
  return (
    mode === 'whitenoise' &&
    get(whiteNoisePlaying) &&
    lastCape != null &&
    lastCape > AUDIO_LIMITS.THUNDER_CAPE_MIN &&
    lastPrecipMmH > AUDIO_LIMITS.THUNDER_PRECIP_MIN_MMH
  );
}

function stopThunderScheduler(): void {
  if (thunderTimer != null) {
    clearTimeout(thunderTimer);
    thunderTimer = null;
  }
}

function thunderGainForCape(cape: number): number {
  return Math.min(
    AUDIO_LIMITS.THUNDER_GAIN_MAX,
    (cape / AUDIO_LIMITS.THUNDER_CAPE_REF) * AUDIO_LIMITS.THUNDER_GAIN_MAX,
  );
}

function fireThunder(): void {
  const audio = context;
  const bus = thunderGain;
  if (!audio || !bus || !thunderEligible() || lastCape == null) return;

  const duration = 1.5 + Math.random();
  const frames = Math.max(1, Math.floor(audio.sampleRate * duration));
  const buffer = audio.createBuffer(1, frames, audio.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < data.length; i += 1) {
    data[i] = Math.random() * 2 - 1;
  }

  const source = audio.createBufferSource();
  const filter = audio.createBiquadFilter();
  const env = audio.createGain();
  source.buffer = buffer;
  filter.type = 'lowpass';
  filter.Q.value = 0.7;

  const now = audio.currentTime;
  const startFreq = 80 + Math.random() * 120;
  const endFreq = Math.max(40, 55 + Math.random() * 35);
  filter.frequency.setValueAtTime(startFreq, now);
  filter.frequency.exponentialRampToValueAtTime(endFreq, now + duration);

  const peak = thunderGainForCape(lastCape);
  env.gain.setValueAtTime(0.0001, now);
  env.gain.exponentialRampToValueAtTime(Math.max(0.0001, peak), now + 0.08);
  env.gain.exponentialRampToValueAtTime(0.0001, now + duration);

  source.connect(filter);
  filter.connect(env);
  env.connect(bus);

  const cleanup = () => {
    releaseAudioNodes(source, filter, env);
  };
  source.onended = cleanup;
  source.start(now);
  try {
    source.stop(now + duration + 0.05);
  } catch {
    // ignore
  }
}

function scheduleNextThunder(): void {
  stopThunderScheduler();
  if (!thunderEligible()) return;
  const span = AUDIO_LIMITS.THUNDER_INTERVAL_MAX_S - AUDIO_LIMITS.THUNDER_INTERVAL_MIN_S;
  const delayS = AUDIO_LIMITS.THUNDER_INTERVAL_MIN_S + Math.random() * span;
  thunderTimer = setTimeout(() => {
    thunderTimer = null;
    fireThunder();
    scheduleNextThunder();
  }, delayS * 1000);
}

export function setWeatherMix(input: {
  precipitation: number;
  windSpeed: number;
  cape: number | null;
}): void {
  lastPrecipMmH = input.precipitation;
  lastWindMs = input.windSpeed;
  lastCape = input.cape;

  if (mode !== 'whitenoise') {
    syncSceneLevels();
    return;
  }

  const audible = get(whiteNoisePlaying);
  applyRainMix(input.precipitation, input.precipitation, audible);
  applyWindMix(input.windSpeed, input.windSpeed, audible);
  syncSceneLevels();

  if (thunderEligible()) {
    if (thunderTimer == null) scheduleNextThunder();
  } else {
    stopThunderScheduler();
  }
}

export function setMasterVolume(v: number): void {
  masterVolume.set(clamp01(v));
}

export function cancelSleepTimer(): void {
  if (sleepTimer != null) {
    clearTimeout(sleepTimer);
    sleepTimer = null;
  }
  if (sleepFadeTimer != null) {
    clearTimeout(sleepFadeTimer);
    sleepFadeTimer = null;
  }
}

export function startSleepTimer(minutes: number): void {
  cancelSleepTimer();
  const ms = Math.max(0, minutes) * 60 * 1000;
  sleepTimer = setTimeout(() => {
    sleepTimer = null;
    const audio = context;
    const gain = masterGain;
    if (audio && gain && audio.state !== 'closed') {
      const now = audio.currentTime;
      gain.gain.cancelScheduledValues(now);
      gain.gain.setValueAtTime(gain.gain.value, now);
      gain.gain.linearRampToValueAtTime(0, now + AUDIO_LIMITS.FADE_OUT_S);
      sleepFadeTimer = setTimeout(() => {
        sleepFadeTimer = null;
        whiteNoisePlaying.set(false);
        stopThunderScheduler();
        applyRainMix(0, lastPrecipMmH, false);
        applyWindMix(0, lastWindMs, false);
        syncSceneLevels();
        syncMediaPlaybackState();
        void audio.suspend().catch(() => undefined);
      }, AUDIO_LIMITS.FADE_OUT_S * 1000);
    } else {
      whiteNoisePlaying.set(false);
      stopThunderScheduler();
      syncSceneLevels();
      syncMediaPlaybackState();
    }
  }, ms);
}

export async function enterWhiteNoiseMode(): Promise<void> {
  ensureChannels();
  await resumeSharedAudio();
  mode = 'whitenoise';
  sceneRainEnabled = false;
  sceneWindEnabled = false;
  whiteNoiseActive.set(true);
  whiteNoisePlaying.set(true);
  cancelSleepTimer();
  applyMasterGain(true);
  // 用当前缓存的天气立刻起混；调用方随后 setWeatherMix 刷新
  setWeatherMix({
    precipitation: lastPrecipMmH,
    windSpeed: lastWindMs,
    cape: lastCape,
  });
  syncMediaPlaybackState();
}

export async function exitWhiteNoiseMode(): Promise<void> {
  cancelSleepTimer();
  stopThunderScheduler();
  if (pauseFadeTimer != null) {
    clearTimeout(pauseFadeTimer);
    pauseFadeTimer = null;
  }

  mode = 'scene';
  sceneRainEnabled = sceneRainPref;
  sceneWindEnabled = sceneWindPref;
  whiteNoisePlaying.set(false);
  whiteNoiseActive.set(false);

  // 先静音；仍挂载的场景层会立刻 updateScene* 把电平推回来
  applyRainMix(0, lastPrecipMmH, false);
  applyWindMix(0, lastWindMs, false);
  applyMasterGain();
  syncSceneLevels();
  syncMediaPlaybackState();
}

export async function pauseWhiteNoise(): Promise<void> {
  if (mode !== 'whitenoise') return;
  whiteNoisePlaying.set(false);
  stopThunderScheduler();
  syncMediaPlaybackState();

  const audio = context;
  const gain = masterGain;
  if (audio && gain && audio.state === 'running') {
    const now = audio.currentTime;
    const fade = 0.12;
    gain.gain.cancelScheduledValues(now);
    gain.gain.setValueAtTime(gain.gain.value, now);
    gain.gain.linearRampToValueAtTime(0, now + fade);
    if (pauseFadeTimer != null) clearTimeout(pauseFadeTimer);
    await new Promise<void>((resolve) => {
      pauseFadeTimer = setTimeout(() => {
        pauseFadeTimer = null;
        resolve();
      }, fade * 1000);
    });
    await audio.suspend().catch(() => undefined);
  } else if (audio) {
    await audio.suspend().catch(() => undefined);
  }
  applyRainMix(0, lastPrecipMmH, false);
  applyWindMix(0, lastWindMs, false);
  syncSceneLevels();
}

export async function resumeWhiteNoise(): Promise<void> {
  if (mode !== 'whitenoise') return;
  whiteNoisePlaying.set(true);
  await resumeSharedAudio();
  applyMasterGain(true);
  applyRainMix(lastPrecipMmH, lastPrecipMmH, true);
  applyWindMix(lastWindMs, lastWindMs, true);
  syncSceneLevels();
  syncMediaPlaybackState();
  if (thunderEligible()) scheduleNextThunder();
}

export function isWhiteNoisePlaying(): boolean {
  return mode === 'whitenoise' && get(whiteNoisePlaying);
}

export function bindMediaSession(handlers: { play: () => void; pause: () => void }): void {
  if (typeof navigator === 'undefined' || !('mediaSession' in navigator)) return;
  try {
    navigator.mediaSession.metadata = new MediaMetadata({
      title: 'Atmos 白噪音',
      artist: 'Serein',
      album: '今晚的雨声陪你睡觉',
    });
    navigator.mediaSession.playbackState = get(whiteNoisePlaying) ? 'playing' : 'paused';
    navigator.mediaSession.setActionHandler('play', () => handlers.play());
    navigator.mediaSession.setActionHandler('pause', () => handlers.pause());
  } catch {
    // Unsupported or restricted — silent no-op.
  }
}

export function unbindMediaSession(): void {
  if (typeof navigator === 'undefined' || !('mediaSession' in navigator)) return;
  try {
    navigator.mediaSession.setActionHandler('play', null);
    navigator.mediaSession.setActionHandler('pause', null);
    navigator.mediaSession.metadata = null;
    navigator.mediaSession.playbackState = 'none';
  } catch {
    // silent no-op
  }
}

function syncMediaPlaybackState(): void {
  if (typeof navigator === 'undefined' || !('mediaSession' in navigator)) return;
  try {
    if (mode !== 'whitenoise') {
      navigator.mediaSession.playbackState = 'none';
      return;
    }
    navigator.mediaSession.playbackState = get(whiteNoisePlaying) ? 'playing' : 'paused';
  } catch {
    // silent no-op
  }
}
