import { describe, it, expect } from 'vitest';
import { renderOrrery, formatElapsed, NEEDS_YOU_PULSE_MS, NEEDS_YOU_GLINT_MS } from '../src/renderer';
import { SWING_DURATION_MS } from '../src/animation';
import { getPalette } from '../src/colors';
import type { OrreryPlanet, OrreryLayout } from '../src/types';

/** A 2D context stub that records arc radii and fill paths drawn around the planet. */
function recorder() {
  const arcs: number[] = [];
  let lineTos = 0;
  const ctx = new Proxy({} as Record<string, unknown>, {
    get(_t, prop) {
      const name = String(prop);
      if (name === 'arc') return (_x: number, _y: number, r: number) => arcs.push(Math.round(r * 100) / 100);
      if (name === 'lineTo') return () => { lineTos += 1; };
      if (name === 'measureText') return (s: string) => ({ width: String(s).length * 6 });
      if (name === 'createRadialGradient' || name === 'createLinearGradient') return () => ({ addColorStop: () => {} });
      return () => {};
    },
    set() { return true; },
  }) as unknown as CanvasRenderingContext2D;
  return { ctx, arcs, lineCount: () => lineTos };
}

function waitingPlanet(transitionStartTime: number | undefined): OrreryPlanet {
  return {
    id: 'p', sunId: 'sun', radius: 10, currentX: 300, currentY: 300,
    session: { id: 's', agent_id: 'claude', family: 'anthropic', project_root: '/p', title: 't', turns: 3, activity: 0.5, state: 'waiting' },
    orbitSemiMajor: 120, orbitSemiMinor: 90, orbitTilt: 0, angle: Math.PI / 2, startAngle: 0, targetAngle: Math.PI / 2,
    transitionProgress: 1, isFront: true, isDoneRing: false, haloProgress: 1, bellGlint: true, waitingElapsedMs: 75_000,
    transitionStartTime, moons: [],
  };
}

function layoutWith(planet: OrreryPlanet): OrreryLayout {
  return { suns: [{ id: 'sun', project: { id: 'p', name: 'Alpha', root: '/p' }, x: 300, y: 150, radius: 22 }], planets: [planet] };
}

function render(t: number, transitionStartTime: number | undefined, reducedMotion = false) {
  const rec = recorder();
  renderOrrery({
    ctx: rec.ctx, width: 800, height: 600, dpr: 1, theme: 'dark', palette: getPalette('dark'),
    layout: layoutWith(waitingPlanet(transitionStartTime)), hoveredPlanet: null, hoveredSun: null, focusedPlanet: null,
    timestamp: t, reducedMotion,
  });
  return rec;
}

/** Arcs drawn in addition to a reference (steady) frame: the one-off effects. */
function extraArcs(arcs: number[], steady: number[]): number[] {
  const pool = [...steady];
  const extra: number[] = [];
  for (const r of arcs) {
    const k = pool.indexOf(r);
    if (k >= 0) pool.splice(k, 1);
    else extra.push(r);
  }
  return extra;
}

describe('needs-you effects play once, then hold steady', () => {
  const start = 10_000;
  const arrival = start + SWING_DURATION_MS;

  it('the halo pulses once after the swing lands', () => {
    const steady = render(arrival + 60_000, start).arcs;
    const pulse = extraArcs(render(arrival + 300, start).arcs, steady);
    expect(pulse.length).toBe(1);
    expect(pulse[0]).toBeGreaterThan(10 + 4);
    expect(extraArcs(render(arrival + NEEDS_YOU_PULSE_MS + 50, start).arcs, steady)).toEqual([]);
    expect(extraArcs(render(arrival - 10, start).arcs, steady)).toEqual([]);
  });

  it('the steady halo is identical at any later time', () => {
    const a = render(arrival + 5_000, start).arcs;
    const b = render(arrival + 95_000, start).arcs;
    expect(a).toEqual(b);
  });

  it('the bell glint flares once (extra drawn star points only inside its window)', () => {
    const during = render(arrival + NEEDS_YOU_GLINT_MS / 2, start).lineCount();
    const after = render(arrival + NEEDS_YOU_GLINT_MS + 400 + NEEDS_YOU_PULSE_MS, start).lineCount();
    expect(during).toBeGreaterThan(after);
  });

  it('reduced motion shows the steady state with no pulse or glint', () => {
    const rm = render(arrival + 300, start, true);
    expect(extraArcs(rm.arcs, render(arrival + 60_000, start, true).arcs)).toEqual([]);
    expect(rm.lineCount()).toBe(render(arrival + 60_000, start, true).lineCount());
  });

  it('a waiting planet with no recorded swing start does not pulse', () => {
    expect(extraArcs(render(arrival + 300, undefined).arcs, render(arrival + 60_000, undefined).arcs)).toEqual([]);
  });

  it('formats elapsed waiting time quietly', () => {
    expect(formatElapsed(3_000)).toBe('now');
    expect(formatElapsed(42_000)).toBe('42s');
    expect(formatElapsed(75_000)).toBe('1m');
    expect(formatElapsed(3_900_000)).toBe('1h 5m');
  });
});
