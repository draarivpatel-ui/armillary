import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const animationCalls: Array<{ elapsedMs: number; timestamp?: number }> = [];
const rendererCalls: Array<{ timestamp: number }> = [];

vi.mock('../src/animation', async importOriginal => {
  const orig = await importOriginal<typeof import('../src/animation')>();
  return {
    ...orig,
    updateAnimationState: (planets: any, options: any) => {
      animationCalls.push({ elapsedMs: options.elapsedMs, timestamp: options.timestamp });
      return orig.updateAnimationState(planets, options);
    },
  };
});

vi.mock('../src/renderer', async importOriginal => {
  const orig = await importOriginal<typeof import('../src/renderer')>();
  return {
    ...orig,
    renderOrrery: (rc: any) => {
      rendererCalls.push({ timestamp: rc.timestamp });
      return orig.renderOrrery(rc);
    },
  };
});

import { Orrery } from '../src/orrery';
import { createRecordingCanvas, makeSession, PROJECT } from './helpers';

describe('tick() passes the same t to animation and renderer', () => {
  let originalRaf: typeof globalThis.requestAnimationFrame;
  let originalCancel: typeof globalThis.cancelAnimationFrame;
  let rafCb: FrameRequestCallback | null = null;

  beforeEach(() => {
    originalRaf = globalThis.requestAnimationFrame;
    originalCancel = globalThis.cancelAnimationFrame;
    rafCb = null;
    globalThis.requestAnimationFrame = (cb: FrameRequestCallback) => {
      rafCb = cb;
      return 1;
    };
    globalThis.cancelAnimationFrame = () => {
      rafCb = null;
    };
    vi.spyOn(performance, 'now').mockImplementation(() => {
      throw new Error('performance.now must not be read');
    });
    animationCalls.length = 0;
    rendererCalls.length = 0;
  });

  afterEach(() => {
    globalThis.requestAnimationFrame = originalRaf;
    globalThis.cancelAnimationFrame = originalCancel;
    vi.restoreAllMocks();
  });

  function fire(ts: number) {
    const cb = rafCb!;
    rafCb = null;
    cb(ts);
  }

  it('uses t = rafTs - firstRafTs for both', () => {
    const { canvas } = createRecordingCanvas();
    const orrery = new Orrery(canvas, { width: 1200, height: 800, seed: 42 });
    orrery.setData([PROJECT], [makeSession('s1')]);
    animationCalls.length = 0;
    rendererCalls.length = 0;

    fire(250_000.5);
    fire(250_034.5);
    fire(250_100.5);

    const tickAnim = animationCalls.slice(-3);
    const tickRender = rendererCalls.slice(-3);
    expect(tickRender.map(c => c.timestamp)).toEqual([0, 34, 100]);
    expect(tickAnim.map(c => c.timestamp)).toEqual([0, 34, 100]);
    expect(tickAnim.map(c => c.elapsedMs)).toEqual([0, 34, 100]);
    orrery.destroy();
  });
});
