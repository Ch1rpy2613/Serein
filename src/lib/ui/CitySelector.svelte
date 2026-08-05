<script lang="ts">
  import { cityFromGeolocation, searchCities, toCity, type GeocodeResult } from '../data/geocode';
  import {
    currentCity,
    isProtectedCity,
    removeSavedCity,
    sameCity,
    savedCities,
    selectCity,
  } from '../stores/app';
  import type { City } from '../contracts';

  const DEBOUNCE_MS = 300;
  const SWIPE_DELETE_PX = 72;

  let open = $state(false);
  let query = $state('');
  let results = $state<GeocodeResult[]>([]);
  let searching = $state(false);
  let locating = $state(false);
  let searchError = $state('');
  let debounceTimer = 0;
  let searchGeneration = 0;

  let swipeCityKey = $state<string | null>(null);
  let swipeDx = $state(0);
  let swipeStartX = 0;
  let swipeStartY = 0;
  let swipePointerId: number | null = null;
  let swipeLocked: 'h' | 'v' | null = null;

  function cityKey(city: City): string {
    return `${city.name}:${city.lat.toFixed(4)}:${city.lon.toFixed(4)}`;
  }

  function closeDrawer(): void {
    open = false;
    query = '';
    results = [];
    searchError = '';
    resetSwipe();
  }

  function toggleDrawer(): void {
    if (open) closeDrawer();
    else open = true;
  }

  function resetSwipe(): void {
    swipeCityKey = null;
    swipeDx = 0;
    swipePointerId = null;
    swipeLocked = null;
  }

  function onSelect(city: City): void {
    selectCity(city);
    closeDrawer();
  }

  function onSearchInput(value: string): void {
    query = value;
    window.clearTimeout(debounceTimer);
    const trimmed = value.trim();
    if (!trimmed) {
      results = [];
      searching = false;
      searchError = '';
      return;
    }
    searching = true;
    searchError = '';
    const generation = ++searchGeneration;
    debounceTimer = window.setTimeout(() => {
      void searchCities(trimmed, 8)
        .then((list) => {
          if (generation !== searchGeneration) return;
          results = list;
          searching = false;
        })
        .catch(() => {
          if (generation !== searchGeneration) return;
          results = [];
          searching = false;
          searchError = '搜索失败';
        });
    }, DEBOUNCE_MS);
  }

  function onLocate(): void {
    if (locating) return;
    if (typeof navigator === 'undefined' || !navigator.geolocation) return;
    locating = true;
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        locating = false;
        onSelect(cityFromGeolocation(pos.coords.latitude, pos.coords.longitude));
      },
      () => {
        // 拒绝 / 失败：静默回退
        locating = false;
      },
      { enableHighAccuracy: false, timeout: 8000, maximumAge: 60_000 },
    );
  }

  function onCardPointerDown(city: City, event: PointerEvent): void {
    if (isProtectedCity(city)) return;
    swipeCityKey = cityKey(city);
    swipeDx = 0;
    swipeStartX = event.clientX;
    swipeStartY = event.clientY;
    swipePointerId = event.pointerId;
    swipeLocked = null;
    (event.currentTarget as HTMLElement).setPointerCapture?.(event.pointerId);
  }

  function onCardPointerMove(event: PointerEvent): void {
    if (swipePointerId !== event.pointerId || !swipeCityKey) return;
    const dx = event.clientX - swipeStartX;
    const dy = event.clientY - swipeStartY;
    if (!swipeLocked) {
      if (Math.abs(dx) < 8 && Math.abs(dy) < 8) return;
      swipeLocked = Math.abs(dx) > Math.abs(dy) * 1.15 ? 'h' : 'v';
    }
    if (swipeLocked !== 'h') return;
    // 右滑删除
    swipeDx = Math.max(0, Math.min(SWIPE_DELETE_PX + 24, dx));
  }

  function onCardPointerUp(city: City, event: PointerEvent): void {
    if (swipePointerId !== event.pointerId) return;
    const shouldDelete = swipeLocked === 'h' && swipeDx >= SWIPE_DELETE_PX;
    resetSwipe();
    if (shouldDelete) removeSavedCity(city);
  }

  function cardOffset(city: City): number {
    return swipeCityKey === cityKey(city) ? swipeDx : 0;
  }
