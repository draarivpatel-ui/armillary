import { describe, it, expect, vi } from 'vitest';
import { Orrery } from '../src/orrery';
import { Project, Session } from '../src/types';

describe('Orrery React Callbacks Freshness (Finding 20)', () => {
  it('updates callbacks dynamically without keeping stale closures', () => {
    const project: Project = { id: 'p1', name: 'Alpha', root: '/alpha' };
    const session: Session = {
      id: 's1',
      agent_id: 'claude',
      family: 'anthropic',
      project_root: '/alpha',
      title: 'Task',
      turns: 1,
      activity: 0.5,
      state: 'working',
    };

    const initialCallback = vi.fn();
    const updatedCallback = vi.fn();

    // Verify controller setCallbacks method exists and updates callback
    const canvas = {
      width: 1200,
      height: 800,
      style: {},
      hasAttribute: vi.fn(() => false),
      setAttribute: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      getContext: vi.fn(() => ({
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
      })),
      getBoundingClientRect: () => ({ left: 0, top: 0, width: 1200, height: 800 }),
    } as unknown as HTMLCanvasElement;

    const orrery = new Orrery(canvas, {
      width: 1200,
      height: 800,
      onSelectSession: initialCallback,
    });
    orrery.setData([project], [session]);

    // Controller should have a setCallbacks or setOptions method
    expect(typeof (orrery as any).setCallbacks).toBe('function');
    (orrery as any).setCallbacks({ onSelectSession: updatedCallback });

    // Simulate clicking planet via internal hit or click handler
    const planet = orrery.getLayout().planets[0];
    (orrery as any).handleClick({
      clientX: planet.currentX,
      clientY: planet.currentY,
    });

    expect(initialCallback).not.toHaveBeenCalled();
    expect(updatedCallback).toHaveBeenCalledWith(session);

    orrery.destroy();
  });
});
