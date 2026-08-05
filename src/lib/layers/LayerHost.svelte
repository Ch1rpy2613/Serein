<script lang="ts">
  import { onDestroy, onMount } from 'svelte';
  import { get } from 'svelte/store';
  import type { ClimateNormals, DayData, WeatherLayer } from '../contracts';
  import { appMode } from '../stores/app';
  import { currentTime } from '../stores/time';

  interface Props {
    /** 当前场景层，null 表示空场景 */
    layer?: WeatherLayer | null;
    data?: DayData | null;
    quality?: 'low' | 'medium' | 'high';
    /** 气候平均（幽灵曲线）；null 表示尚未就绪或不可用 */
    climateNormals?: ClimateNormals | null;
    /** 气候平均首次计算中 */
    climateLoading?: boolean;
  }

  let {
    layer = null,
    data = null,
    quality = 'high',
    climateNormals = null,
    climateLoading = false,
  }: Props = $props();

  let container: HTMLDivElement | undefined = $state();
  let mounted: WeatherLayer | null = null;
  /** 页面不可见时暂停向场景推送时间 */
  let forwarding = true;

  function attach(next: WeatherLayer | null) {
    if (mounted === next || !container) return;
    if (mounted) {
      mounted.unmount();
      mounted = null;
    }
    if (next) {
      next.mount(container);
      mounted = next;
      if (data) next.setData(data);
      next.setQuality(quality);
      next.setTime(get(currentTime));
      next.setMode?.(get(appMode));
      next.setClimateNormals?.(climateNormals);
      next.setClimateLoading?.(climateLoading);
    }
  }

  // 挂载 / 切换场景层
  $effect(() => {
    attach(layer);
  });

  // 数据与画质下发
  $effect(() => {
    if (mounted && data) mounted.setData(data);
  });
  $effect(() => {
    if (mounted) mounted.setQuality(quality);
  });
  $effect(() => {
    mounted?.setMode?.($appMode);
  });
  $effect(() => {
    mounted?.setClimateNormals?.(climateNormals);
  });
  $effect(() => {
    mounted?.setClimateLoading?.(climateLoading);
  });

  // 全局时间 → 场景
  const unsubscribe = currentTime.subscribe((minutes) => {
    if (mounted && forwarding) mounted.setTime(minutes);
  });

  function onVisibility() {
    forwarding = !document.hidden;
    if (forwarding && mounted) mounted.setTime(get(currentTime));
  }

  onMount(() => {
    document.addEventListener('visibilitychange', onVisibility);
    return () => document.removeEventListener('visibilitychange', onVisibility);
  });

  onDestroy(() => {
    unsubscribe();
    if (mounted) {
      mounted.unmount();
      mounted = null;
    }
  });
</script>

<div class="layer-host" bind:this={container}></div>

<style>
  .layer-host {
    position: absolute;
    inset: 0;
    overflow: hidden;
  }
</style>
