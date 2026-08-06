import { DEFAULT_CITY, type DayData } from '../contracts';

const CARD_WIDTH = 1080;
const CARD_HEIGHT = 1350;
const PAD = 64;
const FONT_STACK = '-apple-system, "SF Pro", Inter, "PingFang SC", sans-serif';
const FG1 = 'rgba(255,255,255,.92)';
const FG2 = 'rgba(255,255,255,.45)';
const BG = '#05070a';

const COMPASS_NAMES = [
  '北风',
  '北东北风',
  '东北风',
  '东东北风',
  '东风',
  '东东南风',
  '东南风',
  '南东南风',
  '南风',
  '南西南风',
  '西南风',
  '西西南风',
  '西风',
  '西西北风',
  '西北风',
  '北西北风',
] as const;

const AQI_BANDS: readonly { max: number; label: string }[] = [
  { max: 50, label: '优' },
  { max: 100, label: '良' },
  { max: 150, label: '轻度污染' },
  { max: 200, label: '中度污染' },
  { max: 300, label: '重度污染' },
  { max: 500, label: '严重污染' },
];

export interface ShareCardOptions {
  /** Scene canvases bottom→top (sky first, active scene last). */
  canvases: HTMLCanvasElement[];
  cityName?: string;
  date: string;
  minutes: number;
  sceneId: string;
  sceneName: string;
  data: DayData;
  /** When true, capture profile overlay instead of weather scene HUD. */
  profileActive?: boolean;
}

interface HeroReading {
  value: string;
  unit: string;
  subtitle: string;
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}

function sampleSeries(values: ArrayLike<number> | undefined, minutes: number): number {
  if (!values || values.length === 0) return 0;
  const hour = clamp(minutes / 60, 0, 24);
  const last = values.length - 1;
  const left = Math.min(last, Math.floor(hour));
  const right = Math.min(last, left + 1);
  const t = hour - Math.floor(hour);
  const a = Number(values[left]) || 0;
  const b = Number(values[right]) || 0;
  return a + (b - a) * t;
}

function formatClock(minutes: number): string {
  const rounded = Math.round(clamp(minutes, 0, 1440));
  const hours = Math.floor(rounded / 60) % 24;
  const mins = rounded % 60;
  return `${String(hours).padStart(2, '0')}:${String(mins).padStart(2, '0')}`;
}

function formatTemp(value: number, signed = false): string {
  const text = Math.abs(value).toFixed(1).replace('-', '−');
  if (signed) {
    if (value > 0) return `+${text}`;
    if (value < 0) return `−${text}`;
    return text;
  }
  return value < 0 ? `−${text}` : text;
}

function compassName(degrees: number): string {
  const normalized = ((degrees % 360) + 360) % 360;
  const index = Math.floor((normalized + 11.25) / 22.5) % COMPASS_NAMES.length;
  return COMPASS_NAMES[index];
}

function aqiGrade(aqi: number): string {
  const value = clamp(aqi, 0, 500);
  for (const band of AQI_BANDS) {
    if (value <= band.max) return band.label;
  }
  return AQI_BANDS[AQI_BANDS.length - 1].label;
}

function precipPeak(precipitation: number[]): { value: number; hour: number } {
  let value = 0;
  let hour = 0;
  const limit = Math.min(24, precipitation.length);
  for (let i = 0; i < limit; i += 1) {
    const next = Number(precipitation[i]) || 0;
    if (next > value) {
      value = next;
      hour = i;
    }
  }
  return { value, hour };
}

