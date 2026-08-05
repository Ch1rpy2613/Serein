import { writable, get } from 'svelte/store';

/**
 * Single shared AudioContext for every weather scene.
 * Layers own their source/filter/gain nodes; they must never close this context.
 */

export const muted = writable(false);

let context: AudioContext | null = null;
let masterGain: GainNode | null = null;
let muteUnsubscribe: (() => void) | null = null;

function AudioContextConstructor(): typeof AudioContext | null {
  if (typeof window === 'undefined') return null;
  return (
    window.AudioContext ??
    (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext ??
    null
  );
}

export function getSharedAudioContext(): AudioContext | null {
  if (context && context.state !== 'closed') return context;

  const Constructor = AudioContextConstructor();
  if (!Constructor) return null;

  try {
    context = new Constructor({ latencyHint: 'interactive' });
  } catch {
    try {
      context = new Constructor();
    } catch {
      context = null;
      return null;
    }
  }

  masterGain = context.createGain();
  masterGain.gain.value = get(muted) ? 0 : 1;
  masterGain.connect(context.destination);

  if (!muteUnsubscribe) {
    muteUnsubscribe = muted.subscribe((isMuted) => {
      if (!masterGain || !context || context.state === 'closed') return;
      const now = context.currentTime;
      masterGain.gain.cancelScheduledValues(now);
      masterGain.gain.setTargetAtTime(isMuted ? 0 : 1, now, 0.04);
    });
  }

  return context;
}

/** Master bus — layers should connect their output here, not to destination. */
export function getMasterGain(): GainNode | null {
  if (!getSharedAudioContext()) return null;
  return masterGain;
}

export async function resumeSharedAudio(): Promise<AudioContext | null> {
  const audio = getSharedAudioContext();
  if (!audio) return null;
  if (audio.state === 'suspended') {
    await audio.resume().catch(() => undefined);
  }
  return audio;
}

export function setMuted(next: boolean): void {
  muted.set(next);
}

export function toggleMuted(): boolean {
  const next = !get(muted);
  muted.set(next);
  return next;
}

/** Disconnect layer nodes without closing the shared context. */
export function releaseAudioNodes(
  ...nodes: Array<AudioNode | AudioBufferSourceNode | null | undefined>
): void {
  for (const node of nodes) {
    if (!node) continue;
    try {
      if ('stop' in node && typeof node.stop === 'function') {
        node.stop();
      }
    } catch {
      // Already stopped after an interruption.
    }
    try {
      node.disconnect();
    } catch {
      // Already disconnected.
    }
  }
}
