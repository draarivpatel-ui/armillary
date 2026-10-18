import { describe, it, expect } from 'vitest';
import { computeLayout } from '../src/layout';
import { generateMockData } from '../src/mock';

describe('Orrery Layout', () => {
  it('is deterministic for a seed', () => {
    const data1 = generateMockData({ seed: 42, projectCount: 4, sessionCount: 16 });
    const data2 = generateMockData({ seed: 42, projectCount: 4, sessionCount: 16 });

    const layout1 = computeLayout(data1.projects, data1.sessions, {
      width: 1200,
      height: 800,
      seed: 42,
    });

    const layout2 = computeLayout(data2.projects, data2.sessions, {
      width: 1200,
      height: 800,
      seed: 42,
    });

    expect(layout1.suns.length).toBe(4);
    expect(layout1.suns).toEqual(layout2.suns);
    expect(layout1.planets.length).toBe(layout2.planets.length);

    for (let i = 0; i < layout1.planets.length; i++) {
      expect(layout1.planets[i].currentX).toBeCloseTo(layout2.planets[i].currentX, 5);
      expect(layout1.planets[i].currentY).toBeCloseTo(layout2.planets[i].currentY, 5);
      expect(layout1.planets[i].orbitSemiMajor).toBeCloseTo(layout2.planets[i].orbitSemiMajor, 5);
    }
  });

  it('produces different layouts for different seeds', () => {
    const data1 = generateMockData({ seed: 42, projectCount: 4, sessionCount: 16 });
    const data2 = generateMockData({ seed: 99, projectCount: 4, sessionCount: 16 });

    const layout1 = computeLayout(data1.projects, data1.sessions, {
      width: 1200,
      height: 800,
      seed: 42,
    });

    const layout2 = computeLayout(data2.projects, data2.sessions, {
      width: 1200,
      height: 800,
      seed: 99,
    });

    // Positions should differ
    const pos1 = layout1.suns.map(s => `${s.x},${s.y}`).join(';');
    const pos2 = layout2.suns.map(s => `${s.x},${s.y}`).join(';');
    expect(pos1).not.toEqual(pos2);
  });

  it('places done sessions into the inner done ring', () => {
    const data = generateMockData({ seed: 101, projectCount: 3, sessionCount: 12 });
    const layout = computeLayout(data.projects, data.sessions, {
      width: 1000,
      height: 700,
      seed: 101,
    });

    const donePlanets = layout.planets.filter(p => p.session.state === 'done');
    expect(donePlanets.length).toBeGreaterThan(0);
    for (const p of donePlanets) {
      expect(p.isDoneRing).toBe(true);
      // Done ring has smaller semi-major radius close to the sun
      expect(p.orbitSemiMajor).toBeLessThan(80);
    }
  });

  it('groups subagents as moons around their parent planet', () => {
    const data = generateMockData({ seed: 202, projectCount: 3, sessionCount: 15 });
    const layout = computeLayout(data.projects, data.sessions, {
      width: 1000,
      height: 700,
      seed: 202,
    });

    const planetsWithMoons = layout.planets.filter(p => p.moons.length > 0);
    expect(planetsWithMoons.length).toBeGreaterThan(0);
    for (const p of planetsWithMoons) {
      for (const moon of p.moons) {
        expect(moon.parentPlanetId).toBe(p.id);
        expect(moon.session.parent_id).toBe(p.session.id);
      }
    }
  });

  it('does not throw when projects is empty and sessions are provided, placing them in an unassigned bucket', () => {
    const session = {
      id: 'sess-orphan',
      agent_id: 'claude-code',
      family: 'anthropic' as const,
      project_root: '/untracked/path',
      title: 'Untracked session',
      turns: 3,
      activity: 0.4,
      state: 'working' as const,
    };

    expect(() => {
      const layout = computeLayout([], [session], { width: 1000, height: 700 });
      expect(layout.suns.length).toBe(1);
      expect(layout.suns[0].id).toBe('sun-unassigned');
      expect(layout.suns[0].project.name).toBe('Unassigned');
      expect(layout.planets.length).toBe(1);
      expect(layout.planets[0].sunId).toBe('sun-unassigned');
    }).not.toThrow();
  });

  it('does not silently attach unmatched session root to the first project', () => {
    const project = { id: 'p1', name: 'Project Alpha', root: '/path/alpha' };
    const sessionAlpha = {
      id: 'sess-a',
      agent_id: 'claude-code',
      family: 'anthropic' as const,
      project_root: '/path/alpha',
      title: 'Alpha session',
      turns: 5,
      activity: 0.7,
      state: 'working' as const,
    };
    const sessionBeta = {
      id: 'sess-b',
      agent_id: 'codex',
      family: 'openai' as const,
      project_root: '/path/beta-unknown',
      title: 'Beta session',
      turns: 2,
      activity: 0.3,
      state: 'working' as const,
    };

    const layout = computeLayout([project], [sessionAlpha, sessionBeta], { width: 1000, height: 700 });
    const planetA = layout.planets.find(p => p.session.id === 'sess-a');
    const planetB = layout.planets.find(p => p.session.id === 'sess-b');

    expect(planetA?.sunId).toBe('sun-p1');
    expect(planetB?.sunId).not.toBe('sun-p1');
    expect(planetB?.sunId).toBe('sun-unassigned');
    expect(layout.suns.some(s => s.id === 'sun-unassigned')).toBe(true);
  });
});
