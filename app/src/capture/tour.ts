/**
 * Capture tour schema (stream SNAP). One JSON file drives a scripted walk through the app.
 *
 * Two hosts interpret the same JSON:
 *  - the real app (capture build, `tools/capture-app/run.sh`): snapshots are in-process WKWebView
 *    photographs written by the Rust core, so no Screen Recording permission is needed;
 *  - a browser harness (VID's Chrome/Playwright capture of the web build): it supplies its own
 *    `snapshot` (page.screenshot) through the same `TourHost` interface in `runner.ts`.
 *
 * Everything below is plain data. Times are in milliseconds unless the name says frames.
 * Deterministic steps (`seekAnimations`, `sequence`) never read the wall clock: they set
 * document-timeline times and then snapshot.
 */

export type ViewName =
  | "orrery"
  | "almanac"
  | "folio"
  | "field-guide"
  | "switchboard"
  | "launchpad"
  | "search"
  | "gallery";

/** What a `sequence` step advances for every frame before it snapshots. */
export type SeekTarget =
  /** Pause every Web Animation / CSS transition / CSS animation and set currentTime to `t`. */
  | { kind: "animations" }
  /** Call `window.<hook>(t)` (e.g. "__armillaryFirstRun.seek"), await it, then snapshot. */
  | { kind: "hook"; hook: string };

export type TourStep =
  /** Show a view. Presses the rail shortcut (1 to 7, "g" for the gallery). */
  | { op: "navigate"; view: ViewName }
  /** Dispatch a key or combination, e.g. "1", "Escape", "Meta+k", "Shift+/". Target defaults to the focused element. */
  | { op: "key"; key: string; selector?: string }
  /** Click the first element matching `selector` (pointer and mouse events, then click). */
  | { op: "click"; selector: string; timeoutMs?: number }
  /** Focus a field and type `text`; `delayMs` per character (default 0 = all at once). */
  | { op: "type"; selector: string; text: string; delayMs?: number; clear?: boolean }
  /** Wait a fixed time. Not for deterministic frames: prefer `waitFrames` or `waitFor`. */
  | { op: "wait"; ms: number }
  /** Wait for N requestAnimationFrame ticks. */
  | { op: "waitFrames"; frames: number }
  /** Wait until a selector appears (or, with `gone`, disappears). Fails the tour after `timeoutMs` (default 10000). */
  | { op: "waitFor"; selector: string; gone?: boolean; timeoutMs?: number }
  /**
   * Set the theme: "dark" (default look) or "light" (Day almanac). Without `toggle` it sets data-theme on
   * <html> and on every element that carries data-theme (the shell keeps its own copy). With `toggle`
   * (a selector for the app's theme button) it clicks the real control when the theme differs.
   */
  | { op: "theme"; theme: "dark" | "light"; toggle?: string }
  /** Resize the window to CSS pixels (real app: the native window; browser harness: the viewport). */
  | { op: "resize"; width: number; height: number }
  /** Call a named function on window ("a.b.c" paths allowed) with JSON args; awaited if it returns a promise. */
  | { op: "hook"; name: string; args?: unknown[] }
  /** Sugar for hook "__armillaryFirstRun.seek" with [ms]. */
  | { op: "firstrunSeek"; ms: number }
  /** Sugar for hook "__armillaryTour.emit" with [name] (INT's presentation bridge). */
  | { op: "tourEmit"; name: string }
  /** Sugar for hook "__armillaryTour.advanceLive" with [step] (INT's presentation bridge). */
  | { op: "tourAdvanceLive"; step: number }
  /** Pause every animation on the document timeline and set them all to `atMs`. Later steps see a frozen frame. */
  | { op: "seekAnimations"; atMs: number }
  /** Let paused animations run again (cancels the freeze from `seekAnimations`). */
  | { op: "playAnimations" }
  /** One still. Written as <name>.png. `settleFrames` rAF ticks run first (default 2). */
  | { op: "snapshot"; name: string; settleFrames?: number }
  /** Snapshot continuously for `durationMs` as fast as snapshots complete: <name>-0001.png, ... and a timing list in the report. */
  | { op: "burst"; name: string; durationMs: number; maxFrames?: number }
  /**
   * Frame-accurate sequence: for t = fromMs, fromMs+stepMs, ... <= toMs, seek (`seek`), settle, snapshot
   * <name>-0001.png, ... Use stepMs = 1000/fps (e.g. 33.333 for 30 fps).
   */
  | { op: "sequence"; name: string; fromMs: number; toMs: number; stepMs: number; seek: SeekTarget; settleFrames?: number }
  /** End the tour: the real app exits with `code` (default 0); a browser harness just stops. */
  | { op: "quit"; code?: number };

