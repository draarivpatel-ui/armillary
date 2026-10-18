import {
  AnimationStepOptions,
  FrameGovernor,
  moonAngularSpeed,
  orbitAngularSpeed,
  SWING_DURATION_MS,
  updateAnimationState,
} from './animation';
import { getPalette, ObservatoryPalette } from './colors';
import { hitTest } from './hitTest';
import { computeLayout } from './layout';
import { ORRERY_LAYOUT_SEED } from './seam';
import { KeyboardNavigator } from './navigation';
import { renderOrrery } from './renderer';
import {
  OrreryLayout,
  OrreryMoon,
  OrreryOptions,
  OrreryPlanet,
  OrrerySun,
  OrreryTheme,
  Project,
  Session,
} from './types';

export class Orrery {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private options: OrreryOptions;
  private theme: OrreryTheme;
  private palette: ObservatoryPalette;
  private reducedMotion: boolean;
  private dpr: number = 1;

  private projects: Project[] = [];
  private sessions: Session[] = [];
  private layout: OrreryLayout = { suns: [], planets: [] };

  private hoveredPlanet: OrreryPlanet | null = null;
  private hoveredSun: OrrerySun | null = null;
  private focusedPlanet: OrreryPlanet | null = null;
  private focusedMoon: OrreryMoon | null = null;

  private governor: FrameGovernor;
  private navigator: KeyboardNavigator;
  /** Animation time t (ms): the one clock. Live: rAF timestamp minus the first rAF timestamp. */
  private currentTimestamp: number = 0;
  private firstRafTimestamp: number | null = null;
  /** Unix ms that corresponds to t = 0. */
  private wallEpochMs: number;
  private hasReceivedData = false;
  /** Planets whose swing start was stamped between frames; re-stamped with the next frame's t. */
  private pendingStamp = new Set<string>();

  constructor(canvas: HTMLCanvasElement, options: OrreryOptions) {
    this.canvas = canvas;
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      throw new Error('Failed to get 2D context from canvas');
    }
    this.ctx = ctx;
    this.options = options;
    this.theme = options.theme || 'dark';
    this.reducedMotion = options.reducedMotion ?? false;
    this.wallEpochMs = options.wallEpochMs ?? 0;
    this.palette = getPalette(this.theme, canvas);

    this.navigator = new KeyboardNavigator({
      onSelect: (session) => {
        if (this.options.onSelectSession) {
          this.options.onSelectSession(session);
        }
      },
      onFocusChange: (item) => {
        if (!item) {
          this.focusedPlanet = null;
          this.focusedMoon = null;
        } else if ('moons' in item) {
          this.focusedPlanet = item as OrreryPlanet;
          this.focusedMoon = null;
        } else {
          this.focusedMoon = item as OrreryMoon;
          this.focusedPlanet = this.layout.planets.find(p => p.id === (item as OrreryMoon).parentPlanetId) || null;
        }
        this.requestRender();
      },
    });

    this.governor = new FrameGovernor((timestamp, delta) => {
      this.tick(timestamp, delta);
    }, { maxFps: options.maxFps });

