<script lang="ts">
  import { fly } from 'svelte/transition';
  import { get } from 'svelte/store';
  import {
    fetchWeatherAlerts,
    filterVisibleAlerts,
    dismissAlert,
    syncAppBadge,
    thunderstormTier,
    dayPrecipProbability,
    ALERT_LEVEL_COLORS,
    alertBannerOffset,
  } from '../data/alerts';
  import type { WeatherAlert, DayData } from '../contracts';
  import { fetchProfile } from '../data/openmeteo';
  import { computeSoundingIndices } from '../scenes/sounding/indices';
  import { currentCity } from '../stores/app';
  import { currentTime } from '../stores/time';

  interface Props {
    dayData: DayData;
  }

  let { dayData }: Props = $props();

  const SWIPE_CLOSE_PX = 80;
  const CAROUSEL_MS = 5000;

  let visibleAlerts = $state<WeatherAlert[]>([]);
  let carouselIndex = $state(0);
  let sheetOpen = $state(false);
  let selectedAlert = $state<WeatherAlert | null>(null);
  let cape = $state<number | null>(null);
  let capeLoading = $state(false);
  let sheetDragY = $state(0);

  let fetchGeneration = 0;
  let capeGeneration = 0;
  let dragPointerId: number | null = null;
  let dragStartY = 0;
  let dragActive = false;

  const currentAlert = $derived(
    visibleAlerts.length > 0
      ? visibleAlerts[carouselIndex % visibleAlerts.length]!
      : null,
  );

  const levelColor = $derived(
    currentAlert ? ALERT_LEVEL_COLORS[currentAlert.level] : ALERT_LEVEL_COLORS.blue,
  );

  const selectedLevelColor = $derived(
    selectedAlert ? ALERT_LEVEL_COLORS[selectedAlert.level] : ALERT_LEVEL_COLORS.blue,
  );

  const precipProbability = $derived(dayPrecipProbability(dayData.precipitation));

  const precipLabel = $derived.by(() => {
    const p = precipProbability;
    if (!Number.isFinite(p)) return '—';
    const pct = p <= 1 ? Math.round(p * 100) : Math.round(p);
    return `${pct}%`;
  });

  const capeTier = $derived(cape != null ? thunderstormTier(cape) : null);

  $effect(() => {
    const city = $currentCity;
    const generation = ++fetchGeneration;
    void fetchWeatherAlerts(city)
      .then((alerts) => {
        if (generation !== fetchGeneration) return;
        visibleAlerts = filterVisibleAlerts(alerts);
        carouselIndex = 0;
      })
      .catch(() => {
        if (generation !== fetchGeneration) return;
        visibleAlerts = [];
        carouselIndex = 0;
      });
  });

  $effect(() => {
    const count = visibleAlerts.length;
    syncAppBadge(count);
    alertBannerOffset.set(count > 0 ? 40 : 0);
    return () => {
      alertBannerOffset.set(0);
    };
  });

  $effect(() => {
    const len = visibleAlerts.length;
    if (len <= 1) return;
    const id = window.setInterval(() => {
      carouselIndex = (carouselIndex + 1) % len;
    }, CAROUSEL_MS);
    return () => window.clearInterval(id);
  });

  function formatPubTime(epochSec: number, tz: string): string {
    try {
      return new Intl.DateTimeFormat('zh-CN', {
        timeZone: tz || 'Asia/Shanghai',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
      }).format(new Date(epochSec * 1000));
    } catch {
      return new Intl.DateTimeFormat('zh-CN', {
        timeZone: 'Asia/Shanghai',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
      }).format(new Date(epochSec * 1000));
    }
  }

  function closeSheet(): void {
    sheetOpen = false;
    selectedAlert = null;
    sheetDragY = 0;
    dragPointerId = null;
    dragActive = false;
    cape = null;
    capeLoading = false;
  }

  function loadCape(): void {
    const generation = ++capeGeneration;
    capeLoading = true;
    cape = null;
    const minutes = get(currentTime);
    const city = get(currentCity);
    const date = dayData.date;
    void fetchProfile(minutes, date, city)
      .then((profile) => {
        if (generation !== capeGeneration) return;
        cape = computeSoundingIndices(profile.levels).cape;
        capeLoading = false;
      })
      .catch(() => {
        if (generation !== capeGeneration) return;
        cape = null;
        capeLoading = false;
      });
  }

  function openSheet(alert: WeatherAlert): void {
    selectedAlert = alert;
    sheetOpen = true;
    sheetDragY = 0;
    loadCape();
  }

  function onBannerClick(): void {
    if (!currentAlert) return;
    openSheet(currentAlert);
  }

  function onDismiss(event: MouseEvent | KeyboardEvent): void {
    event.stopPropagation();
    event.preventDefault();
    if (!currentAlert) return;
    const id = currentAlert.id;
    dismissAlert(id);
    const next = visibleAlerts.filter((a) => a.id !== id);
    visibleAlerts = next;
    if (carouselIndex >= next.length) carouselIndex = 0;
    if (selectedAlert?.id === id) closeSheet();
  }

  function onWindowKeydown(event: KeyboardEvent): void {
    if (event.key === 'Escape' && sheetOpen) {
      event.preventDefault();
      closeSheet();
    }
  }

  function onHandlePointerDown(event: PointerEvent): void {
    dragPointerId = event.pointerId;
    dragStartY = event.clientY;
    dragActive = true;
    sheetDragY = 0;
    (event.currentTarget as HTMLElement).setPointerCapture?.(event.pointerId);
  }

  function onHandlePointerMove(event: PointerEvent): void {
    if (!dragActive || dragPointerId !== event.pointerId) return;
    const dy = event.clientY - dragStartY;
    sheetDragY = Math.max(0, dy);
  }

  function onHandlePointerUp(event: PointerEvent): void {
    if (dragPointerId !== event.pointerId) return;
    const shouldClose = sheetDragY > SWIPE_CLOSE_PX;
    dragPointerId = null;
    dragActive = false;
    if (shouldClose) {
      closeSheet();
      return;
    }
    sheetDragY = 0;
  }

  function onHandlePointerCancel(): void {
    dragPointerId = null;
    dragActive = false;
    sheetDragY = 0;
  }
