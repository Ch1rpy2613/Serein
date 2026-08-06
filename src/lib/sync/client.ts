import { get, writable } from 'svelte/store';
import {
  applyAudioPrefs,
  getAudioPrefs,
  masterVolume,
  muted,
  sceneAudioPrefsRevision,
  type AudioPrefs,
} from '../audio';
import { DEFAULT_CITY, type City } from '../contracts';
import {
  dismissedRevision,
  listDismissedAlertIds,
  replaceDismissedAlertIds,
} from '../data/alerts';
import type { Quality } from '../perf';
import {
  ALL_LEVELS,
  pushLevels,
  type PushAlertLevel,
  updatePushPreferences,
} from '../push/subscribe';
import {
  currentCity,
  ensureTianjin,
  isValidCity,
  savedCities,
  selectCity,
} from '../stores/app';
import type {
  SyncConflict,
  SyncCreateResponse,
  SyncGetResponse,
  SyncHttpError,
  SyncNotFound,
  SyncPayload,
  SyncPutResponse,
} from './types';

const CODE_KEY = 'serein:sync-code';
const VERSION_KEY = 'serein:sync-version';
const QUALITY_KEY = 'serein:quality-override';
const UPLOAD_DEBOUNCE_MS = 5_000;

export const syncCode = writable<string | null>(readCode());
export const syncVersion = writable<number>(readVersion());
/** null = 自适应；非 null = 用户/同步锁定画质 */
export const qualityOverride = writable<Quality | null>(readQualityOverride());
/** UI 状态提示（恢复成功 / 冲突 / 错误） */
export const syncMessage = writable<string>('');
/** 递增以请求 App 强制全场景刷新 */
export const syncRefreshTick = writable(0);

let applyingRemote = false;
let uploadTimer: ReturnType<typeof setTimeout> | null = null;
let watchersStarted = false;
let messageClearTimer: ReturnType<typeof setTimeout> | null = null;

function readCode(): string | null {
  if (typeof localStorage === 'undefined') return null;
  try {
    const raw = localStorage.getItem(CODE_KEY);
    if (!raw) return null;
    const normalized = normalizeSyncCode(raw);
    return normalized;
  } catch {
    return null;
  }
}

function readVersion(): number {
  if (typeof localStorage === 'undefined') return 0;
  try {
    const n = Number(localStorage.getItem(VERSION_KEY));
    return Number.isInteger(n) && n > 0 ? n : 0;
  } catch {
    return 0;
  }
}

function readQualityOverride(): Quality | null {
  if (typeof localStorage === 'undefined') return null;
  try {
    const raw = localStorage.getItem(QUALITY_KEY);
    if (raw === 'low' || raw === 'medium' || raw === 'high') return raw;
  } catch {
    // ignore
  }
  return null;
}

function persistCode(code: string | null): void {
  if (typeof localStorage === 'undefined') return;
  try {
    if (code) localStorage.setItem(CODE_KEY, code);
    else localStorage.removeItem(CODE_KEY);
  } catch {
    // ignore
  }
}

function persistVersion(version: number): void {
  if (typeof localStorage === 'undefined') return;
  try {
    if (version > 0) localStorage.setItem(VERSION_KEY, String(version));
    else localStorage.removeItem(VERSION_KEY);
  } catch {
    // ignore
  }
}

function persistQualityOverride(q: Quality | null): void {
  if (typeof localStorage === 'undefined') return;
  try {
    if (q) localStorage.setItem(QUALITY_KEY, q);
    else localStorage.removeItem(QUALITY_KEY);
  } catch {
    // ignore
  }
}

if (typeof window !== 'undefined') {
  syncCode.subscribe((code) => persistCode(code));
  syncVersion.subscribe((v) => persistVersion(v));
  qualityOverride.subscribe((q) => persistQualityOverride(q));
}

