<script lang="ts">
  import { onMount } from 'svelte';
  import { fly } from 'svelte/transition';
  import { settingsOpenTick } from '../push/subscribe';
  import IosInstallGuide from './IosInstallGuide.svelte';
  import PushSettings from './PushSettings.svelte';
  import SyncSettings from './SyncSettings.svelte';

  let open = $state(false);
  let iosGuideOpen = $state(false);

  onMount(() => {
    let lastTick = 0;
    return settingsOpenTick.subscribe((tick) => {
      if (tick > 0 && tick !== lastTick) {
        lastTick = tick;
        open = true;
      }
    });
  });

  function close(): void {
    open = false;
  }

  function onKeydown(event: KeyboardEvent): void {
    if (event.key === 'Escape' && open && !iosGuideOpen) {
      event.preventDefault();
      close();
    }
  }
</script>

<svelte:window onkeydown={onKeydown} />

<div class="settings-root" data-scene-swipe-ignore>
  <button
    type="button"
    class="settings-entry"
    aria-expanded={open}
    aria-haspopup="dialog"
    aria-controls="settings-sheet"
    aria-label="设置"
    title="设置"
    onclick={() => (open = !open)}
  >
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path
        d="M12 15.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7Z"
        fill="none"
        stroke="currentColor"
        stroke-width="1.6"
      />
      <path
        d="M19.4 13a7.7 7.7 0 0 0 .05-1l2-1.55-2-3.45-2.4.5a7.4 7.4 0 0 0-1.7-1L15 4h-4l-.35 2.5a7.4 7.4 0 0 0-1.7 1l-2.4-.5-2 3.45L6.55 12a7.7 7.7 0 0 0 0 2l-2 1.55 2 3.45 2.4-.5a7.4 7.4 0 0 0 1.7 1L11 22h4l.35-2.5a7.4 7.4 0 0 0 1.7-1l2.4.5 2-3.45L19.4 13Z"
        fill="none"
        stroke="currentColor"
        stroke-width="1.4"
        stroke-linejoin="round"
      />
    </svg>
  </button>

  {#if open}
    <button
      type="button"
      class="sheet-backdrop"
      aria-label="关闭设置"
      onclick={close}
      transition:fly={{ duration: 160 }}
    ></button>

    <div
      id="settings-sheet"
      class="sheet"
      role="dialog"
      aria-modal="true"
      aria-label="设置"
      transition:fly={{ y: 36, duration: 220 }}
    >
      <header class="sheet-head">
        <h2 class="sheet-title">设置</h2>
        <button type="button" class="sheet-close" aria-label="关闭" onclick={close}>关闭</button>
      </header>

      <div class="sheet-body">
        <PushSettings
          variant="panel"
          onNeedIosGuide={() => (iosGuideOpen = true)}
        />
        <SyncSettings />
      </div>
    </div>
  {/if}

  <IosInstallGuide open={iosGuideOpen} onClose={() => (iosGuideOpen = false)} />
</div>

<style>
  .settings-root {
    position: relative;
    width: 40px;
    height: 40px;
  }

  .settings-entry {
    display: grid;
    place-items: center;
    width: 40px;
    height: 40px;
    margin: 0;
    padding: 0;
    border: 1px solid var(--line);
    border-radius: 50%;
    background: rgba(5, 7, 10, 0.42);
    color: var(--fg-2);
    backdrop-filter: blur(12px);
    -webkit-backdrop-filter: blur(12px);
    cursor: pointer;
    touch-action: manipulation;
    -webkit-tap-highlight-color: transparent;
  }

  .settings-entry:hover,
  .settings-entry[aria-expanded='true'] {
    border-color: rgba(255, 255, 255, 0.34);
    color: var(--fg-1);
  }

  .settings-entry svg {
    width: 18px;
    height: 18px;
  }

  .settings-entry:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 2px;
  }

  .sheet-backdrop {
    position: fixed;
    inset: 0;
    z-index: 32;
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
    z-index: 33;
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
  }

  .sheet-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    padding: 14px 16px 8px;
  }

  .sheet-title {
    margin: 0;
    color: var(--fg-1);
    font-size: 16px;
    font-weight: 600;
    letter-spacing: 0.03em;
  }

  .sheet-close {
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
    overflow-y: auto;
    padding: 4px 16px calc(18px + env(safe-area-inset-bottom, 0px));
    -webkit-overflow-scrolling: touch;
  }
</style>
