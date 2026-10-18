import { describe, it, expect, vi } from 'vitest';
import { updateAnimationState } from '../src/animation';
import { OrreryPlanet } from '../src/types';

describe('Orrery Reduced Motion', () => {
  function makeWorkingPlanet(): OrreryPlanet {
    return {
      id: 'p-working',
      session: {
        id: 's-w',
        agent_id: 'codex',
        family: 'openai',
        project_root: '/p',
        title: 'Background indexing',
        turns: 5,
        activity: 1.0,
        state: 'working',
      },
      sunId: 'sun-1',
      orbitSemiMajor: 150,
      orbitSemiMinor: 90,
      orbitTilt: 0,
      angle: 1.25,
      startAngle: 1.25,
      targetAngle: 1.25,
      transitionProgress: 1,
      currentX: 100,
      currentY: 100,
      radius: 10,
      isFront: false,
      isDoneRing: false,
      haloProgress: 0,
      bellGlint: false,
      waitingElapsedMs: 0,
      moons: [],
    };
  }

  it('holds planet positions static over time when reducedMotion is true', () => {
    const planet = makeWorkingPlanet();
    const initialAngle = planet.angle;

    // Simulate 5000 ms elapsed with reducedMotion: true
    updateAnimationState([planet], { elapsedMs: 5000, deltaMs: 5000, reducedMotion: true });

    expect(planet.angle).toBe(initialAngle);
  });

  it('advances planet orbit angle over time when reducedMotion is false', () => {
    const planet = makeWorkingPlanet();
    const initialAngle = planet.angle;

    // Simulate 1000 ms elapsed with reducedMotion: false
    updateAnimationState([planet], { elapsedMs: 1000, deltaMs: 1000, reducedMotion: false });

    expect(planet.angle).not.toBe(initialAngle);
    expect(planet.angle).toBeGreaterThan(initialAngle);
  });

  it('governs rendering with reducedMotion and keeps waiting halo steady after transition', async () => {
    const { renderOrrery } = await import('../src/renderer');
    const { getPalette } = await import('../src/colors');

    const arcRadii: number[] = [];
    const mockCtx = {
      save: () => {},
      restore: () => {},
      scale: () => {},
      translate: () => {},
      rotate: () => {},
      beginPath: () => {},
      closePath: () => {},
      arc: (_x: number, _y: number, r: number) => {
        arcRadii.push(Math.round(r * 100) / 100);
      },
      fill: () => {},
      stroke: () => {},
      fillRect: () => {},
      strokeRect: () => {},
      clearRect: () => {},
      moveTo: () => {},
      lineTo: () => {},
      ellipse: () => {},
      fillText: () => {},
      setLineDash: () => {},
      createRadialGradient: () => ({ addColorStop: () => {} }),
    } as unknown as CanvasRenderingContext2D;

    const waitingPlanet: OrreryPlanet = {
      id: 'p-wait',
      session: {
        id: 's-wait',
        agent_id: 'claude',
        family: 'anthropic',
        project_root: '/p',
        title: 'Needs you',
        turns: 4,
        activity: 0.5,
        state: 'waiting',
      },
      sunId: 'sun-1',
      orbitSemiMajor: 120,
      orbitSemiMinor: 80,
      orbitTilt: 0,
      angle: Math.PI / 2,
      startAngle: 0,
      targetAngle: Math.PI / 2,
      transitionProgress: 1.0,
      currentX: 200,
      currentY: 200,
      radius: 10,
      isFront: true, // transition already finished
      isDoneRing: false,
      haloProgress: 1.0,
      bellGlint: true,
      waitingElapsedMs: 5000,
      moons: [],
    };

    const layout = {
      suns: [{ id: 'sun-1', project: { id: 'p', name: 'P', root: '/p' }, x: 200, y: 100, radius: 20 }],
      planets: [waitingPlanet],
    };

    const palette = getPalette('dark');

    // Render at t=300 (peak of sine wave in old code)
    arcRadii.length = 0;
    renderOrrery({
      ctx: mockCtx,
      width: 800,
      height: 600,
      dpr: 1,
      theme: 'dark',
      palette,
      layout,
      hoveredPlanet: null,
      hoveredSun: null,
      focusedPlanet: null,
      timestamp: 300,
      reducedMotion: true,
    } as any);
    const radiusAt300 = [...arcRadii];

    // Render at t=900 (trough of sine wave in old code)
    arcRadii.length = 0;
    renderOrrery({
      ctx: mockCtx,
      width: 800,
      height: 600,
      dpr: 1,
      theme: 'dark',
      palette,
      layout,
      hoveredPlanet: null,
      hoveredSun: null,
      focusedPlanet: null,
      timestamp: 900,
      reducedMotion: true,
    } as any);
    const radiusAt900 = [...arcRadii];

    // In reduced motion or when isFront is true, halo radius must be steady, NOT oscillating with timestamp
    expect(radiusAt300).toEqual(radiusAt900);
  });

  it('resolves OS prefers-reduced-motion when reducedMotion prop is omitted', async () => {
    (globalThis as any).window = globalThis;
    (globalThis as any).matchMedia = vi.fn().mockImplementation((query: string) => ({
      matches: query === '(prefers-reduced-motion: reduce)',
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    }));

    const { resolveReducedMotion } = await import('../src/OrreryComponent');
    expect(typeof resolveReducedMotion).toBe('function');
    expect(resolveReducedMotion(undefined)).toBe(true);
    expect(resolveReducedMotion(false)).toBe(false);
    expect(resolveReducedMotion(true)).toBe(true);
  });
});
