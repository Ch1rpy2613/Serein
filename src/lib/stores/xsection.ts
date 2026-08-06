import { writable } from 'svelte/store';

export interface XSectionPoint {
  name: string;
  lat: number;
  lon: number;
}

export interface XSectionEndpoints {
  a: XSectionPoint;
  b: XSectionPoint;
  /** 关闭剖面后回到的地图场景 */
  returnSceneId: 'radar' | 'typhoon';
}

/** 当前空间剖面两端点；null 表示未打开 */
export const xsectionEndpoints = writable<XSectionEndpoints | null>(null);

/** 递增以请求关闭剖面并返回地图 */
export const xsectionCloseTick = writable(0);

export function openXSection(endpoints: XSectionEndpoints): void {
  xsectionEndpoints.set(endpoints);
}

export function requestCloseXSection(): void {
  xsectionCloseTick.update((n) => n + 1);
}