export interface Tour {
  version: 1;
  name?: string;
  /** Window size in CSS pixels applied before step one. Default 1440 x 900. */
  window?: { width: number; height: number };
  /** Applied before step one. Default "dark". */
  theme?: "dark" | "light";
  /** Whole-tour budget in ms (real app: the core quits with exit code 3 when exceeded). Default 120000. */
  timeoutMs?: number;
  /** Wait for this selector before step one (default "#root > *"). */
  readySelector?: string;
  steps: TourStep[];
}

export const VIEW_KEYS: Record<ViewName, string> = {
  orrery: "1",
  almanac: "2",
  folio: "3",
  "field-guide": "4",
  switchboard: "5",
  launchpad: "6",
  search: "7",
  gallery: "g",
};

export const DEFAULT_WINDOW = { width: 1440, height: 900 } as const;

const OPS = new Set([
  "navigate", "key", "click", "type", "wait", "waitFrames", "waitFor", "theme", "resize", "hook",
  "firstrunSeek", "tourEmit", "tourAdvanceLive", "seekAnimations", "playAnimations", "snapshot",
  "burst", "sequence", "quit",
]);

/** Returns a list of problems (empty = valid). Pure, so both hosts can reject a bad tour before running it. */
export function validateTour(input: unknown): string[] {
  const errs: string[] = [];
  if (typeof input !== "object" || input === null) return ["tour must be an object"];
  const t = input as Record<string, unknown>;
  if (t.version !== 1) errs.push("version must be 1");
  if (!Array.isArray(t.steps)) return [...errs, "steps must be an array"];
  const names = new Set<string>();
  t.steps.forEach((raw, i) => {
    const at = `steps[${i}]`;
    if (typeof raw !== "object" || raw === null) return void errs.push(`${at} must be an object`);
    const s = raw as Record<string, unknown>;
    if (typeof s.op !== "string" || !OPS.has(s.op)) return void errs.push(`${at}.op "${String(s.op)}" is not a known op`);
    const need = (k: string, type: "string" | "number") => {
      if (typeof s[k] !== type) errs.push(`${at} (${s.op}) needs ${k}: ${type}`);
    };
    switch (s.op) {
      case "navigate": need("view", "string"); if (typeof s.view === "string" && !(s.view in VIEW_KEYS)) errs.push(`${at} unknown view "${s.view}"`); break;
      case "key": need("key", "string"); break;
      case "click": need("selector", "string"); break;
      case "type": need("selector", "string"); need("text", "string"); break;
      case "wait": need("ms", "number"); break;
      case "waitFrames": need("frames", "number"); break;
      case "waitFor": need("selector", "string"); break;
      case "theme": if (s.theme !== "dark" && s.theme !== "light") errs.push(`${at} theme must be "dark" or "light"`); break;
      case "resize": need("width", "number"); need("height", "number"); break;
      case "hook": need("name", "string"); break;
      case "firstrunSeek": need("ms", "number"); break;
      case "tourEmit": need("name", "string"); break;
      case "tourAdvanceLive": need("step", "number"); break;
      case "seekAnimations": need("atMs", "number"); break;
      case "snapshot": case "burst": case "sequence": {
        need("name", "string");
        if (typeof s.name === "string") {
          if (!/^[A-Za-z0-9_-][A-Za-z0-9._-]*$/.test(s.name) || s.name.includes("..")) errs.push(`${at} name "${s.name}" is not a safe file stem`);
          if (names.has(s.name)) errs.push(`${at} name "${s.name}" is used twice (files would overwrite)`);
          names.add(s.name);
        }
        if (s.op === "burst") need("durationMs", "number");
        if (s.op === "sequence") {
          need("fromMs", "number"); need("toMs", "number"); need("stepMs", "number");
          if (typeof s.stepMs === "number" && s.stepMs <= 0) errs.push(`${at} stepMs must be positive`);
          const seek = s.seek as { kind?: string; hook?: string } | undefined;
          if (!seek || (seek.kind !== "animations" && !(seek.kind === "hook" && typeof seek.hook === "string"))) errs.push(`${at} seek must be {kind:"animations"} or {kind:"hook",hook}`);
        }
        break;
      }
    }
  });
  return errs;
}
