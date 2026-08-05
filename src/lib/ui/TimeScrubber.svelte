<script lang="ts">
  import { onMount } from 'svelte';
  import { cubicOut as easeOutCubic } from 'svelte/easing';
  import { on } from 'svelte/events';
  import { CITY } from '../contracts';
  import { solarPosition } from '../scenes/sky/solarPosition';
  import { prefersReducedMotion } from '../motion';
  import { currentTime, isPlaying, playSpeed } from '../stores/time';

  interface Props {
    /** ISO local date used by both the readout and solar calculation. */
    date?: string;
    /** 数据最近更新时刻，用于 Open-Meteo 出处行 */
    updatedAt?: Date | number | string | null;
  }

  interface SolarDay {
    sunrise: number | null;
    sunset: number | null;
    arcStart: number | null;
    arcEnd: number | null;
    alwaysDay: boolean;
  }

  interface SolarVisual {
    x: number;
    y: number;
    daytime: boolean;
  }

  const DAY_MINUTES = 24 * 60;
  const DEFAULT_TIME = 8 * 60;
  const CLICK_ANIMATION_MS = 250;
  const MAX_PLAYBACK_DT_MS = 100;
  const LONG_PRESS_MS = 500;
  const LONG_PRESS_MOVE_PX = 8;
  const DRAG_THRESHOLD_PX = 4;
  const SNAP_DISTANCE_PX = 8;
  const SNAP_RELEASE_PX = 12;
  const SNAP_MAX_VELOCITY = 0.45;
  const SNAP_RELEASE_VELOCITY = 0.75;
  const PLAY_SPEEDS = [0.5, 1, 4] as const;
  const HOURS = Array.from({ length: 25 }, (_, hour) => hour);
  const LABELED_HOURS = HOURS.filter((hour) => hour % 2 === 0);

  type PlaybackSpeed = (typeof PLAY_SPEEDS)[number];

  let { date, updatedAt = null }: Props = $props();
  const componentId = $props.id();
  const speedPopupId = `${componentId}-speed-popup`;
  const speedPopupTitleId = `${componentId}-speed-title`;
  const timelineHelpId = `${componentId}-timeline-help`;
  const solarSummaryId = `${componentId}-solar-summary`;
  const fallbackDate = currentDateInCity();

  let trackElement: HTMLDivElement | undefined;
  let playControlElement: HTMLDivElement | undefined;
  let playButtonElement: HTMLButtonElement | undefined;
  let isDragging = $state(false);
  let isTrackFocused = $state(false);
  let speedPopupOpen = $state(false);
  const reducedMotion = $derived($prefersReducedMotion);

  $effect(() => {
    if (reducedMotion && $isPlaying) {
      isPlaying.set(false);
    }
  });

  let activeTrackPointerId: number | null = null;
  let trackBounds: DOMRect | null = null;
  let pointerStartX = 0;
  let pointerStartY = 0;
  let lastPointerX = 0;
  let lastPointerAt = 0;
  let pointerVelocity = 0;
  let draggedBeyondThreshold = false;
  let snappedHour: number | null = null;

  let pressPointerId: number | null = null;
  let pressStartX = 0;
  let pressStartY = 0;
  let longPressTriggered = false;
  let suppressNextPlayClick = false;
  let longPressTimer: number | null = null;
  let suppressClickTimer: number | null = null;

  let playbackFrame: number | null = null;
  let playbackTimestamp: number | null = null;
  let trackAnimationFrame: number | null = null;
  let latestTime = DEFAULT_TIME;
  let latestSpeed: PlaybackSpeed = 1;
  let latestPlaying = false;
  let hasTimeSample = false;
  let previousHapticTime = DEFAULT_TIME;

  let solarDate = $derived(normalizeDate(date, fallbackDate));
  let displayedTime = $derived(clampTime($currentTime));
  let formattedTime = $derived(formatTime(displayedTime));
  let timePosition = $derived((displayedTime / DAY_MINUTES) * 100);
  let bubbleVisible = $derived(isDragging || isTrackFocused);
  let bubbleShift = $derived(displayedTime < 90 ? '0%' : displayedTime > 1350 ? '-100%' : '-50%');
  let solarDay = $derived(findSolarDay(solarDate));
  let currentSolarPosition = $derived(
    solarPosition(solarDate, displayedTime, CITY.lat, CITY.lon),
  );
  let solarArcPath = $derived(buildSolarArcPath(solarDay));
  let solarVisual = $derived(
    buildSolarVisual(displayedTime, currentSolarPosition.elevation, solarDay),
  );
  let solarSummary = $derived(formatSolarSummary(solarDay));
  let dataSourceLine = $derived(
    `数据 Open-Meteo · ${formatClockHHmm(updatedAt)} 更新`,
  );

  function attachTrack(element: HTMLDivElement): () => void {
    trackElement = element;
    const removeListeners = [
      on(element, 'pointerdown', handleTrackPointerDown, { passive: true }),
      on(element, 'pointermove', handleTrackPointerMove, { passive: true }),
      on(element, 'pointerup', handleTrackPointerUp, { passive: true }),
      on(element, 'pointercancel', handleTrackPointerCancel, { passive: true }),
      on(element, 'lostpointercapture', handleTrackLostPointerCapture, { passive: true }),
    ];

    return () => {
      for (const removeListener of removeListeners) removeListener();

      if (trackElement === element) {
        if (
          activeTrackPointerId !== null &&
          element.hasPointerCapture(activeTrackPointerId)
        ) {
          element.releasePointerCapture(activeTrackPointerId);
        }

        activeTrackPointerId = null;
        trackBounds = null;
        snappedHour = null;
        isDragging = false;
        trackElement = undefined;
      }
    };
  }

  function attachPlayControl(element: HTMLDivElement): () => void {
    playControlElement = element;
    return () => {
      if (playControlElement === element) playControlElement = undefined;
    };
  }

  function attachPlayButton(element: HTMLButtonElement): () => void {
    playButtonElement = element;
    const removeListeners = [
      on(element, 'pointerdown', handlePlayPointerDown, { passive: true }),
      on(element, 'pointermove', handlePlayPointerMove, { passive: true }),
      on(element, 'pointerup', handlePlayPointerUp, { passive: true }),
      on(element, 'pointercancel', handlePlayPointerCancel, { passive: true }),
      on(element, 'lostpointercapture', handlePlayLostPointerCapture, { passive: true }),
    ];

    return () => {
      for (const removeListener of removeListeners) removeListener();

      if (playButtonElement === element) {
        if (
          pressPointerId !== null &&
          element.hasPointerCapture(pressPointerId)
        ) {
          element.releasePointerCapture(pressPointerId);
        }

        clearLongPressTimer();
        clearSuppressClickTimer();
        pressPointerId = null;
        longPressTriggered = false;
        suppressNextPlayClick = false;
        playButtonElement = undefined;
      }
    };
  }

  onMount(() => {
    document.addEventListener('visibilitychange', handleVisibilityChange);

    const unsubscribeTime = currentTime.subscribe((value) => {
      const safeTime = clampTime(value);

      latestTime = safeTime;
      if (hasTimeSample && crossedHourlyBoundary(previousHapticTime, safeTime)) {
        vibrateHourlyBoundary();
      }

      previousHapticTime = safeTime;
      hasTimeSample = true;

      if (!Object.is(value, safeTime)) {
        currentTime.set(safeTime);
      }
    });

    const unsubscribeSpeed = playSpeed.subscribe((value) => {
      const safeSpeed = normalizeSpeed(value);
      latestSpeed = safeSpeed;

      if (value !== safeSpeed) {
        playSpeed.set(safeSpeed);
      }
    });

    const unsubscribePlaying = isPlaying.subscribe((playing) => {
      latestPlaying = playing;

      if (playing && !reducedMotion) {
        startPlayback();
      } else {
        if (playing && reducedMotion) {
          isPlaying.set(false);
        }
        stopPlayback();
      }
    });

    return () => {
      unsubscribePlaying();
      unsubscribeSpeed();
      unsubscribeTime();
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      stopPlayback();
      cancelTrackAnimation();
      clearLongPressTimer();
      clearSuppressClickTimer();
      releaseCapturedPointers();
    };
  });

  function currentDateInCity(): string {
    try {
      const parts = new Intl.DateTimeFormat('en-US', {
        timeZone: CITY.tz,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
      }).formatToParts(new Date());
      const year = parts.find((part) => part.type === 'year')?.value;
      const month = parts.find((part) => part.type === 'month')?.value;
      const day = parts.find((part) => part.type === 'day')?.value;

      if (year && month && day) {
        return `${year}-${month}-${day}`;
      }
    } catch {
      // Fall through to a UTC date if the configured time zone is unavailable.
    }

    return new Date().toISOString().slice(0, 10);
  }

  function normalizeDate(value: string | undefined, fallback: string): string {
    return value && isIsoDate(value) ? value : fallback;
  }

  function isIsoDate(value: string): boolean {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
    if (!match) return false;

    const year = Number(match[1]);
    const month = Number(match[2]);
    const day = Number(match[3]);
    if (year < 1000 || month < 1 || month > 12 || day < 1) return false;

    const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
    return day <= daysInMonth;
  }

  function clampTime(value: number): number {
    if (!Number.isFinite(value)) return DEFAULT_TIME;
    if (value <= 0) return 0;
    if (value >= DAY_MINUTES) return DAY_MINUTES;
    return value;
  }

  function wrapPlaybackTime(value: number): number {
    if (!Number.isFinite(value)) return 0;
    return ((value % DAY_MINUTES) + DAY_MINUTES) % DAY_MINUTES;
  }

  function normalizeSpeed(value: number): PlaybackSpeed {
    for (const speed of PLAY_SPEEDS) {
      if (value === speed) return speed;
    }

    return 1;
  }

  function formatTime(value: number): string {
    const rounded = Math.round(clampTime(value));
    const hours = Math.floor(rounded / 60);
    const minutes = rounded % 60;
    return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
  }

  function formatClockHHmm(value: Date | number | string | null | undefined): string {
    const dateValue =
      value instanceof Date
        ? value
        : value === null || value === undefined || value === ''
          ? new Date()
          : new Date(value);
    const safe = Number.isNaN(dateValue.getTime()) ? new Date() : dateValue;
    try {
      const parts = new Intl.DateTimeFormat('en-GB', {
        timeZone: CITY.tz,
        hour: '2-digit',
        minute: '2-digit',
        hourCycle: 'h23',
      }).formatToParts(safe);
      const hour = parts.find((part) => part.type === 'hour')?.value ?? '00';
      const minute = parts.find((part) => part.type === 'minute')?.value ?? '00';
      return `${hour}:${minute}`;
    } catch {
      return `${String(safe.getHours()).padStart(2, '0')}:${String(safe.getMinutes()).padStart(2, '0')}`;
    }
  }

  function formatHour(hour: number): string {
    return `${String(hour).padStart(2, '0')}:00`;
  }

  function formatSpeed(speed: PlaybackSpeed): string {
    return `${speed}×`;
  }

  function findSolarDay(value: string): SolarDay {
    const step = 10;
    let sunrise: number | null = null;
    let sunset: number | null = null;
    let previousMinute = 0;
    let previousElevation = solarPosition(value, 0, CITY.lat, CITY.lon).elevation;
    const startsAboveHorizon = previousElevation > 0;

    for (let minute = step; minute <= DAY_MINUTES; minute += step) {
      const elevation = solarPosition(value, minute, CITY.lat, CITY.lon).elevation;
      const wasAbove = previousElevation > 0;
      const isAbove = elevation > 0;

      if (wasAbove !== isAbove) {
        const crossing = refineHorizonCrossing(value, previousMinute, minute, previousElevation);
        if (!wasAbove && isAbove && sunrise === null) {
          sunrise = crossing;
        } else if (wasAbove && !isAbove) {
          sunset = crossing;
        }
      }

      previousMinute = minute;
      previousElevation = elevation;
    }

    const endsAboveHorizon = previousElevation > 0;
    const alwaysDay = sunrise === null && sunset === null && startsAboveHorizon;
    let arcStart: number | null = sunrise;
    let arcEnd: number | null = sunset;

    if (alwaysDay) {
      arcStart = 0;
      arcEnd = DAY_MINUTES;
    } else {
      if (arcStart === null && startsAboveHorizon) arcStart = 0;
      if (arcEnd === null && endsAboveHorizon) arcEnd = DAY_MINUTES;
    }

    return { sunrise, sunset, arcStart, arcEnd, alwaysDay };
  }

  function refineHorizonCrossing(
    value: string,
    leftMinute: number,
    rightMinute: number,
    leftElevation: number,
  ): number {
    let left = leftMinute;
    let right = rightMinute;
    let leftIsAbove = leftElevation > 0;

    for (let iteration = 0; iteration < 28; iteration += 1) {
      const middle = (left + right) / 2;
      const middleIsAbove = solarPosition(value, middle, CITY.lat, CITY.lon).elevation > 0;

      if (middleIsAbove === leftIsAbove) {
        left = middle;
        leftIsAbove = middleIsAbove;
      } else {
        right = middle;
      }
    }

    return (left + right) / 2;
  }

  function buildSolarArcPath(day: SolarDay): string {
    if (day.arcStart === null || day.arcEnd === null || day.arcEnd <= day.arcStart) return '';

    const start = (day.arcStart / DAY_MINUTES) * 100;
    const end = (day.arcEnd / DAY_MINUTES) * 100;
    const radiusX = (end - start) / 2;
    return `M ${start} 20 A ${radiusX} 14 0 0 1 ${end} 20`;
  }

  function buildSolarVisual(
    minute: number,
    elevation: number,
    day: SolarDay,
  ): SolarVisual {
    const x = Math.min(98.5, Math.max(1.5, (minute / DAY_MINUTES) * 100));
    const daytime = elevation >= 0;

    if (
      daytime &&
      day.arcStart !== null &&
      day.arcEnd !== null &&
      day.arcEnd > day.arcStart
    ) {
      const progress = Math.min(
        1,
        Math.max(0, (minute - day.arcStart) / (day.arcEnd - day.arcStart)),
      );
      const ellipseHeight = Math.sqrt(Math.max(0, 1 - (2 * progress - 1) ** 2));
      return { x, y: 20 - 14 * ellipseHeight, daytime };
    }

    return {
      x,
      y: Math.min(19, 15 + Math.min(4, Math.abs(elevation) / 12)),
      daytime,
    };
  }

  function formatSolarSummary(day: SolarDay): string {
    if (day.sunrise !== null && day.sunset !== null) {
      return `日出 ${formatTime(day.sunrise)}，日落 ${formatTime(day.sunset)}`;
    }

    return day.alwaysDay ? '太阳全天位于地平线上方' : '太阳全天位于地平线下方';
  }

  function setDirectTime(value: number): void {
    currentTime.set(clampTime(value));
  }

  function startPlayback(): void {
    cancelTrackAnimation();
    if (playbackFrame !== null || document.hidden) return;

    playbackTimestamp = null;
    playbackFrame = requestAnimationFrame(playbackTick);
  }

  function stopPlayback(): void {
    if (playbackFrame !== null) {
      cancelAnimationFrame(playbackFrame);
      playbackFrame = null;
    }
    playbackTimestamp = null;
  }

  function playbackTick(timestamp: number): void {
    if (!latestPlaying || document.hidden) {
      playbackFrame = null;
      playbackTimestamp = null;
      return;
    }

    if (playbackTimestamp !== null) {
      const elapsed = Math.min(
        MAX_PLAYBACK_DT_MS,
        Math.max(0, timestamp - playbackTimestamp),
      );
      const advancedMinutes = (elapsed / 1000) * latestSpeed * 60;
      setDirectTime(wrapPlaybackTime(latestTime + advancedMinutes));
    }

    playbackTimestamp = timestamp;
    playbackFrame = requestAnimationFrame(playbackTick);
  }

  function cancelTrackAnimation(): void {
    if (trackAnimationFrame !== null) {
      cancelAnimationFrame(trackAnimationFrame);
      trackAnimationFrame = null;
    }
  }

  function animateToTime(value: number): void {
    cancelTrackAnimation();
    const target = clampTime(value);
    const start = latestTime;

    if (reducedMotion || Math.abs(target - start) < 0.001) {
      setDirectTime(target);
      return;
    }

    const startedAt = performance.now();
    const animate = (timestamp: number) => {
      if (document.hidden) {
        trackAnimationFrame = null;
        return;
      }
      const progress = Math.min(1, Math.max(0, (timestamp - startedAt) / CLICK_ANIMATION_MS));
      setDirectTime(start + (target - start) * easeOutCubic(progress));

      if (progress < 1) {
        trackAnimationFrame = requestAnimationFrame(animate);
      } else {
        trackAnimationFrame = null;
      }
    };

    trackAnimationFrame = requestAnimationFrame(animate);
  }

  function handleVisibilityChange(): void {
    if (document.hidden) {
      stopPlayback();
      cancelTrackAnimation();
    } else if (latestPlaying) {
      startPlayback();
    }
  }

  function prepareManualTimeChange(): void {
    cancelTrackAnimation();
    if (latestPlaying) {
      isPlaying.set(false);
    }
  }

  function minuteAtClientX(clientX: number, bounds: DOMRect): number {
    if (bounds.width <= 0) return latestTime;
    const ratio = Math.min(1, Math.max(0, (clientX - bounds.left) / bounds.width));
    return ratio * DAY_MINUTES;
  }

  function clickMinuteAtClientX(clientX: number, bounds: DOMRect): number {
    const minute = minuteAtClientX(clientX, bounds);
    const nearestHour = Math.round(minute / 60);
    const hourX = bounds.left + (nearestHour / 24) * bounds.width;
    return Math.abs(clientX - hourX) <= SNAP_DISTANCE_PX ? nearestHour * 60 : minute;
  }

  function dragMinuteAtClientX(clientX: number, timestamp: number, bounds: DOMRect): number {
    const elapsed = Math.max(1, timestamp - lastPointerAt);
    const instantaneousVelocity = Math.abs(clientX - lastPointerX) / elapsed;
    pointerVelocity =
      pointerVelocity === 0
        ? instantaneousVelocity
        : pointerVelocity * 0.55 + instantaneousVelocity * 0.45;
    lastPointerX = clientX;
    lastPointerAt = timestamp;

    const minute = minuteAtClientX(clientX, bounds);
    const nearestHour = Math.round(minute / 60);

    if (snappedHour !== null) {
      const snappedX = bounds.left + (snappedHour / 24) * bounds.width;
      const snappedDistance = Math.abs(clientX - snappedX);

      if (
        pointerVelocity <= SNAP_RELEASE_VELOCITY &&
        snappedDistance <= SNAP_RELEASE_PX
      ) {
        return snappedHour * 60;
      }

      snappedHour = null;
    }

    const nearestHourX = bounds.left + (nearestHour / 24) * bounds.width;
    if (
      pointerVelocity <= SNAP_MAX_VELOCITY &&
      Math.abs(clientX - nearestHourX) <= SNAP_DISTANCE_PX
    ) {
      snappedHour = nearestHour;
      return nearestHour * 60;
    }

    return minute;
  }

  function handleTrackPointerDown(event: PointerEvent): void {
    if (
      activeTrackPointerId !== null ||
      !event.isPrimary ||
      (event.pointerType === 'mouse' && event.button !== 0)
    ) {
      return;
    }

    const element = event.currentTarget as HTMLDivElement;
    const bounds = element.getBoundingClientRect();
    if (bounds.width <= 0) return;

    prepareManualTimeChange();
    activeTrackPointerId = event.pointerId;
    trackBounds = bounds;
    pointerStartX = event.clientX;
    pointerStartY = event.clientY;
    lastPointerX = event.clientX;
    lastPointerAt = performance.now();
    pointerVelocity = 0;
    draggedBeyondThreshold = false;
    snappedHour = null;
    isDragging = true;
    element.setPointerCapture(event.pointerId);
  }

  function handleTrackPointerMove(event: PointerEvent): void {
    if (
      event.pointerId !== activeTrackPointerId ||
      trackBounds === null ||
      !event.isPrimary
    ) {
      return;
    }

    if (
      !draggedBeyondThreshold &&
      Math.hypot(event.clientX - pointerStartX, event.clientY - pointerStartY) >=
        DRAG_THRESHOLD_PX
    ) {
      draggedBeyondThreshold = true;
    }

    if (draggedBeyondThreshold) {
      setDirectTime(
        dragMinuteAtClientX(event.clientX, performance.now(), trackBounds),
      );
    }
  }

  function handleTrackPointerUp(event: PointerEvent): void {
    if (event.pointerId !== activeTrackPointerId || trackBounds === null) return;

    const bounds = trackBounds;
    const wasDragged = draggedBeyondThreshold;

    if (wasDragged) {
      setDirectTime(
        dragMinuteAtClientX(event.clientX, performance.now(), bounds),
      );
    }

    finishTrackPointer(event.currentTarget as HTMLDivElement, event.pointerId);

    if (!wasDragged) {
      animateToTime(clickMinuteAtClientX(event.clientX, bounds));
    }
  }

  function handleTrackPointerCancel(event: PointerEvent): void {
    if (event.pointerId !== activeTrackPointerId) return;
    finishTrackPointer(event.currentTarget as HTMLDivElement, event.pointerId);
  }

  function handleTrackLostPointerCapture(event: PointerEvent): void {
    if (event.pointerId !== activeTrackPointerId) return;
    activeTrackPointerId = null;
    trackBounds = null;
    snappedHour = null;
    isDragging = false;
  }

  function finishTrackPointer(element: HTMLDivElement, pointerId: number): void {
    activeTrackPointerId = null;
    trackBounds = null;
    snappedHour = null;
    isDragging = false;

    if (element.hasPointerCapture(pointerId)) {
      element.releasePointerCapture(pointerId);
    }
  }

  function isEditableTarget(target: EventTarget | null): boolean {
    if (!(target instanceof HTMLElement)) return false;
    return (
      target.isContentEditable ||
      target instanceof HTMLInputElement ||
      target instanceof HTMLTextAreaElement ||
      target instanceof HTMLSelectElement ||
      target.getAttribute('role') === 'textbox'
    );
  }

  function handleTrackKeydown(event: KeyboardEvent): void {
    if (isEditableTarget(event.target)) return;

    if (event.key === ' ') {
      event.preventDefault();
      togglePlayback();
      return;
    }

    let target: number | null = null;
    if (event.key === 'ArrowLeft') {
      target = latestTime - (event.shiftKey ? 60 : 10);
    } else if (event.key === 'ArrowRight') {
      target = latestTime + (event.shiftKey ? 60 : 10);
    } else if (event.key === 'Home') {
      target = 0;
    } else if (event.key === 'End') {
      target = DAY_MINUTES;
    }

    if (target !== null) {
      event.preventDefault();
      prepareManualTimeChange();
      setDirectTime(target);
    }
  }

  function togglePlayback(): void {
    cancelTrackAnimation();
    speedPopupOpen = false;
    if (reducedMotion) {
      isPlaying.set(false);
      return;
    }
    isPlaying.update((playing) => !playing);
  }

  function handlePlayPointerDown(event: PointerEvent): void {
    if (
      pressPointerId !== null ||
      !event.isPrimary ||
      (event.pointerType === 'mouse' && event.button !== 0)
    ) {
      return;
    }

    const button = event.currentTarget as HTMLButtonElement;
    clearLongPressTimer();
    clearSuppressClickTimer();
    pressPointerId = event.pointerId;
    pressStartX = event.clientX;
    pressStartY = event.clientY;
    longPressTriggered = false;
    suppressNextPlayClick = false;
    button.setPointerCapture(event.pointerId);

    longPressTimer = window.setTimeout(() => {
      if (pressPointerId !== event.pointerId) return;
      longPressTriggered = true;
      suppressNextPlayClick = true;
      speedPopupOpen = true;
    }, LONG_PRESS_MS);
  }

  function handlePlayPointerMove(event: PointerEvent): void {
    if (event.pointerId !== pressPointerId || longPressTriggered) return;

    if (
      Math.hypot(event.clientX - pressStartX, event.clientY - pressStartY) >
      LONG_PRESS_MOVE_PX
    ) {
      clearLongPressTimer();
    }
  }

  function handlePlayPointerUp(event: PointerEvent): void {
    if (event.pointerId !== pressPointerId) return;

    const button = event.currentTarget as HTMLButtonElement;
    const shouldSuppressClick = longPressTriggered;
    clearLongPressTimer();
    pressPointerId = null;
    longPressTriggered = false;

    if (button.hasPointerCapture(event.pointerId)) {
      button.releasePointerCapture(event.pointerId);
    }

    if (shouldSuppressClick) {
      suppressNextPlayClick = true;
      suppressClickTimer = window.setTimeout(() => {
        suppressNextPlayClick = false;
        suppressClickTimer = null;
      }, 0);
    }
  }

  function handlePlayPointerCancel(event: PointerEvent): void {
    if (event.pointerId !== pressPointerId) return;
    clearLongPressTimer();
    pressPointerId = null;
    longPressTriggered = false;
    suppressNextPlayClick = false;
  }

  function handlePlayLostPointerCapture(event: PointerEvent): void {
    if (event.pointerId !== pressPointerId) return;
    clearLongPressTimer();
    pressPointerId = null;
    longPressTriggered = false;
  }

  function handlePlayClick(event: MouseEvent): void {
    if (suppressNextPlayClick) {
      event.preventDefault();
      suppressNextPlayClick = false;
      clearSuppressClickTimer();
      return;
    }

    togglePlayback();
  }

  function handlePlayKeydown(event: KeyboardEvent): void {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      speedPopupOpen = true;
    } else if (event.key === 'Escape' && speedPopupOpen) {
      event.preventDefault();
      speedPopupOpen = false;
    }
  }

  function handlePlayContextMenu(event: MouseEvent): void {
    event.preventDefault();
  }

  function selectSpeed(speed: PlaybackSpeed): void {
    playSpeed.set(speed);
    speedPopupOpen = false;
    playButtonElement?.focus({ preventScroll: true });
  }

  function handleDocumentPointerDown(event: PointerEvent): void {
    if (
      speedPopupOpen &&
      event.target instanceof Node &&
      !playControlElement?.contains(event.target)
    ) {
      speedPopupOpen = false;
    }
  }

  function handleDocumentKeydown(event: KeyboardEvent): void {
    if (event.key !== 'Escape' || !speedPopupOpen) return;
    speedPopupOpen = false;
    playButtonElement?.focus({ preventScroll: true });
  }

  function handlePlayControlFocusout(event: FocusEvent): void {
    const nextTarget = event.relatedTarget;
    if (
      speedPopupOpen &&
      (!(nextTarget instanceof Node) || !playControlElement?.contains(nextTarget))
    ) {
      speedPopupOpen = false;
    }
  }

  function clearLongPressTimer(): void {
    if (longPressTimer !== null) {
      window.clearTimeout(longPressTimer);
      longPressTimer = null;
    }
  }

  function clearSuppressClickTimer(): void {
    if (suppressClickTimer !== null) {
      window.clearTimeout(suppressClickTimer);
      suppressClickTimer = null;
    }
  }

  function crossedHourlyBoundary(previous: number, next: number): boolean {
    if (previous === next) return false;
    return Math.floor(previous / 60) !== Math.floor(next / 60);
  }

  function vibrateHourlyBoundary(): void {
    try {
      navigator.vibrate?.(1);
    } catch {
      // Haptics are optional and can be blocked by browser or system policy.
    }
  }

  function releaseCapturedPointers(): void {
    if (
      activeTrackPointerId !== null &&
      trackElement?.hasPointerCapture(activeTrackPointerId)
    ) {
      trackElement.releasePointerCapture(activeTrackPointerId);
    }

    if (
      pressPointerId !== null &&
      playButtonElement?.hasPointerCapture(pressPointerId)
    ) {
      playButtonElement.releasePointerCapture(pressPointerId);
    }

    activeTrackPointerId = null;
    pressPointerId = null;
  }

  function tickLabelClass(hour: number): string {
    const classes = ['tick-label'];
    if (hour % 4 !== 0) classes.push('narrow-hidden');
    if (hour % 12 !== 0) classes.push('compact-hidden');
    if (hour === 0) classes.push('edge-start');
    if (hour === 24) classes.push('edge-end');
    return classes.join(' ');
  }