    this.bindEvents();
    this.resize(options.width, options.height);
    if (!options.paused) {
      this.governor.start();
    }
  }

  public pause(): void {
    this.governor.stop();
  }

  public resume(): void {
    this.governor.start();
  }

  public setData(projects: Project[], sessions: Session[]): void {
    this.projects = projects;
    this.sessions = sessions;
    // The first data a controller receives is the mount: waiting sessions are already
    // at the front. Every later call is an event arriving at the current t.
    const isMount = !this.hasReceivedData;
    this.hasReceivedData = true;
    this.recomputeLayout(isMount ? 'mount' : 'update');
    this.navigator.setPlanets(this.layout.planets);
    this.requestRender();
  }

  /** Sets the Unix ms that corresponds to t = 0 (wall time at t is wallEpochMs + t). */
  public setWallEpoch(ms: number): void {
    this.wallEpochMs = ms;
    this.requestRender();
  }

  public setTheme(theme: OrreryTheme): void {
    this.theme = theme;
    this.palette = getPalette(theme, this.canvas);
    this.requestRender();
  }

  public setCallbacks(callbacks: {
    onSelectSession?: (session: Session) => void;
    onHoverSession?: (session: Session | null) => void;
    onSelectSun?: (project: Project) => void;
  }): void {
    if (callbacks.onSelectSession !== undefined) {
      this.options.onSelectSession = callbacks.onSelectSession;
    }
    if (callbacks.onHoverSession !== undefined) {
      this.options.onHoverSession = callbacks.onHoverSession;
    }
    if (callbacks.onSelectSun !== undefined) {
      this.options.onSelectSun = callbacks.onSelectSun;
    }
  }

  public setReducedMotion(reduced: boolean): void {
    if (reduced !== this.reducedMotion) {
      // Bring angles to the present under the old mode, then rebase orbit phases so
      // that leaving reduced motion continues from where the planets are held.
      this.evaluate(this.currentTimestamp);
      this.reducedMotion = reduced;
      this.rebasePhases(this.currentTimestamp);
    }
    this.recomputeLayout('other');
    this.requestRender();
  }

  public resize(width: number, height: number): void {
    this.options.width = width;
    this.options.height = height;

    this.dpr = typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1;
    this.canvas.width = Math.round(width * this.dpr);
    this.canvas.height = Math.round(height * this.dpr);
    this.canvas.style.width = `${width}px`;
    this.canvas.style.height = `${height}px`;

    this.recomputeLayout('other');
    this.requestRender();
  }

  public focusPlanet(planetId: string): void {
    this.navigator.setFocusedId(planetId);
  }

  /**
   * Where a session's planet (or moon) is right now, in canvas CSS pixels: its centre and radius.
   * Read from the current layout, so it follows the orbit. Used by the demo tour to aim its cursor.
   */
  public locateSession(sessionId: string): { x: number; y: number; radius: number } | null {
    for (const planet of this.layout.planets) {
      if (planet.session.id === sessionId) {
        return { x: planet.currentX, y: planet.currentY, radius: planet.radius };
      }
      for (const moon of planet.moons) {
        if (moon.session.id === sessionId) return { x: moon.x, y: moon.y, radius: moon.radius };
      }
    }
    return null;
  }

  /** The host time t of the last frame (ms). */
  public now(): number {
    return this.currentTimestamp;
  }

  /**
   * Sun and planet positions at host time t, computed on a copy: the live state and the canvas are untouched.
   * The first run's handoff uses it to land its constellations exactly where the Orrery will draw them.
   */
  public layoutAt(t: number): OrreryLayout {
    const planets = this.layout.planets.map((p) => ({
      ...p,
      moons: p.moons.map((m) => ({ ...m })),
    }));
    const suns = this.layout.suns.map((sun) => ({ ...sun }));
    updateAnimationState(planets, { ...this.stepOptions(t, 0), suns });
    return { suns, planets };
  }

  public getLayout(): OrreryLayout {
    return this.layout;
  }

  /**
   * Deterministic render step at animation time t (ms). Pure: the same t and the same
   * data always give the same planet state and the same draw calls.
   */
  public renderAt(timestamp: number): void {
    this.step(timestamp, 0);
  }

  private stepOptions(t: number, delta: number): AnimationStepOptions {
    return {
      elapsedMs: t,
      deltaMs: delta,
      timestamp: t,
      reducedMotion: this.reducedMotion,
      suns: this.layout.suns,
      wallEpochMs: this.wallEpochMs,
    };
  }

  /** Brings planet and moon state to time t without drawing. */
  private evaluate(t: number): void {
    updateAnimationState(this.layout.planets, this.stepOptions(t, 0));
  }

  /** The one place t is applied: the same t goes to the animation and to the renderer. */
  private step(t: number, delta: number): void {
    this.currentTimestamp = t;
    updateAnimationState(this.layout.planets, this.stepOptions(t, delta));

    this.ctx.save();
    this.ctx.scale(this.dpr, this.dpr);
    renderOrrery({
      ctx: this.ctx,
      width: this.options.width,
      height: this.options.height,
      dpr: this.dpr,
      theme: this.theme,
      palette: this.palette,
      layout: this.layout,
      hoveredPlanet: this.hoveredPlanet,
      hoveredSun: this.hoveredSun,
      focusedPlanet: this.focusedPlanet,
      focusedMoon: this.focusedMoon,
      timestamp: t,
      reducedMotion: this.reducedMotion,
    });
    this.ctx.restore();
  }

  /** Re-derives start angles so angle(t) equals the current angle (no jump when speed or mode changes). */
  private rebasePhases(t: number): void {
    for (const planet of this.layout.planets) {
      const state = planet.session.state;
      if (state === 'working' || state === 'idle') {
        planet.startAngle = planet.angle - orbitAngularSpeed(planet.session) * t;
      }
      planet.moons.forEach((moon, index) => {
        moon.startAngle = moon.angle - moonAngularSpeed(index) * t;
      });
    }
  }

  private recomputeLayout(origin: 'mount' | 'update' | 'other'): void {
    const t = this.currentTimestamp;

    // Bring the outgoing planets to the present (pure) so reconciliation sees current angles.
    this.evaluate(t);

    const prevPlanets = new Map<string, OrreryPlanet>();
    for (const p of this.layout.planets) {
      prevPlanets.set(p.session.id, p);
    }

    this.layout = computeLayout(this.projects, this.sessions, {
      width: this.options.width,
      height: this.options.height,
      seed: this.options.seed ?? ORRERY_LAYOUT_SEED,
    });

    // Latch swing starts at event arrival (t of this update), never from waiting_since.
    const stampAtArrival = (planet: OrreryPlanet) => {
      planet.transitionStartTime = t;
      if (origin === 'update' && this.firstRafTimestamp !== null) this.pendingStamp.add(planet.id);
    };

    // Reconcile planets by session id to preserve orbit positions and track transitions
    for (const planet of this.layout.planets) {
      const prev = prevPlanets.get(planet.session.id);
      const state = planet.session.state;
      const isOrbiting = state === 'working' || state === 'idle';

      if (!prev) {
        if (state === 'waiting') {
          if (origin === 'mount') planet.transitionStartTime = t - SWING_DURATION_MS;
          else stampAtArrival(planet);
        } else if (isOrbiting) {
          // Keep the layout's collision-free angle at the current t.
          planet.startAngle = planet.angle - orbitAngularSpeed(planet.session) * t;
        }
      } else if (prev.session.state === state) {
        if (state === 'waiting') {
          if (prev.targetAngle !== planet.targetAngle) {
            // Another planet joined or left the front row: swing again to the new slot.
            planet.startAngle = prev.angle;
            planet.angle = prev.angle;
            stampAtArrival(planet);
          } else {
            planet.angle = prev.angle;
            planet.startAngle = prev.startAngle;
            planet.transitionStartTime = prev.transitionStartTime;
          }
        } else if (isOrbiting) {
          // Activity may have changed: rebase the phase so the planet does not jump.
          planet.angle = prev.angle;
          planet.startAngle = prev.angle - orbitAngularSpeed(planet.session) * t;
        } else {
          planet.angle = prev.angle;
          planet.startAngle = prev.startAngle;
          planet.targetAngle = prev.targetAngle;
        }
        planet.currentX = prev.currentX;
        planet.currentY = prev.currentY;
      } else {
        // Transitioned state
        planet.currentX = prev.currentX;
        planet.currentY = prev.currentY;
        if (state === 'waiting') {
          planet.startAngle = prev.angle;
          planet.angle = prev.angle;
          planet.transitionProgress = 0;
          planet.isFront = false;
          planet.haloProgress = 0;
          planet.bellGlint = false;
          planet.waitingElapsedMs = 0;
          stampAtArrival(planet);
        } else if (isOrbiting) {
          planet.angle = prev.angle;
          planet.startAngle = prev.angle - orbitAngularSpeed(planet.session) * t;
          planet.transitionProgress = 1;
        }
      }

      // Reconcile moons: phase continues from the previous angle at the current t.
      const prevMoons = new Map((prev?.moons ?? []).map(m => [m.session.id, m]));
      planet.moons.forEach((moon, index) => {
        const prevMoon = prevMoons.get(moon.session.id);
        const base = prevMoon ? prevMoon.angle : moon.angle;
        moon.angle = base;
        moon.startAngle = base - moonAngularSpeed(index) * t;
        if (prevMoon) {
          moon.x = prevMoon.x;
          moon.y = prevMoon.y;
        }
      });
    }

    this.navigator.setPlanets(this.layout.planets);

    // Update active movement state for governor
    const hasMoving =
      !this.reducedMotion &&
      this.sessions.some(s => s.state === 'working' || s.state === 'waiting');
    this.governor.setActiveMovement(hasMoving);
  }

  private tick(rafTimestamp: number, delta: number): void {
    // The first rAF timestamp is the epoch: t = 0 at the first frame.
    if (this.firstRafTimestamp === null) this.firstRafTimestamp = rafTimestamp;
    const t = rafTimestamp - this.firstRafTimestamp;

    // Swings stamped between frames start at this frame, the first moment the host clock is known.
    if (this.pendingStamp.size > 0) {
      for (const planet of this.layout.planets) {
        if (this.pendingStamp.has(planet.id)) planet.transitionStartTime = t;
      }
      this.pendingStamp.clear();
    }

    this.step(t, delta);
  }

  private requestRender(): void {
    this.renderAt(this.currentTimestamp);
  }

  private bindEvents(): void {
    // Ensure canvas is keyboard focusable
    if (!this.canvas.hasAttribute('tabindex')) {
      this.canvas.setAttribute('tabindex', '0');
    }

    this.canvas.addEventListener('mousemove', this.handleMouseMove);
    this.canvas.addEventListener('mouseleave', this.handleMouseLeave);
    this.canvas.addEventListener('click', this.handleClick);
    this.canvas.addEventListener('keydown', this.handleKeyDown);
  }

  private unbindEvents(): void {
    this.canvas.removeEventListener('mousemove', this.handleMouseMove);
    this.canvas.removeEventListener('mouseleave', this.handleMouseLeave);
    this.canvas.removeEventListener('click', this.handleClick);
    this.canvas.removeEventListener('keydown', this.handleKeyDown);
  }

  private handleMouseMove = (e: MouseEvent): void => {
    const rect = this.canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;

    const hit = hitTest(x, y, this.layout);

    let changed = false;
    const newHoverPlanet = hit?.type === 'planet' ? hit.planet ?? null : null;
    const newHoverSun = hit?.type === 'sun' ? hit.sun ?? null : null;

    if (newHoverPlanet?.id !== this.hoveredPlanet?.id) {
      this.hoveredPlanet = newHoverPlanet;
      changed = true;
      if (this.options.onHoverSession) {
        this.options.onHoverSession(newHoverPlanet ? newHoverPlanet.session : null);
      }
    }

    if (newHoverSun?.id !== this.hoveredSun?.id) {
      this.hoveredSun = newHoverSun;
      changed = true;
    }

    this.canvas.style.cursor = hit ? 'pointer' : 'default';

    if (changed) {
      this.requestRender();
    }
  };

  private handleMouseLeave = (): void => {
    if (this.hoveredPlanet || this.hoveredSun) {
      this.hoveredPlanet = null;
      this.hoveredSun = null;
      this.canvas.style.cursor = 'default';
      if (this.options.onHoverSession) {
        this.options.onHoverSession(null);
      }
      this.requestRender();
    }
  };

  private handleClick = (e: MouseEvent): void => {
    const rect = this.canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;

    const hit = hitTest(x, y, this.layout);
    if (!hit) return;

    if (hit.type === 'planet' && hit.planet && this.options.onSelectSession) {
      this.focusedPlanet = hit.planet;
      this.focusedMoon = null;
      this.navigator.setFocusedId(hit.planet.id);
      this.options.onSelectSession(hit.planet.session);
      this.requestRender();
    } else if (hit.type === 'moon' && hit.moon && this.options.onSelectSession) {
      this.focusedMoon = hit.moon;
      this.focusedPlanet = hit.planet || null;
      this.navigator.setFocusedId(hit.moon.id);
      this.options.onSelectSession(hit.moon.session);
      this.requestRender();
    } else if (hit.type === 'sun' && hit.sun && this.options.onSelectSun) {
      this.options.onSelectSun(hit.sun.project);
    }
  };

  private handleKeyDown = (e: KeyboardEvent): void => {
    const handled = this.navigator.handleKeyDown(e.key);
    if (handled) {
      e.preventDefault();
      this.requestRender();
    }
  };

  public destroy(): void {
    this.unbindEvents();
    this.governor.destroy();
  }
}
