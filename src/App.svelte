<script lang="ts">
  import LayerHost from './lib/layers/LayerHost.svelte';
  import { mockDayData } from './lib/data/mock';
  import { SkyLayer } from './lib/scenes/sky/SkyLayer';
  import { currentTime } from './lib/stores/time';

  const skyLayer = new SkyLayer();
  const dayData = mockDayData(78325);

  function formatTime(minutes: number): string {
    const boundedMinutes = Math.min(1440, Math.max(0, Math.round(minutes)));
    const hours = Math.floor(boundedMinutes / 60);
    const remainingMinutes = boundedMinutes % 60;

    return `${String(hours).padStart(2, '0')}:${String(remainingMinutes).padStart(2, '0')}`;
  }
</script>

<svelte:head>
  <title>Serein · 天空引擎验收</title>
</svelte:head>

<main>
  <LayerHost layer={skyLayer} data={dayData} quality="high" />

  <section class="acceptance-controls" aria-labelledby="acceptance-title">
    <header>
      <div>
        <p>2026-08-04 · HIGH</p>
        <h1 id="acceptance-title">天空引擎验收</h1>
      </div>
      <output id="time-output" for="review-time">{formatTime($currentTime)}</output>
    </header>

    <label for="review-time">验收时间</label>
    <input
      id="review-time"
      type="range"
      min="0"
      max="1440"
      step="1"
      bind:value={$currentTime}
      aria-describedby="time-output"
      aria-valuetext={formatTime($currentTime)}
    />

    <div class="range-limits" aria-hidden="true">
      <span>00:00</span>
      <span>24:00</span>
    </div>
  </section>
</main>

<style>
  main {
    position: relative;
    min-height: 100dvh;
    overflow: hidden;
    background: var(--bg);
    color: var(--fg-1);
    isolation: isolate;
  }

  .acceptance-controls {
    position: absolute;
    bottom: max(1.25rem, env(safe-area-inset-bottom));
    left: 50%;
    z-index: 10;
    box-sizing: border-box;
    width: min(calc(100% - 2rem), 32rem);
    padding: 1rem 1.125rem 0.875rem;
    border: 1px solid var(--line);
    border-radius: 1rem;
    background: color-mix(in srgb, var(--bg) 78%, transparent);
    box-shadow: 0 1rem 3rem color-mix(in srgb, var(--bg) 55%, transparent);
    color: var(--fg-1);
    backdrop-filter: blur(18px) saturate(125%);
    transform: translateX(-50%);
    -webkit-backdrop-filter: blur(18px) saturate(125%);
  }

  header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 1rem;
    margin-bottom: 0.875rem;
  }

  p,
  h1 {
    margin: 0;
  }

  p {
    margin-bottom: 0.25rem;
    color: var(--fg-2);
    font-size: 0.6875rem;
    font-weight: 600;
    letter-spacing: 0.12em;
  }

  h1 {
    font-size: 1rem;
    font-weight: 600;
    letter-spacing: 0.02em;
  }

  output {
    color: var(--accent);
    font-size: 1.75rem;
    font-weight: 500;
    font-variant-numeric: tabular-nums;
    letter-spacing: -0.03em;
  }

  label {
    color: var(--fg-2);
    font-size: 0.75rem;
  }

  input[type='range'] {
    display: block;
    width: 100%;
    margin: 0.625rem 0 0.375rem;
    accent-color: var(--accent);
    cursor: pointer;
  }

  input[type='range']:focus-visible {
    border-radius: 999px;
    outline: 2px solid var(--accent);
    outline-offset: 0.25rem;
  }

  .range-limits {
    display: flex;
    justify-content: space-between;
    color: var(--fg-2);
    font-size: 0.6875rem;
    font-variant-numeric: tabular-nums;
  }

  @media (max-width: 30rem) {
    .acceptance-controls {
      bottom: max(0.75rem, env(safe-area-inset-bottom));
      width: calc(100% - 1.5rem);
    }
  }
</style>
