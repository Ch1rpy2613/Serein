import { writable } from 'svelte/store';

const LIGHTNING_KEY = 'serein:potential-lightning';
const RADAR_OVERLAY_KEY = 'serein:radar-map-overlay';

export type RadarMapOverlay = 'radar' | 'satellite';

function readLightningPref(): boolean {
  if (typeof localStorage === 'undefined') return true;
  try {
    const raw = localStorage.getItem(LIGHTNING_KEY);
    if (raw === null) return true; // 默认开
    return raw !== '0' && raw !== 'false';
  } catch {
    return true;
  }
}

/**
 * 降水场景「潜势驱动」放电闪光总开关（默认开）。
 * 文案 / 注释须写「潜势驱动」，不得写「实时雷电」。
 */
export const potentialLightningEnabled = writable(readLightningPref());

if (typeof window !== 'undefined') {
  potentialLightningEnabled.subscribe((enabled) => {
    try {
      localStorage.setItem(LIGHTNING_KEY, enabled ? '1' : '0');
    } catch {
      // ignore
    }
  });
}

export function readRadarMapOverlay(): RadarMapOverlay {
  if (typeof localStorage === 'undefined') return 'radar';
  try {
    const raw = localStorage.getItem(RADAR_OVERLAY_KEY);
    return raw === 'satellite' ? 'satellite' : 'radar';
  } catch {
    return 'radar';
  }
}

export function writeRadarMapOverlay(overlay: RadarMapOverlay): void {
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.setItem(RADAR_OVERLAY_KEY, overlay);
  } catch {
    // ignore
  }
}
