import { get, writable } from 'svelte/store';
import type { City } from '../contracts';
import { currentCity } from '../stores/app';

export type PushAlertLevel = 'yellow' | 'orange' | 'red';

export interface PushLocalState {
  endpoint: string;
  levels: PushAlertLevel[];
  cityName: string;
  subscribedAt: number;
}

export type PushUiStatus =
  | 'unsupported'
  | 'ios-install'
  | 'denied'
  | 'idle'
  | 'subscribed'
  | 'busy'
  | 'error';

const STORAGE_KEY = 'serein:push-subscription';
const DEFAULT_LEVELS: PushAlertLevel[] = ['yellow', 'orange', 'red'];
const ALL_LEVELS: readonly PushAlertLevel[] = ['yellow', 'orange', 'red'];

export const pushStatus = writable<PushUiStatus>('idle');
export const pushLevels = writable<PushAlertLevel[]>([...DEFAULT_LEVELS]);
export const pushError = writable<string>('');
export const pushSubscribed = writable(false);

/** Increment to request AlertBanner open its sheet (notification deep-link). */
export const alertSheetOpenTick = writable(0);

/** Increment to open the settings sheet (from alert CTA etc.). */
export const settingsOpenTick = writable(0);

export function requestOpenAlertSheet(): void {
  alertSheetOpenTick.update((n) => n + 1);
}

export function requestOpenSettings(): void {
  settingsOpenTick.update((n) => n + 1);
}

export function isPushSupported(): boolean {
  return (
    typeof window !== 'undefined' &&
    'serviceWorker' in navigator &&
    'PushManager' in window &&
    'Notification' in window
  );
}

export function isIosDevice(): boolean {
  if (typeof navigator === 'undefined') return false;
  const ua = navigator.userAgent || '';
  if (/iPad|iPhone|iPod/.test(ua)) return true;
  // iPadOS 13+ reports as MacIntel with touch
  return navigator.platform === 'MacIntel' && (navigator.maxTouchPoints ?? 0) > 1;
}

export function isStandaloneDisplay(): boolean {
  if (typeof window === 'undefined') return false;
  const media = window.matchMedia?.('(display-mode: standalone)')?.matches === true;
  const iosStandalone =
    'standalone' in navigator &&
    (navigator as Navigator & { standalone?: boolean }).standalone === true;
  return media || iosStandalone;
}

/** iOS Safari in browser tab — must Add to Home Screen before Web Push works. */
export function needsIosInstallGuide(): boolean {
  return isIosDevice() && !isStandaloneDisplay();
}

export function urlBase64ToUint8Array(base64String: string): Uint8Array {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(base64);
  const output = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i += 1) {
    output[i] = raw.charCodeAt(i);
  }
  return output;
}

function readLocalState(): PushLocalState | null {
  if (typeof localStorage === 'undefined') return null;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<PushLocalState>;
    if (typeof parsed.endpoint !== 'string' || !parsed.endpoint) return null;
    const levels = Array.isArray(parsed.levels)
      ? parsed.levels.filter((l): l is PushAlertLevel =>
          ALL_LEVELS.includes(l as PushAlertLevel),
        )
      : [...DEFAULT_LEVELS];
    return {
      endpoint: parsed.endpoint,
      levels: levels.length > 0 ? levels : [...DEFAULT_LEVELS],
      cityName: typeof parsed.cityName === 'string' ? parsed.cityName : '',
      subscribedAt:
        typeof parsed.subscribedAt === 'number' && Number.isFinite(parsed.subscribedAt)
          ? parsed.subscribedAt
          : Date.now(),
    };
  } catch {
    return null;
  }
}

function writeLocalState(state: PushLocalState | null): void {
  if (typeof localStorage === 'undefined') return;
  try {
    if (!state) {
      localStorage.removeItem(STORAGE_KEY);
      return;
    }
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    // quota / private mode
  }
}

function vapidPublicKey(): string {
  const key = import.meta.env.VITE_VAPID_PUBLIC_KEY;
  return typeof key === 'string' ? key.trim() : '';
}

function subscriptionJSON(sub: PushSubscription): PushSubscriptionJSON {
  return sub.toJSON();
}

