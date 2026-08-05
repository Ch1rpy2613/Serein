import { writable } from 'svelte/store';
import { CITY } from '../contracts';

/** 城市时区下的今日 ISO 日期 YYYY-MM-DD */
function todayIso(): string {
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
    if (year && month && day) return `${year}-${month}-${day}`;
  } catch {
    // fall through
  }
  return new Date().toISOString().slice(0, 10);
}

/** 体感 feel / 分析 analysis */
export const appMode = writable<'feel' | 'analysis'>('feel');
/** 当前分析/展示日期，ISO YYYY-MM-DD */
export const currentDate = writable<string>(todayIso());