/** 去连字符 / 空格，校验无歧义字符集 */
export function normalizeSyncCode(raw: string): string | null {
  const code = raw.trim().toUpperCase().replace(/[^0-9A-Z]/g, '');
  if (code.length !== 8) return null;
  const alphabet = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
  for (const ch of code) {
    if (!alphabet.includes(ch)) return null;
  }
  return code;
}

/** 展示用 4-4 分组 */
export function formatSyncCode(code: string): string {
  const c = code.replace(/[^0-9A-Za-z]/g, '').toUpperCase();
  if (c.length <= 4) return c;
  return `${c.slice(0, 4)}-${c.slice(4, 8)}`;
}

export function setSyncMessage(msg: string, clearAfterMs = 4_000): void {
  syncMessage.set(msg);
  if (messageClearTimer != null) clearTimeout(messageClearTimer);
  if (msg && clearAfterMs > 0) {
    messageClearTimer = setTimeout(() => {
      syncMessage.set('');
      messageClearTimer = null;
    }, clearAfterMs);
  }
}

export function buildSyncPayload(): SyncPayload {
  return {
    savedCities: get(savedCities),
    currentCity: get(currentCity),
    dismissedAlertIds: listDismissedAlertIds(),
    audioPrefs: getAudioPrefs(),
    qualityOverride: get(qualityOverride),
    pushLevels: [...get(pushLevels)],
  };
}

function sanitizeCity(value: unknown): City | null {
  return isValidCity(value) ? value : null;
}

function sanitizePayload(raw: unknown): SyncPayload | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;

  const citiesRaw = Array.isArray(o.savedCities) ? o.savedCities : [];
  const cities = ensureTianjin(
    citiesRaw.map(sanitizeCity).filter((c): c is City => c != null),
  );
  if (cities.length === 0) cities.push(DEFAULT_CITY);

  const current =
    sanitizeCity(o.currentCity) ??
    cities.find((c) => c.name === DEFAULT_CITY.name) ??
    cities[0] ??
    DEFAULT_CITY;

  const dismissed = Array.isArray(o.dismissedAlertIds)
    ? o.dismissedAlertIds.filter((id): id is string => typeof id === 'string' && id.length > 0)
    : [];

  const audioRaw =
    o.audioPrefs && typeof o.audioPrefs === 'object'
      ? (o.audioPrefs as Partial<AudioPrefs>)
      : {};
  const audioPrefs: AudioPrefs = {
    muted: !!audioRaw.muted,
    masterVolume:
      typeof audioRaw.masterVolume === 'number' && Number.isFinite(audioRaw.masterVolume)
        ? Math.min(1, Math.max(0, audioRaw.masterVolume))
        : 1,
    sceneRain: audioRaw.sceneRain !== false,
    sceneWind: !!audioRaw.sceneWind,
  };

  const q = o.qualityOverride;
  const quality: Quality | null =
    q === 'low' || q === 'medium' || q === 'high' ? q : null;

  const levelsRaw = Array.isArray(o.pushLevels) ? o.pushLevels : [];
  const levels = levelsRaw.filter(
    (l): l is PushAlertLevel => typeof l === 'string' && (ALL_LEVELS as readonly string[]).includes(l),
  );
  const push: PushAlertLevel[] = levels.length > 0 ? levels : ['yellow', 'orange', 'red'];

  return {
    savedCities: cities,
    currentCity: current,
    dismissedAlertIds: dismissed,
    audioPrefs,
    qualityOverride: quality,
    pushLevels: push,
  };
}

/** 覆盖本地全部同步字段，并请求全场景刷新 */
export function applySyncPayload(payload: SyncPayload): void {
  applyingRemote = true;
  if (uploadTimer != null) {
    clearTimeout(uploadTimer);
    uploadTimer = null;
  }
  try {
    const cities = ensureTianjin(payload.savedCities);
    savedCities.set(cities);
    const match =
      cities.find(
        (c) =>
          c.name === payload.currentCity.name &&
          Math.abs(c.lat - payload.currentCity.lat) < 1e-4 &&
          Math.abs(c.lon - payload.currentCity.lon) < 1e-4,
      ) ?? payload.currentCity;
    selectCity(match);
    replaceDismissedAlertIds(payload.dismissedAlertIds);
    applyAudioPrefs(payload.audioPrefs);
    qualityOverride.set(payload.qualityOverride);
    pushLevels.set([...payload.pushLevels]);
    void updatePushPreferences(payload.pushLevels);
    syncRefreshTick.update((n) => n + 1);
  } finally {
    // 短暂抑制自动上传，避免恢复后的 store 订阅立刻 PUT 抬版本
    setTimeout(() => {
      applyingRemote = false;
    }, 750);
  }
}

