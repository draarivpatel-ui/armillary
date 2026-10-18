import { describe, it, expect, vi, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createRecordingCanvas } from './helpers';
import { CAPTURE_WALL_EPOCH_MS, createCaptureOrrery, replayCapture } from '../src/capture';

afterEach(() => vi.restoreAllMocks());

function labelsAt(fakeNow: number, seconds: number): string[] {
  vi.spyOn(Date, 'now').mockReturnValue(fakeNow);
  const { canvas } = createRecordingCanvas();
  const orrery = createCaptureOrrery(canvas, 'dark', 42);
  replayCapture(orrery, seconds);
  const labels = orrery
    .getLayout()
    .planets.filter(p => p.session.state === 'waiting')
    .map(p => `${p.session.id}:${p.labelLayout?.labelText}`);
  orrery.destroy();
  return labels;
}

describe('capture determinism', () => {
  it('produces identical label text regardless of the system date', () => {
    for (const seconds of [0, 2, 4, 6, 8]) {
      const a = labelsAt(1_700_000_000_000, seconds);
      const b = labelsAt(1_900_000_000_000, seconds);
      expect(a.length).toBeGreaterThan(0);
      expect(b).toEqual(a);
    }
  });

  it('uses a fixed wall epoch and exact elapsed times', () => {
    expect(CAPTURE_WALL_EPOCH_MS).toBe(1_760_000_000_000);
    const labels = labelsAt(1_800_000_000_000, 4);
    expect(labels).toContain('session-2:Needs you (49s)');
    expect(labels).toContain('session-5:Needs you (1s)');
  });

  it('the capture source never samples the real clock', () => {
    const src = readFileSync(join(__dirname, '..', 'src', 'capture.tsx'), 'utf8');
    expect(src).not.toMatch(/Date\.now\s*\(/);
  });
});
