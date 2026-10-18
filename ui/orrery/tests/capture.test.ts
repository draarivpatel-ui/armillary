import { describe, it, expect, vi } from 'vitest';
import { Orrery } from '../src/orrery';
import { Project, Session } from '../src/types';

function createMockCanvas(): HTMLCanvasElement {
  const ctx = {
    save: vi.fn(),
    restore: vi.fn(),
    scale: vi.fn(),
    translate: vi.fn(),
    rotate: vi.fn(),
    beginPath: vi.fn(),
    closePath: vi.fn(),
    arc: vi.fn(),
    fill: vi.fn(),
    stroke: vi.fn(),
    fillRect: vi.fn(),
    strokeRect: vi.fn(),
    clearRect: vi.fn(),
    moveTo: vi.fn(),
    lineTo: vi.fn(),
    ellipse: vi.fn(),
    fillText: vi.fn(),
    setLineDash: vi.fn(),
    createRadialGradient: () => ({ addColorStop: vi.fn() }),
  } as unknown as CanvasRenderingContext2D;

  return {
    width: 1200,
    height: 800,
    style: {},
    hasAttribute: vi.fn(() => false),
    setAttribute: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    getContext: () => ctx,
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 1200, height: 800 }),
  } as unknown as HTMLCanvasElement;
}

describe('Deterministic Capture API (Finding 16)', () => {
  it('purely evaluates planet and moon positions from fixed epoch, remaining idempotent across repeated calls', () => {
    const canvas = createMockCanvas();
    const project: Project = { id: 'p1', name: 'Alpha', root: '/alpha' };
    const sessions: Session[] = [
      {
        id: 's-working',
        agent_id: 'claude',
        family: 'anthropic',
        project_root: '/alpha',
        title: 'Task Alpha',
        turns: 10,
        activity: 0.8,
        state: 'working',
      },
      {
        id: 's-sub',
        agent_id: 'sub',
        family: 'anthropic',
        project_root: '/alpha',
        title: 'Subagent Alpha',
        turns: 2,
        activity: 0.5,
        state: 'working',
        parent_id: 's-working',
      },
    ];

    const orrery = new Orrery(canvas, {
      width: 1200,
      height: 800,
      seed: 42,
      paused: true,
    });
    orrery.setData([project], sessions);

    // First render at 2000ms
    orrery.renderAt(2000);
    const planetFirst = orrery.getLayout().planets[0];
    const planetAngleFirst = planetFirst.angle;
    const planetXFirst = planetFirst.currentX;
    const moonFirst = planetFirst.moons[0];
    const moonAngleFirst = moonFirst.angle;

    // Second render at exact same timestamp 2000ms
    orrery.renderAt(2000);
    const planetSecond = orrery.getLayout().planets[0];
    const moonSecond = planetSecond.moons[0];

    // Calling renderAt twice at the same timestamp must NOT advance planets or moons twice!
    expect(planetSecond.angle).toBe(planetAngleFirst);
    expect(planetSecond.currentX).toBe(planetXFirst);
    expect(moonSecond.angle).toBe(moonAngleFirst);

    // Advance to 6000ms
    orrery.renderAt(6000);
    const planet6s = orrery.getLayout().planets[0];
    expect(planet6s.angle).not.toBe(planetAngleFirst);

    // Step backwards to 2000ms: pure evaluation should produce the exact same position as before
    orrery.renderAt(2000);
    const planetBackTo2s = orrery.getLayout().planets[0];
    expect(planetBackTo2s.angle).toBe(planetAngleFirst);
    expect(planetBackTo2s.currentX).toBe(planetXFirst);

    orrery.destroy();
  });
});
