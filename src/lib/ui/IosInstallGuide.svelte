<script lang="ts">
  interface Props {
    open: boolean;
    onClose: () => void;
  }

  let { open, onClose }: Props = $props();

  function onKeydown(event: KeyboardEvent): void {
    if (event.key === 'Escape' && open) {
      event.preventDefault();
      onClose();
    }
  }
</script>

<svelte:window onkeydown={onKeydown} />

{#if open}
  <button
    type="button"
    class="guide-backdrop"
    data-scene-swipe-ignore
    aria-label="关闭添加主屏幕引导"
    onclick={onClose}
  ></button>

  <div
    class="guide"
    data-scene-swipe-ignore
    role="dialog"
    aria-modal="true"
    aria-labelledby="ios-install-title"
  >
    <header class="guide-head">
      <h2 id="ios-install-title">先添加到主屏幕才能收推送</h2>
      <button type="button" class="guide-close" aria-label="关闭" onclick={onClose}>关闭</button>
    </header>

    <p class="guide-lead">iOS 仅在主屏幕 App（PWA）内支持 Web Push。按下面三步操作后再回来开启。</p>

    <ol class="steps">
      <li class="step">
        <span class="step-num" aria-hidden="true">1</span>
        <div class="step-body">
          <p class="step-title">打开分享菜单</p>
          <p class="step-desc">轻点 Safari 底栏中间的「分享」按钮（方框向上箭头）。</p>
          <div class="step-visual" aria-hidden="true">
            <svg viewBox="0 0 64 40" class="icon-share">
              <rect x="18" y="14" width="28" height="22" rx="4" fill="none" stroke="currentColor" stroke-width="2" />
              <path
                d="M32 4v22M32 4l-7 7M32 4l7 7"
                fill="none"
                stroke="currentColor"
                stroke-width="2"
                stroke-linecap="round"
                stroke-linejoin="round"
              />
            </svg>
          </div>
        </div>
      </li>
      <li class="step">
        <span class="step-num" aria-hidden="true">2</span>
        <div class="step-body">
          <p class="step-title">添加到主屏幕</p>
          <p class="step-desc">在菜单中向下滑动，选择「添加到主屏幕」。</p>
          <div class="step-visual chip" aria-hidden="true">
            <span class="plus">＋</span>
            <span>添加到主屏幕</span>
          </div>
        </div>
      </li>
      <li class="step">
        <span class="step-num" aria-hidden="true">3</span>
        <div class="step-body">
          <p class="step-title">从主屏幕打开</p>
          <p class="step-desc">回到桌面点开 Serein 图标，再在 App 内开启预警推送。</p>
          <div class="step-visual home" aria-hidden="true">
            <span class="home-icon">S</span>
            <span class="home-label">Serein</span>
          </div>
        </div>
      </li>
    </ol>
  </div>
{/if}

<style>
  .guide-backdrop {
    position: fixed;
    inset: 0;
    z-index: 40;
    margin: 0;
    padding: 0;
    border: 0;
    background: rgba(5, 7, 10, 0.55);
    cursor: pointer;
  }

  .guide {
    position: fixed;
    left: 50%;
    top: 50%;
    z-index: 41;
    display: flex;
    flex-direction: column;
    gap: 14px;
    width: min(360px, calc(100vw - 28px));
    max-height: min(80vh, 560px);
    padding: 16px 16px calc(16px + env(safe-area-inset-bottom, 0px));
    border: 1px solid var(--line);
    border-radius: 16px;
    background: color-mix(in srgb, var(--bg) 92%, transparent);
    backdrop-filter: blur(18px);
    -webkit-backdrop-filter: blur(18px);
    box-shadow: 0 16px 48px rgba(0, 0, 0, 0.5);
    transform: translate(-50%, -50%);
    overflow-y: auto;
    font-family: -apple-system, 'SF Pro', Inter, 'PingFang SC', sans-serif;
  }

  .guide-head {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 12px;
  }

  .guide-head h2 {
    margin: 0;
    color: var(--fg-1);
    font-size: 16px;
    font-weight: 600;
    letter-spacing: 0.02em;
    line-height: 1.35;
  }

  .guide-close {
    flex: 0 0 auto;
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

  .guide-close:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 2px;
  }

  .guide-lead {
    margin: 0;
    color: var(--fg-2);
    font-size: 12px;
    line-height: 1.55;
    letter-spacing: 0.02em;
  }

  .steps {
    margin: 0;
    padding: 0;
    list-style: none;
    display: flex;
    flex-direction: column;
    gap: 12px;
  }

  .step {
    display: flex;
    gap: 12px;
    align-items: flex-start;
    padding: 12px;
    border: 1px solid var(--line);
    border-radius: 12px;
    background: rgba(5, 7, 10, 0.35);
  }

  .step-num {
    flex: 0 0 auto;
    display: grid;
    place-items: center;
    width: 22px;
    height: 22px;
    border-radius: 50%;
    border: 1px solid color-mix(in srgb, var(--accent) 55%, var(--line));
    color: var(--accent);
    font-size: 11px;
    font-variant-numeric: tabular-nums;
  }

  .step-body {
    flex: 1 1 auto;
    min-width: 0;
  }

  .step-title {
    margin: 0 0 4px;
    color: var(--fg-1);
    font-size: 13px;
    font-weight: 560;
    letter-spacing: 0.03em;
  }

  .step-desc {
    margin: 0 0 10px;
    color: var(--fg-2);
    font-size: 12px;
    line-height: 1.5;
  }

  .step-visual {
    display: flex;
    align-items: center;
    justify-content: center;
    min-height: 44px;
    border-radius: 10px;
    background: rgba(126, 200, 255, 0.06);
    color: var(--accent);
  }

  .icon-share {
    width: 64px;
    height: 40px;
  }

  .step-visual.chip {
    gap: 8px;
    color: var(--fg-1);
    font-size: 12px;
    letter-spacing: 0.03em;
  }

  .plus {
    color: var(--accent);
    font-size: 16px;
    line-height: 1;
  }

  .step-visual.home {
    flex-direction: column;
    gap: 4px;
    padding: 8px 0;
  }

  .home-icon {
    display: grid;
    place-items: center;
    width: 36px;
    height: 36px;
    border-radius: 9px;
    background: color-mix(in srgb, var(--accent) 22%, var(--bg));
    color: var(--fg-1);
    font-size: 16px;
    font-weight: 600;
    letter-spacing: 0.06em;
  }

  .home-label {
    color: var(--fg-2);
    font-size: 10px;
    letter-spacing: 0.04em;
  }
</style>
