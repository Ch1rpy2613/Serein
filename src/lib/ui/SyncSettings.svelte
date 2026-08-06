<script lang="ts">
  import {
    createSyncCode,
    formatSyncCode,
    restoreFromSyncCode,
    syncCode,
    syncMessage,
  } from '../sync';

  let busy = $state(false);
  let restoreInput = $state('');
  let copied = $state(false);

  let displayCode = $derived($syncCode ? formatSyncCode($syncCode) : '');

  async function onCreate(): Promise<void> {
    if (busy) return;
    busy = true;
    try {
      await createSyncCode();
    } finally {
      busy = false;
    }
  }

  async function onRestore(): Promise<void> {
    if (busy || !restoreInput.trim()) return;
    busy = true;
    try {
      const ok = await restoreFromSyncCode(restoreInput);
      if (ok) restoreInput = '';
    } finally {
      busy = false;
    }
  }

  async function onCopy(): Promise<void> {
    if (!$syncCode) return;
    try {
      await navigator.clipboard.writeText($syncCode);
      copied = true;
      setTimeout(() => {
        copied = false;
      }, 1600);
    } catch {
      // fallback: select-less environments
      copied = false;
    }
  }
</script>

<section class="sync-panel" aria-label="跨设备同步">
  <div class="panel-head">
    <h3 class="panel-title">跨设备同步</h3>
  </div>

  <p class="panel-desc">
    8 位同步码即凭证，无需登录。在另一设备输入同一码即可恢复城市与偏好。
  </p>

  {#if $syncCode}
    <div class="code-block">
      <p class="code-label">你的同步码</p>
      <p class="code-display" aria-label="同步码 {displayCode}">{displayCode}</p>
      <p class="code-warn">此码即凭证，请妥善保存</p>
      <button type="button" class="secondary" onclick={() => void onCopy()}>
        {copied ? '已复制' : '复制'}
      </button>
    </div>
    <p class="hint">偏好变更将在约 5 秒后自动上传。</p>
  {:else}
    <button type="button" class="primary" disabled={busy} onclick={() => void onCreate()}>
      {busy ? '生成中…' : '生成同步码'}
    </button>
  {/if}

  <div class="restore">
    <label class="restore-label" for="sync-code-input">输入同步码</label>
    <div class="restore-row">
      <input
        id="sync-code-input"
        class="restore-input"
        type="text"
        inputmode="text"
        autocomplete="off"
        spellcheck="false"
        maxlength="9"
        placeholder="XXXX-XXXX"
        bind:value={restoreInput}
        disabled={busy}
        onkeydown={(e) => {
          if (e.key === 'Enter') void onRestore();
        }}
      />
      <button
        type="button"
        class="secondary"
        disabled={busy || !restoreInput.trim()}
        onclick={() => void onRestore()}
      >
        恢复
      </button>
    </div>
  </div>

  {#if $syncMessage}
    <p class="status" role="status">{$syncMessage}</p>
  {/if}

  <p class="privacy">同步仅含城市列表与偏好设置，不含位置轨迹等敏感信息</p>
</section>

<style>
  .sync-panel {
    display: flex;
    flex-direction: column;
    gap: 10px;
    margin-top: 14px;
    padding: 12px;
    border: 1px solid var(--line);
    border-radius: 12px;
    background: rgba(5, 7, 10, 0.35);
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

  .panel-desc {
    margin: 0;
    color: var(--fg-2);
    font-size: 11px;
    line-height: 1.5;
    letter-spacing: 0.02em;
  }

  .code-block {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 8px;
    padding: 12px 10px;
    border: 1px dashed color-mix(in srgb, var(--accent) 40%, var(--line));
    border-radius: 10px;
    background: rgba(5, 7, 10, 0.28);
  }

  .code-label {
    margin: 0;
    color: var(--fg-2);
    font-size: 10px;
    letter-spacing: 0.08em;
    text-transform: uppercase;
  }

  .code-display {
    margin: 0;
    color: var(--fg-1);
    font-family: ui-monospace, 'SF Mono', Menlo, Consolas, monospace;
    font-size: 28px;
    font-weight: 600;
    letter-spacing: 0.12em;
    font-variant-numeric: tabular-nums;
    line-height: 1.2;
  }

  .code-warn {
    margin: 0;
    color: var(--fg-2);
    font-size: 11px;
    letter-spacing: 0.02em;
    text-align: center;
  }

  .primary,
  .secondary {
    min-height: 34px;
    margin: 0;
    padding: 0 12px;
    border-radius: 8px;
    font: inherit;
    font-size: 12px;
    letter-spacing: 0.04em;
    cursor: pointer;
    -webkit-tap-highlight-color: transparent;
  }

  .primary {
    width: 100%;
    border: 1px solid color-mix(in srgb, var(--accent) 55%, var(--line));
    background: color-mix(in srgb, var(--accent) 12%, transparent);
    color: var(--fg-1);
    font-weight: 520;
  }

  .secondary {
    border: 1px solid var(--line);
    background: transparent;
    color: var(--fg-1);
  }

  .primary:disabled,
  .secondary:disabled {
    opacity: 0.45;
    cursor: not-allowed;
  }

  .primary:focus-visible,
  .secondary:focus-visible,
  .restore-input:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 2px;
  }

  .hint {
    margin: 0;
    color: var(--fg-2);
    font-size: 11px;
    letter-spacing: 0.02em;
  }

  .restore {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }

  .restore-label {
    color: var(--fg-2);
    font-size: 10px;
    letter-spacing: 0.04em;
  }

  .restore-row {
    display: flex;
    gap: 8px;
  }

  .restore-input {
    flex: 1;
    min-width: 0;
    min-height: 34px;
    margin: 0;
    padding: 0 10px;
    border: 1px solid var(--line);
    border-radius: 8px;
    background: rgba(5, 7, 10, 0.45);
    color: var(--fg-1);
    font-family: ui-monospace, 'SF Mono', Menlo, Consolas, monospace;
    font-size: 14px;
    letter-spacing: 0.1em;
    font-variant-numeric: tabular-nums;
  }

  .restore-input::placeholder {
    color: color-mix(in srgb, var(--fg-2) 70%, transparent);
    letter-spacing: 0.08em;
  }

  .status {
    margin: 0;
    color: var(--accent);
    font-size: 11px;
    letter-spacing: 0.02em;
  }

  .privacy {
    margin: 4px 0 0;
    color: color-mix(in srgb, var(--fg-2) 85%, transparent);
    font-size: 10px;
    line-height: 1.45;
    letter-spacing: 0.02em;
  }
</style>
