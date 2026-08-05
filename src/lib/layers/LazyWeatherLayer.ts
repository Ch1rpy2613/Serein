import type { DayData, WeatherLayer } from '../contracts';

type Quality = 'low' | 'medium' | 'high';

interface LazyWeatherLayerOptions {
  id: string;
  name: string;
  preferredSkyDim: number;
  /** 未载入底层前即可声明，避免手势竞态 */
  capturesVerticalPan?: boolean;
  load: () => Promise<WeatherLayer>;
}

/**
 * Keeps the WeatherLayer contract synchronous while allowing Vite to split
 * each heavyweight scene into its own chunk.
 */
export class LazyWeatherLayer implements WeatherLayer {
  readonly id: string;
  readonly name: string;
  readonly preferredSkyDim: number;
  readonly capturesVerticalPan?: boolean;

  private readonly loader: () => Promise<WeatherLayer>;
  private layer: WeatherLayer | null = null;
  private layerPromise: Promise<WeatherLayer> | null = null;
  private container: HTMLElement | null = null;
  private status: HTMLElement | null = null;
  private attached = false;
  private generation = 0;

  private data: DayData | null = null;
  private time = 480;
  private quality: Quality = 'high';

  constructor(options: LazyWeatherLayerOptions) {
    this.id = options.id;
    this.name = options.name;
    this.preferredSkyDim = options.preferredSkyDim;
    this.capturesVerticalPan = options.capturesVerticalPan;
    this.loader = options.load;
  }

  mount(container: HTMLElement): void {
    if (this.attached && this.container === container) return;
    if (this.attached) this.unmount();

    this.container = container;
    const generation = ++this.generation;
    this.showStatus(`正在载入${this.name}…`, false);

    void this.resolveLayer()
      .then((layer) => {
        if (generation !== this.generation || this.container !== container) return;
        this.clearStatus();
        layer.mount(container);
        this.attached = true;
        if (this.data) layer.setData(this.data);
        layer.setQuality(this.quality);
        layer.setTime(this.time);
      })
      .catch((error: unknown) => {
        if (generation !== this.generation || this.container !== container) return;
        console.error(`[${this.id}] 场景载入失败`, error);
        this.showStatus(`${this.name}场景载入失败`, true);
      });
  }

  unmount(): void {
    this.generation += 1;
    this.clearStatus();
    if (this.attached) this.layer?.unmount();
    this.attached = false;
    this.container = null;
  }

  setTime(minutes: number): void {
    this.time = minutes;
    if (this.attached) this.layer?.setTime(minutes);
  }

  setData(data: DayData): void {
    this.data = data;
    if (this.attached) this.layer?.setData(data);
  }

  setQuality(quality: Quality): void {
    this.quality = quality;
    if (this.attached) this.layer?.setQuality(quality);
  }

  preload(): Promise<void> {
    return this.resolveLayer().then(() => undefined);
  }

  /** Resolves once the underlying layer is mounted into the current container. */
  whenReady(timeoutMs = 8_000): Promise<void> {
    const started = performance.now();
    return new Promise((resolve, reject) => {
      const tick = () => {
        if (this.attached && this.layer) {
          resolve();
          return;
        }
        if (performance.now() - started > timeoutMs) {
          reject(new Error(`[${this.id}] 场景未能在 ${timeoutMs}ms 内就绪`));
          return;
        }
        requestAnimationFrame(tick);
      };
      tick();
    });
  }

  /** Recreates a lost renderer without changing the App's active layer object. */
  recover(): void {
    const target = this.container;
    if (!target) return;
    this.unmount();
    this.mount(target);
  }

  private resolveLayer(): Promise<WeatherLayer> {
    if (this.layer) return Promise.resolve(this.layer);
    if (!this.layerPromise) {
      this.layerPromise = this.loader()
        .then((layer) => {
          this.layer = layer;
          return layer;
        })
        .catch((error: unknown) => {
          this.layerPromise = null;
          throw error;
        });
    }
    return this.layerPromise;
  }

  private showStatus(message: string, error: boolean): void {
    if (!this.container) return;
    if (!this.status) {
      this.status = document.createElement('p');
      this.status.className = 'serein-layer-status';
      this.container.appendChild(this.status);
    }
    this.status.dataset.error = String(error);
    this.status.textContent = message;
  }

  private clearStatus(): void {
    this.status?.remove();
    this.status = null;
  }
}