</script>

<div class="city-selector" data-scene-swipe-ignore>
  <button
    type="button"
    class="city-name"
    aria-expanded={open}
    aria-haspopup="dialog"
    aria-controls="city-drawer"
    onclick={toggleDrawer}
  >
    {$currentCity.name}
  </button>

  {#if open}
    <button
      type="button"
      class="city-backdrop"
      aria-label="关闭城市选择"
      onclick={closeDrawer}
    ></button>

    <div
      id="city-drawer"
      class="city-drawer"
      role="dialog"
      aria-label="选择城市"
      aria-modal="true"
    >
      <div class="saved-row" role="list" aria-label="已存城市">
        {#each $savedCities as city (cityKey(city))}
          <div class="saved-card-shell" role="listitem">
            <button
              type="button"
              class="saved-card"
              class:active={sameCity(city, $currentCity)}
              class:protected={isProtectedCity(city)}
              style:transform={`translateX(${cardOffset(city)}px)`}
              aria-current={sameCity(city, $currentCity) ? 'true' : undefined}
              onpointerdown={(e) => onCardPointerDown(city, e)}
              onpointermove={onCardPointerMove}
              onpointerup={(e) => onCardPointerUp(city, e)}
              onpointercancel={resetSwipe}
              onclick={() => {
                if (swipeDx > 8) return;
                onSelect(city);
              }}
            >
              {city.name}
            </button>
            {#if !isProtectedCity(city)}
              <span class="swipe-hint" aria-hidden="true">删除</span>
            {/if}
          </div>
        {/each}
      </div>

      <label class="search-field">
        <span class="visually-hidden">搜索城市</span>
        <input
          type="search"
          placeholder="搜索城市"
          autocomplete="off"
          autocorrect="off"
          spellcheck="false"
          value={query}
          oninput={(e) => onSearchInput(e.currentTarget.value)}
        />
      </label>

      <button type="button" class="locate-item" disabled={locating} onclick={onLocate}>
        {locating ? '定位中…' : '定位'}
      </button>

      {#if searching}
        <p class="search-status">搜索中…</p>
      {:else if searchError}
        <p class="search-status">{searchError}</p>
      {:else if results.length > 0}
        <ul class="search-results">
          {#each results as item (`${item.name}:${item.lat}:${item.lon}`)}
            <li>
              <button type="button" onclick={() => onSelect(toCity(item))}>
                <span class="result-name">{item.name}</span>
                {#if item.subtitle}
                  <span class="result-sub">{item.subtitle}</span>
                {/if}
              </button>
            </li>
          {/each}
        </ul>
      {/if}
    </div>
  {/if}
</div>

<style>
  .city-selector {
    position: fixed;
    top: max(14px, env(safe-area-inset-top, 0px));
    left: max(14px, env(safe-area-inset-left, 0px));
    z-index: 22;
  }

  .city-name {
    margin: 0;
    padding: 0;
    border: 0;
    background: transparent;
    color: var(--fg-1);
    font: inherit;
    font-size: 15px;
    font-weight: 560;
    letter-spacing: 0.04em;
    cursor: pointer;
    text-shadow: 0 1px 3px rgba(0, 0, 0, 0.55);
    -webkit-tap-highlight-color: transparent;
  }

  .city-name:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 4px;
    border-radius: 4px;
  }

  .city-backdrop {
    position: fixed;
    inset: 0;
    z-index: 23;
    margin: 0;
    padding: 0;
    border: 0;
    background: rgba(5, 7, 10, 0.45);
    cursor: pointer;
  }

  .city-drawer {
    position: fixed;
    top: max(48px, calc(env(safe-area-inset-top, 0px) + 40px));
    left: max(12px, env(safe-area-inset-left, 0px));
    z-index: 24;
    display: flex;
    flex-direction: column;
    gap: 12px;
    width: min(320px, calc(100vw - 24px));
    max-height: min(70vh, 420px);
    padding: 14px;
    border: 1px solid var(--line);
    border-radius: 14px;
    background: color-mix(in srgb, var(--bg) 88%, transparent);
    backdrop-filter: blur(16px);
    -webkit-backdrop-filter: blur(16px);
    box-shadow: 0 12px 40px rgba(0, 0, 0, 0.45);
    overflow: hidden;
  }

  .saved-row {
    display: flex;
    gap: 8px;
    overflow-x: auto;
    overflow-y: hidden;
    padding-bottom: 2px;
    scrollbar-width: none;
    -webkit-overflow-scrolling: touch;
  }

  .saved-row::-webkit-scrollbar {
    display: none;
  }

  .saved-card-shell {
    position: relative;
    flex: 0 0 auto;
  }

  .swipe-hint {
    position: absolute;
    top: 50%;
    left: 10px;
    z-index: 0;
    color: var(--fg-2);
    font-size: 9px;
    letter-spacing: 0.06em;
    pointer-events: none;
    transform: translateY(-50%);
  }

  .saved-card {
    position: relative;
    z-index: 1;
    min-width: 64px;
    min-height: 34px;
    padding: 0 12px;
    border: 1px solid var(--line);
    border-radius: 10px;
    background: rgba(5, 7, 10, 0.35);
    color: var(--fg-1);
    font: inherit;
    font-size: 12px;
    letter-spacing: 0.04em;
    cursor: pointer;
    touch-action: pan-y;
    -webkit-tap-highlight-color: transparent;
    transition: border-color 160ms ease;
  }

  .saved-card.active {
    border-color: var(--accent);
    box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--accent) 40%, transparent);
  }

  .saved-card:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 2px;
  }

  .search-field input {
    width: 100%;
    height: 36px;
    padding: 0 12px;
    border: 1px solid var(--line);
    border-radius: 10px;
    background: rgba(5, 7, 10, 0.4);
    color: var(--fg-1);
    font: inherit;
    font-size: 13px;
    outline: none;
  }

  .search-field input::placeholder {
    color: var(--fg-2);
  }

  .search-field input:focus {
    border-color: color-mix(in srgb, var(--accent) 65%, var(--line));
  }

  .locate-item {
    align-self: flex-start;
    min-height: 32px;
    padding: 0 12px;
    border: 1px solid var(--line);
    border-radius: 8px;
    background: transparent;
    color: var(--fg-1);
    font: inherit;
    font-size: 12px;
    letter-spacing: 0.04em;
    cursor: pointer;
  }

  .locate-item:disabled {
    color: var(--fg-2);
    cursor: wait;
  }

  .locate-item:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 2px;
  }

  .search-status {
    margin: 0;
    color: var(--fg-2);
    font-size: 9px;
    letter-spacing: 0.04em;
  }

  .search-results {
    margin: 0;
    padding: 0;
    list-style: none;
    overflow-y: auto;
    max-height: 180px;
  }

  .search-results button {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 2px;
    width: 100%;
    padding: 8px 4px;
    border: 0;
    border-bottom: 1px solid color-mix(in srgb, var(--line) 55%, transparent);
    background: transparent;
    color: inherit;
    font: inherit;
    text-align: left;
    cursor: pointer;
  }

  .search-results button:last-child {
    border-bottom: 0;
  }

  .result-name {
    color: var(--fg-1);
    font-size: 13px;
  }

  .result-sub {
    color: var(--fg-2);
    font-size: 9px;
    letter-spacing: 0.03em;
  }

  .visually-hidden {
    position: absolute;
    width: 1px;
    height: 1px;
    padding: 0;
    margin: -1px;
    overflow: hidden;
    clip: rect(0, 0, 0, 0);
    white-space: nowrap;
    border: 0;
  }
</style>
