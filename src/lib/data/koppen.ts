/**
 * Köppen–Geiger 气候分类本地查找（运行时零请求）。
 *
 * 网格由 `scripts/fetch-koppen.mjs` 离线生成（Beck et al. 2018 / GloH2O，CC-BY 4.0），
 * 1° 分辨率存于 `koppen-grid.json`。JSON 懒加载，不进首屏入口 chunk。
 */

export type KoppenGrid = {
  attribution: string;
  resolution: number;
  latMin: number;
  lonMin: number;
  rows: number;
  cols: number;
  legend: string[];
  /** 行优先 uint8 索引（row 0 = 北端 90°→89°），base64 */
  cells: string;
};

let data: KoppenGrid | null = null;
let decoded: Uint8Array | null = null;
let loadPromise: Promise<KoppenGrid> | null = null;

function decodeBase64(b64: string): Uint8Array {
  const atobFn =
    typeof globalThis.atob === 'function'
      ? globalThis.atob.bind(globalThis)
      : (s: string) => {
          // vitest / node 无 atob 时的最小解码
          const chars =
            'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/=';
          let str = s.replace(/=+$/, '');
          let output = '';
          for (let i = 0; i < str.length; i += 4) {
            const enc1 = chars.indexOf(str[i]);
            const enc2 = chars.indexOf(str[i + 1]);
            const enc3 = chars.indexOf(str[i + 2]);
            const enc4 = chars.indexOf(str[i + 3]);
            const bitmap = (enc1 << 18) | (enc2 << 12) | (enc3 << 6) | enc4;
            output += String.fromCharCode((bitmap >> 16) & 255);
            if (enc3 !== 64 && str[i + 2] !== undefined) {
              output += String.fromCharCode((bitmap >> 8) & 255);
            }
            if (enc4 !== 64 && str[i + 3] !== undefined) {
              output += String.fromCharCode(bitmap & 255);
            }
          }
          return output;
        };
  const bin = atobFn(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
  return out;
}

function cells(): Uint8Array {
  if (!data) return new Uint8Array();
  if (decoded) return decoded;
  decoded = decodeBase64(data.cells);
  return decoded;
}

function wrapLon(lon: number): number {
  let x = ((lon + 180) % 360 + 360) % 360 - 180;
  if (x === -180) x = -180;
  return x;
}

/** 懒加载网格（独立 chunk）；可重复调用 */
export async function ensureKoppenGrid(): Promise<KoppenGrid> {
  if (data) return data;
  if (!loadPromise) {
    loadPromise = import('./koppen-grid.json').then((mod) => {
      data = mod.default as KoppenGrid;
      decoded = null;
      return data;
    });
  }
  return loadPromise;
}

/**
 * 查 (lat, lon) 的 Köppen 分类码（如 `Dwa`）。
 * 网格未加载或海洋 / 无数据 → null。
 */
export function lookupKoppen(lat: number, lon: number): string | null {
  if (!data) return null;
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  if (lat < -90 || lat > 90) return null;
  const res = data.resolution;
  const row = Math.floor((90 - lat) / res);
  const col = Math.floor((wrapLon(lon) - data.lonMin) / res);
  if (row < 0 || row >= data.rows || col < 0 || col >= data.cols) return null;
  const idx = cells()[row * data.cols + col] ?? 0;
  if (!idx) return null;
  const code = data.legend[idx];
  return code && code !== 'Ocean' ? code : null;
}

export function koppenAttribution(): string {
  return data?.attribution ?? 'Beck et al. 2018, CC-BY 4.0';
}
