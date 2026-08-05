<script lang="ts">
  import { onMount } from 'svelte';
  import { get } from 'svelte/store';
  import { cubicOut as easeOutCubic } from 'svelte/easing';
  import { muted, toggleMuted } from './lib/audio';
  import { CITY, type DayData } from './lib/contracts';
  import { mockDayData } from './lib/data/mock';
  import { fetchDayData, getCachedDayUpdatedAt, todayInCity } from './lib/data/openmeteo';
  import LayerHost from './lib/layers/LayerHost.svelte';
  import { LazyWeatherLayer } from './lib/layers/LazyWeatherLayer';
  import { prefersReducedMotion } from './lib/motion';
  import { PerformanceGovernor, type Quality } from './lib/perf';
  import { ProfileLayer } from './lib/scenes/profile/ProfileLayer';
  import { SkyLayer } from './lib/scenes/sky/SkyLayer';
  import {
    collectSceneCanvases,
    downloadShareCard,
    readActiveSceneReading,
  } from './lib/shareCard';
  import { currentTime, isPlaying } from './lib/stores/time';
  import TimeScrubber from './lib/ui/TimeScrubber.svelte';

  interface TransitionAnimation {
    from: number;
    to: number;
    startedAt: number;
    pausedAt: number | null;
    commit: boolean;
    targetIndex: number | null;
  }

  interface ProfileTransition {
    from: number;
    to: number;
    startedAt: number;
    entering: boolean;
  }

  const SWIPE_LOCK_PX = 8;
  const SWIPE_DISTANCE_PX = 60;
  const SWIPE_VELOCITY = 0.3;
  const TRANSITION_MS = 300;
  const PROFILE_ENTER_PX = 80;
  const PROFILE_TRANSITION_MS = 400;
  /** Start on the dependency-free wind renderer; Three scenes remain on demand. */
  const INITIAL_SCENE_INDEX = 2;
  const MOCK_SEED = 78325;

  function initialDayData(): DayData {
    const forcedMock =
      typeof window !== 'undefined' &&
      new URLSearchParams(window.location.search).get('mock') === '1';
    if (forcedMock) {
      const data = mockDayData(MOCK_SEED);
      return { ...data, date: todayInCity() };
    }
    return mockDayData(MOCK_SEED);
  }

  const bootDayData = initialDayData();
  let dayData = $state<DayData>(bootDayData);
  let dataUpdatedAt = $state(getCachedDayUpdatedAt(bootDayData.date));
  const skyLayer = new SkyLayer();
  const profileLayer = new ProfileLayer();
  const scenes = [
    new LazyWeatherLayer({
      id: 'temperature',
      name: '温度',
      preferredSkyDim: 0.55,
      load: async () => {
        const { TemperatureLayer } = await import('./lib/scenes/temperature/TemperatureLayer');
        return new TemperatureLayer();
      },
    }),
    new LazyWeatherLayer({
      id: 'precipitation',
      name: '降水',
      preferredSkyDim: 0.85,
      load: async () => {
        const { PrecipitationLayer } = await import(
          './lib/scenes/precipitation/PrecipitationLayer'
        );
        return new PrecipitationLayer();
      },
    }),
    new LazyWeatherLayer({
      id: 'wind',
      name: '风',
      preferredSkyDim: 0.6,
      load: async () => {
        const { WindLayer } = await import('./lib/scenes/wind/WindLayer');
        return new WindLayer();
      },
    }),
    new LazyWeatherLayer({
      id: 'humidity',
      name: '湿度',
      preferredSkyDim: 0.5,
      load: async () => {
        const { HumidityLayer } = await import('./lib/scenes/humidity/HumidityLayer');
        return new HumidityLayer();
      },
    }),
    new LazyWeatherLayer({
      id: 'radar',
      name: '雷达',
      preferredSkyDim: 1,
      capturesVerticalPan: true,
      load: async () => {
        const { RadarLayer } = await import('./lib/scenes/radar/RadarLayer');
        return new RadarLayer();
      },
    }),
  ];

  let appElement: HTMLElement | null = null;
  let activeIndex = $state(INITIAL_SCENE_INDEX);
  let incomingIndex = $state<number | null>(null);
  let mountedIndices = $state([INITIAL_SCENE_INDEX]);
  let swipeDirection = $state<-1 | 0 | 1>(0);
  let swipeX = $state(0);
  let swiping = $state(false);
  let animating = $state(false);
  let viewportWidth = $state(1);
  let quality = $state<Quality>('high');
  let sharing = $state(false);
  let bootDismissed = $state(false);
  let profileActive = $state(false);
  let profileMounted = $state(false);
  let profileReveal = $state(0);
  let profileAnimating = $state(false);
  let viewportHeight = $state(1);

  let activePointerId: number | null = null;
  let gestureRejected = false;
  /** 'scene' = 左右切场景；'profile-enter' = 底部上滑进剖面 */
  let gestureMode: 'none' | 'scene' | 'profile-enter' = 'none';
  let pointerStartX = 0;
  let pointerStartY = 0;
  let pointerLastX = 0;
  let pointerLastAt = 0;
  let pointerVelocity = 0;
  let transition: TransitionAnimation | null = null;
  let transitionFrame = 0;
  let profileTransition: ProfileTransition | null = null;
  let profileTransitionFrame = 0;

  const lostCanvases = new Set<HTMLCanvasElement>();
  let lostContextCount = $state(0);
  let recoveringContext = $state(false);
  let recoveryTimer = 0;

  $effect(() => {
    const dim = profileActive
      ? profileLayer.preferredSkyDim
      : scenes[activeIndex].preferredSkyDim;
    skyLayer.setDim(dim);
  });

  $effect(() => {
    if ($prefersReducedMotion && $isPlaying) {
      isPlaying.set(false);
    }
  });

  function setQuality(next: Quality): void {
    quality = next;
    skyLayer.setQuality(next);
    profileLayer.setQuality(next);
    for (const scene of scenes) scene.setQuality(next);
  }

  function sceneTransform(index: number): string {
    let offset = 0;
    if (index === activeIndex) {
      offset = swipeX;
    } else if (index === incomingIndex) {
      offset = swipeX + swipeDirection * viewportWidth;
    }
    // 剖面进出时场景轻微下沉/上浮视差
    const dive = profileReveal * 28;
    return `translate3d(${offset.toFixed(2)}px, ${dive.toFixed(2)}px, 0) scale(${(1 - profileReveal * 0.04).toFixed(4)})`;
  }

  function sampleSkyAverage(): [number, number, number] {
    const canvas = appElement?.querySelector('.sky-layer canvas') as HTMLCanvasElement | null;
    if (!canvas || canvas.width < 2 || canvas.height < 2) {
      return [0.35, 0.55, 0.78];
    }
    try {
      const probe = document.createElement('canvas');
      probe.width = 8;
      probe.height = 8;
      const ctx = probe.getContext('2d', { willReadFrequently: true });
      if (!ctx) return [0.35, 0.55, 0.78];
      ctx.drawImage(
        canvas,
        canvas.width * 0.25,
        canvas.height * 0.15,
        canvas.width * 0.5,
        canvas.height * 0.35,
        0,
        0,
        8,
        8,
      );
      const pixels = ctx.getImageData(0, 0, 8, 8).data;
      let r = 0;
      let g = 0;
      let b = 0;
      let n = 0;
      for (let i = 0; i < pixels.length; i += 4) {
        r += pixels[i];
        g += pixels[i + 1];
        b += pixels[i + 2];
        n += 1;
      }
      if (n === 0) return [0.35, 0.55, 0.78];
      return [r / n / 255, g / n / 255, b / n / 255];
    } catch {
      return [0.35, 0.55, 0.78];
    }
  }

  function enterProfile(): void {
    if (profileActive || profileAnimating || scenes[activeIndex].capturesVerticalPan) return;
    const [r, g, b] = sampleSkyAverage();
    profileLayer.setSkyBaseColor(r, g, b);
    profileLayer.resetToGround();
    profileLayer.onRequestExit(exitProfile);
    profileMounted = true;
    profileActive = true;
    profileReveal = 0;
    animateProfileReveal(0, 1, true);
  }

  function exitProfile(): void {
    if (!profileActive || profileAnimating) return;
    animateProfileReveal(profileReveal, 0, false);
  }

  function animateProfileReveal(from: number, to: number, entering: boolean): void {
    cancelProfileTransitionFrame();
    profileTransition = {
      from,
      to,
      startedAt: performance.now(),
      entering,
    };
    profileAnimating = true;
    profileTransitionFrame = requestAnimationFrame(stepProfileTransition);
  }

  function stepProfileTransition(timestamp: number): void {
    profileTransitionFrame = 0;
    const current = profileTransition;
    if (!current || document.hidden) return;
    const duration = $prefersReducedMotion ? 1 : PROFILE_TRANSITION_MS;
    const progress = Math.min(1, Math.max(0, (timestamp - current.startedAt) / duration));
    const eased = easeOutCubic(progress);
    profileReveal = current.from + (current.to - current.from) * eased;
    profileLayer.setReveal(profileReveal);
    if (progress < 1) {
      profileTransitionFrame = requestAnimationFrame(stepProfileTransition);
      return;
    }
    profileReveal = current.to;
    profileLayer.setReveal(profileReveal);
    profileTransition = null;
    profileAnimating = false;
    if (!current.entering) {
      profileActive = false;
      profileMounted = false;
      profileLayer.onRequestExit(null);
    }
  }

  function cancelProfileTransitionFrame(): void {
    if (profileTransitionFrame) cancelAnimationFrame(profileTransitionFrame);
    profileTransitionFrame = 0;
  }

  function prepareIncoming(direction: -1 | 1): void {
    if (swipeDirection === direction && incomingIndex !== null) return;
    swipeDirection = direction;
    const candidate = activeIndex + direction;
    incomingIndex = candidate >= 0 && candidate < scenes.length ? candidate : null;
    mountedIndices =
      incomingIndex === null ? [activeIndex] : [activeIndex, incomingIndex];
  }

  function requestScene(index: number): void {
    if (
      index === activeIndex ||
      index < 0 ||
      index >= scenes.length ||
      swiping ||
      animating ||
      profileActive ||
      profileAnimating
    ) {
      return;
    }
    const direction: -1 | 1 = index > activeIndex ? 1 : -1;
    swipeDirection = direction;
    incomingIndex = index;
    mountedIndices = [activeIndex, index];
    swipeX = 0;
    animateSwipe(-direction * viewportWidth, true, index);
  }

  function animateSwipe(to: number, commit: boolean, targetIndex = incomingIndex): void {
    cancelTransitionFrame();
    transition = {
      from: swipeX,
      to,
      startedAt: performance.now(),
      pausedAt: null,
      commit,
      targetIndex: commit ? targetIndex : null,
    };
    swiping = false;
    animating = true;
    transitionFrame = requestAnimationFrame(stepTransition);
  }

  function stepTransition(timestamp: number): void {
    transitionFrame = 0;
    const current = transition;
    if (!current || document.hidden) return;

    const progress = Math.min(1, Math.max(0, (timestamp - current.startedAt) / TRANSITION_MS));
    swipeX = current.from + (current.to - current.from) * easeOutCubic(progress);
    if (progress < 1) {
      transitionFrame = requestAnimationFrame(stepTransition);
    } else {
      finishTransition();
    }
  }

  function finishTransition(): void {
    const completed = transition;
    transition = null;
    animating = false;
    swipeX = 0;

    if (
      completed?.commit &&
      completed.targetIndex !== null &&
      completed.targetIndex >= 0 &&
      completed.targetIndex < scenes.length
    ) {
      activeIndex = completed.targetIndex;
      mountedIndices = [completed.targetIndex];
    } else {
      mountedIndices = [activeIndex];
    }

    incomingIndex = null;
    swipeDirection = 0;
    queueMicrotask(pruneLostCanvases);
  }

  function cancelTransitionFrame(): void {
    if (transitionFrame) cancelAnimationFrame(transitionFrame);
    transitionFrame = 0;
  }

  function resetGestureImmediately(): void {
    releaseGestureCapture();
    activePointerId = null;
    gestureRejected = false;
    gestureMode = 'none';
    swiping = false;
    swipeX = 0;
    incomingIndex = null;
    swipeDirection = 0;
    mountedIndices = [activeIndex];
  }

  function attachGestures(element: HTMLElement): () => void {
    appElement = element;
    const options: AddEventListenerOptions = { capture: true, passive: false };
    element.addEventListener('pointerdown', onPointerDown, options);
    element.addEventListener('pointermove', onPointerMove, options);
    element.addEventListener('pointerup', onPointerUp, options);
    element.addEventListener('pointercancel', onPointerCancel, options);
    element.addEventListener('lostpointercapture', onLostPointerCapture, options);

    return () => {
      element.removeEventListener('pointerdown', onPointerDown, options);
      element.removeEventListener('pointermove', onPointerMove, options);
      element.removeEventListener('pointerup', onPointerUp, options);
      element.removeEventListener('pointercancel', onPointerCancel, options);
      element.removeEventListener('lostpointercapture', onLostPointerCapture, options);
      resetGestureImmediately();
      appElement = null;
    };
  }

  function onPointerDown(event: PointerEvent): void {
    const target = event.target instanceof Element ? event.target : null;
    if (
      activePointerId !== null ||
      animating ||
      profileAnimating ||
      profileActive ||
      !event.isPrimary ||
      (event.pointerType === 'mouse' && event.button !== 0) ||
      target?.closest('[data-scene-swipe-ignore]')
    ) {
      return;
    }

    activePointerId = event.pointerId;
    gestureRejected = false;
    gestureMode = 'none';
    pointerStartX = pointerLastX = event.clientX;
    pointerStartY = event.clientY;
    pointerLastAt = event.timeStamp;
    pointerVelocity = 0;
  }

  function onPointerMove(event: PointerEvent): void {
    if (event.pointerId !== activePointerId || gestureRejected) return;
    const deltaX = event.clientX - pointerStartX;
    const deltaY = event.clientY - pointerStartY;
    const absoluteX = Math.abs(deltaX);
    const absoluteY = Math.abs(deltaY);

    if (gestureMode === 'none' && !swiping) {
      if (Math.max(absoluteX, absoluteY) < SWIPE_LOCK_PX) return;

      const verticalDominant = absoluteY > absoluteX * 1.15;
      const horizontalDominant = absoluteX > absoluteY * 1.15;
      const fromBottomHalf = pointerStartY >= viewportHeight * 0.5;
      const canEnterProfile =
        !scenes[activeIndex].capturesVerticalPan && fromBottomHalf && verticalDominant;

      if (canEnterProfile) {
        gestureMode = 'profile-enter';
        try {
          appElement?.setPointerCapture(event.pointerId);
        } catch {
          // optional
        }
      } else if (verticalDominant) {
        gestureRejected = true;
        activePointerId = null;
        return;
      } else if (horizontalDominant) {
        gestureMode = 'scene';
        swiping = true;
        prepareIncoming(deltaX < 0 ? 1 : -1);
        try {
          appElement?.setPointerCapture(event.pointerId);
        } catch {
          // Pointer capture is an optimization; document-level propagation still works.
        }
      } else {
        return;
      }
    }

    if (gestureMode === 'profile-enter') {
      event.preventDefault();
      event.stopPropagation();
      return;
    }

    if (gestureMode !== 'scene' && !swiping) return;

    event.preventDefault();
    event.stopPropagation();
    const elapsed = Math.max(1, event.timeStamp - pointerLastAt);
    pointerVelocity = (event.clientX - pointerLastX) / elapsed;
    pointerLastX = event.clientX;
    pointerLastAt = event.timeStamp;

    const direction: -1 | 1 = deltaX < 0 ? 1 : -1;
    if (direction !== swipeDirection) prepareIncoming(direction);
    swipeX = incomingIndex === null ? deltaX * 0.22 : deltaX;
  }

  function onPointerUp(event: PointerEvent): void {
    if (event.pointerId !== activePointerId) return;

    if (gestureMode === 'profile-enter') {
      const deltaY = event.clientY - pointerStartY;
      const deltaX = event.clientX - pointerStartX;
      const upward = -deltaY;
      const verticalDominant = Math.abs(deltaY) > Math.abs(deltaX);
      releaseGestureCapture();
      activePointerId = null;
      gestureMode = 'none';
      if (verticalDominant && upward > PROFILE_ENTER_PX) {
        enterProfile();
      }
      return;
    }

    if (!swiping) {
      activePointerId = null;
      gestureMode = 'none';
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    const rawDistance = Math.abs(event.clientX - pointerStartX);
    const directionalVelocity = -swipeDirection * pointerVelocity;
    const shouldCommit =
      incomingIndex !== null &&
      (rawDistance > SWIPE_DISTANCE_PX || directionalVelocity > SWIPE_VELOCITY);
    const destination = shouldCommit ? -swipeDirection * viewportWidth : 0;
    const target = incomingIndex;

    releaseGestureCapture();
    activePointerId = null;
    gestureMode = 'none';
    animateSwipe(destination, shouldCommit, target);
  }

  function onPointerCancel(event: PointerEvent): void {
    if (event.pointerId !== activePointerId) return;
    if (swiping) {
      event.stopPropagation();
      releaseGestureCapture();
      activePointerId = null;
      gestureMode = 'none';
      animateSwipe(0, false);
    } else {
      releaseGestureCapture();
      activePointerId = null;
      gestureMode = 'none';
    }
  }

  function onLostPointerCapture(event: PointerEvent): void {
    if (event.target !== appElement || event.pointerId !== activePointerId) return;
    activePointerId = null;
    if (swiping) animateSwipe(0, false);
  }

  function releaseGestureCapture(): void {
    if (
      activePointerId !== null &&
      appElement?.hasPointerCapture(activePointerId)
    ) {
      appElement.releasePointerCapture(activePointerId);
    }
  }

  function updateViewport(): void {
    viewportWidth = Math.max(1, appElement?.clientWidth ?? window.innerWidth);
    viewportHeight = Math.max(1, appElement?.clientHeight ?? window.innerHeight);
  }

  function onVisibilityChange(): void {
    if (document.hidden) {
      if (transition) {
        transition.pausedAt = performance.now();
        cancelTransitionFrame();
      }
      if (activePointerId !== null) resetGestureImmediately();
      return;
    }

    if (transition) {
      const now = performance.now();
      if (transition.pausedAt !== null) {
        transition.startedAt += now - transition.pausedAt;
        transition.pausedAt = null;
      }
      if (!transitionFrame) transitionFrame = requestAnimationFrame(stepTransition);
    }
    if (profileTransition && !profileTransitionFrame) {
      profileTransition.startedAt = performance.now() - PROFILE_TRANSITION_MS * profileReveal;
      profileTransitionFrame = requestAnimationFrame(stepProfileTransition);
    }
  }

  function webGLContext(canvas: HTMLCanvasElement): WebGLRenderingContext | WebGL2RenderingContext | null {
    return (
      canvas.getContext('webgl2') ??
      canvas.getContext('webgl') ??
      (canvas.getContext('experimental-webgl') as WebGLRenderingContext | null)
    );
  }

  function onWebGLContextLost(event: Event): void {
    const canvas = event.target;
    if (!(canvas instanceof HTMLCanvasElement)) return;
    window.setTimeout(() => {
      if (!canvas.isConnected) return;
      lostCanvases.add(canvas);
      pruneLostCanvases();
    }, 0);
  }

  function onWebGLContextRestored(event: Event): void {
    const canvas = event.target;
    if (!(canvas instanceof HTMLCanvasElement)) return;
    lostCanvases.delete(canvas);
    pruneLostCanvases();
  }

  function pruneLostCanvases(): void {
    for (const canvas of lostCanvases) {
      const context = canvas.isConnected ? webGLContext(canvas) : null;
      if (!canvas.isConnected || (context && !context.isContextLost())) {
        lostCanvases.delete(canvas);
      }
    }
    lostContextCount = lostCanvases.size;
  }

  function restoreWebGLContexts(): void {
    recoveringContext = true;
    const sceneIds = new Set<string>();
    let skyLost = false;

    for (const canvas of lostCanvases) {
      if (!canvas.isConnected) continue;
      webGLContext(canvas)?.getExtension('WEBGL_lose_context')?.restoreContext();
      skyLost ||= canvas.closest('.sky-layer') !== null;
      const sceneId = canvas.closest<HTMLElement>('.scene-frame')?.dataset.sceneId;
      if (sceneId) sceneIds.add(sceneId);
    }
    if (skyLost) skyLayer.restoreContext();
    for (const sceneId of sceneIds) {
      scenes.find((scene) => scene.id === sceneId)?.recover();
    }
    pruneLostCanvases();

    window.clearTimeout(recoveryTimer);
    recoveryTimer = window.setTimeout(() => {
      pruneLostCanvases();
      recoveringContext = false;
    }, 900);
  }

  function formatClock(minutes: number): string {
    const rounded = Math.round(Math.min(1440, Math.max(0, minutes)));
    const hours = Math.floor(rounded / 60);
    const mins = rounded % 60;
    return `${String(hours).padStart(2, '0')}:${String(mins).padStart(2, '0')}`;
  }

  async function dismissBootSplash(): Promise<void> {
    const boot = document.getElementById('atmos-boot');
    if (!boot || bootDismissed) return;

    try {
      await Promise.all([
        document.fonts?.ready ?? Promise.resolve(),
        scenes[INITIAL_SCENE_INDEX].preload(),
      ]);
    } catch {
      // Still dismiss so the UI is usable if a scene chunk fails.
    }

    await new Promise<void>((resolve) => {
      requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
    });

    boot.dataset.ready = 'true';
    window.setTimeout(() => {
      boot.hidden = true;
      boot.remove();
      bootDismissed = true;
    }, 400);
  }

  async function shareCurrentScene(): Promise<void> {
    if (sharing || !appElement) return;
    sharing = true;
    try {
      await downloadShareCard({
        canvases: collectSceneCanvases(appElement),
        cityName: CITY.name,
        date: dayData.date,
        sceneName: scenes[activeIndex].name,
        reading: readActiveSceneReading(appElement),
        timeLabel: formatClock(get(currentTime)),
      });
    } catch (error) {
      console.warn('[Atmos] 分享卡片生成失败', error);
    } finally {
      sharing = false;
    }
  }

  function onMuteToggle(): void {
    toggleMuted();
  }

  async function runMountUnmountStress(cycles = 20): Promise<{
    cycles: number;
    scenes: string[];
    ok: boolean;
  }> {
    const previousActive = activeIndex;
    const sceneIds: string[] = [];
    try {
      for (let cycle = 0; cycle < cycles; cycle += 1) {
        for (let index = 0; index < scenes.length; index += 1) {
          activeIndex = index;
          mountedIndices = [index];
          incomingIndex = null;
          swipeDirection = 0;
          swipeX = 0;
          sceneIds.push(scenes[index].id);
          await scenes[index].preload();
          await scenes[index].whenReady();
          await new Promise<void>((resolve) => {
            requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
          });
        }
      }
      activeIndex = previousActive;
      mountedIndices = [previousActive];
      await scenes[previousActive].whenReady();
      return { cycles, scenes: sceneIds, ok: true };
    } catch (error) {
      console.error('[Atmos] mount/unmount stress failed', error);
      activeIndex = previousActive;
      mountedIndices = [previousActive];
      return { cycles, scenes: sceneIds, ok: false };
    }
  }

  onMount(() => {
    updateViewport();
    setQuality(quality);
    const governor = new PerformanceGovernor(setQuality, quality);
    governor.start();
    void dismissBootSplash();

    let cancelled = false;
    void fetchDayData()
      .then((data) => {
        if (cancelled) return;
        dayData = data;
        dataUpdatedAt = getCachedDayUpdatedAt(data.date);
      })
      .catch((error: unknown) => {
        console.warn('[Atmos] 天气数据加载失败，保留当前数据', error);
      });

    window.addEventListener('resize', updateViewport, { passive: true });
    window.visualViewport?.addEventListener('resize', updateViewport, { passive: true });
    document.addEventListener('visibilitychange', onVisibilityChange);
    document.addEventListener('webglcontextlost', onWebGLContextLost, true);
    document.addEventListener('webglcontextrestored', onWebGLContextRestored, true);

    const stressEnabled =
      import.meta.env.DEV ||
      new URLSearchParams(window.location.search).has('stress');
    if (stressEnabled) {
      (
        window as unknown as {
          __SEREIN_STRESS__?: typeof runMountUnmountStress;
        }
      ).__SEREIN_STRESS__ = runMountUnmountStress;
    }

    return () => {
      cancelled = true;
      governor.stop();
      cancelTransitionFrame();
      cancelProfileTransitionFrame();
      profileLayer.onRequestExit(null);
      window.clearTimeout(recoveryTimer);
      window.removeEventListener('resize', updateViewport);
      window.visualViewport?.removeEventListener('resize', updateViewport);
      document.removeEventListener('visibilitychange', onVisibilityChange);
      document.removeEventListener('webglcontextlost', onWebGLContextLost, true);
      document.removeEventListener('webglcontextrestored', onWebGLContextRestored, true);
      delete (window as unknown as { __SEREIN_STRESS__?: unknown }).__SEREIN_STRESS__;
    };
  });
</script>

<svelte:head>
  <title>Atmos</title>
  <meta name="theme-color" content="#05070a" />
</svelte:head>

<main
  class="app-shell"
  class:profile-open={profileActive}
  data-active-scene={profileActive ? 'profile' : scenes[activeIndex].id}
  data-quality={quality}
  {@attach attachGestures}
>
  <div class="sky-layer" aria-hidden="true">
    <LayerHost layer={skyLayer} data={dayData} {quality} />
  </div>

  <section class="scene-stage" aria-label={`${scenes[activeIndex].name}天气场景`}>
    {#each mountedIndices as sceneIndex (scenes[sceneIndex].id)}
      <div
        class:interactive={sceneIndex === activeIndex && !swiping && !animating && !profileActive}
        class="scene-frame"
        data-scene-id={scenes[sceneIndex].id}
        aria-hidden={sceneIndex !== activeIndex || profileActive}
        style:transform={sceneTransform(sceneIndex)}
        style:opacity={1 - profileReveal * 0.55}
      >
        <LayerHost layer={scenes[sceneIndex]} data={dayData} {quality} />
      </div>
    {/each}
  </section>

  {#if profileMounted}
    <section
      class="profile-stage"
      aria-label="大气垂直剖面"
      style:opacity={profileReveal}
      style:transform={`translate3d(0, ${(1 - profileReveal) * 12}%, 0) scale(${(0.96 + profileReveal * 0.04).toFixed(4)})`}
    >
      <LayerHost layer={profileLayer} data={dayData} {quality} />
    </section>
  {/if}

  <div class="timeline-layer" data-scene-swipe-ignore>
    <TimeScrubber date={dayData.date} updatedAt={dataUpdatedAt} />
  </div>

  <div class="chrome-actions" data-scene-swipe-ignore>
    <button
      type="button"
      class="chrome-button"
      aria-pressed={$muted}
      aria-label={$muted ? '取消静音' : '全局静音'}
      title={$muted ? '取消静音' : '全局静音'}
      onclick={onMuteToggle}
    >
      {#if $muted}
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="M11 5 6 9H3v6h3l5 4V5Z"></path>
          <path d="m16 9 5 6m0-6-5 6"></path>
        </svg>
      {:else}
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="M11 5 6 9H3v6h3l5 4V5Z"></path>
          <path d="M15.5 8.5a5 5 0 0 1 0 7M18 6a8.5 8.5 0 0 1 0 12"></path>
        </svg>
      {/if}
    </button>
    <button
      type="button"
      class="chrome-button"
      aria-label="分享当前场景卡片"
      title="分享卡片"
      disabled={sharing}
      onclick={() => void shareCurrentScene()}
    >
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="M12 3v12"></path>
        <path d="m7 8 5-5 5 5"></path>
        <path d="M5 14v5a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-5"></path>
      </svg>
    </button>
  </div>

  <nav
    class="scene-switcher"
    class:dimmed={profileActive}
    aria-label="天气场景"
    data-scene-swipe-ignore
    aria-hidden={profileActive}
  >
    {#each scenes as scene, sceneIndex (scene.id)}
      <button
        type="button"
        class:active={sceneIndex === activeIndex && !profileActive}
        aria-current={sceneIndex === activeIndex && !profileActive ? 'page' : undefined}
        disabled={profileActive}
        onclick={() => requestScene(sceneIndex)}
      >
        {scene.name}
      </button>
    {/each}
  </nav>

  {#if lostContextCount > 0}
    <section class="context-recovery" role="alert" aria-live="assertive" data-scene-swipe-ignore>
      <p>图形渲染已暂停</p>
      <span>WebGL context 已丢失，天气数据与时间仍会保留。</span>
      <button type="button" onclick={restoreWebGLContexts} disabled={recoveringContext}>
        {recoveringContext ? '正在恢复…' : '恢复渲染'}
      </button>
    </section>
  {/if}
</main>

<style>
  .app-shell {
    position: relative;
    width: 100%;
    height: 100dvh;
    min-height: 100%;
    overflow: hidden;
    background: var(--bg);
    color: var(--fg-1);
    isolation: isolate;
    overscroll-behavior: none;
    touch-action: manipulation;
  }

  .sky-layer,
  .scene-stage,
  .scene-frame {
    position: absolute;
    inset: 0;
  }

  .sky-layer {
    z-index: 0;
    overflow: hidden;
    background: var(--bg);
    pointer-events: none;
  }

  .scene-stage {
    z-index: 1;
    overflow: hidden;
    background: transparent;
  }

  .scene-frame {
    overflow: hidden;
    background: transparent;
    pointer-events: none;
    will-change: transform, opacity;
    transform-origin: 50% 60%;
  }

  .scene-frame.interactive {
    pointer-events: auto;
  }

  .profile-stage {
    position: absolute;
    inset: 0;
    z-index: 5;
    overflow: hidden;
    pointer-events: auto;
    will-change: transform, opacity;
    transform-origin: 50% 80%;
  }

  .app-shell.profile-open .chrome-actions {
    opacity: 0.35;
    pointer-events: none;
  }

  .timeline-layer {
    position: relative;
    z-index: 10;
  }

  .chrome-actions {
    position: fixed;
    right: max(12px, env(safe-area-inset-right, 0px));
    bottom: calc(130px + env(safe-area-inset-bottom, 0px));
    z-index: 21;
    display: flex;
    gap: 8px;
  }

  .chrome-button {
    display: grid;
    place-items: center;
    width: 40px;
    height: 40px;
    padding: 0;
    border: 1px solid var(--line);
    border-radius: 50%;
    background: rgba(5, 7, 10, 0.42);
    color: var(--fg-2);
    cursor: pointer;
    touch-action: manipulation;
    -webkit-tap-highlight-color: transparent;
    backdrop-filter: blur(12px);
    -webkit-backdrop-filter: blur(12px);
  }

  .chrome-button:hover,
  .chrome-button[aria-pressed='true'] {
    border-color: rgba(255, 255, 255, 0.34);
    color: var(--fg-1);
  }

  .chrome-button:disabled {
    cursor: wait;
    opacity: 0.55;
  }

  .chrome-button:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 2px;
  }

  .chrome-button svg {
    width: 18px;
    height: 18px;
    overflow: visible;
  }

  .chrome-button path {
    fill: none;
    stroke: currentColor;
    stroke-linecap: round;
    stroke-linejoin: round;
    stroke-width: 1.6;
  }

  .scene-switcher {
    position: fixed;
    bottom: calc(88px + env(safe-area-inset-bottom, 0px));
    left: 50%;
    z-index: 20;
    display: flex;
    align-items: stretch;
    justify-content: center;
    height: 34px;
    padding: 0 8px;
    background: linear-gradient(180deg, transparent, rgba(5, 7, 10, 0.42));
    transform: translateX(-50%);
    white-space: nowrap;
    touch-action: manipulation;
  }

  .scene-switcher button {
    position: relative;
    min-width: 52px;
    padding: 0 11px;
    border: 0;
    background: transparent;
    color: var(--fg-2);
    font: inherit;
    font-size: 11px;
    font-weight: 520;
    letter-spacing: 0.04em;
    cursor: pointer;
    -webkit-tap-highlight-color: transparent;
  }

  .scene-switcher button::after {
    position: absolute;
    right: 10px;
    bottom: 0;
    left: 10px;
    height: 2px;
    background: var(--accent);
    content: '';
    opacity: 0;
    transform: scaleX(0.45);
    transition:
      opacity 140ms ease,
      transform 180ms ease;
  }

  .scene-switcher button.active {
    color: var(--fg-1);
  }

  .scene-switcher button.active::after {
    opacity: 1;
    transform: scaleX(1);
  }

  .scene-switcher.dimmed {
    opacity: 0.28;
    pointer-events: none;
  }

  .scene-switcher button:disabled {
    cursor: default;
  }

  .scene-switcher button:focus-visible,
  .context-recovery button:focus-visible {
    border-radius: 4px;
    outline: 2px solid var(--accent);
    outline-offset: 2px;
  }

  :global(.serein-layer-status) {
    position: absolute;
    top: 50%;
    left: 50%;
    z-index: 4;
    margin: 0;
    color: var(--fg-2);
    font-size: 11px;
    letter-spacing: 0.08em;
    transform: translate(-50%, -50%);
  }

  :global(.serein-layer-status[data-error='true']) {
    color: var(--fg-1);
  }

  .context-recovery {
    position: fixed;
    top: 50%;
    left: 50%;
    z-index: 30;
    display: grid;
    box-sizing: border-box;
    width: min(330px, calc(100% - 40px));
    padding: 20px;
    gap: 8px;
    border: 1px solid var(--line);
    border-radius: 14px;
    background: rgba(5, 7, 10, 0.92);
    box-shadow: 0 22px 70px rgba(0, 0, 0, 0.48);
    text-align: center;
    transform: translate(-50%, -50%);
    backdrop-filter: blur(20px);
    -webkit-backdrop-filter: blur(20px);
  }

  .context-recovery p {
    margin: 0;
    color: var(--fg-1);
    font-size: 15px;
    font-weight: 600;
  }

  .context-recovery span {
    color: var(--fg-2);
    font-size: 11px;
    line-height: 1.55;
  }

  .context-recovery button {
    min-height: 38px;
    margin-top: 6px;
    border: 1px solid color-mix(in srgb, var(--accent) 55%, transparent);
    border-radius: 9px;
    background: color-mix(in srgb, var(--accent) 13%, transparent);
    color: var(--fg-1);
    font: inherit;
    font-size: 12px;
    cursor: pointer;
  }

  .context-recovery button:disabled {
    cursor: wait;
    opacity: 0.62;
  }

  @media (max-width: 30rem) {
    .scene-switcher {
      right: 0;
      left: 0;
      padding: 0 4px;
      transform: none;
    }

    .scene-switcher button {
      min-width: 0;
      padding: 0 8px;
      flex: 1;
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .scene-switcher button::after {
      transition-duration: 0.01ms;
    }
  }
</style>
