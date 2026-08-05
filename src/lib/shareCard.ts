import { CITY } from './contracts';

const CARD_WIDTH = 1080;
const CARD_HEIGHT = 1350;

export interface ShareCardOptions {
  /** Scene canvases bottom→top (sky first, active scene last). */
  canvases: HTMLCanvasElement[];
  cityName?: string;
  date: string;
  sceneName: string;
  reading: string;
  timeLabel: string;
}

function roundRect(
  context: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  radius: number,
): void {
  const r = Math.min(radius, width / 2, height / 2);
  context.beginPath();
  context.moveTo(x + r, y);
  context.arcTo(x + width, y, x + width, y + height, r);
  context.arcTo(x + width, y + height, x, y + height, r);
  context.arcTo(x, y + height, x, y, r);
  context.arcTo(x, y, x + width, y, r);
  context.closePath();
}

function drawCover(
  context: CanvasRenderingContext2D,
  source: HTMLCanvasElement,
  x: number,
  y: number,
  width: number,
  height: number,
): void {
  if (source.width < 1 || source.height < 1) return;
  const scale = Math.max(width / source.width, height / source.height);
  const drawWidth = source.width * scale;
  const drawHeight = source.height * scale;
  const drawX = x + (width - drawWidth) / 2;
  const drawY = y + (height - drawHeight) / 2;
  context.drawImage(source, drawX, drawY, drawWidth, drawHeight);
}

/** Compose a 1080×1350 PNG share card and trigger download. */
export async function downloadShareCard(options: ShareCardOptions): Promise<void> {
  const canvas = document.createElement('canvas');
  canvas.width = CARD_WIDTH;
  canvas.height = CARD_HEIGHT;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('无法创建分享画布');

  context.fillStyle = '#05070a';
  context.fillRect(0, 0, CARD_WIDTH, CARD_HEIGHT);

  const mediaX = 0;
  const mediaY = 0;
  const mediaW = CARD_WIDTH;
  const mediaH = Math.round(CARD_HEIGHT * 0.72);

  for (const source of options.canvases) {
    if (!(source instanceof HTMLCanvasElement)) continue;
    if (source.width < 1 || source.height < 1) continue;
    drawCover(context, source, mediaX, mediaY, mediaW, mediaH);
  }

  const fade = context.createLinearGradient(0, mediaH * 0.55, 0, mediaH);
  fade.addColorStop(0, 'rgba(5,7,10,0)');
  fade.addColorStop(1, 'rgba(5,7,10,0.92)');
  context.fillStyle = fade;
  context.fillRect(0, mediaH * 0.55, CARD_WIDTH, mediaH * 0.45);

  context.fillStyle = '#05070a';
  context.fillRect(0, mediaH, CARD_WIDTH, CARD_HEIGHT - mediaH);

  const city = options.cityName ?? CITY.name;
  const pad = 72;

  context.fillStyle = 'rgba(255,255,255,0.45)';
  context.font = '500 28px -apple-system, "SF Pro", Inter, "PingFang SC", sans-serif';
  context.textBaseline = 'top';
  context.fillText('Atmos', pad, mediaH + 48);

  context.fillStyle = 'rgba(255,255,255,0.92)';
  context.font = '560 64px -apple-system, "SF Pro", Inter, "PingFang SC", sans-serif';
  context.fillText(city, pad, mediaH + 96);

  context.fillStyle = 'rgba(255,255,255,0.45)';
  context.font =
    '500 30px -apple-system, "SF Pro", Inter, "PingFang SC", sans-serif';
  context.fillText(`${options.date}  ·  ${options.timeLabel}`, pad, mediaH + 176);

  roundRect(context, pad, mediaH + 240, CARD_WIDTH - pad * 2, 120, 18);
  context.fillStyle = 'rgba(255,255,255,0.06)';
  context.fill();

  context.fillStyle = 'rgba(255,255,255,0.45)';
  context.font = '500 26px -apple-system, "SF Pro", Inter, "PingFang SC", sans-serif';
  context.fillText(options.sceneName, pad + 36, mediaH + 262);

  context.fillStyle = 'rgba(255,255,255,0.92)';
  context.font =
    '340 56px -apple-system, "SF Pro", Inter, "PingFang SC", sans-serif';
  context.fillText(options.reading, pad + 36, mediaH + 300);

  const blob = await new Promise<Blob | null>((resolve) =>
    canvas.toBlob((value) => resolve(value), 'image/png'),
  );
  if (!blob) throw new Error('分享卡片导出失败');

  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  const stamp = options.date.replaceAll('-', '');
  anchor.href = url;
  anchor.download = `atmos-${city}-${stamp}-${options.sceneName}.png`;
  anchor.rel = 'noopener';
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 2_000);
}

export function collectSceneCanvases(root: ParentNode | null | undefined): HTMLCanvasElement[] {
  if (!root) return [];
  const sky = root.querySelectorAll<HTMLCanvasElement>('.sky-layer canvas');
  const scene = root.querySelectorAll<HTMLCanvasElement>(
    '.scene-frame.interactive canvas, .scene-frame[aria-hidden="false"] canvas',
  );
  const canvases: HTMLCanvasElement[] = [];
  for (const canvas of sky) canvases.push(canvas);
  for (const canvas of scene) {
    if (!canvases.includes(canvas)) canvases.push(canvas);
  }
  return canvases;
}

export function readActiveSceneReading(root: ParentNode | null | undefined): string {
  if (!root) return '—';
  const frame =
    root.querySelector<HTMLElement>('.scene-frame.interactive') ??
    root.querySelector<HTMLElement>('.scene-frame[aria-hidden="false"]');
  if (!frame) return '—';

  const readout =
    frame.querySelector<HTMLElement>('.serein-temperature-readout') ??
    frame.querySelector<HTMLElement>('.serein-precipitation-readout') ??
    frame.querySelector<HTMLElement>('.serein-wind-speed') ??
    frame.querySelector<HTMLElement>('.serein-humidity-readout') ??
    frame.querySelector<HTMLElement>('.serein-aqi-readout');

  const text = readout?.textContent?.replace(/\s+/g, ' ').trim();
  return text && text.length > 0 ? text : '—';
}
