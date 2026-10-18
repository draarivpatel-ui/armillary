import { vi } from 'vitest';
import { Project, Session } from '../src/types';

/**
 * Recording canvas: every 2D call and every property assignment is appended to
 * `calls`, so two renders can be compared draw call for draw call.
 */
export function createRecordingCanvas(width = 1200, height = 800) {
  const calls: string[] = [];
  const ctx = new Proxy(
    {},
    {
      get(_target, prop) {
        const name = String(prop);
        if (name === 'createRadialGradient' || name === 'createLinearGradient') {
          return (...args: unknown[]) => {
            calls.push(`${name}${JSON.stringify(args)}`);
            return { addColorStop: (...a: unknown[]) => calls.push(`stop${JSON.stringify(a)}`) };
          };
        }
        if (name === 'measureText') {
          return (s: string) => ({ width: String(s).length * 6 });
        }
        return (...args: unknown[]) => {
          calls.push(`${name}${JSON.stringify(args)}`);
        };
      },
      set(_target, prop, value) {
        calls.push(`set ${String(prop)}=${String(value)}`);
        return true;
      },
    }
  ) as unknown as CanvasRenderingContext2D;

  const canvas = {
    width,
    height,
    style: {},
    hasAttribute: vi.fn(() => false),
    setAttribute: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    getContext: () => ctx,
    getBoundingClientRect: () => ({ left: 0, top: 0, width, height }),
  } as unknown as HTMLCanvasElement;

  return { canvas, calls };
}

export const PROJECT: Project = { id: 'p1', name: 'Alpha', root: '/alpha' };

export function makeSession(id: string, overrides: Partial<Session> = {}): Session {
  return {
    id,
    agent_id: 'claude',
    family: 'anthropic',
    project_root: '/alpha',
    title: `Task ${id}`,
    turns: 8,
    activity: 0.7,
    state: 'working',
    ...overrides,
  };
}
