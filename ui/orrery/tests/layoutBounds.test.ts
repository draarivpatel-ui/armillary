import { describe, it, expect } from 'vitest';
import { computeLayout } from '../src/layout';
import { Project, Session } from '../src/types';

function sess(id: string, root: string, over: Partial<Session> = {}): Session {
  return {
    id,
    agent_id: 'claude',
    family: 'anthropic',
    project_root: root,
    title: id,
    turns: 6,
    activity: 0.6,
    state: 'working',
    ...over,
  };
}

function assertInside(layout: ReturnType<typeof computeLayout>, w: number, h: number, margin = 24) {
  const eps = 0.5;
  for (const sun of layout.suns) {
    expect(sun.x - sun.radius).toBeGreaterThanOrEqual(margin - eps);
    expect(sun.x + sun.radius).toBeLessThanOrEqual(w - margin + eps);
    expect(sun.y - sun.radius).toBeGreaterThanOrEqual(margin - eps);
    expect(sun.y + sun.radius).toBeLessThanOrEqual(h - margin + eps);
  }
  for (const p of layout.planets) {
    const sun = layout.suns.find(s => s.id === p.sunId)!;
    const a = p.orbitSemiMajor;
    const b = p.orbitSemiMinor;
    const ex = Math.hypot(a * Math.cos(p.orbitTilt), b * Math.sin(p.orbitTilt));
    const ey = Math.hypot(a * Math.sin(p.orbitTilt), b * Math.cos(p.orbitTilt));
    expect(sun.x - ex).toBeGreaterThanOrEqual(margin - eps);
    expect(sun.x + ex).toBeLessThanOrEqual(w - margin + eps);
    expect(sun.y - ey).toBeGreaterThanOrEqual(margin - eps);
    expect(sun.y + ey).toBeLessThanOrEqual(h - margin + eps);
  }
}

describe('small canvas bounds (640x420)', () => {
  const W = 640;
  const H = 420;

  it('keeps 12 sessions in one project inside the canvas', () => {
    const proj: Project = { id: 'p1', name: 'One', root: '/one' };
    const sessions = Array.from({ length: 12 }, (_, i) =>
      sess(`s${i}`, '/one', { state: i % 4 === 0 ? 'waiting' : 'working' })
    );
    assertInside(computeLayout([proj], sessions, { width: W, height: H, seed: 42 }), W, H);
  });

  for (const n of [2, 3, 4, 5, 6, 8]) {
    it(`keeps ${n} projects with several sessions each inside the canvas`, () => {
      const projects: Project[] = Array.from({ length: n }, (_, i) => ({ id: `p${i}`, name: `P${i}`, root: `/p${i}` }));
      const sessions = projects.flatMap((p, i) =>
        Array.from({ length: 5 }, (_, j) => sess(`s${i}-${j}`, p.root, { state: j === 0 ? 'waiting' : 'working' }))
      );
      assertInside(computeLayout(projects, sessions, { width: W, height: H, seed: 42 }), W, H);
    });
  }
});

describe('very small canvas bounds (480x320)', () => {
  for (const n of [4, 8]) {
    it(`keeps ${n} projects with 12 sessions each inside the canvas`, () => {
      const projects: Project[] = Array.from({ length: n }, (_, i) => ({ id: `p${i}`, name: `P${i}`, root: `/p${i}` }));
      const sessions = projects.flatMap((p, i) =>
        Array.from({ length: 12 }, (_, j) => sess(`s${i}-${j}`, p.root))
      );
      assertInside(computeLayout(projects, sessions, { width: 480, height: 320, seed: 42 }), 480, 320);
    });
  }
});

describe('orphan subagents', () => {
  it('marks a subagent whose parent is absent as isOrphan and leaves others unmarked', () => {
    const proj: Project = { id: 'p1', name: 'One', root: '/one' };
    const sessions = [
      sess('parent', '/one'),
      sess('child', '/one', { parent_id: 'parent' }),
      sess('orphan', '/one', { parent_id: 'missing-parent' }),
      sess('orphan-done', '/one', { parent_id: 'missing-parent', state: 'done' }),
    ];
    const layout = computeLayout([proj], sessions, { width: 1200, height: 800, seed: 42 });
    const byId = new Map(layout.planets.map(p => [p.session.id, p]));
    expect(byId.get('orphan')?.isOrphan).toBe(true);
    expect(byId.get('orphan-done')?.isOrphan).toBe(true);
    expect(byId.get('parent')?.isOrphan).toBeFalsy();
    expect(byId.has('child')).toBe(false);
    expect(byId.get('parent')!.moons.length).toBe(1);
  });
});
