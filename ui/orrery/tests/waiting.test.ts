import { describe, it, expect } from 'vitest';
import { updateAnimationState } from '../src/animation';
import { OrreryPlanet } from '../src/types';

describe('Orrery Waiting Transition', () => {
  function makeMockPlanet(overrides?: Partial<OrreryPlanet>): OrreryPlanet {
    return {
      id: 'p-1',
      session: {
        id: 's-1',
        agent_id: 'claude-code',
        family: 'anthropic',
        project_root: '/p',
        title: 'Refactor test',
        turns: 12,
        activity: 0.8,
        state: 'waiting',
        waiting_since: 1000,
      },
      sunId: 'sun-1',
      orbitSemiMajor: 120,
      orbitSemiMinor: 75,
      orbitTilt: 0.2,
      angle: 0,
      startAngle: 0,
      targetAngle: Math.PI / 2, // Front of orbit
      transitionProgress: 0,
      currentX: 100,
      currentY: 100,
      radius: 12,
      isFront: false,
      isDoneRing: false,
      haloProgress: 0,
      bellGlint: false,
      waitingElapsedMs: 0,
      moons: [],
      ...overrides,
    };
  }

  it('starts at initial angle when transition begins', () => {
    const planet = makeMockPlanet({ angle: 0, startAngle: 0, targetAngle: Math.PI / 2 });
    updateAnimationState([planet], { elapsedMs: 0, deltaMs: 0, reducedMotion: false });
    expect(planet.angle).toBeCloseTo(0, 2);
    expect(planet.isFront).toBe(false);
  });

  it('interpolates towards the front position at halfway (300 ms)', () => {
    const planet = makeMockPlanet({ angle: 0, startAngle: 0, targetAngle: Math.PI / 2 });
    updateAnimationState([planet], { elapsedMs: 300, deltaMs: 300, reducedMotion: false });
    // Cubic-bezier / smooth easing should place it between 0 and PI/2
    expect(planet.angle).toBeGreaterThan(0.2);
    expect(planet.angle).toBeLessThan(Math.PI / 2);
  });

  it('reaches the front position at 600 ms and triggers halo pulse', () => {
    const planet = makeMockPlanet({ angle: 0, startAngle: 0, targetAngle: Math.PI / 2 });
    updateAnimationState([planet], { elapsedMs: 650, deltaMs: 650, reducedMotion: false });
    // Swung to front (Math.PI / 2)
    expect(planet.angle).toBeCloseTo(Math.PI / 2, 2);
    expect(planet.isFront).toBe(true);
    // Halo has pulsed and holds steady (progress >= 1)
    expect(planet.haloProgress).toBeGreaterThanOrEqual(1);
    // Bell glint triggered
    expect(planet.bellGlint).toBe(true);
  });
});
