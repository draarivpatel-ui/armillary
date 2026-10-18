import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { FrameGovernor } from '../src/animation';
import { Orrery } from '../src/orrery';
import { ORRERY_FRAME, ORRERY_LAYOUT_SEED } from '../src/seam';
import { FRAME_METRICS } from '../src/renderer';
import { createRecordingCanvas, makeSession, PROJECT } from './helpers';

describe('host frame budget', () => {
  let rafCallback: FrameRequestCallback | null = null;
  const realRaf = globalThis.requestAnimationFrame;
  const realCancel = globalThis.cancelAnimationFrame;
  beforeEach(() => {
    rafCallback = null;
    globalThis.requestAnimationFrame = (cb: FrameRequestCallback) => {
      rafCallback = cb;
      return 1;
    };
    globalThis.cancelAnimationFrame = () => {
      rafCallback = null;
    };
  });
  afterEach(() => {
    globalThis.requestAnimationFrame = realRaf;
    globalThis.cancelAnimationFrame = realCancel;
  });

  function run(governor: FrameGovernor, frames: number): number {
    let count = 0;
    governor.start();
    for (let i = 1; i <= frames; i++) {
      const cb = rafCallback;
      rafCallback = null;
      cb?.(i * (1000 / 60));
    }
    governor.destroy();
    return count;
  }

  it('paints every host frame by default (no 30 fps judder in a 60 fps recording)', () => {
    let count = 0;
    const g = new FrameGovernor(() => {
      count += 1;
    });
    run(g, 120);
    expect(count).toBe(120);
  });

  it('honours a host-set budget when asked', () => {
    let count = 0;
    const g = new FrameGovernor(
      () => {
        count += 1;
      },
      { maxFps: 30 },
    );
    run(g, 120);
    expect(count).toBeGreaterThanOrEqual(58);
    expect(count).toBeLessThanOrEqual(61);
  });
});

describe('live layout for the first-run handoff', () => {
  it('layoutAt(t) gives positions at t without touching the live state', () => {
    const { canvas } = createRecordingCanvas(1200, 800);
    const orrery = new Orrery(canvas, { width: 1200, height: 800, paused: true });
    orrery.setData([PROJECT], [makeSession('a'), makeSession('b')]);
    orrery.renderAt(1000);
    const before = JSON.stringify(orrery.getLayout().planets.map((p) => [p.currentX, p.currentY]));
    const at = orrery.layoutAt(25_000);
    expect(JSON.stringify(orrery.getLayout().planets.map((p) => [p.currentX, p.currentY]))).toBe(before);
    expect(orrery.now()).toBe(1000);
    orrery.renderAt(25_000);
    expect(at.planets.map((p) => [p.currentX, p.currentY])).toEqual(
      orrery.getLayout().planets.map((p) => [p.currentX, p.currentY]),
    );
    expect(at.suns.map((s) => [s.x, s.y, s.radius])).toEqual(orrery.getLayout().suns.map((s) => [s.x, s.y, s.radius]));
    orrery.destroy();
  });
});

describe('seam constants', () => {
  it('the renderer draws the frame from the seam constants', () => {
    expect(FRAME_METRICS.outer).toBe(ORRERY_FRAME.outerInset);
    expect(FRAME_METRICS.inner).toBe(ORRERY_FRAME.innerInset);
    expect(FRAME_METRICS.scaleDegrees).toBe(ORRERY_FRAME.scaleDegrees);
    expect(ORRERY_LAYOUT_SEED).toBe(42);
  });
});
