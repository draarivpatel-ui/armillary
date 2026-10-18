import { describe, it, expect, beforeEach, vi } from 'vitest';
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

describe('Orrery Data Reconciliation & Waiting Transition (Finding 9)', () => {
  let canvas: HTMLCanvasElement;

  beforeEach(() => {
    canvas = createMockCanvas();
  });

  it('reapplying identical data preserves advanced orbit positions instead of resetting', () => {
    const project: Project = { id: 'p1', name: 'Project 1', root: '/path/1' };
    const session: Session = {
      id: 'sess-1',
      agent_id: 'claude-code',
      family: 'anthropic',
      project_root: '/path/1',
      title: 'Working Session',
      turns: 10,
      activity: 0.9,
      state: 'working',
    };

    const orrery = new Orrery(canvas, {
      width: 1200,
      height: 800,
      seed: 42,
    });

    orrery.setData([project], [session]);
    const initialPlanet = orrery.getLayout().planets[0];
    const initialAngle = initialPlanet.angle;

    // Advance planet angle by simulating motion (e.g. planet orbited to a new position)
    orrery.renderAt(5000);
    const advancedAngle = orrery.getLayout().planets[0].angle;

    // Reapply identical data
    orrery.setData([project], [session]);
    const reconciledPlanet = orrery.getLayout().planets[0];

    // The angle must NOT have been reset to initial layout angle
    expect(reconciledPlanet.angle).toBeCloseTo(advancedAngle, 4);
    expect(reconciledPlanet.angle).not.toBeCloseTo(initialAngle, 2);

    orrery.destroy();
  });

  it('a session that starts waiting after 60s of uptime swings over 600ms and does not show 60s waiting', () => {
    const project: Project = { id: 'p1', name: 'Project 1', root: '/path/1' };
    const workingSession: Session = {
      id: 'sess-2',
      agent_id: 'codex',
      family: 'openai',
      project_root: '/path/1',
      title: 'Session 2',
      turns: 8,
      activity: 0.8,
      state: 'working',
    };

    const orrery = new Orrery(canvas, {
      width: 1200,
      height: 800,
      seed: 42,
    });

    orrery.setData([project], [workingSession]);

    // Fast-forward orrery to 60 seconds (60000ms) of uptime
    orrery.renderAt(60000);
    const angleBeforeWaiting = orrery.getLayout().planets[0].angle;

    // Now transition session to waiting at 60s uptime
    const waitingSession: Session = {
      ...workingSession,
      state: 'waiting',
      waiting_since: 60000,
    };

    orrery.setData([project], [waitingSession]);
    const planetAtTransition = orrery.getLayout().planets[0];

    // At transition start (60000ms):
    // Should NOT immediately be finished with transition
    expect(planetAtTransition.isFront).toBe(false);
    expect(planetAtTransition.transitionProgress).toBeLessThan(0.2);
    expect(planetAtTransition.waitingElapsedMs).toBeLessThan(1000); // NOT 60000ms

    // At halfway through 600ms swing (60300ms):
    orrery.renderAt(60300);
    const planetHalfway = orrery.getLayout().planets[0];
    expect(planetHalfway.transitionProgress).toBeGreaterThan(0.2);
    expect(planetHalfway.transitionProgress).toBeLessThan(0.9);
    expect(planetHalfway.isFront).toBe(false);
    // Angle should be transitioning smoothly from angleBeforeWaiting towards targetAngle (PI/2)
    expect(planetHalfway.angle).not.toBeCloseTo(angleBeforeWaiting, 2);

    // At 60650ms (after 600ms transition finishes):
    orrery.renderAt(60650);
    const planetDone = orrery.getLayout().planets[0];
    expect(planetDone.transitionProgress).toBe(1.0);
    expect(planetDone.isFront).toBe(true);
    expect(planetDone.angle).toBeCloseTo(Math.PI / 2, 2);
    expect(planetDone.waitingElapsedMs).toBeCloseTo(650, -2); // ~650ms, NOT 60650ms

    orrery.destroy();
  });
});
