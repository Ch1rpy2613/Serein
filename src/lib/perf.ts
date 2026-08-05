export type Quality = 'low' | 'medium' | 'high';

const QUALITY_ORDER: readonly Quality[] = ['low', 'medium', 'high'];
const SAMPLE_COUNT = 60;
const DOWN_FPS = 45;
const UP_FPS = 55;
const DOWN_HOLD_MS = 2_000;
const UP_HOLD_MS = 10_000;

/**
 * Global adaptive-quality governor. It measures one lightweight rAF stream,
 * then lets the App fan quality changes out to every mounted renderer.
 */
export class PerformanceGovernor {
  private readonly onQualityChange: (quality: Quality) => void;
  private readonly frameDurations = new Float32Array(SAMPLE_COUNT);

  private quality: Quality;
  private frameCursor = 0;
  private frameCount = 0;
  private frameDurationTotal = 0;
  private averageFps = 60;
  private lowDuration = 0;
  private highDuration = 0;
  private lastTimestamp = 0;
  private raf = 0;
  private running = false;

  constructor(onQualityChange: (quality: Quality) => void, initialQuality: Quality = 'high') {
    this.onQualityChange = onQualityChange;
    this.quality = initialQuality;
  }

  start(): void {
    if (this.running || typeof document === 'undefined') return;
    this.running = true;
    document.addEventListener('visibilitychange', this.onVisibility);
    if (!document.hidden) this.resume();
  }

  stop(): void {
    if (!this.running) return;
    this.running = false;
    document.removeEventListener('visibilitychange', this.onVisibility);
    this.pause();
  }

  getQuality(): Quality {
    return this.quality;
  }

  getAverageFps(): number {
    return this.averageFps;
  }

  private resume(): void {
    if (!this.running || this.raf || document.hidden) return;
    this.lastTimestamp = 0;
    this.raf = requestAnimationFrame(this.frame);
  }

  private pause(): void {
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
    this.lastTimestamp = 0;
    this.lowDuration = 0;
    this.highDuration = 0;
  }

  private frame = (timestamp: number): void => {
    this.raf = 0;
    if (!this.running || document.hidden) return;

    if (this.lastTimestamp > 0) {
      const duration = Math.min(1_000, Math.max(0.1, timestamp - this.lastTimestamp));
      this.recordFrame(duration);
      this.evaluate(duration);
    }
    this.lastTimestamp = timestamp;
    this.raf = requestAnimationFrame(this.frame);
  };

  private recordFrame(duration: number): void {
    if (this.frameCount < SAMPLE_COUNT) {
      this.frameCount += 1;
    } else {
      this.frameDurationTotal -= this.frameDurations[this.frameCursor];
    }

    this.frameDurations[this.frameCursor] = duration;
    this.frameDurationTotal += duration;
    this.frameCursor = (this.frameCursor + 1) % SAMPLE_COUNT;
    this.averageFps = (this.frameCount * 1_000) / Math.max(1, this.frameDurationTotal);
  }

  private evaluate(duration: number): void {
    if (this.frameCount < SAMPLE_COUNT) return;

    if (this.averageFps < DOWN_FPS) {
      this.lowDuration += duration;
      this.highDuration = 0;
      if (this.lowDuration >= DOWN_HOLD_MS) this.shiftQuality(-1);
      return;
    }

    if (this.averageFps > UP_FPS) {
      this.highDuration += duration;
      this.lowDuration = 0;
      if (this.highDuration >= UP_HOLD_MS) this.shiftQuality(1);
      return;
    }

    this.lowDuration = 0;
    this.highDuration = 0;
  }

  private shiftQuality(direction: -1 | 1): void {
    this.lowDuration = 0;
    this.highDuration = 0;
    const current = QUALITY_ORDER.indexOf(this.quality);
    const next = Math.min(QUALITY_ORDER.length - 1, Math.max(0, current + direction));
    if (next === current) return;
    this.quality = QUALITY_ORDER[next];
    this.onQualityChange(this.quality);
  }

  private onVisibility = (): void => {
    if (document.hidden) this.pause();
    else this.resume();
  };
}
