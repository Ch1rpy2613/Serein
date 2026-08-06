<script lang="ts">
  import { onMount } from 'svelte';
  import { get } from 'svelte/store';
  import type { City, DayData } from '../contracts';
  import {
    enterWhiteNoiseMode,
    exitWhiteNoiseMode,
    setWeatherMix,
    setMasterVolume,
    startSleepTimer,
    cancelSleepTimer,
    pauseWhiteNoise,
    resumeWhiteNoise,
    bindMediaSession,
    unbindMediaSession,
    channelLevels,
    masterVolume,
    whiteNoisePlaying,
  } from '../audio';
  import { currentTime } from '../stores/time';
  import { currentCity } from '../stores/app';
  import { fetchProfile } from '../data/openmeteo';
  import { computeSoundingIndices } from '../scenes/sounding/indices';

  interface Props {
    dayData: DayData;
    onClose?: () => void;
  }

  let { dayData, onClose }: Props = $props();

  const TIMER_OPTIONS = [
    { label: '15分钟', minutes: 15 },
    { label: '30分钟', minutes: 30 },
    { label: '60分钟', minutes: 60 },
    { label: '整晚', minutes: 8 * 60 },
  ] as const;

  const CHANNELS = [
    { key: 'rain' as const, label: '雨' },
    { key: 'wind' as const, label: '风' },
    { key: 'thunder' as const, label: '雷' },
  ];

  let dimOn = $state(false);
  let cape = $state<number | null>(null);
  let selectedMinutes = $state(30);
  let timerEndsAt = $state<number | null>(null);
  let nowTick = $state(Date.now());
  let capeGeneration = 0;

  function clamp(value: number, lo: number, hi: number): number {
    return Math.min(hi, Math.max(lo, value));
  }

  function sampleSeries(values: number[], minutes: number): number {
    const hour = clamp(minutes / 60, 0, 24);
    const left = Math.min(23, Math.floor(hour));
    const t = hour - left;
    return (values[left] ?? 0) * (1 - t) + (values[left + 1] ?? values[left] ?? 0) * t;
  }

  const currentHour = $derived(Math.floor($currentTime / 60));

  const remainingLabel = $derived.by(() => {
    if (timerEndsAt == null) return null;
    const remSec = Math.max(0, Math.ceil((timerEndsAt - nowTick) / 1000));
    if (remSec <= 0) return '00:00';
    const hours = Math.floor(remSec / 3600);
    const minutes = Math.floor((remSec % 3600) / 60);
    const seconds = remSec % 60;
    if (hours > 0) {
      return `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
    }
    return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
  });

  const weatherMix = $derived.by(() => {
    const minutes = $currentTime;
    return {
      precipitation: sampleSeries(dayData.precipitation, minutes),
      windSpeed: sampleSeries(dayData.windSpeed, minutes),
      cape,
    };
  });

  function selectTimer(minutes: number): void {
    selectedMinutes = minutes;
    startSleepTimer(minutes);
    timerEndsAt = Date.now() + minutes * 60 * 1000;
    nowTick = Date.now();
  }

  function handleVolumeInput(event: Event): void {
    const target = event.currentTarget;
    if (!(target instanceof HTMLInputElement)) return;
    setMasterVolume(Number(target.value));
  }

  function togglePlay(): void {
    if ($whiteNoisePlaying) {
      void pauseWhiteNoise();
    } else {
      void resumeWhiteNoise();
    }
  }

  function handleClose(): void {
    onClose?.();
  }

  function handleKeydown(event: KeyboardEvent): void {
    if (event.key === 'Escape') {
      event.preventDefault();
      handleClose();
    }
  }

  function attachCloseButton(node: HTMLButtonElement): () => void {
    node.focus({ preventScroll: true });
    return () => undefined;
  }

  function loadCape(date: string, city: City): void {
    const generation = ++capeGeneration;
    void fetchProfile(get(currentTime), date, city)
      .then((profile) => {
        if (generation !== capeGeneration) return;
        cape = computeSoundingIndices(profile.levels).cape;
      })
      .catch(() => {
        if (generation !== capeGeneration) return;
        cape = null;
      });
  }

  $effect(() => {
    setWeatherMix(weatherMix);
  });

  $effect(() => {
    const date = dayData.date;
    const city = $currentCity;
    const hour = currentHour;
    loadCape(date, city);
    void hour;
  });

  onMount(() => {
    let cancelled = false;
    const raf = requestAnimationFrame(() => {
      dimOn = true;
    });
    const tickId = window.setInterval(() => {
      nowTick = Date.now();
    }, 1000);

    void (async () => {
      await enterWhiteNoiseMode();
      if (cancelled) return;
      bindMediaSession({
        play: () => {
          void resumeWhiteNoise();
        },
        pause: () => {
          void pauseWhiteNoise();
        },
      });
      startSleepTimer(30);
      timerEndsAt = Date.now() + 30 * 60 * 1000;
      nowTick = Date.now();
    })();

    return () => {
      cancelled = true;
      cancelAnimationFrame(raf);
      window.clearInterval(tickId);
      unbindMediaSession();
      cancelSleepTimer();
      void exitWhiteNoiseMode();
    };
  });
</script>

<svelte:window onkeydown={handleKeydown} />

<div
  class="white-noise"
  role="dialog"
  aria-modal="true"
  aria-label="白噪音"
  data-scene-swipe-ignore
>
  <div class={['dim', { on: dimOn }]} aria-hidden="true"></div>

  <button
    type="button"
    class="close"
    aria-label="退出白噪音"
    {@attach attachCloseButton}
    onclick={handleClose}
  >
    <svg viewBox="0 0 20 20" aria-hidden="true">
      <path d="M5 5l10 10M15 5L5 15"></path>
    </svg>
  </button>

  <div class="content">
    <h1 class="title">白噪音</h1>
    <p class="subtitle">今晚的雨声陪你睡觉</p>

    <div class="meters" role="group" aria-label="声道电平">
      {#each CHANNELS as channel (channel.key)}
        <div class="meter">
          <span class="meter-label">{channel.label}</span>
          <div class="meter-track">
            <div
              class="meter-fill"
              style:width={`${clamp($channelLevels[channel.key], 0, 1) * 100}%`}
            ></div>
          </div>
        </div>
      {/each}
    </div>

    <div class="timers" role="group" aria-label="睡眠定时">
      {#each TIMER_OPTIONS as option (option.minutes)}
        <button
          type="button"
          class={['timer-pill', { selected: selectedMinutes === option.minutes }]}
          aria-pressed={selectedMinutes === option.minutes}
          onclick={() => selectTimer(option.minutes)}
        >
          {option.label}
        </button>
      {/each}
    </div>

    {#if remainingLabel}
      <p class="remaining" aria-live="polite">
        {$whiteNoisePlaying ? `剩余 ${remainingLabel}` : '已暂停'}
      </p>
    {/if}

    <label class="volume">
      <span class="volume-label">音量</span>
      <input
        class="volume-slider"
        type="range"
        min="0"
        max="1"
        step="0.01"
        value={$masterVolume}
        aria-valuemin={0}
        aria-valuemax={1}
        aria-valuenow={$masterVolume}
        aria-label="主音量"
        oninput={handleVolumeInput}
      />
    </label>

    <button
      type="button"
      class="play-toggle"
      aria-label={$whiteNoisePlaying ? '暂停白噪音' : '播放白噪音'}
      aria-pressed={$whiteNoisePlaying}
      onclick={togglePlay}
    >
      {#if $whiteNoisePlaying}
        <svg viewBox="0 0 20 20" aria-hidden="true">
          <rect x="5" y="4" width="3.5" height="12" rx="0.5"></rect>
          <rect x="11.5" y="4" width="3.5" height="12" rx="0.5"></rect>
        </svg>
      {:else}
        <svg viewBox="0 0 20 20" aria-hidden="true">
          <path d="M7 4.5v11l9-5.5-9-5.5Z"></path>
        </svg>
      {/if}
    </button>
  </div>
</div>

<style>
  .white-noise {
    position: fixed;
    inset: 0;
    z-index: 80;
    box-sizing: border-box;
    display: grid;
    place-items: center;
    padding: max(24px, env(safe-area-inset-top)) max(24px, env(safe-area-inset-right))
      max(24px, env(safe-area-inset-bottom)) max(24px, env(safe-area-inset-left));
    color: var(--fg-1);
    font-family: var(--font-ui);
    font-variant-numeric: tabular-nums;
  }

  .dim {
    position: absolute;
    inset: 0;
    background: #000;
    opacity: 0;
    /* 拦截下层 chrome 点击；内容层 z-index 更高仍可交互 */
    pointer-events: auto;
    transition: opacity 1.2s ease;
  }

  .dim.on {
    opacity: 0.7;
  }

  .close {
    position: absolute;
    top: max(16px, env(safe-area-inset-top));
    right: max(16px, env(safe-area-inset-right));
    z-index: 1;
    display: grid;
    place-items: center;
    width: 40px;
    height: 40px;
    margin: 0;
    padding: 0;
    border: 1px solid var(--line);
    border-radius: 50%;
    background: rgba(255, 255, 255, 0.04);
    color: var(--fg-2);
    cursor: pointer;
    touch-action: manipulation;
    -webkit-tap-highlight-color: transparent;
  }

  .close:hover {
    color: var(--fg-1);
    background: rgba(255, 255, 255, 0.08);
  }

  .close:focus-visible,
  .timer-pill:focus-visible,
  .play-toggle:focus-visible,
  .volume-slider:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 3px;
  }

  .close svg {
    width: 18px;
    height: 18px;
  }

  .close path {
    fill: none;
    stroke: currentColor;
    stroke-linecap: round;
    stroke-width: 1.5;
  }

  .content {
    position: relative;
    z-index: 1;
    display: grid;
    justify-items: center;
    gap: 28px;
    width: min(100%, 360px);
    animation: title-fade 0.8s ease both;
  }

  .title {
    margin: 0;
    color: var(--fg-1);
    font-size: clamp(40px, 12vw, 72px);
    font-weight: 500;
    letter-spacing: 0.18em;
    line-height: 1.05;
    text-indent: 0.18em;
  }

  .subtitle {
    margin: -12px 0 0;
    color: var(--fg-2);
    font-size: 15px;
    letter-spacing: 0.04em;
    line-height: 1.4;
  }

  .meters {
    display: grid;
    gap: 12px;
    width: 100%;
  }

  .meter {
    display: grid;
    grid-template-columns: 1.5em 1fr;
    align-items: center;
    gap: 12px;
  }

  .meter-label {
    color: var(--fg-2);
    font-size: 13px;
    line-height: 1;
  }

  .meter-track {
    height: 4px;
    overflow: hidden;
    border-radius: 999px;
    background: rgba(255, 255, 255, 0.08);
  }

  .meter-fill {
    height: 100%;
    border-radius: inherit;
    background: var(--accent);
    transition: width 120ms ease;
  }

  .timers {
    display: flex;
    flex-wrap: wrap;
    justify-content: center;
    gap: 8px;
  }

  .timer-pill {
    min-width: 72px;
    height: 34px;
    padding: 0 12px;
    border: 1px solid transparent;
    border-bottom: 1px solid transparent;
    border-radius: 999px;
    background: rgba(255, 255, 255, 0.05);
    color: var(--fg-2);
    font: inherit;
    font-size: 12px;
    letter-spacing: 0.02em;
    cursor: pointer;
    touch-action: manipulation;
    -webkit-tap-highlight-color: transparent;
  }

  .timer-pill.selected {
    border-color: rgba(126, 200, 255, 0.35);
    border-bottom-color: var(--accent);
    color: var(--accent);
    background: rgba(126, 200, 255, 0.1);
  }

  .remaining {
    margin: -12px 0 0;
    color: var(--fg-2);
    font-size: 13px;
    font-variant-numeric: tabular-nums;
    letter-spacing: 0.04em;
  }

  .volume {
    display: grid;
    grid-template-columns: auto 1fr;
    align-items: center;
    gap: 14px;
    width: 100%;
  }

  .volume-label {
    color: var(--fg-2);
    font-size: 13px;
  }

  .volume-slider {
    width: 100%;
    accent-color: var(--accent);
    cursor: pointer;
  }

  .play-toggle {
    display: grid;
    place-items: center;
    width: 48px;
    height: 48px;
    margin: 0;
    padding: 0;
    border: 1px solid var(--line);
    border-radius: 50%;
    background: rgba(255, 255, 255, 0.05);
    color: var(--accent);
    cursor: pointer;
    touch-action: manipulation;
    -webkit-tap-highlight-color: transparent;
  }

  .play-toggle:hover {
    background: rgba(255, 255, 255, 0.09);
  }

  .play-toggle svg {
    width: 20px;
    height: 20px;
  }

  .play-toggle path,
  .play-toggle rect {
    fill: currentColor;
  }

  @keyframes title-fade {
    from {
      opacity: 0;
    }
    to {
      opacity: 1;
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .dim {
      transition-duration: 0.01ms;
    }

    .meter-fill {
      transition-duration: 0.01ms;
    }

    .content {
      animation: none;
    }
  }
</style>
