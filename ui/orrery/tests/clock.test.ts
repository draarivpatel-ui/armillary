import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { Orrery } from '../src/orrery';
import { FrameGovernor } from '../src/animation';
import { createRecordingCanvas, makeSession, PROJECT } from './helpers';

const WALL_EPOCH = 1_760_000_000_000;

function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (/\.(ts|tsx)$/.test(name)) out.push(p);
  }
  return out;
}

describe('one injectable clock: source scan', () => {
  it('has no Date.now or performance.now outside the two host files', () => {
    const srcDir = join(__dirname, '..', 'src');
    const offenders: string[] = [];
    let componentCount = 0;
    for (const file of walk(srcDir)) {
      const code = stripComments(readFileSync(file, 'utf8'));
      const count = (code.match(/\b(Date\.now|performance\.now)\s*\(/g) || []).length;
      const base = file.split('/').pop()!;
      if (base === 'OrreryComponent.tsx') {
        componentCount = count;
        continue;
      }
      if (base === 'demo.tsx') continue;
      if (count > 0) offenders.push(`${base}: ${count}`);
    }
    expect(offenders).toEqual([]);
    expect(componentCount).toBe(1);
  });
});

describe('needs-you swing with Unix ms data (review item 9)', () => {
  it('swings over 600 ms from the update arrival, not from waiting_since', () => {
    const { canvas } = createRecordingCanvas();
    const orrery = new Orrery(canvas, { width: 1200, height: 800, seed: 42, paused: true, wallEpochMs: WALL_EPOCH });
    orrery.setData([PROJECT], [makeSession('s1')]);
    orrery.renderAt(5000);

    orrery.setData([PROJECT], [makeSession('s1', { state: 'waiting', waiting_since: WALL_EPOCH + 4000 })]);

    orrery.renderAt(5000);
    let p = orrery.getLayout().planets[0];
    expect(p.transitionStartTime).toBe(5000);
    expect(p.transitionProgress).toBe(0);
    expect(p.isFront).toBe(false);

    orrery.renderAt(5300);
    p = orrery.getLayout().planets[0];
    expect(p.transitionProgress).toBeGreaterThan(0);
    expect(p.transitionProgress).toBeLessThan(1);
    expect(p.isFront).toBe(false);

    orrery.renderAt(5600);
    p = orrery.getLayout().planets[0];
    expect(p.transitionProgress).toBe(1);
    expect(p.isFront).toBe(true);
    expect(p.waitingElapsedMs).toBe(1600);
    orrery.destroy();
  });

  it('derives the label text from waitingElapsedMs and wallEpochMs', () => {
    const { canvas } = createRecordingCanvas();
    const orrery = new Orrery(canvas, { width: 1200, height: 800, seed: 42, paused: true, wallEpochMs: WALL_EPOCH });
    orrery.setData([PROJECT], [makeSession('s1', { state: 'waiting', waiting_since: WALL_EPOCH - 120_000 })]);
    orrery.renderAt(0);
    expect(orrery.getLayout().planets[0].labelLayout?.labelText).toBe('Needs you (2m)');
    orrery.renderAt(60_000);
    expect(orrery.getLayout().planets[0].labelLayout?.labelText).toBe('Needs you (3m)');
    orrery.setWallEpoch(WALL_EPOCH + 60_000);
    orrery.renderAt(60_000);
    expect(orrery.getLayout().planets[0].labelLayout?.labelText).toBe('Needs you (4m)');
    orrery.destroy();
  });

  it('without waiting_since, elapsed is time since the swing began', () => {
    const { canvas } = createRecordingCanvas();
    const orrery = new Orrery(canvas, { width: 1200, height: 800, seed: 42, paused: true, wallEpochMs: WALL_EPOCH });
    orrery.setData([PROJECT], [makeSession('s1')]);
    orrery.renderAt(2000);
    orrery.setData([PROJECT], [makeSession('s1', { state: 'waiting' })]);
    orrery.renderAt(4500);
    expect(orrery.getLayout().planets[0].waitingElapsedMs).toBe(2500);
    orrery.destroy();
  });
});

describe('purity', () => {
  it('renderAt twice at the same t gives identical state and identical draw calls mid-swing', () => {
    const { canvas, calls } = createRecordingCanvas();
    const orrery = new Orrery(canvas, { width: 1200, height: 800, seed: 42, paused: true, wallEpochMs: WALL_EPOCH });
    orrery.setData([PROJECT], [makeSession('s1'), makeSession('s2', { activity: 0.3 }), makeSession('s3', { parent_id: 's1' })]);
    orrery.renderAt(5000);
    orrery.setData(
      [PROJECT],
      [
        makeSession('s1'),
        makeSession('s2', { activity: 0.3, state: 'waiting', waiting_since: WALL_EPOCH + 4000 }),
        makeSession('s3', { parent_id: 's1' }),
      ]
    );

    calls.length = 0;
    orrery.renderAt(5300);
    const callsA = calls.slice();
    const stateA = JSON.stringify(orrery.getLayout().planets);

    calls.length = 0;
    orrery.renderAt(5300);
    const callsB = calls.slice();
    const stateB = JSON.stringify(orrery.getLayout().planets);

    expect(callsA.length).toBeGreaterThan(20);
    expect(stateB).toBe(stateA);
    expect(callsB).toEqual(callsA);

    // stepping away and back reproduces the same frame
    orrery.renderAt(9000);
    calls.length = 0;
    orrery.renderAt(5300);
    expect(calls.slice()).toEqual(callsA);
    expect(JSON.stringify(orrery.getLayout().planets)).toBe(stateA);
    orrery.destroy();
  });

  it('a data update that changes activity does not make an orbiting planet jump', () => {
    const { canvas } = createRecordingCanvas();
    const orrery = new Orrery(canvas, { width: 1200, height: 800, seed: 42, paused: true });
    orrery.setData([PROJECT], [makeSession('s1', { activity: 0.2 })]);
    orrery.renderAt(30_000);
    const before = orrery.getLayout().planets[0].angle;
    orrery.setData([PROJECT], [makeSession('s1', { activity: 1.0 })]);
    orrery.renderAt(30_000);
    expect(orrery.getLayout().planets[0].angle).toBeCloseTo(before, 6);
    orrery.destroy();
  });
});

describe('mount with an already waiting session', () => {
  it('is at the front with progress 1 at the first render', () => {
    const { canvas } = createRecordingCanvas();
    const orrery = new Orrery(canvas, { width: 1200, height: 800, seed: 42, paused: true, wallEpochMs: WALL_EPOCH });
    orrery.setData([PROJECT], [makeSession('s1', { state: 'waiting', waiting_since: WALL_EPOCH - 90_000 })]);
    orrery.renderAt(0);
    const p = orrery.getLayout().planets[0];
    expect(p.transitionProgress).toBe(1);
    expect(p.isFront).toBe(true);
    expect(p.transitionStartTime).toBe(-600);
    expect(p.waitingElapsedMs).toBe(90_000);
    orrery.destroy();
  });

  it('uses the current t of the controller at setData', () => {
    const { canvas } = createRecordingCanvas();
    const orrery = new Orrery(canvas, { width: 1200, height: 800, seed: 42, paused: true });
    orrery.renderAt(2000);
    orrery.setData([PROJECT], [makeSession('s1', { state: 'waiting' })]);
    const p = orrery.getLayout().planets[0];
    expect(p.transitionStartTime).toBe(1400);
    expect(p.transitionProgress).toBe(1);
    expect(p.isFront).toBe(true);
    orrery.destroy();
  });
});

describe('reduced motion', () => {
  it('holds positions identical at t=0 and t=60000 and snaps waiting planets to the front', () => {
    const { canvas } = createRecordingCanvas();
    const orrery = new Orrery(canvas, { width: 1200, height: 800, seed: 42, paused: true, reducedMotion: true });
    const snap = () =>
      JSON.stringify(
        orrery.getLayout().planets.map(p => [p.angle, p.currentX, p.currentY, p.moons.map(m => [m.angle, m.x, m.y])])
      );
    orrery.setData([PROJECT], [makeSession('s1'), makeSession('s2', { parent_id: 's1' }), makeSession('s3', { activity: 0.1 })]);
    orrery.renderAt(0);
    const snap0 = snap();
    orrery.renderAt(60_000);
    expect(snap()).toBe(snap0);

    orrery.setData([PROJECT], [makeSession('s1', { state: 'waiting' }), makeSession('s2', { parent_id: 's1' }), makeSession('s3', { activity: 0.1 })]);
    const waiting = orrery.getLayout().planets.find(p => p.session.id === 's1')!;
    expect(waiting.isFront).toBe(true);
    expect(waiting.transitionProgress).toBe(1);
    orrery.renderAt(60_000);
    expect(orrery.getLayout().planets.find(p => p.session.id === 's1')!.isFront).toBe(true);
    orrery.destroy();
  });
});

describe('FrameGovernor uses only rAF timestamps', () => {
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
      throw new Error('performance.now must not be read by the governor');
    });
  });

  afterEach(() => {
    globalThis.requestAnimationFrame = originalRaf;
    globalThis.cancelAnimationFrame = originalCancel;
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  function fire(ts: number) {
    const cb = rafCb!;
    rafCb = null;
    cb(ts);
  }

  it('derives throttling and deltas from the timestamps it is handed', () => {
    const seen: Array<[number, number]> = [];
    // the throttle is opt-in now (the host sets the budget); test it at an explicit 30 fps
    const g = new FrameGovernor((ts, delta) => seen.push([ts, delta]), { maxFps: 30 });
    g.start();
    fire(5000);
    fire(5016.7); // throttled at 30 fps
    fire(5040);
    fire(5080);
    g.destroy();
    expect(seen.map(s => s[0])).toEqual([5000, 5040, 5080]);
    expect(seen[0][1]).toBe(0);
    expect(seen[1][1]).toBeCloseTo(40, 9);
    expect(seen[2][1]).toBeCloseTo(40, 9);
  });

  it('the idle 1 fps path also reads the rAF timestamp', () => {
    vi.useFakeTimers();
    const seen: Array<[number, number]> = [];
    const g = new FrameGovernor((ts, delta) => seen.push([ts, delta]));
    g.setActiveMovement(false);
    g.start();
    vi.advanceTimersByTime(1000);
    fire(7000);
    g.destroy();
    expect(seen.length).toBe(1);
    expect(seen[0][0]).toBe(7000);
  });
});
