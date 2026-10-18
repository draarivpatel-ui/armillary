import { describe, it, expect } from 'vitest';
import { computeLayout } from '../src/layout';
import { generateMockData } from '../src/mock';
import { hitTest } from '../src/hitTest';

describe('Orrery Hit Testing', () => {
  it('finds the right planet at mouse coordinates', () => {
    const data = generateMockData({ seed: 77, projectCount: 3, sessionCount: 9 });
    const layout = computeLayout(data.projects, data.sessions, {
      width: 1000,
      height: 800,
      seed: 77,
    });

    const target = layout.planets[0];
    const hit = hitTest(target.currentX, target.currentY, layout);
    expect(hit).not.toBeNull();
    expect(hit?.type).toBe('planet');
    expect(hit?.planet?.id).toBe(target.id);
    expect(hit?.planet?.session.id).toBe(target.session.id);
  });

  it('allows clicking within a reasonable hit margin of a planet', () => {
    const data = generateMockData({ seed: 77, projectCount: 3, sessionCount: 9 });
    const layout = computeLayout(data.projects, data.sessions, {
      width: 1000,
      height: 800,
      seed: 77,
    });

    const target = layout.planets[0];
    // Offset by radius + 2 px (within 6px hit padding)
    const hit = hitTest(target.currentX + target.radius + 2, target.currentY, layout);
    expect(hit).not.toBeNull();
    expect(hit?.planet?.id).toBe(target.id);
  });

  it('returns null when clicking in empty space', () => {
    const data = generateMockData({ seed: 77, projectCount: 3, sessionCount: 9 });
    const layout = computeLayout(data.projects, data.sessions, {
      width: 1000,
      height: 800,
      seed: 77,
    });

    const hit = hitTest(10, 10, layout);
    expect(hit).toBeNull();
  });

  it('finds sun when clicking near sun center', () => {
    const data = generateMockData({ seed: 77, projectCount: 3, sessionCount: 9 });
    const layout = computeLayout(data.projects, data.sessions, {
      width: 1000,
      height: 800,
      seed: 77,
    });

    const sun = layout.suns[0];
    const hit = hitTest(sun.x, sun.y, layout);
    expect(hit).not.toBeNull();
    expect(hit?.type).toBe('sun');
    expect(hit?.sun?.id).toBe(sun.id);
  });
});