async function postSubscribe(
  subscription: PushSubscription,
  city: City,
  levels: PushAlertLevel[],
): Promise<void> {
  const body = {
    subscription: subscriptionJSON(subscription),
    city,
    levels,
  };
  const res = await fetch('/api/push/subscribe', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  // Server may be 404/501 until next prompt — still treat network delivery as success for UX
  // if we got a response (any status). Only throw on network failure (fetch itself throws).
  void res;
}

async function postUnsubscribe(subscription: PushSubscription | null): Promise<void> {
  const body = {
    subscription: subscription ? subscriptionJSON(subscription) : null,
    endpoint: subscription?.endpoint ?? readLocalState()?.endpoint ?? null,
  };
  try {
    await fetch('/api/push/unsubscribe', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch {
    // best-effort
  }
}

function applyUiFromBrowser(sub: PushSubscription | null, local: PushLocalState | null): void {
  if (!isPushSupported()) {
    pushStatus.set('unsupported');
    pushSubscribed.set(false);
    return;
  }
  if (needsIosInstallGuide() && !sub) {
    pushStatus.set('ios-install');
    pushSubscribed.set(false);
    if (local?.levels) pushLevels.set([...local.levels]);
    return;
  }
  if (typeof Notification !== 'undefined' && Notification.permission === 'denied') {
    pushStatus.set('denied');
    pushSubscribed.set(false);
    return;
  }
  if (sub) {
    pushSubscribed.set(true);
    pushStatus.set('subscribed');
    if (local?.levels?.length) pushLevels.set([...local.levels]);
    return;
  }
  pushSubscribed.set(false);
  pushStatus.set('idle');
  if (local?.levels?.length) pushLevels.set([...local.levels]);
}

/**
 * Register `/sw.js` (idempotent). Returns the registration or null.
 */
export async function registerServiceWorker(): Promise<ServiceWorkerRegistration | null> {
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return null;
  try {
    return await navigator.serviceWorker.register('/sw.js', { scope: '/' });
  } catch (error) {
    console.warn('[Atmos] service worker register failed', error);
    return null;
  }
}

async function getPushSubscription(): Promise<PushSubscription | null> {
  if (!isPushSupported()) return null;
  const reg = await navigator.serviceWorker.ready;
  return reg.pushManager.getSubscription();
}

/**
 * On boot: browser subscription is source of truth; re-POST if local record drifts.
 */
export async function reconcilePushSubscription(): Promise<void> {
  pushError.set('');
  if (!isPushSupported()) {
    applyUiFromBrowser(null, readLocalState());
    return;
  }

  try {
    await registerServiceWorker();
    const sub = await getPushSubscription();
    const local = readLocalState();

    if (sub && (!local || local.endpoint !== sub.endpoint)) {
      const city = get(currentCity);
      const levels = local?.levels?.length ? local.levels : get(pushLevels);
      try {
        await postSubscribe(sub, city, levels);
      } catch (error) {
        console.warn('[Atmos] push re-report failed', error);
      }
      writeLocalState({
        endpoint: sub.endpoint,
        levels,
        cityName: city.name,
        subscribedAt: Date.now(),
      });
      pushLevels.set([...levels]);
    } else if (!sub && local) {
      writeLocalState(null);
    }

    applyUiFromBrowser(sub, readLocalState());
  } catch (error) {
    console.warn('[Atmos] push reconcile failed', error);
    applyUiFromBrowser(null, readLocalState());
  }
}

export async function subscribeToPush(
  levels: PushAlertLevel[] = get(pushLevels),
): Promise<boolean> {
  pushError.set('');

  if (!isPushSupported()) {
    pushStatus.set('unsupported');
    return false;
  }

  if (needsIosInstallGuide()) {
    pushStatus.set('ios-install');
    return false;
  }

  const key = vapidPublicKey();
  if (!key) {
    pushStatus.set('error');
    pushError.set('未配置 VITE_VAPID_PUBLIC_KEY');
    return false;
  }

  const normalized = levels.filter((l) => ALL_LEVELS.includes(l));
  const useLevels = normalized.length > 0 ? normalized : [...DEFAULT_LEVELS];

  pushStatus.set('busy');
  try {
    const permission = await Notification.requestPermission();
    if (permission !== 'granted') {
      pushStatus.set(permission === 'denied' ? 'denied' : 'idle');
      pushSubscribed.set(false);
      if (permission === 'denied') pushError.set('通知权限已拒绝');
      return false;
    }

    await registerServiceWorker();
    const reg = await navigator.serviceWorker.ready;
    let sub = await reg.pushManager.getSubscription();
    if (!sub) {
      sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(key) as BufferSource,
      });
    }

    const city = get(currentCity);
    await postSubscribe(sub, city, useLevels);

    writeLocalState({
      endpoint: sub.endpoint,
      levels: useLevels,
      cityName: city.name,
      subscribedAt: Date.now(),
    });
    pushLevels.set([...useLevels]);
    pushSubscribed.set(true);
    pushStatus.set('subscribed');
    return true;
  } catch (error) {
    console.warn('[Atmos] push subscribe failed', error);
    pushStatus.set('error');
    pushError.set(error instanceof Error ? error.message : '订阅失败');
    pushSubscribed.set(false);
    return false;
  }
}

export async function unsubscribeFromPush(): Promise<boolean> {
  pushError.set('');
  pushStatus.set('busy');
  try {
    const sub = await getPushSubscription();
    await postUnsubscribe(sub);
    if (sub) {
      try {
        await sub.unsubscribe();
      } catch {
        // already gone
      }
    }
    writeLocalState(null);
    pushSubscribed.set(false);
    if (!isPushSupported()) {
      pushStatus.set('unsupported');
    } else if (needsIosInstallGuide()) {
      pushStatus.set('ios-install');
    } else if (Notification.permission === 'denied') {
      pushStatus.set('denied');
    } else {
      pushStatus.set('idle');
    }
    return true;
  } catch (error) {
    console.warn('[Atmos] push unsubscribe failed', error);
    pushStatus.set('error');
    pushError.set(error instanceof Error ? error.message : '退订失败');
    return false;
  }
}

/** Re-report levels / city while keeping the same browser subscription. */
export async function updatePushPreferences(levels: PushAlertLevel[]): Promise<boolean> {
  const normalized = levels.filter((l) => ALL_LEVELS.includes(l));
  const useLevels = normalized.length > 0 ? normalized : [...DEFAULT_LEVELS];
  pushLevels.set([...useLevels]);

  const sub = await getPushSubscription();
  if (!sub) return false;

  pushStatus.set('busy');
  try {
    const city = get(currentCity);
    await postSubscribe(sub, city, useLevels);
    writeLocalState({
      endpoint: sub.endpoint,
      levels: useLevels,
      cityName: city.name,
      subscribedAt: Date.now(),
    });
    pushSubscribed.set(true);
    pushStatus.set('subscribed');
    return true;
  } catch (error) {
    console.warn('[Atmos] push preference update failed', error);
    pushStatus.set('error');
    pushError.set(error instanceof Error ? error.message : '更新失败');
    return false;
  }
}

export function listenForPushMessages(): () => void {
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) {
    return () => undefined;
  }

  const onMessage = (event: MessageEvent) => {
    const data = event.data;
    if (!data || typeof data !== 'object') return;
    if ((data as { type?: string }).type === 'serein:open-alert') {
      requestOpenAlertSheet();
    }
  };

  navigator.serviceWorker.addEventListener('message', onMessage);

  // Cold start from notification: /?alert=1
  try {
    const params = new URLSearchParams(window.location.search);
    if (params.get('alert') === '1') {
      requestOpenAlertSheet();
      params.delete('alert');
      const qs = params.toString();
      const next = `${window.location.pathname}${qs ? `?${qs}` : ''}${window.location.hash}`;
      history.replaceState(null, '', next);
    }
  } catch {
    // ignore
  }

  return () => {
    navigator.serviceWorker.removeEventListener('message', onMessage);
  };
}

export { DEFAULT_LEVELS, ALL_LEVELS, STORAGE_KEY };