async function parseJson(res: Response): Promise<unknown> {
  try {
    return await res.json();
  } catch {
    return null;
  }
}

export async function apiCreateSync(
  payload: SyncPayload = buildSyncPayload(),
): Promise<SyncCreateResponse | SyncHttpError> {
  const res = await fetch('/api/sync/create', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ payload }),
  });
  const data = await parseJson(res);
  if (!res.ok) {
    const msg =
      data && typeof data === 'object' && typeof (data as { error?: unknown }).error === 'string'
        ? (data as { error: string }).error
        : `创建失败 (${res.status})`;
    return { kind: 'error', status: res.status, message: msg };
  }
  const obj = data as { code?: unknown; version?: unknown };
  if (typeof obj.code !== 'string' || typeof obj.version !== 'number') {
    return { kind: 'error', status: res.status, message: '创建响应无效' };
  }
  return { code: obj.code, version: obj.version };
}

export async function apiGetSync(
  code: string,
): Promise<SyncGetResponse | SyncNotFound | SyncHttpError> {
  const normalized = normalizeSyncCode(code);
  if (!normalized) return { kind: 'not_found' };
  const res = await fetch(`/api/sync/${encodeURIComponent(normalized)}`, {
    method: 'GET',
    headers: { Accept: 'application/json' },
    cache: 'no-store',
  });
  if (res.status === 404) return { kind: 'not_found' };
  const data = await parseJson(res);
  if (!res.ok) {
    const msg =
      data && typeof data === 'object' && typeof (data as { error?: unknown }).error === 'string'
        ? (data as { error: string }).error
        : `拉取失败 (${res.status})`;
    return { kind: 'error', status: res.status, message: msg };
  }
  const obj = data as { payload?: unknown; version?: unknown };
  if (typeof obj.version !== 'number') {
    return { kind: 'error', status: res.status, message: '拉取响应无效' };
  }
  const payload = sanitizePayload(obj.payload);
  if (!payload) {
    return { kind: 'error', status: res.status, message: '云端数据无效' };
  }
  return { payload, version: obj.version };
}

