import { describe, it, expect } from 'vitest';
import { Orrery } from '../src/orrery';
import { createRecordingCanvas, makeSession, PROJECT } from './helpers';

describe('planet locator for the demo tour', () => {
  it('locates a planet by session id in canvas coordinates, following its current position', () => {
    const { canvas } = createRecordingCanvas(1200, 800);
    const orrery = new Orrery(canvas, { width: 1200, height: 800, paused: true, wallEpochMs: 1_760_000_000_000 });
    orrery.setData([PROJECT], [makeSession('a'), makeSession('b', { state: 'waiting', waiting_since: 1_759_999_990_000 })]);
    orrery.renderAt(1000);
    const a = orrery.locateSession('a');
    expect(a).not.toBeNull();
    const planet = orrery.getLayout().planets.find((p) => p.session.id === 'a')!;
    expect(a).toEqual({ x: planet.currentX, y: planet.currentY, radius: planet.radius });
    orrery.renderAt(20_000);
    const later = orrery.locateSession('a')!;
    expect(later.x !== a!.x || later.y !== a!.y).toBe(true);
    expect(orrery.locateSession('b')).not.toBeNull();
    expect(orrery.locateSession('nope')).toBeNull();
    orrery.destroy();
  });

  it('locates a moon by its own session id', () => {
    const { canvas } = createRecordingCanvas(1200, 800);
    const orrery = new Orrery(canvas, { width: 1200, height: 800, paused: true });
    orrery.setData([PROJECT], [makeSession('parent'), makeSession('child', { parent_id: 'parent' })]);
    orrery.renderAt(0);
    const moon = orrery.getLayout().planets.flatMap((p) => p.moons).find((m) => m.session.id === 'child');
    expect(moon).toBeDefined();
    expect(orrery.locateSession('child')).toEqual({ x: moon!.x, y: moon!.y, radius: moon!.radius });
    orrery.destroy();
  });
});