</script>

<svelte:window onkeydown={onWindowKeydown} />

{#if currentAlert}
  <div
    class="alert-banner"
    data-scene-swipe-ignore
    role="status"
    aria-live="polite"
    style:--alert-level={levelColor}
    transition:fly={{ y: 16, duration: 220 }}
  >
    <button
      type="button"
      class="alert-main"
      aria-label={`查看预警：${currentAlert.title}`}
      onclick={onBannerClick}
    >
      <span class="level-dot" aria-hidden="true"></span>
      <span class="alert-title">{currentAlert.title}</span>
    </button>
    <button
      type="button"
      class="alert-close"
      aria-label="关闭此预警"
      onclick={onDismiss}
    >
      ×
    </button>
  </div>
{/if}

{#if sheetOpen && selectedAlert}
  <button
    type="button"
    class="sheet-backdrop"
    data-scene-swipe-ignore
    aria-label="关闭预警详情"
    onclick={closeSheet}
    transition:fly={{ duration: 180 }}
  ></button>

  <div
    class="sheet"
    data-scene-swipe-ignore
    role="dialog"
    aria-modal="true"
    aria-label="预警详情"
    style:--alert-level={selectedLevelColor}
    style:transform={`translateY(${sheetDragY}px)`}
    transition:fly={{ y: 40, duration: 240 }}
  >
    <div class="sheet-chrome">
      <button
        type="button"
        class="sheet-handle"
        aria-label="下滑关闭详情"
        onpointerdown={onHandlePointerDown}
        onpointermove={onHandlePointerMove}
        onpointerup={onHandlePointerUp}
        onpointercancel={onHandlePointerCancel}
      >
        <span class="handle-bar" aria-hidden="true"></span>
      </button>
      <button type="button" class="sheet-close" aria-label="关闭" onclick={closeSheet}>
        关闭
      </button>
    </div>

    <div class="sheet-body">
      <header class="sheet-header">
        <span class="level-dot large" aria-hidden="true"></span>
        <h2 class="sheet-title">{selectedAlert.title}</h2>
      </header>

      <p class="pub-time">
        发布于 {formatPubTime(selectedAlert.pubTime, $currentCity.tz)}
      </p>

      <section class="alert-text" aria-label="防御指南">
        {selectedAlert.text}
      </section>

      <section class="thunder-card" aria-label="雷暴潜势">
        <div class="thunder-head">
          <span class="thunder-label">雷暴潜势</span>
          <span class="thunder-badge">由 CAPE 推导</span>
        </div>

        {#if capeLoading}
          <p class="thunder-loading">计算中…</p>
        {:else}
          <div class="thunder-stats">
            <div class="thunder-tier">
              <span class="tier-value">{capeTier ?? '—'}</span>
              <span class="tier-caption">档位</span>
            </div>
            <div class="thunder-metric">
              <span class="metric-value tabular">
                {cape != null && Number.isFinite(cape) ? Math.round(cape) : '—'}
              </span>
              <span class="metric-unit">J/kg CAPE</span>
            </div>
            <div class="thunder-metric">
              <span class="metric-value tabular">{precipLabel}</span>
              <span class="metric-unit">当日降水概率</span>
            </div>
          </div>
        {/if}
      </section>
    </div>
  </div>
{/if}

<style>
  .alert-banner {
    position: fixed;
    left: 12px;
    right: 12px;
    bottom: calc(88px + env(safe-area-inset-bottom, 0px));
    z-index: 22;
    display: flex;
    align-items: center;
    gap: 8px;
    height: 40px;
    padding: 0 10px 0 12px;
    border: 1px solid var(--alert-level, var(--line));
    border-radius: 10px;
    background: rgba(5, 7, 10, 0.88);
    backdrop-filter: blur(14px);
    -webkit-backdrop-filter: blur(14px);
    box-shadow: 0 8px 24px rgba(0, 0, 0, 0.35);
    font-family: -apple-system, 'SF Pro', Inter, 'PingFang SC', sans-serif;
  }

  .alert-main {
    display: flex;
    align-items: center;
    gap: 10px;
    flex: 1;
    min-width: 0;
    margin: 0;
    padding: 0;
    border: 0;
    background: transparent;
    color: inherit;
    font: inherit;
    text-align: left;
    cursor: pointer;
    -webkit-tap-highlight-color: transparent;
  }

  .alert-main:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 2px;
    border-radius: 6px;
  }

  .level-dot {
    flex: 0 0 auto;
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: var(--alert-level, var(--accent));
  }

  .level-dot.large {
    width: 10px;
    height: 10px;
  }

  .alert-title {
    overflow: hidden;
    color: var(--fg-1);
    font-size: 13px;
    font-weight: 520;
    letter-spacing: 0.02em;
    white-space: nowrap;
    text-overflow: ellipsis;
  }

  .alert-close {
    flex: 0 0 auto;
    width: 28px;
    height: 28px;
    margin: 0;
    padding: 0;
    border: 0;
    border-radius: 8px;
    background: transparent;
    color: var(--fg-2);
    font: inherit;
    font-size: 18px;
    line-height: 1;
    cursor: pointer;
    -webkit-tap-highlight-color: transparent;
  }

  .alert-close:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 2px;
  }

  .sheet-backdrop {
    position: fixed;
    inset: 0;
    z-index: 30;
    margin: 0;
    padding: 0;
    border: 0;
    background: rgba(5, 7, 10, 0.45);
    cursor: pointer;
  }

  .sheet {
    position: fixed;
    left: 0;
    right: 0;
    bottom: 0;
    z-index: 31;
    display: flex;
    flex-direction: column;
    max-height: 70vh;
    border: 1px solid var(--line);
    border-bottom: 0;
    border-radius: 16px 16px 0 0;
    background: color-mix(in srgb, var(--bg) 90%, transparent);
    backdrop-filter: blur(18px);
    -webkit-backdrop-filter: blur(18px);
    box-shadow: 0 -12px 40px rgba(0, 0, 0, 0.4);
    font-family: -apple-system, 'SF Pro', Inter, 'PingFang SC', sans-serif;
    will-change: transform;
  }

  .sheet-chrome {
    position: relative;
    flex: 0 0 auto;
    display: flex;
    align-items: center;
    justify-content: center;
    min-height: 44px;
    padding: 10px 14px 6px;
  }

  .sheet-handle {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 100%;
    min-height: 28px;
    margin: 0;
    padding: 8px;
    border: 0;
    background: transparent;
    touch-action: none;
    cursor: grab;
    -webkit-tap-highlight-color: transparent;
  }

  .sheet-handle:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 2px;
    border-radius: 8px;
  }

  .handle-bar {
    width: 36px;
    height: 4px;
    border-radius: 999px;
    background: color-mix(in srgb, var(--fg-2) 55%, transparent);
  }

  .sheet-close {
    position: absolute;
    top: 10px;
    right: 12px;
    margin: 0;
    padding: 4px 8px;
    border: 0;
    border-radius: 8px;
    background: transparent;
    color: var(--fg-2);
    font: inherit;
    font-size: 12px;
    letter-spacing: 0.04em;
    cursor: pointer;
  }

  .sheet-close:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 2px;
  }

  .sheet-body {
    flex: 1 1 auto;
    overflow-y: auto;
    padding: 4px 16px calc(18px + env(safe-area-inset-bottom, 0px));
    -webkit-overflow-scrolling: touch;
  }

  .sheet-header {
    display: flex;
    align-items: center;
    gap: 10px;
    margin-bottom: 8px;
  }

  .sheet-title {
    margin: 0;
    color: var(--fg-1);
    font-size: 16px;
    font-weight: 600;
    letter-spacing: 0.02em;
    line-height: 1.35;
  }

  .pub-time {
    margin: 0 0 14px;
    color: var(--fg-2);
    font-size: 12px;
    letter-spacing: 0.03em;
    font-variant-numeric: tabular-nums;
  }

  .alert-text {
    margin: 0 0 18px;
    color: var(--fg-1);
    font-size: 13px;
    line-height: 1.65;
    letter-spacing: 0.02em;
    white-space: pre-wrap;
  }

  .thunder-card {
    margin-top: 4px;
    padding: 12px;
    border: 1px solid var(--line);
    border-radius: 12px;
    background: rgba(5, 7, 10, 0.35);
  }

  .thunder-head {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 10px;
    margin-bottom: 10px;
  }

  .thunder-label {
    color: var(--fg-1);
    font-size: 13px;
    font-weight: 560;
    letter-spacing: 0.04em;
  }

  .thunder-badge {
    color: var(--fg-2);
    font-size: 10px;
    letter-spacing: 0.04em;
  }

  .thunder-loading {
    margin: 0;
    color: var(--fg-2);
    font-size: 12px;
    letter-spacing: 0.03em;
  }

  .thunder-stats {
    display: grid;
    grid-template-columns: 1fr 1fr 1fr;
    gap: 10px;
  }

  .thunder-tier,
  .thunder-metric {
    display: flex;
    flex-direction: column;
    gap: 4px;
    min-width: 0;
  }

  .tier-value {
    color: var(--fg-1);
    font-size: 18px;
    font-weight: 600;
    letter-spacing: 0.04em;
  }

  .tier-caption,
  .metric-unit {
    color: var(--fg-2);
    font-size: 10px;
    letter-spacing: 0.03em;
  }

  .metric-value {
    color: var(--fg-1);
    font-size: 16px;
    font-weight: 560;
  }

  .tabular {
    font-variant-numeric: tabular-nums;
  }
</style>