function buildHero(options: ShareCardOptions): HeroReading {
  const { data, minutes, sceneId, profileActive } = options;

  if (profileActive || sceneId === 'profile') {
    const altitude =
      typeof document !== 'undefined'
        ? document.querySelector('.serein-profile-altitude')?.textContent?.replace(/\s+/g, ' ').trim()
        : '';
    if (altitude) {
      const match = /^([\d,]+)\s*m$/i.exec(altitude);
      if (match) {
        return { value: match[1], unit: 'm', subtitle: '大气垂直剖面' };
      }
      return { value: altitude, unit: '', subtitle: '大气垂直剖面' };
    }
    return { value: '剖面', unit: '', subtitle: '大气垂直剖面' };
  }

  switch (sceneId) {
    case 'temperature': {
      const value = sampleSeries(data.temperature, minutes);
      let min = Number.POSITIVE_INFINITY;
      let max = Number.NEGATIVE_INFINITY;
      for (const point of data.temperature) {
        if (point < min) min = point;
        if (point > max) max = point;
      }
      const range =
        Number.isFinite(min) && Number.isFinite(max)
          ? `最高 ${formatTemp(max)}° · 最低 ${formatTemp(min)}°`
          : options.sceneName;
      return {
        value: formatTemp(value),
        unit: '°C',
        subtitle: range,
      };
    }
    case 'precipitation': {
      const value = sampleSeries(data.precipitation, minutes);
      const peak = precipPeak(data.precipitation);
      return {
        value: value.toFixed(1),
        unit: 'mm/h',
        subtitle: `峰值 ${peak.value.toFixed(1)} mm/h · ${String(peak.hour).padStart(2, '0')}:00`,
      };
    }
    case 'wind': {
      const speed = sampleSeries(data.windSpeed, minutes);
      const direction = sampleSeries(data.windDirection, minutes);
      return {
        value: Math.max(0, speed).toFixed(1),
        unit: 'm/s',
        subtitle: compassName(direction),
      };
    }
    case 'humidity': {
      const humidity = sampleSeries(data.humidity, minutes);
      const dew = sampleSeries(data.dewPoint, minutes);
      return {
        value: String(Math.round(clamp(humidity, 0, 100))),
        unit: '%',
        subtitle: `露点 ${formatTemp(dew)}°C`,
      };
    }
    case 'aqi': {
      const aqi = sampleSeries(data.aqi?.usAqi, minutes);
      const rounded = Math.round(clamp(aqi, 0, 500));
      return {
        value: String(rounded),
        unit: 'AQI',
        subtitle: aqiGrade(rounded),
      };
    }
    case 'radar': {
      const value = sampleSeries(data.precipitation, minutes);
      return {
        value: value.toFixed(1),
        unit: 'mm/h',
        subtitle: `雷达回波 · ${formatClock(minutes)}`,
      };
    }
    case 'typhoon': {
      return {
        value: '—',
        unit: '',
        subtitle: '西北太平洋台风',
      };
    }
    case 'tide': {
      return {
        value: '—',
        unit: 'm',
        subtitle: `潮汐 · ${formatClock(minutes)}`,
      };
    }
    default:
      return { value: '—', unit: '', subtitle: options.sceneName };
  }
}

function isWebGLCanvas(canvas: HTMLCanvasElement): boolean {
  try {
    return Boolean(
      canvas.getContext('webgl2') ||
        canvas.getContext('webgl') ||
        canvas.getContext('experimental-webgl'),
    );
  } catch {
    return false;
  }
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error('分享帧解码失败'));
    image.src = src;
  });
}

async function captureFrame(
  canvas: HTMLCanvasElement,
): Promise<CanvasImageSource | null> {
  if (!(canvas instanceof HTMLCanvasElement)) return null;
  if (canvas.width < 1 || canvas.height < 1) return null;

  if (isWebGLCanvas(canvas)) {
    try {
      const dataUrl = canvas.toDataURL('image/png');
      return await loadImage(dataUrl);
    } catch {
      // Fall through to direct draw when toDataURL is blocked.
    }
  }

  return canvas;
}

function drawCover(
  context: CanvasRenderingContext2D,
  source: CanvasImageSource,
  x: number,
  y: number,
  width: number,
  height: number,
): void {
  const sourceWidth =
    'naturalWidth' in source && source.naturalWidth
      ? source.naturalWidth
      : 'videoWidth' in source && source.videoWidth
        ? source.videoWidth
        : 'width' in source
          ? Number(source.width)
          : 0;
  const sourceHeight =
    'naturalHeight' in source && source.naturalHeight
      ? source.naturalHeight
      : 'videoHeight' in source && source.videoHeight
        ? source.videoHeight
        : 'height' in source
          ? Number(source.height)
          : 0;
  if (sourceWidth < 1 || sourceHeight < 1) return;

  const scale = Math.max(width / sourceWidth, height / sourceHeight);
  const drawWidth = sourceWidth * scale;
  const drawHeight = sourceHeight * scale;
  const drawX = x + (width - drawWidth) / 2;
  const drawY = y + (height - drawHeight) / 2;
  context.drawImage(source, drawX, drawY, drawWidth, drawHeight);
}

function fitText(
  context: CanvasRenderingContext2D,
  text: string,
  maxWidth: number,
): string {
  if (context.measureText(text).width <= maxWidth) return text;
  const ellipsis = '…';
  let low = 0;
  let high = text.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    const candidate = `${text.slice(0, mid)}${ellipsis}`;
    if (context.measureText(candidate).width <= maxWidth) low = mid;
    else high = mid - 1;
  }
  return low > 0 ? `${text.slice(0, low)}${ellipsis}` : ellipsis;
}

