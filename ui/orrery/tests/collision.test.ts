import { describe, it, expect } from 'vitest';
import { computeLabelLayout } from '../src/collision';
import { OrreryPlanet, OrrerySun } from '../src/types';

describe('Orrery Label Collision Avoidance', () => {
  function makeWaitingPlanet(id: string, x: number, y: number, radius = 12): OrreryPlanet {
    return {
      id,
      session: {
        id: `s-${id}`,
        agent_id: 'claude',
        family: 'anthropic',
        project_root: '/proj',
        title: `Session ${id}`,
        turns: 5,
        activity: 0.8,
        state: 'waiting',
        waiting_since: Date.now() - 45000,
      },
      sunId: 'sun-1',
      orbitSemiMajor: 100,
      orbitSemiMinor: 70,
      orbitTilt: 0,
      angle: Math.PI / 2,
      startAngle: Math.PI / 2,
      targetAngle: Math.PI / 2,
      transitionProgress: 1,
      currentX: x,
      currentY: y,
      radius,
      isFront: true,
      isDoneRing: false,
      haloProgress: 1,
      bellGlint: true,
      waitingElapsedMs: 45000,
      moons: [],
    };
  }

  const mockSun: OrrerySun = {
    id: 'sun-1',
    project: { id: 'p-1', name: 'ASTROLABE-CORE', root: '/proj' },
    x: 400,
    y: 300,
    radius: 24,
  };

  function rectsOverlap(
    r1: { x: number; y: number; width: number; height: number },
    r2: { x: number; y: number; width: number; height: number },
    padding = 2
  ): boolean {
    return !(
      r1.x + r1.width + padding <= r2.x ||
      r2.x + r2.width + padding <= r1.x ||
      r1.y + r1.height + padding <= r2.y ||
      r2.y + r2.height + padding <= r1.y
    );
  }

  it('ensures no two needs-you labels collide or overlap when planets are nearby', () => {
    // Two planets close to each other at the bottom front of orbits
    const p1 = makeWaitingPlanet('p1', 380, 390);
    const p2 = makeWaitingPlanet('p2', 420, 400);

    const labels = computeLabelLayout([p1, p2], [mockSun], { width: 1200, height: 800 });

    expect(labels.length).toBe(2);

    // Bounding boxes must not overlap
    const overlaps = rectsOverlap(labels[0], labels[1]);
    expect(overlaps).toBe(false);
  });

  it('creates leader lines in gilt hairline when a label must move to avoid collision', () => {
    // Three clustered waiting planets
    const p1 = makeWaitingPlanet('p1', 400, 380);
    const p2 = makeWaitingPlanet('p2', 415, 395);
    const p3 = makeWaitingPlanet('p3', 390, 410);

    const labels = computeLabelLayout([p1, p2, p3], [mockSun], { width: 1200, height: 800 });

    expect(labels.length).toBe(3);

    // At least one label must be displaced and have a leaderLine defined
    const displaced = labels.filter(l => l.isDisplaced);
    expect(displaced.length).toBeGreaterThanOrEqual(1);

    for (const l of displaced) {
      expect(l.leaderLine).toBeDefined();
      expect(l.leaderLine?.fromX).toBeDefined();
      expect(l.leaderLine?.fromY).toBeDefined();
      expect(l.leaderLine?.toX).toBeDefined();
      expect(l.leaderLine?.toY).toBeDefined();
    }

    // Verify all 3 labels do not overlap each other
    for (let i = 0; i < labels.length; i++) {
      for (let j = i + 1; j < labels.length; j++) {
        expect(rectsOverlap(labels[i], labels[j])).toBe(false);
      }
    }
  });

  it('ensures labels do not overlap planet bodies', () => {
    const p1 = makeWaitingPlanet('p1', 400, 380, 16);
    const p2 = makeWaitingPlanet('p2', 400, 430, 16);

    const labels = computeLabelLayout([p1, p2], [mockSun], { width: 1200, height: 800 });

    for (const label of labels) {
      for (const planet of [p1, p2]) {
        // Label bounding box should not overlap the planet circle
        const closestX = Math.max(label.x, Math.min(planet.currentX, label.x + label.width));
        const closestY = Math.max(label.y, Math.min(planet.currentY, label.y + label.height));
        const distSq = (planet.currentX - closestX) ** 2 + (planet.currentY - closestY) ** 2;
        // Distance must be >= planet radius (not intersecting)
        expect(Math.sqrt(distSq)).toBeGreaterThanOrEqual(planet.radius - 1);
      }
    }
  });
});
