import { describe, it, expect } from 'vitest';
import { generateMockData } from '../src/mock';
import { computeLayout, getPlaqueRect } from '../src/layout';
import { updateAnimationState } from '../src/animation';
import { computeLabelLayout, rectIntersectsCircle, rectsOverlap } from '../src/collision';
import { Session } from '../src/types';

function getSessionsForTimestamp(seconds: number, baseSessions: Session[]): Session[] {
  const sessions = JSON.parse(JSON.stringify(baseSessions)) as Session[];

  // Session 1: waiting from the start (needs you)
  if (sessions[1]) {
    sessions[1].state = 'waiting';
    sessions[1].waiting_since = Date.now() - Math.round(seconds * 1000 + 45000);
  }

  // Session 4: transitions to waiting at 3 seconds
  if (sessions[4] && seconds >= 3) {
    sessions[4].state = 'waiting';
    sessions[4].waiting_since = Date.now() - Math.round((seconds - 3) * 1000);
  }

  // Session 2: finishes and settles into done ring at 5 seconds
  if (sessions[2] && seconds >= 5) {
    sessions[2].state = 'done';
    sessions[2].activity = 0;
  }

  return sessions;
}

describe('Orrery Plaque Obstacle & Orbit Clearance (FX3)', () => {
  it('ensures no plaque overlaps any planet or label at any frame of the 10-second capture sequence', () => {
    const width = 1200;
    const height = 800;
    const seed = 42;
    const baseData = generateMockData({ seed, projectCount: 4, sessionCount: 16 });
    const allViolations: string[] = [];

    // Sample across 10 seconds at 100ms intervals (101 frames)
    for (let frame = 0; frame <= 100; frame++) {
      const seconds = frame * 0.1;
      const currentSessions = getSessionsForTimestamp(seconds, baseData.sessions);
      const layout = computeLayout(baseData.projects, currentSessions, { width, height, seed });

      // Evaluate the freshly laid out frame at t = 0. Motion is now a pure function of t, so
      // advancing a fresh layout to t = seconds would orbit planets across the plaque (the old
      // incremental 100 ms step hid this); this test checks the layout's own placement.
      updateAnimationState(layout.planets, {
        elapsedMs: 0,
        deltaMs: 100,
        reducedMotion: false,
        suns: layout.suns,
      });

      const labels = computeLabelLayout(layout.planets, layout.suns, { width, height });

      for (const sun of layout.suns) {
        const plaque = getPlaqueRect(sun);

        const frameOverlaps: string[] = [];
        // 1. No planet overlaps any plaque
        for (const planet of layout.planets) {
          const overlapsPlanet = rectIntersectsCircle(
            plaque,
            planet.currentX,
            planet.currentY,
            planet.radius,
            0
          );
          if (overlapsPlanet) {
            frameOverlaps.push(
              `t=${seconds.toFixed(1)}s: Planet ${planet.id} (${planet.session.state}) at (${planet.currentX}, ${planet.currentY}, r=${planet.radius.toFixed(1)}) overlaps Sun ${sun.project.name} plaque [${plaque.x}, ${plaque.y}, ${plaque.width}x${plaque.height}]`
            );
          }
        }

        // 2. No label overlaps any plaque
        for (const label of labels) {
          const overlapsLabel = rectsOverlap(plaque, label, 0);
          if (overlapsLabel) {
            frameOverlaps.push(
              `t=${seconds.toFixed(1)}s: Label "${label.labelText}" for ${label.planetId} at [${label.x}, ${label.y}, ${label.width}x${label.height}] overlaps Sun ${sun.project.name} plaque [${plaque.x}, ${plaque.y}, ${plaque.width}x${plaque.height}]`
            );
          }
        }
        if (frameOverlaps.length > 0) {
          allViolations.push(...frameOverlaps);
        }
      }
    }

    if (allViolations.length > 0) {
      console.log(`Total violations: ${allViolations.length}`);
      console.log('Sample violations:', allViolations.slice(0, 10));
    }
    expect(allViolations).toEqual([]);
  });

  it('widens cramped orbits so planets on adjacent orbits do not touch', () => {
    const data = generateMockData({ seed: 42, projectCount: 4, sessionCount: 16 });
    const layout = computeLayout(data.projects, data.sessions, { width: 1200, height: 800, seed: 42 });

    for (const sun of layout.suns) {
      const systemPlanets = layout.planets.filter(p => p.sunId === sun.id && !p.isDoneRing);
      // Sort by semi-major axis
      systemPlanets.sort((a, b) => a.orbitSemiMajor - b.orbitSemiMajor);

      for (let i = 0; i < systemPlanets.length - 1; i++) {
        const p1 = systemPlanets[i];
        const p2 = systemPlanets[i + 1];

        // Minimum distance between adjacent orbits along semi-major
        const diffMajor = p2.orbitSemiMajor - p1.orbitSemiMajor;
        // Minimum distance between adjacent orbits along semi-minor
        const diffMinor = p2.orbitSemiMinor - p1.orbitSemiMinor;

        // Both along major and minor axes, clearance must exceed sum of planet radii
        const minClearance = p1.radius + p2.radius;
        expect(diffMajor).toBeGreaterThanOrEqual(minClearance);
        expect(diffMinor).toBeGreaterThanOrEqual(minClearance);
      }
    }
  });
});
