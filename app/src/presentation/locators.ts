/**
 * Registries the presentation tour uses to find things on screen and to drive the app, without the
 * bridge depending on any view. Components register what they know:
 *
 *   registerLocator("planet", (id) => rectOfPlanet(id))   // the Orrery, from its hit-test layout
 *   registerTourAction("openSession", openSession)        // the navigation controller
 *
 * Both are plain module-level maps (no timers, no globals beyond this module), so importing this file
 * costs nothing outside presentation mode.
 */

export interface TourRect {
  x: number;
  y: number;
  width: number;
  height: number;
  top: number;
  left: number;
  right: number;
  bottom: number;
}

export type RectLike = { x: number; y: number; width: number; height: number };

/** A locator returns the target's viewport rectangle (CSS pixels), or null when it is not on screen. */
export type Locator = (id: string) => RectLike | null;

const locators = new Map<string, Locator>();
const actions = new Map<string, (...args: never[]) => unknown>();

/** Register a locator for a kind of target. Returns an unregister function. */
export function registerLocator(kind: string, locator: Locator): () => void {
  locators.set(kind, locator);
  return () => {
    if (locators.get(kind) === locator) locators.delete(kind);
  };
}

/** Register an action the tour may call (e.g. "openSession"). Returns an unregister function. */
export function registerTourAction<A extends unknown[], R>(name: string, action: (...args: A) => R): () => void {
  const stored = action as unknown as (...args: never[]) => unknown;
  actions.set(name, stored);
  return () => {
    if (actions.get(name) === stored) actions.delete(name);
  };
}

export function tourAction(name: string): ((...args: unknown[]) => unknown) | null {
  return (actions.get(name) as ((...args: unknown[]) => unknown) | undefined) ?? null;
}

/** Components that cannot import this module may set window.__armillaryLocators[kind] = fn instead. */
function windowLocator(kind: string): Locator | null {
  if (typeof window === "undefined") return null;
  const table = (window as unknown as { __armillaryLocators?: Record<string, unknown> }).__armillaryLocators;
  const fn = table?.[kind];
  return typeof fn === "function" ? (fn as Locator) : null;
}

function toRect(r: RectLike): TourRect {
  return { x: r.x, y: r.y, width: r.width, height: r.height, left: r.x, top: r.y, right: r.x + r.width, bottom: r.y + r.height };
}

function domRect(selector: string): TourRect | null {
  if (typeof document === "undefined") return null;
  let el: Element | null = null;
  try {
    el = document.querySelector(selector);
  } catch {
    return null;
  }
  if (!el) return null;
  const r = el.getBoundingClientRect();
  return toRect({ x: r.x ?? r.left, y: r.y ?? r.top, width: r.width, height: r.height });
}

/**
 * Where a target is on screen. Built-in kinds: "selector" (a CSS selector) and "testid" (a data-testid).
 * Other kinds ("planet", ...) go to registered locators.
 */
export function locate(kind: string, id: string): TourRect | null {
  const registered = locators.get(kind) ?? windowLocator(kind);
  if (registered) {
    const r = registered(id);
    return r ? toRect(r) : null;
  }
  if (kind === "selector") return domRect(id);
  if (kind === "testid") return domRect(`[data-testid="${id.replace(/["\\]/g, "\\$&")}"]`);
  return null;
}

/** Test helper. */
export function resetLocators(): void {
  locators.clear();
  actions.clear();
}