/** Compose a 1080×1350 PNG blob from scene frames + typography. */
export async function composeShareCard(options: ShareCardOptions): Promise<Blob> {
  const canvas = document.createElement('canvas');
  canvas.width = CARD_WIDTH;
  canvas.height = CARD_HEIGHT;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('无法创建分享画布');

  context.fillStyle = BG;
  context.fillRect(0, 0, CARD_WIDTH, CARD_HEIGHT);
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = 'high';

  for (const source of options.canvases) {
    const frame = await captureFrame(source);
    if (!frame) continue;
    drawCover(context, frame, 0, 0, CARD_WIDTH, CARD_HEIGHT);
  }

  const topScrim = context.createLinearGradient(0, 0, 0, 280);
  topScrim.addColorStop(0, 'rgba(5,7,10,0.82)');
  topScrim.addColorStop(0.55, 'rgba(5,7,10,0.35)');
  topScrim.addColorStop(1, 'rgba(5,7,10,0)');
  context.fillStyle = topScrim;
  context.fillRect(0, 0, CARD_WIDTH, 280);

  const bottomScrim = context.createLinearGradient(0, CARD_HEIGHT - 520, 0, CARD_HEIGHT);
  bottomScrim.addColorStop(0, 'rgba(5,7,10,0)');
  bottomScrim.addColorStop(0.35, 'rgba(5,7,10,0.55)');
  bottomScrim.addColorStop(1, 'rgba(5,7,10,0.94)');
  context.fillStyle = bottomScrim;
  context.fillRect(0, CARD_HEIGHT - 520, CARD_WIDTH, 520);

  const city = options.cityName ?? DEFAULT_CITY.name;
  const timeLabel = formatClock(options.minutes);
  const datetime = `${options.date}  ${timeLabel}`;
  const hero = buildHero(options);
  const maxTextWidth = CARD_WIDTH - PAD * 2;

  context.textBaseline = 'top';
  context.fillStyle = FG1;
  context.font = `560 28px ${FONT_STACK}`;
  context.fillText(fitText(context, city, maxTextWidth), PAD, 56);

  context.fillStyle = FG2;
  context.font = `500 16px ${FONT_STACK}`;
  context.fillText(fitText(context, datetime, maxTextWidth), PAD, 96);

  const heroY = CARD_HEIGHT - 320;
  context.fillStyle = FG1;
  context.font = `340 96px ${FONT_STACK}`;
  const heroValue = fitText(context, hero.value, maxTextWidth * 0.72);
  context.fillText(heroValue, PAD, heroY);
  const valueWidth = context.measureText(heroValue).width;

  if (hero.unit) {
    context.fillStyle = FG2;
    context.font = `500 28px ${FONT_STACK}`;
    context.fillText(hero.unit, PAD + valueWidth + 16, heroY + 52);
  }

  if (hero.subtitle) {
    context.fillStyle = FG2;
    context.font = `500 20px ${FONT_STACK}`;
    context.fillText(fitText(context, hero.subtitle, maxTextWidth), PAD, heroY + 118);
  }

  context.fillStyle = FG1;
  context.font = `600 22px ${FONT_STACK}`;
  context.fillText('Atmos', PAD, CARD_HEIGHT - 88);

  context.fillStyle = FG2;
  context.font = `500 12px ${FONT_STACK}`;
  context.fillText('数据即天气', PAD, CARD_HEIGHT - 56);

  context.textAlign = 'right';
  context.font = `500 9px ${FONT_STACK}`;
  context.fillText('© Open-Meteo · RainViewer · NASA GIBS · OSM/CARTO', CARD_WIDTH - PAD, CARD_HEIGHT - 56);
  context.textAlign = 'left';

  const blob = await new Promise<Blob | null>((resolve) =>
    canvas.toBlob((value) => resolve(value), 'image/png'),
  );
  if (!blob) throw new Error('分享卡片导出失败');
  return blob;
}

function isInAppBrowser(): boolean {
  const ua = navigator.userAgent;
  return /MicroMessenger/i.test(ua) || /QQ\//i.test(ua) || /\bQQ\b/i.test(ua);
}

function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.rel = 'noopener';
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 2_000);
}

