import { describe, it, expect } from 'vitest';
import { computeLayout } from '../src/layout';
import { generateMockData } from '../src/mock';

describe('Orrery Non-Overlapping Systems & Star-Chart Layout', () => {
  it('distributes suns across vertical space instead of a single horizontal band', () => {
    const data = generateMockData({ seed: 42, projectCount: 4, sessionCount: 16 });
    const layout = computeLayout(data.projects, data.sessions, {
      width: 1200,
      height: 800,
      seed: 42,
    });

    const sunYs = layout.suns.map(s => s.y);
    const minY = Math.min(...sunYs);
    const maxY = Math.max(...sunYs);

    // Vertical spread must be substantial (at least 200px across the canvas)
    expect(maxY - minY).toBeGreaterThanOrEqual(200);

    // Suns must occupy both the upper region and lower region of the canvas
    const hasUpper = sunYs.some(y => y < 380);
    const hasLower = sunYs.some(y => y > 420);
    expect(hasUpper).toBe(true);
    expect(hasLower).toBe(true);
  });

  it('guarantees that neighbouring systems never overlap across various seeds and configurations', () => {
    const testCases = [
      { seed: 42, projects: 4, sessions: 16 },
      { seed: 99, projects: 3, sessions: 12 },
      { seed: 123, projects: 5, sessions: 20 },
      { seed: 777, projects: 4, sessions: 24 },
    ];

    for (const tc of testCases) {
      const data = generateMockData({ seed: tc.seed, projectCount: tc.projects, sessionCount: tc.sessions });
      const layout = computeLayout(data.projects, data.sessions, {
        width: 1200,
        height: 800,
        seed: tc.seed,
      });

      // Calculate max orbit radius per sun
      const maxOrbitBySun = new Map<string, number>();
      for (const sun of layout.suns) {
        maxOrbitBySun.set(sun.id, sun.radius);
      }

      for (const planet of layout.planets) {
        const currentMax = maxOrbitBySun.get(planet.sunId) || 0;
        if (planet.orbitSemiMajor > currentMax) {
          maxOrbitBySun.set(planet.sunId, planet.orbitSemiMajor);
        }
      }

      // Check all pairs of suns
      for (let i = 0; i < layout.suns.length; i++) {
        for (let j = i + 1; j < layout.suns.length; j++) {
          const sunA = layout.suns[i];
          const sunB = layout.suns[j];
          const dist = Math.hypot(sunA.x - sunB.x, sunA.y - sunB.y);
          const rA = maxOrbitBySun.get(sunA.id)!;
          const rB = maxOrbitBySun.get(sunB.id)!;

          // Crucial acceptance criterion: system orbits must NEVER overlap
          expect(dist).toBeGreaterThan(rA + rB);
        }
      }
    }
  });
});
