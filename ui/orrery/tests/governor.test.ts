import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { FrameGovernor } from '../src/animation';

describe('FrameGovernor timing and integration', () => {
  let originalRaf: typeof globalThis.requestAnimationFrame;
  let originalCancelRaf: typeof globalThis.cancelAnimationFrame;
  let rafCallback: FrameRequestCallback | null = null;
  let rafIdCounter = 0;

  beforeEach(() => {
    originalRaf = globalThis.requestAnimationFrame;
    originalCancelRaf = globalThis.cancelAnimationFrame;
    rafCallback = null;
    rafIdCounter = 0;

    globalThis.requestAnimationFrame = (cb: FrameRequestCallback): number => {
      rafCallback = cb;
      return ++rafIdCounter;
    };
    globalThis.cancelAnimationFrame = (_id: number): void => {
      rafCallback = null;
    };
  });

  afterEach(() => {
    globalThis.requestAnimationFrame = originalRaf;
    globalThis.cancelAnimationFrame = originalCancelRaf;
  });

  it('does not overcount animation time during a 10s 60Hz probe', () => {
    let totalIntegratedDelta = 0;
    let callCount = 0;

    // Fixed performance.now starting at 0
    vi.spyOn(performance, 'now').mockReturnValue(0);

    const governor = new FrameGovernor((_timestamp, deltaMs) => {
      totalIntegratedDelta += deltaMs;
      callCount++;
    });

    governor.start();

    // Simulate 10 seconds of 60 Hz display refresh (~16.6667 ms per frame, 600 frames)
    const frameDuration = 1000 / 60; // 16.666666...
    const totalDuration = 10000;

    for (let t = frameDuration; t <= totalDuration + 0.001; t += frameDuration) {
      vi.spyOn(performance, 'now').mockReturnValue(t);
      if (rafCallback) {
        const cb = rafCallback;
        rafCallback = null;
        cb(t);
      }
    }

    governor.destroy();

    expect(callCount).toBeGreaterThan(0);
    // Over 10 seconds (10000ms), the total integrated delta should match 10000ms closely,
    // NOT overcount to ~11533ms due to double-counting the modulo remainder
    expect(totalIntegratedDelta).toBeGreaterThanOrEqual(9900);
    expect(totalIntegratedDelta).toBeLessThanOrEqual(10100);
  });
});