</script>

<svelte:document onpointerdown={handleDocumentPointerDown} onkeydown={handleDocumentKeydown} />

<section class="time-scrubber" aria-label="全局时间轴">
  <div
    class="play-control"
    {@attach attachPlayControl}
    onfocusout={handlePlayControlFocusout}
  >
    <button
      class="play-button"
      type="button"
      {@attach attachPlayButton}
      aria-label={reducedMotion
        ? '已开启减少动态效果，自动播放已关闭'
        : `${$isPlaying ? '暂停' : '播放'}时间，当前速度 ${formatSpeed(normalizeSpeed($playSpeed))}`}
      aria-pressed={$isPlaying}
      aria-haspopup="dialog"
      aria-expanded={speedPopupOpen}
      aria-controls={speedPopupId}
      aria-disabled={reducedMotion || undefined}
      title={reducedMotion ? '减少动态效果时不可自动播放' : '长按选择播放速度'}
      oncontextmenu={handlePlayContextMenu}
      onkeydown={handlePlayKeydown}
      onclick={handlePlayClick}
    >
      <span class={['play-icon', { playing: $isPlaying }]} aria-hidden="true">
        <span class="icon-piece icon-piece-top"></span>
        <span class="icon-piece icon-piece-bottom"></span>
      </span>
    </button>

    {#if speedPopupOpen}
      <div
        id={speedPopupId}
        class="speed-popup"
        role="dialog"
        aria-labelledby={speedPopupTitleId}
      >
        <span id={speedPopupTitleId} class="speed-title">播放速度</span>
        {#each PLAY_SPEEDS as speed (speed)}
          <button
            type="button"
            class="speed-option"
            aria-pressed={normalizeSpeed($playSpeed) === speed}
            onclick={() => selectSpeed(speed)}
          >
            {formatSpeed(speed)}
          </button>
        {/each}
      </div>
    {/if}
  </div>

  <div class="timeline">
    <div
      class={['track-interaction', { dragging: isDragging }]}
      {@attach attachTrack}
      role="slider"
      tabindex="0"
      aria-label="一天中的时间"
      aria-orientation="horizontal"
      aria-valuemin="0"
      aria-valuemax={DAY_MINUTES}
      aria-valuenow={Math.round(displayedTime)}
      aria-valuetext={`${formattedTime}，${solarDate}`}
      aria-describedby={`${timelineHelpId} ${solarSummaryId}`}
      onkeydown={handleTrackKeydown}
      onfocus={() => (isTrackFocused = true)}
      onblur={() => (isTrackFocused = false)}
    >
      <div class="solar-strip" aria-hidden="true">
        <svg viewBox="0 0 100 22" preserveAspectRatio="none">
          {#if solarArcPath}
            <path class="solar-arc" d={solarArcPath}></path>
          {/if}
        </svg>

        {#if solarDay.sunrise !== null}
          <span
            class="horizon-marker sunrise-marker"
            style:left={`${(solarDay.sunrise / DAY_MINUTES) * 100}%`}
          ></span>
        {/if}

        {#if solarDay.sunset !== null}
          <span
            class="horizon-marker sunset-marker"
            style:left={`${(solarDay.sunset / DAY_MINUTES) * 100}%`}
          ></span>
        {/if}

        <span
          class={['solar-marker', solarVisual.daytime ? 'sun-marker' : 'moon-marker']}
          style:--solar-x={`${solarVisual.x}%`}
          style:--solar-y={`${solarVisual.y}px`}
        >
          {#if solarVisual.daytime}
            <svg viewBox="0 0 16 16">
              <circle cx="8" cy="8" r="2.5"></circle>
              <path d="M8 1.2v2M8 12.8v2M1.2 8h2M12.8 8h2M3.2 3.2l1.4 1.4M11.4 11.4l1.4 1.4M12.8 3.2l-1.4 1.4M4.6 11.4l-1.4 1.4"></path>
            </svg>
          {:else}
            <svg viewBox="0 0 16 16">
              <path d="M11.8 11.4A5.6 5.6 0 0 1 5 4.2a5.6 5.6 0 1 0 6.8 7.2Z"></path>
            </svg>
          {/if}
        </span>
      </div>

      <span class="track-line" aria-hidden="true"></span>

      <div class="hour-dots" aria-hidden="true">
        {#each HOURS as hour (hour)}
          <span
            class="hour-dot"
            style:left={`${(hour / 24) * 100}%`}
          ></span>
        {/each}
      </div>

      <div class="ticks" aria-hidden="true">
        {#each LABELED_HOURS as hour (hour)}
          <span class="tick" style:left={`${(hour / 24) * 100}%`}>
            <span class="tick-mark"></span>
            <span class={tickLabelClass(hour)}>{formatHour(hour)}</span>
          </span>
        {/each}
      </div>

      <div
        class={['thumb', { dragging: isDragging }]}
        style:--time-position={`${timePosition}%`}
        aria-hidden="true"
      >
        <output
          class={['time-bubble', { visible: bubbleVisible }]}
          style:--bubble-shift={bubbleShift}
        >
          {formattedTime}
        </output>
      </div>
    </div>
  </div>

  <div class="time-readout">
    <output class="time-value" aria-label={`当前时间 ${formattedTime}`}>{formattedTime}</output>
    <time class="date-value" datetime={solarDate}>{solarDate}</time>
    <span class="data-source" aria-label={dataSourceLine}>{dataSourceLine}</span>
  </div>

  <span id={timelineHelpId} class="sr-only">
    左右方向键每次调整 10 分钟，按住 Shift 调整 60 分钟，空格键播放或暂停。
  </span>
  <span id={solarSummaryId} class="sr-only">{solarSummary}</span>
</section>

<style>
  .time-scrubber {
    position: fixed;
    right: 0;
    bottom: env(safe-area-inset-bottom, 0px);
    left: 0;
    z-index: 10;
    box-sizing: border-box;
    display: grid;
    grid-template-columns: 44px minmax(0, 1fr) minmax(84px, max-content);
    align-items: center;
    gap: 24px;
    height: 88px;
    padding-right: max(24px, env(safe-area-inset-right));
    padding-left: max(24px, env(safe-area-inset-left));
    border-top: 1px solid var(--line, rgba(255, 255, 255, 0.22));
    background: rgba(5, 7, 10, 0.78);
    color: var(--fg-1, rgba(255, 255, 255, 0.92));
    font-family: -apple-system, 'SF Pro', Inter, 'PingFang SC', sans-serif;
    font-variant-numeric: tabular-nums;
    backdrop-filter: blur(16px) saturate(120%);
    -webkit-backdrop-filter: blur(16px) saturate(120%);
  }

  .play-control {
    position: relative;
    display: grid;
    place-items: center;
    width: 44px;
    height: 44px;
  }

  .play-button {
    display: grid;
    place-items: center;
    width: 40px;
    height: 40px;
    padding: 0;
    border: 1px solid var(--line, rgba(255, 255, 255, 0.22));
    border-radius: 50%;
    background: rgba(255, 255, 255, 0.05);
    color: var(--accent, #7ec8ff);
    cursor: pointer;
    touch-action: manipulation;
    user-select: none;
    -webkit-tap-highlight-color: transparent;
    -webkit-touch-callout: none;
  }

  .play-button:hover {
    background: rgba(255, 255, 255, 0.09);
  }

  .play-button:focus-visible,
  .speed-option:focus-visible {
    outline: 2px solid var(--accent, #7ec8ff);
    outline-offset: 3px;
  }

  .play-icon {
    position: relative;
    display: block;
    width: 20px;
    height: 20px;
  }

  .icon-piece {
    position: absolute;
    top: 2px;
    left: 4px;
    width: 12px;
    height: 16px;
    border-radius: 1px;
    background: currentColor;
    transition: clip-path 150ms ease;
    will-change: clip-path;
  }

  .icon-piece-top {
    clip-path: polygon(0 0, 100% 50%, 100% 50%, 0 50%);
  }

  .icon-piece-bottom {
    clip-path: polygon(0 50%, 100% 50%, 100% 50%, 0 100%);
  }

  .play-icon.playing .icon-piece-top {
    clip-path: polygon(0 0, 28% 0, 28% 100%, 0 100%);
  }

  .play-icon.playing .icon-piece-bottom {
    clip-path: polygon(72% 0, 100% 0, 100% 100%, 72% 100%);
  }

  .speed-popup {
    position: absolute;
    bottom: calc(100% + 8px);
    left: 0;
    z-index: 2;
    display: grid;
    grid-template-columns: repeat(3, minmax(40px, 1fr));
    gap: 5px;
    width: 148px;
    padding: 8px;
    border: 1px solid var(--line, rgba(255, 255, 255, 0.22));
    border-radius: 12px;
    background: var(--bg, #05070a);
    box-shadow: 0 12px 32px rgba(0, 0, 0, 0.38);
  }

  .speed-title {
    grid-column: 1 / -1;
    padding: 0 2px 2px;
    color: var(--fg-2, rgba(255, 255, 255, 0.45));
    font-size: 10px;
    font-weight: 600;
    letter-spacing: 0.08em;
  }

  .speed-option {
    min-width: 0;
    height: 28px;
    padding: 0 6px;
    border: 0;
    border-radius: 7px;
    background: rgba(255, 255, 255, 0.06);
    color: var(--fg-2, rgba(255, 255, 255, 0.45));
    font: inherit;
    font-size: 11px;
    font-variant-numeric: tabular-nums;
    cursor: pointer;
  }

  .speed-option[aria-pressed='true'] {
    background: rgba(126, 200, 255, 0.16);
    color: var(--accent, #7ec8ff);
  }

  .timeline {
    min-width: 0;
    height: 68px;
  }

  .track-interaction {
    position: relative;
    width: 100%;
    height: 68px;
    border-radius: 8px;
    cursor: ew-resize;
    touch-action: none;
    user-select: none;
    overscroll-behavior: contain;
    -webkit-user-select: none;
    -webkit-tap-highlight-color: transparent;
  }

  .track-interaction.dragging {
    cursor: grabbing;
  }

  .track-interaction:focus-visible {
    outline: 2px solid var(--accent, #7ec8ff);
    outline-offset: 4px;
  }

  .solar-strip {
    position: absolute;
    top: 1px;
    right: 0;
    left: 0;
    height: 22px;
    pointer-events: none;
  }

  .solar-strip > svg {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 22px;
    overflow: visible;
  }

  .solar-arc {
    fill: none;
    stroke: var(--line, rgba(255, 255, 255, 0.22));
    stroke-width: 1;
    vector-effect: non-scaling-stroke;
  }

  .horizon-marker {
    position: absolute;
    top: 20px;
    width: 5px;
    height: 5px;
    border: 1px solid var(--accent, #7ec8ff);
    border-radius: 50%;
    background: var(--bg, #05070a);
    transform: translate(-50%, -50%);
  }

  .sunset-marker {
    opacity: 0.7;
  }

  .solar-marker {
    position: absolute;
    top: var(--solar-y);
    left: var(--solar-x);
    z-index: 1;
    display: grid;
    place-items: center;
    width: 12px;
    height: 12px;
    transform: translate(-50%, -50%);
  }

  .solar-marker svg {
    width: 12px;
    height: 12px;
    overflow: visible;
  }

  .sun-marker {
    color: var(--accent, #7ec8ff);
    filter: drop-shadow(0 0 4px rgba(126, 200, 255, 0.7));
  }

  .sun-marker circle,
  .sun-marker path {
    fill: none;
    stroke: currentColor;
    stroke-linecap: round;
    stroke-width: 1.2;
  }

  .moon-marker {
    color: var(--fg-2, rgba(255, 255, 255, 0.45));
  }

  .moon-marker path {
    fill: currentColor;
  }

  .track-line {
    position: absolute;
    top: 38px;
    right: 0;
    left: 0;
    height: 1px;
    background: var(--line, rgba(255, 255, 255, 0.22));
    pointer-events: none;
  }

  .hour-dots,
  .ticks {
    position: absolute;
    inset: 0;
    pointer-events: none;
  }

  .hour-dot {
    position: absolute;
    top: 38.5px;
    width: 3px;
    height: 3px;
    border-radius: 50%;
    background: var(--fg-2, rgba(255, 255, 255, 0.45));
    transform: translate(-50%, -50%);
  }

  .tick {
    position: absolute;
    top: 38px;
    height: 24px;
  }

  .tick-mark {
    position: absolute;
    top: 2px;
    left: 0;
    width: 1px;
    height: 4px;
    background: var(--line, rgba(255, 255, 255, 0.22));
    transform: translateX(-50%);
  }

  .tick-label {
    position: absolute;
    top: 10px;
    left: 0;
    color: var(--axis-tick-color, var(--fg-2, rgba(255, 255, 255, 0.45)));
    font-size: var(--axis-tick-size, 11px);
    font-variant-numeric: tabular-nums;
    line-height: 1;
    white-space: nowrap;
    transform: translateX(-50%);
  }

  .tick-label.edge-start {
    transform: translateX(0);
  }

  .tick-label.edge-end {
    transform: translateX(-100%);
  }

  .thumb {
    position: absolute;
    top: 38.5px;
    left: var(--time-position);
    z-index: 3;
    width: 12px;
    height: 12px;
    border: 1px solid rgba(255, 255, 255, 0.72);
    border-radius: 50%;
    background: var(--accent, #7ec8ff);
    box-shadow:
      0 0 0 4px rgba(126, 200, 255, 0.12),
      0 0 14px rgba(126, 200, 255, 0.78);
    transform: translate(-50%, -50%);
    transition:
      width 120ms ease,
      height 120ms ease,
      box-shadow 120ms ease;
    pointer-events: none;
  }

  .thumb.dragging {
    width: 16px;
    height: 16px;
    box-shadow:
      0 0 0 5px rgba(126, 200, 255, 0.16),
      0 0 18px rgba(126, 200, 255, 0.9);
  }

  .time-bubble {
    position: absolute;
    bottom: calc(100% + 7px);
    left: 50%;
    padding: 4px 7px;
    border: 1px solid var(--line, rgba(255, 255, 255, 0.22));
    border-radius: 6px;
    background: var(--bg, #05070a);
    box-shadow: 0 6px 18px rgba(0, 0, 0, 0.32);
    color: var(--fg-1, rgba(255, 255, 255, 0.92));
    font-size: 11px;
    font-variant-numeric: tabular-nums;
    line-height: 1;
    opacity: 0;
    transform: translate(var(--bubble-shift), 4px);
    transition:
      opacity 100ms ease,
      transform 100ms ease;
    white-space: nowrap;
  }

  .time-bubble.visible {
    opacity: 1;
    transform: translate(var(--bubble-shift), 0);
  }

  .time-readout {
    display: grid;
    justify-items: end;
    align-content: center;
    min-width: 84px;
  }

  .time-value {
    margin: 0;
    padding: 0;
    border: 0;
    background: transparent;
    color: var(--fg-1, rgba(255, 255, 255, 0.92));
    font: inherit;
    font-size: 28px;
    font-variant-numeric: tabular-nums;
    font-weight: 400;
    letter-spacing: -0.035em;
    line-height: 1;
  }

  .date-value {
    margin-top: 5px;
    color: var(--fg-2, rgba(255, 255, 255, 0.45));
    font-size: 11px;
    font-variant-numeric: tabular-nums;
    line-height: 1;
    white-space: nowrap;
  }

  .data-source {
    margin-top: 4px;
    color: var(--fg-2, rgba(255, 255, 255, 0.45));
    font-size: 9px;
    font-variant-numeric: tabular-nums;
    line-height: 1;
    opacity: 0.5;
    white-space: nowrap;
  }

  .sr-only {
    position: absolute;
    width: 1px;
    height: 1px;
    padding: 0;
    overflow: hidden;
    clip: rect(0, 0, 0, 0);
    white-space: nowrap;
    border: 0;
  }

  @media (max-width: 40rem) {
    .time-scrubber {
      grid-template-columns: 40px minmax(0, 1fr) minmax(76px, max-content);
      gap: 12px;
    }

    .play-control {
      width: 40px;
    }
  }

  @media (max-width: 32rem) {
    .time-scrubber {
      grid-template-columns: 36px minmax(0, 1fr) minmax(70px, max-content);
      gap: 8px;
    }

    .play-control,
    .play-button {
      width: 36px;
      height: 36px;
    }

    .tick-label.narrow-hidden {
      display: none;
    }
  }

  @media (max-width: 23rem) {
    .tick-label.compact-hidden {
      display: none;
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .icon-piece,
    .thumb,
    .time-bubble {
      transition-duration: 0.01ms;
    }
  }
</style>