export async function apiPutSync(
  code: string,
  version: number,
  payload: SyncPayload = buildSyncPayload(),
): Promise<SyncPutResponse | SyncConflict | SyncNotFound | SyncHttpError> {
  const normalized = normalizeSyncCode(code);
  if (!normalized) return { kind: 'not_found' };
  const res = await fetch(`/api/sync/${encodeURIComponent(normalized)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ payload, version }),
  });
  const data = await parseJson(res);
  if (res.status === 404) return { kind: 'not_found' };
  if (res.status === 409) {
    const v =
      data && typeof data === 'object' && typeof (data as { version?: unknown }).version === 'number'
        ? (data as { version: number }).version
        : 0;
    return { kind: 'conflict', version: v };
  }
  if (!res.ok) {
    const msg =
      data && typeof data === 'object' && typeof (data as { error?: unknown }).error === 'string'
        ? (data as { error: string }).error
        : `上传失败 (${res.status})`;
    return { kind: 'error', status: res.status, message: msg };
  }
  const obj = data as { version?: unknown };
  if (typeof obj.version !== 'number') {
    return { kind: 'error', status: res.status, message: '上传响应无效' };
  }
  return { version: obj.version };
}

export async function createSyncCode(): Promise<boolean> {
  const result = await apiCreateSync();
  if ('kind' in result) {
    setSyncMessage(result.message || '生成同步码失败');
    return false;
  }
  syncCode.set(result.code);
  syncVersion.set(result.version);
  setSyncMessage('同步码已生成，请妥善保存');
  return true;
}

/** 输入码恢复：GET → 覆盖本地 → 刷新 */
export async function restoreFromSyncCode(input: string): Promise<boolean> {
  const code = normalizeSyncCode(input);
  if (!code) {
    setSyncMessage('请输入有效的 8 位同步码');
    return false;
  }
  const result = await apiGetSync(code);
  if ('kind' in result) {
    if (result.kind === 'not_found') {
      setSyncMessage('同步码无效或已失效');
    } else {
      setSyncMessage(result.message || '恢复失败');
    }
    return false;
  }
  syncCode.set(code);
  syncVersion.set(result.version);
  applySyncPayload(result.payload);
  setSyncMessage('已从云端恢复');
  return true;
}

/** 409 后拉取覆盖本地 */
async function pullAndOverwrite(code: string): Promise<boolean> {
  const result = await apiGetSync(code);
  if ('kind' in result) {
    if (result.kind === 'not_found') {
      setSyncMessage('同步码无效或已失效');
      syncCode.set(null);
      syncVersion.set(0);
    } else {
      setSyncMessage(result.message || '拉取失败');
    }
    return false;
  }
  syncVersion.set(result.version);
  applySyncPayload(result.payload);
  setSyncMessage('云端有更新，已覆盖本地');
  return true;
}

export async function uploadSyncNow(): Promise<void> {
  const code = get(syncCode);
  if (!code || applyingRemote) return;
  const version = get(syncVersion);
  if (version < 1) return;

  const result = await apiPutSync(code, version);
  if ('kind' in result) {
    if (result.kind === 'conflict') {
      setSyncMessage('版本冲突，正在从云端覆盖…');
      await pullAndOverwrite(code);
      return;
    }
    if (result.kind === 'not_found') {
      setSyncMessage('同步码无效或已失效');
      syncCode.set(null);
      syncVersion.set(0);
      return;
    }
    setSyncMessage(result.message || '上传失败');
    return;
  }
  syncVersion.set(result.version);
}

function scheduleUpload(): void {
  if (applyingRemote || !get(syncCode)) return;
  if (uploadTimer != null) clearTimeout(uploadTimer);
  uploadTimer = setTimeout(() => {
    uploadTimer = null;
    void uploadSyncNow();
  }, UPLOAD_DEBOUNCE_MS);
}

/** 启动时：有码则 GET，云端 version 更新则覆盖 */
export async function bootSync(): Promise<void> {
  startSyncWatchers();
  const code = get(syncCode);
  if (!code) return;
  const localVersion = get(syncVersion);
  try {
    const result = await apiGetSync(code);
    if ('kind' in result) {
      if (result.kind === 'not_found') {
        setSyncMessage('同步码无效或已失效');
        syncCode.set(null);
        syncVersion.set(0);
      }
      return;
    }
    if (result.version > localVersion) {
      syncVersion.set(result.version);
      applySyncPayload(result.payload);
      setSyncMessage('已从云端恢复');
    } else if (result.version < localVersion) {
      // 本地超前（少见）：尝试上传
      void uploadSyncNow();
    } else {
      syncVersion.set(result.version);
    }
  } catch (err) {
    console.warn('[Serein] sync boot failed', err);
  }
}

/** 订阅相关 store，防抖 5s 自动 PUT */
export function startSyncWatchers(): void {
  if (watchersStarted || typeof window === 'undefined') return;
  watchersStarted = true;

  const bump = () => scheduleUpload();
  savedCities.subscribe(bump);
  currentCity.subscribe(bump);
  pushLevels.subscribe(bump);
  qualityOverride.subscribe(bump);
  muted.subscribe(bump);
  masterVolume.subscribe(bump);
  dismissedRevision.subscribe(bump);
  sceneAudioPrefsRevision.subscribe(bump);
}
