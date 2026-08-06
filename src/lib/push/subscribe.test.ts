import { describe, expect, it } from 'vitest';
import { urlBase64ToUint8Array } from './subscribe';

describe('urlBase64ToUint8Array', () => {
  it('decodes URL-safe base64 without padding', () => {
    // "hello" in standard base64 is aGVsbG8= → URL-safe aGVsbG8
    const bytes = urlBase64ToUint8Array('aGVsbG8');
    expect(Array.from(bytes)).toEqual([104, 101, 108, 108, 111]);
  });

  it('accepts standard base64 with padding characters replaced', () => {
    const bytes = urlBase64ToUint8Array('AQID');
    expect(Array.from(bytes)).toEqual([1, 2, 3]);
  });
});
