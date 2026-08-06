<script lang="ts">
  import {
    ALL_LEVELS,
    needsIosInstallGuide,
    pushError,
    pushLevels,
    pushStatus,
    pushSubscribed,
    requestOpenSettings,
    subscribeToPush,
    unsubscribeFromPush,
    updatePushPreferences,
    type PushAlertLevel,
  } from '../push/subscribe';

  interface Props {
    /** Compact footer CTA for alert sheet */
    variant?: 'panel' | 'cta';
    onNeedIosGuide?: () => void;
  }

  let { variant = 'panel', onNeedIosGuide }: Props = $props();

  const LEVEL_LABELS: Record<PushAlertLevel, string> = {
    yellow: '黄色',
    orange: '橙色',
    red: '红色',
  };

  let busy = $derived($pushStatus === 'busy');
  let unsupported = $derived($pushStatus === 'unsupported');
  let denied = $derived($pushStatus === 'denied');

  function toggleLevel(level: PushAlertLevel): void {
    const current = $pushLevels;
    const next = current.includes(level)
      ? current.filter((l) => l !== level)
      : [...current, level];
    // Keep at least one level
    const ensured = next.length > 0 ? next : ([level] as PushAlertLevel[]);
    pushLevels.set(ensured);
    if ($pushSubscribed) {
      void updatePushPreferences(ensured);
    }
  }

  async function onEnable(): Promise<void> {
    if (unsupported) return;
    if (needsIosInstallGuide()) {
      onNeedIosGuide?.();
      return;
    }
    await subscribeToPush($pushLevels);
  }

  async function onDisable(): Promise<void> {
    await unsubscribeFromPush();
  }

  async function onCtaClick(): Promise<void> {
    if (unsupported) return;
    if ($pushSubscribed) {
      requestOpenSettings();
      return;
    }
    await onEnable();
  }
</script>