function dismissLongPressOverlay(overlay: HTMLElement, objectUrl: string): void {
  overlay.remove();
  URL.revokeObjectURL(objectUrl);
}

function showLongPressSave(blob: Blob): void {
  const objectUrl = URL.createObjectURL(blob);
  const overlay = document.createElement('div');
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-modal', 'true');
  overlay.setAttribute('aria-label', '长按图片保存');
  overlay.style.cssText = [
    'position:fixed',
    'inset:0',
    'z-index:9999',
    'display:flex',
    'flex-direction:column',
    'align-items:center',
    'justify-content:center',
    'gap:16px',
    'padding:24px',
    'background:rgba(5,7,10,0.92)',
    `color:${FG1}`,
    `font-family:${FONT_STACK}`,
  ].join(';');

  const hint = document.createElement('p');
  hint.textContent = '长按图片保存';
  hint.style.cssText =
    'margin:0;color:rgba(255,255,255,.45);font-size:14px;letter-spacing:.06em';

  const image = document.createElement('img');
  image.src = objectUrl;
  image.alt = 'Atmos 分享卡片';
  image.style.cssText = [
    'max-width:min(86vw,360px)',
    'max-height:70vh',
    'border-radius:12px',
    'box-shadow:0 18px 48px rgba(0,0,0,.45)',
    'touch-action:manipulation',
    '-webkit-touch-callout:default',
  ].join(';');

  const close = document.createElement('button');
  close.type = 'button';
  close.textContent = '关闭';
  close.style.cssText = [
    'margin-top:4px',
    'padding:10px 22px',
    'border:1px solid rgba(255,255,255,.22)',
    'border-radius:999px',
    'background:transparent',
    `color:${FG1}`,
    `font:500 13px ${FONT_STACK}`,
    'cursor:pointer',
  ].join(';');

  const onKey = (event: KeyboardEvent) => {
    if (event.key === 'Escape') cleanup();
  };
  const cleanup = () => {
    document.removeEventListener('keydown', onKey);
    dismissLongPressOverlay(overlay, objectUrl);
  };

  close.addEventListener('click', cleanup);
  overlay.addEventListener('click', (event) => {
    if (event.target === overlay) cleanup();
  });
  document.addEventListener('keydown', onKey);

  overlay.append(hint, image, close);
  document.body.appendChild(overlay);
}

async function deliverShareCard(blob: Blob, filename: string): Promise<void> {
  if (isInAppBrowser()) {
    showLongPressSave(blob);
    return;
  }

  const file = new File([blob], filename, { type: 'image/png' });
  const payload: ShareData = {
    files: [file],
    title: 'Atmos',
    text: '数据即天气',
  };

  try {
    if (typeof navigator.canShare === 'function' && navigator.canShare(payload)) {
      await navigator.share(payload);
      return;
    }
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') return;
  }

  downloadBlob(blob, filename);
}

export function collectSceneCanvases(
  root: ParentNode | null | undefined,
  options?: { profileActive?: boolean },
): HTMLCanvasElement[] {
  if (!root) return [];
  const canvases: HTMLCanvasElement[] = [];

  if (options?.profileActive) {
    const profile = root.querySelectorAll<HTMLCanvasElement>('.profile-stage canvas');
    for (const canvas of profile) canvases.push(canvas);
    return canvases;
  }

  const sky = root.querySelectorAll<HTMLCanvasElement>('.sky-layer canvas');
  const scene = root.querySelectorAll<HTMLCanvasElement>(
    '.scene-frame.interactive canvas, .scene-frame[aria-hidden="false"] canvas',
  );
  for (const canvas of sky) canvases.push(canvas);
  for (const canvas of scene) {
    if (!canvases.includes(canvas)) canvases.push(canvas);
  }
  return canvases;
}

function waitForPaint(): Promise<void> {
  return new Promise((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
  });
}

/** Capture, compose, and share/download a scene card. Failures fall back to download. */
export async function shareSceneCard(options: ShareCardOptions): Promise<void> {
  const city = options.cityName ?? DEFAULT_CITY.name;
  const stamp = options.date.replaceAll('-', '');
  const filename = `atmos-${city}-${stamp}-${options.sceneName}.png`;

  let blob: Blob;
  try {
    await waitForPaint();
    blob = await composeShareCard(options);
  } catch {
    return;
  }

  try {
    await deliverShareCard(blob, filename);
  } catch {
    try {
      downloadBlob(blob, filename);
    } catch {
      // Silent failure — share UX should never surface errors.
    }
  }
}
