import { describe, it, expect, vi } from 'vitest';
import { computeLayout } from '../src/layout';
import { KeyboardNavigator } from '../src/navigation';
import { renderOrrery } from '../src/renderer';
import { getPalette } from '../src/colors';
import { Project, Session, OrreryPlanet } from '../src/types';

describe('Finding 17: Density, Orphan Subagents, Waiting Moons & Keyboard Navigation', () => {
  it('bounds 12 working sessions on 1 project at 1200x800 seed 42 within canvas margins', () => {
    const project: Project = { id: 'p1', name: 'Alpha', root: '/alpha' };
    const sessions: Session[] = Array.from({ length: 12 }, (_, i) => ({
      id: `sess-${i}`,
      agent_id: 'claude',
      family: 'anthropic',
      project_root: '/alpha',
      title: `Task ${i}`,
      turns: 8,
      activity: 0.6,
      state: 'working',
    }));

    const layout = computeLayout([project], sessions, {
      width: 1200,
      height: 800,
      seed: 42,
    });

    expect(layout.planets).toHaveLength(12);
    const margin = 20;

    for (const planet of layout.planets) {
      // Must not overflow canvas (unlike the bug where y reached 833.8)
      expect(planet.currentY - planet.radius).toBeGreaterThanOrEqual(margin);
      expect(planet.currentY + planet.radius).toBeLessThanOrEqual(800 - margin);
      expect(planet.currentX - planet.radius).toBeGreaterThanOrEqual(margin);
      expect(planet.currentX + planet.radius).toBeLessThanOrEqual(1200 - margin);

      // Max orbit extent must also fit within margins
      const sun = layout.suns[0];
      const maxExtentY = sun.y + planet.orbitSemiMajor + planet.radius;
      const minExtentY = sun.y - planet.orbitSemiMajor - planet.radius;
      expect(maxExtentY).toBeLessThanOrEqual(800 - margin);
      expect(minExtentY).toBeGreaterThanOrEqual(margin);
    }
  });

  it('preserves orphan subagents whose parent session does not exist', () => {
    const project: Project = { id: 'p1', name: 'Alpha', root: '/alpha' };
    const sessions: Session[] = [
      {
        id: 's-normal',
        agent_id: 'claude',
        family: 'anthropic',
        project_root: '/alpha',
        title: 'Normal Session',
        turns: 4,
        activity: 0.5,
        state: 'working',
      },
      {
        id: 's-orphan',
        agent_id: 'codex',
        family: 'openai',
        project_root: '/alpha',
        title: 'Orphan Subagent',
        turns: 2,
        activity: 0.3,
        state: 'working',
        parent_id: 'non-existent-parent',
      },
    ];

    const layout = computeLayout([project], sessions, {
      width: 1200,
      height: 800,
      seed: 42,
    });

    // The orphan subagent MUST NOT disappear
    const sessionIds = layout.planets.map(p => p.session.id);
    expect(sessionIds).toContain('s-orphan');
  });

  it('renders waiting treatment (vermilion halo) for waiting moons', () => {
    const project: Project = { id: 'p1', name: 'Alpha', root: '/alpha' };
    const sessions: Session[] = [
      {
        id: 's-parent',
        agent_id: 'claude',
        family: 'anthropic',
        project_root: '/alpha',
        title: 'Parent Session',
        turns: 5,
        activity: 0.7,
        state: 'working',
      },
      {
        id: 's-moon-waiting',
        agent_id: 'codex',
        family: 'openai',
        project_root: '/alpha',
        title: 'Waiting Subagent',
        turns: 3,
        activity: 0.2,
        state: 'waiting',
        parent_id: 's-parent',
      },
    ];

    const layout = computeLayout([project], sessions, {
      width: 1200,
      height: 800,
      seed: 42,
    });

    const parentPlanet = layout.planets.find(p => p.session.id === 's-parent')!;
    expect(parentPlanet.moons).toHaveLength(1);
    const moon = parentPlanet.moons[0];
    expect(moon.session.state).toBe('waiting');

    // Create a mock canvas context and spy on fillStyle / strokeStyle
    const fillStyles: string[] = [];
    const strokeStyles: string[] = [];
    const mockCtx = {
      save: vi.fn(),
      restore: vi.fn(),
      translate: vi.fn(),
      rotate: vi.fn(),
      scale: vi.fn(),
      ellipse: vi.fn(),
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
      fillText: vi.fn(),
      setLineDash: vi.fn(),
      createRadialGradient: () => ({ addColorStop: vi.fn() }),
      set fillStyle(val: string) { fillStyles.push(val); },
      get fillStyle() { return fillStyles[fillStyles.length - 1] || ''; },
      set strokeStyle(val: string) { strokeStyles.push(val); },
      get strokeStyle() { return strokeStyles[strokeStyles.length - 1] || ''; },
    } as unknown as CanvasRenderingContext2D;

    const palette = getPalette('dark');
    renderOrrery({
      ctx: mockCtx,
      width: 1200,
      height: 800,
      dpr: 1,
      theme: 'dark',
      palette,
      layout,
      hoveredPlanet: null,
      hoveredSun: null,
      focusedPlanet: null,
      timestamp: 1000,
      reducedMotion: false,
    });

    // The renderer must have applied vermilion waiting halo for the waiting moon
    const usedVermilion = strokeStyles.includes(palette.vermilion) || fillStyles.includes(palette.vermilion);
    expect(usedVermilion).toBe(true);
  });

  it('allows keyboard navigation to reach and select moons', () => {
    const parentPlanet: OrreryPlanet = {
      id: 'planet-parent',
      session: {
        id: 's-parent',
        agent_id: 'claude',
        family: 'anthropic',
        project_root: '/p',
        title: 'Parent',
        turns: 4,
        activity: 0.5,
        state: 'working',
      },
      sunId: 'sun-1',
      orbitSemiMajor: 100,
      orbitSemiMinor: 80,
      orbitTilt: 0,
      angle: 0,
      startAngle: 0,
      targetAngle: 0,
      transitionProgress: 1,
      currentX: 200,
      currentY: 200,
      radius: 10,
      isFront: false,
      isDoneRing: false,
      haloProgress: 0,
      bellGlint: false,
      waitingElapsedMs: 0,
      moons: [
        {
          id: 'moon-child',
          session: {
            id: 's-child-waiting',
            agent_id: 'codex',
            family: 'openai',
            project_root: '/p',
            title: 'Child Waiting',
            turns: 2,
            activity: 0.2,
            state: 'waiting',
            parent_id: 's-parent',
          },
          parentPlanetId: 'planet-parent',
          orbitRadius: 30,
          angle: 0,
          x: 230, // to the right of parent
          y: 200,
          radius: 4,
        },
      ],
    };

    let selectedSession: Session | null = null;
    let focusedItem: any = null;

    const nav = new KeyboardNavigator({
      onSelect: (session) => {
        selectedSession = session;
      },
      onFocusChange: (item) => {
        focusedItem = item;
      },
    });

    nav.setPlanets([parentPlanet]);
    nav.setFocusedId('planet-parent');

    // ArrowRight moves from parentPlanet (x=200) to moon-child (x=230)
    const handled = nav.handleKeyDown('ArrowRight');
    expect(handled).toBe(true);
    expect(focusedItem?.id).toBe('moon-child');

    // Press Enter to select the focused moon
    nav.handleKeyDown('Enter');
    expect(selectedSession).not.toBeNull();
    expect((selectedSession as unknown as Session | null)?.id).toBe('s-child-waiting');
  });
});