{#if variant === 'cta'}
  <div class="cta-wrap">
    <button
      type="button"
      class="cta-btn"
      class:disabled={unsupported}
      disabled={unsupported || busy}
      aria-disabled={unsupported}
      title={unsupported ? '此浏览器不支持推送' : undefined}
      onclick={() => void onCtaClick()}
    >
      {#if unsupported}
        此浏览器不支持推送
      {:else if busy}
        处理中…
      {:else if $pushSubscribed}
        推送已开启 · 管理
      {:else}
        开启预警推送
      {/if}
    </button>
    {#if unsupported}
      <p class="hint">当前环境无 PushManager，无法订阅。</p>
    {:else if needsIosInstallGuide() && !$pushSubscribed}
      <p class="hint">需先添加到主屏幕（PWA）后才能收推送。</p>
    {/if}
  </div>
{:else}
  <section class="push-panel" aria-label="预警推送">
    <div class="panel-head">
      <h3 class="panel-title">预警推送</h3>
      {#if $pushSubscribed}
        <button
          type="button"
          class="toggle on"
          disabled={busy}
          aria-pressed="true"
          onclick={() => void onDisable()}
        >
          已开启
        </button>
      {:else}
        <button
          type="button"
          class="toggle"
          class:disabled={unsupported}
          disabled={unsupported || busy || denied}
          aria-pressed="false"
          title={unsupported ? '此浏览器不支持推送' : denied ? '通知权限已拒绝' : undefined}
          onclick={() => void onEnable()}
        >
          {#if unsupported}
            不支持
          {:else if denied}
            已拒绝
          {:else if busy}
            …
          {:else}
            开启
          {/if}
        </button>
      {/if}
    </div>

    <p class="panel-desc">
      {#if unsupported}
        此浏览器不支持 Web Push。
      {:else if denied}
        通知权限已被拒绝，请在系统设置中允许后再试。
      {:else if needsIosInstallGuide() && !$pushSubscribed}
        iOS 需先「添加到主屏幕」，再在主屏幕 App 内开启推送。
      {:else}
        订阅后，所选级别的天气预警将以系统通知送达。
      {/if}
    </p>

    {#if needsIosInstallGuide() && !$pushSubscribed && !unsupported}
      <button type="button" class="guide-link" onclick={() => onNeedIosGuide?.()}>
        查看添加主屏幕步骤
      </button>
    {/if}

    <fieldset class="levels" disabled={unsupported || busy}>
      <legend class="levels-legend">推送级别</legend>
      {#each ALL_LEVELS as level (level)}
        <label class="level-item">
          <input
            type="checkbox"
            checked={$pushLevels.includes(level)}
            onchange={() => toggleLevel(level)}
          />
          <span>{LEVEL_LABELS[level]}</span>
        </label>
      {/each}
    </fieldset>

    {#if $pushError}
      <p class="error" role="alert">{$pushError}</p>
    {/if}
  </section>
{/if}

<style>
  .cta-wrap {
    margin-top: 16px;
    display: flex;
    flex-direction: column;
    gap: 8px;
  }

  .cta-btn {
    width: 100%;
    min-height: 40px;
    margin: 0;
    padding: 0 14px;
    border: 1px solid color-mix(in srgb, var(--accent) 55%, var(--line));
    border-radius: 10px;
    background: color-mix(in srgb, var(--accent) 12%, transparent);
    color: var(--fg-1);
    font: inherit;
    font-size: 13px;
    font-weight: 520;
    letter-spacing: 0.04em;
    cursor: pointer;
    -webkit-tap-highlight-color: transparent;
  }

  .cta-btn:disabled,
  .cta-btn.disabled {
    opacity: 0.45;
    cursor: not-allowed;
    border-color: var(--line);
    background: transparent;
    color: var(--fg-2);
  }

  .cta-btn:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 2px;
  }

  .hint {
    margin: 0;
    color: var(--fg-2);
    font-size: 11px;
    letter-spacing: 0.03em;
    line-height: 1.45;
  }

  .push-panel {
    display: flex;
    flex-direction: column;
    gap: 10px;
    padding: 12px;
    border: 1px solid var(--line);
    border-radius: 12px;
    background: var(--chrome);
  }

  .panel-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 10px;
  }

  .panel-title {
    margin: 0;
    color: var(--fg-1);
    font-size: 13px;
    font-weight: 560;
    letter-spacing: 0.04em;
  }

  .toggle {
    min-height: 28px;
    padding: 0 10px;
    border: 1px solid var(--line);
    border-radius: 8px;
    background: transparent;
    color: var(--fg-1);
    font: inherit;
    font-size: 11px;
    letter-spacing: 0.04em;
    cursor: pointer;
  }

  .toggle.on {
    border-color: color-mix(in srgb, var(--accent) 55%, var(--line));
    color: var(--accent);
  }

  .toggle:disabled,
  .toggle.disabled {
    opacity: 0.45;
    cursor: not-allowed;
    color: var(--fg-2);
  }

  .toggle:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 2px;
  }

  .panel-desc {
    margin: 0;
    color: var(--fg-2);
    font-size: 11px;
    line-height: 1.5;
    letter-spacing: 0.02em;
  }

  .guide-link {
    align-self: flex-start;
    margin: 0;
    padding: 0;
    border: 0;
    background: transparent;
    color: var(--accent);
    font: inherit;
    font-size: 12px;
    letter-spacing: 0.03em;
    cursor: pointer;
    text-decoration: underline;
    text-underline-offset: 3px;
  }

  .guide-link:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 2px;
    border-radius: 4px;
  }

  .levels {
    margin: 0;
    padding: 0;
    border: 0;
    display: flex;
    flex-wrap: wrap;
    gap: 8px 14px;
  }

  .levels-legend {
    width: 100%;
    margin: 0 0 4px;
    padding: 0;
    color: var(--fg-2);
    font-size: 10px;
    letter-spacing: 0.04em;
  }

  .level-item {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    color: var(--fg-1);
    font-size: 12px;
    letter-spacing: 0.03em;
    cursor: pointer;
  }

  .level-item input {
    accent-color: var(--accent);
  }

  .error {
    margin: 0;
    color: #ff8f8f;
    font-size: 11px;
    letter-spacing: 0.02em;
  }
</style>
