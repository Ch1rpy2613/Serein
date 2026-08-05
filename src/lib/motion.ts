import { readable } from 'svelte/store';

/** Sync snapshot for imperative WeatherLayer code. */
export function getPrefersReducedMotion(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
    return false;
  }
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/** Reactive preference for Svelte UI. */
export const prefersReducedMotion = readable(getPrefersReducedMotion(), (set) => {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
    set(false);
    return () => undefined;
  }

  const query = window.matchMedia('(prefers-reduced-motion: reduce)');
  const update = () => set(query.matches);
  update();
  query.addEventListener('change', update);
  return () => query.removeEventListener('change', update);
});

/** Halve particle budgets when reduced motion is on. */
export function particleBudget(count: number, reduced = getPrefersReducedMotion()): number {
  if (!Number.isFinite(count) || count <= 0) return 0;
  return reduced ? Math.max(1, Math.floor(count * 0.5)) : Math.floor(count);
}

export function subscribeReducedMotion(listener: (reduced: boolean) => void): () => void {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
    listener(false);
    return () => undefined;
  }

  const query = window.matchMedia('(prefers-reduced-motion: reduce)');
  const update = () => listener(query.matches);
  update();
  query.addEventListener('change', update);
  return () => query.removeEventListener('change', update);
}
