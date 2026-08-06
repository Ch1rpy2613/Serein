/**
 * 空间剖面网格：沿程距离 × 高度，列失败时邻列插值。
 */

import type { AtmosProfile, ProfilePoint } from '../../contracts';

export type XSectionVariable = 'temperature' | 'humidity' | 'wind';

export const HEIGHT_MAX_M = 12_000;
export const HEIGHT_STEP_M = 250;
export const SAMPLE_COUNT = 7;

export interface XSectionColumn {
  lat: number;
  lon: number;
  distanceKm: number;
  /** 原始廓线；失败为 null */
  profile: AtmosProfile | null;
  failed: boolean;
}

export interface XSectionGrid {
  /** 列数（含端点） */
  cols: number;
  /** 行数：高度层 */
  rows: number;
  heightsM: Float32Array;
  distancesKm: Float32Array;
  /** row-major: value[row * cols + col] */
  values: Float32Array;
  variable: XSectionVariable;
  /** 有效数值范围（忽略 NaN） */
  min: number;
  max: number;
}

const clamp = (x: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, x));

function sampleProfileAtHeight(levels: readonly ProfilePoint[], heightM: number, pick: (p: ProfilePoint) => number): number {
  if (levels.length === 0) return Number.NaN;
  if (levels.length === 1) return pick(levels[0]);
  if (heightM <= levels[0].heightM) return pick(levels[0]);
  if (heightM >= levels[levels.length - 1].heightM) return pick(levels[levels.length - 1]);
  for (let i = 0; i < levels.length - 1; i += 1) {
    const a = levels[i];
    const b = levels[i + 1];
    if (heightM >= a.heightM && heightM <= b.heightM) {
      const span = b.heightM - a.heightM || 1;
      const t = (heightM - a.heightM) / span;
      return pick(a) + (pick(b) - pick(a)) * t;
    }
  }
  return pick(levels[levels.length - 1]);
}

function pickVariable(variable: XSectionVariable): (p: ProfilePoint) => number {
  if (variable === 'humidity') return (p) => p.rh;
  if (variable === 'wind') return (p) => p.windSpeed;
  return (p) => p.temperature;
}

/** 将各列廓线插到等高网格；失败列用左右邻列线性插值 */
export function buildXSectionGrid(
  columns: readonly XSectionColumn[],
  variable: XSectionVariable,
): XSectionGrid {
  const cols = columns.length;
  const rows = Math.floor(HEIGHT_MAX_M / HEIGHT_STEP_M) + 1;
  const heightsM = new Float32Array(rows);
  for (let r = 0; r < rows; r += 1) heightsM[r] = r * HEIGHT_STEP_M;
  const distancesKm = new Float32Array(cols);
  for (let c = 0; c < cols; c += 1) distancesKm[c] = columns[c].distanceKm;

  const pick = pickVariable(variable);
  const raw = new Float32Array(rows * cols);
  raw.fill(Number.NaN);

  for (let c = 0; c < cols; c += 1) {
    const profile = columns[c].profile;
    if (!profile || columns[c].failed || profile.levels.length === 0) continue;
    const levels = [...profile.levels].sort((a, b) => a.heightM - b.heightM);
    for (let r = 0; r < rows; r += 1) {
      raw[r * cols + c] = sampleProfileAtHeight(levels, heightsM[r], pick);
    }
  }

  const columnHasData = (c: number): boolean => {
    for (let r = 0; r < rows; r += 1) {
      if (Number.isFinite(raw[r * cols + c])) return true;
    }
    return false;
  };

  // 失败列：按距离在最近左右成功列之间插值
  const values = new Float32Array(raw);
  for (let c = 0; c < cols; c += 1) {
    if (columnHasData(c)) continue;

    let left = -1;
    let right = -1;
    for (let i = c - 1; i >= 0; i -= 1) {
      if (columnHasData(i)) {
        left = i;
        break;
      }
    }
    for (let i = c + 1; i < cols; i += 1) {
      if (columnHasData(i)) {
        right = i;
        break;
      }
    }

    for (let r = 0; r < rows; r += 1) {
      const idx = r * cols + c;
      if (left >= 0 && right >= 0) {
        const dL = distancesKm[c] - distancesKm[left];
        const dR = distancesKm[right] - distancesKm[left];
        const t = dR > 1e-6 ? dL / dR : 0.5;
        const vL = raw[r * cols + left];
        const vR = raw[r * cols + right];
        values[idx] =
          Number.isFinite(vL) && Number.isFinite(vR) ? vL + (vR - vL) * t : Number.NaN;
      } else if (left >= 0) {
        values[idx] = raw[r * cols + left];
      } else if (right >= 0) {
        values[idx] = raw[r * cols + right];
      }
    }
  }

  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  for (let i = 0; i < values.length; i += 1) {
    const v = values[i];
    if (!Number.isFinite(v)) continue;
    if (v < min) min = v;
    if (v > max) max = v;
  }
  if (!Number.isFinite(min) || !Number.isFinite(max)) {
    min = 0;
    max = 1;
  }
  if (max - min < 1e-3) {
    min -= 1;
    max += 1;
  }

  return { cols, rows, heightsM, distancesKm, values, variable, min, max };
}

/** 在单列中找 value 穿越高度（线性）；无则 null */
export function heightOfValue(
  grid: XSectionGrid,
  col: number,
  target: number,
): number | null {
  const { rows, cols, heightsM, values } = grid;
  for (let r = 0; r < rows - 1; r += 1) {
    const v0 = values[r * cols + col];
    const v1 = values[(r + 1) * cols + col];
    if (!Number.isFinite(v0) || !Number.isFinite(v1)) continue;
    if ((v0 - target) * (v1 - target) > 0) continue;
    if (v0 === v1) return heightsM[r];
    const t = (target - v0) / (v1 - v0);
    return heightsM[r] + (heightsM[r + 1] - heightsM[r]) * clamp(t, 0, 1);
  }
  return null;
}
