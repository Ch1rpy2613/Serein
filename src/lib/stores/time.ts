import { writable } from 'svelte/store';
export const currentTime = writable(480);  // 分钟 0–1440，默认 08:00
export const isPlaying = writable(false);
export const playSpeed = writable(1);      // 小时/秒，可选 0.5 / 1 / 4
/** 时间轴正在拖拽（探空等重绘节流用） */
export const isScrubbing = writable(false);
