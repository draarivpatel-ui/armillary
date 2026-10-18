/**
 * Tour interpreter (stream SNAP). Host-agnostic: the real app passes a host whose `snapshot`
 * asks the Rust core for an in-process WKWebView photograph; a browser harness passes its own.
 * See tour.ts for the schema. Everything runs on the document timeline except the wait/burst
 * steps, which are explicitly wall-clock.
 */
import { DEFAULT_WINDOW, VIEW_KEYS, type SeekTarget, type Tour, type TourStep } from "./tour";

export interface TourHost {
  /** Take one still named `name` (a safe file stem). Resolves with where it went (path), if known. */
  snapshot(name: string): Promise<string | void>;
  /** Resize the window / viewport to CSS pixels. */
  resize?(width: number, height: number): Promise<void>;
  /** End the run. The real app exits with `code`. */
  quit?(code: number): Promise<void>;
  /** Persist the finished report (JSON text). */
  report?(json: string): Promise<void>;
}

export interface StepResult {
  index: number;
  op: string;
  ms: number;
  error?: string;
}

export interface FrameTiming {
  name: string;
  /** Wall-clock ms the snapshot call took. */
  ms: number;
  /** ms since the start of the burst or sequence (burst only). */
  at?: number;
}

export interface RunReport {
  tour: string;
  ok: boolean;
  error?: string;
  devicePixelRatio: number;
  innerWidth: number;
  innerHeight: number;
  outerWidth: number;
  outerHeight: number;
  screenAvail: string;
  clientHeight: number;
  totalMs: number;
  steps: StepResult[];
  frames: FrameTiming[];
  /** Mean ms per snapshot over all frames taken by burst and sequence steps. */
  meanFrameMs: number | null;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** One animation frame, but never hangs when the page is hidden and rAF is throttled. */
function frame(): Promise<void> {
  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (!done) {
        done = true;
        resolve();
      }
    };
    requestAnimationFrame(() => finish());
    setTimeout(finish, 250);
  });
}

async function frames(n: number): Promise<void> {
  for (let i = 0; i < n; i++) await frame();
}

async function waitForSelector(selector: string, gone: boolean, timeoutMs: number): Promise<Element | null> {
  const start = performance.now();
  for (;;) {
    const el = document.querySelector(selector);
    if (gone ? !el : el) return el;
    if (performance.now() - start > timeoutMs) {
      throw new Error(`timed out after ${timeoutMs} ms waiting for ${gone ? "absence of " : ""}${selector}`);
    }
    await sleep(40);
  }
}

function pad(n: number): string {
  return String(n).padStart(4, "0");
}

/** "Meta+k" -> a KeyboardEvent init. The last token is the key; the rest are modifiers. */
export function parseKey(combo: string): KeyboardEventInit {
  const parts = combo.length > 1 ? combo.split("+") : [combo];
  // "Shift++" style: a trailing empty token means the key is "+".
  let key = parts.pop() ?? "";
  if (key === "" && parts.length > 0) key = "+";
  const mods = new Set(parts.map((m) => m.toLowerCase()));
  return {
    key,
    code: key.length === 1 && /[a-z]/i.test(key) ? `Key${key.toUpperCase()}` : /^\d$/.test(key) ? `Digit${key}` : key,
    metaKey: mods.has("meta") || mods.has("cmd") || mods.has("command"),
    ctrlKey: mods.has("ctrl") || mods.has("control"),
    altKey: mods.has("alt") || mods.has("option"),
    shiftKey: mods.has("shift"),
    bubbles: true,
    cancelable: true,
  };
}

function resolveHook(path: string): { fn: (...a: unknown[]) => unknown; self: unknown } {
  const segs = path.split(".");
  let self: unknown = window;
  let cur: unknown = window;
  for (const seg of segs) {
    self = cur;
    cur = (cur as Record<string, unknown> | undefined)?.[seg];
    if (cur === undefined || cur === null) throw new Error(`hook window.${path} is not defined`);
  }
  if (typeof cur !== "function") throw new Error(`hook window.${path} is not a function`);
  return { fn: cur as (...a: unknown[]) => unknown, self };
}

async function callHook(path: string, args: unknown[]): Promise<void> {
  const { fn, self } = resolveHook(path);
  await fn.apply(self, args);
}

const frozen = new Set<Animation>();

function seekAnimations(atMs: number): void {
  for (const a of document.getAnimations()) {
    a.pause();
    a.currentTime = atMs;
    frozen.add(a);
  }
}

function playAnimations(): void {
  for (const a of frozen) {
    try {
      a.play();
    } catch {
      /* the animation was cancelled */
    }
  }
  frozen.clear();
}

function pointerSequence(el: Element): void {
  const r = el.getBoundingClientRect();
  const init = { bubbles: true, cancelable: true, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2, button: 0 };
  for (const type of ["pointerover", "pointerdown", "mousedown", "pointerup", "mouseup"]) {
    const Ctor = type.startsWith("pointer") && typeof PointerEvent === "function" ? PointerEvent : MouseEvent;
    el.dispatchEvent(new Ctor(type, init));
  }
  (el as HTMLElement).click();
}

function setFieldValue(el: HTMLInputElement | HTMLTextAreaElement, value: string): void {
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, "value")?.set?.call(el, value);
  el.dispatchEvent(new Event("input", { bubbles: true }));
}

export async function runTour(tour: Tour, host: TourHost): Promise<RunReport> {
  const t0 = performance.now();
  const results: StepResult[] = [];
  const timings: FrameTiming[] = [];
  let failure: string | undefined;

  const snap = async (name: string, settle: number, at?: number) => {
    await frames(settle);
    const s = performance.now();
    await host.snapshot(name);
    timings.push({ name, ms: Math.round((performance.now() - s) * 10) / 10, at });
  };

  const seekTo = async (seek: SeekTarget, t: number) => {
    if (seek.kind === "animations") seekAnimations(t);
    else await callHook(seek.hook, [t]);
  };

  const runStep = async (step: TourStep): Promise<boolean> => {
    switch (step.op) {
      case "navigate":
        window.dispatchEvent(new KeyboardEvent("keydown", { key: VIEW_KEYS[step.view], bubbles: true }));
        await frames(2);
        return true;
      case "key": {
        const target = step.selector ? document.querySelector(step.selector) : document.activeElement ?? document.body;
        if (!target) throw new Error(`no element for ${step.selector}`);
        const init = parseKey(step.key);
        target.dispatchEvent(new KeyboardEvent("keydown", init));
        target.dispatchEvent(new KeyboardEvent("keyup", init));
        await frames(1);
        return true;
      }
      case "click": {
        const el = await waitForSelector(step.selector, false, step.timeoutMs ?? 5000);
        if (el) pointerSequence(el);
        await frames(1);
        return true;
      }
      case "type": {
        const el = (await waitForSelector(step.selector, false, 5000)) as HTMLInputElement | HTMLTextAreaElement | null;
        if (!el) return true;
        el.focus();
        const delay = step.delayMs ?? 0;
        let value = step.clear ? "" : el.value;
        if (step.clear) setFieldValue(el, "");
        if (delay <= 0) {
          setFieldValue(el, value + step.text);
        } else {
          for (const ch of step.text) {
            value += ch;
            el.dispatchEvent(new KeyboardEvent("keydown", { key: ch, bubbles: true }));
            setFieldValue(el, value);
            el.dispatchEvent(new KeyboardEvent("keyup", { key: ch, bubbles: true }));
            await sleep(delay);
          }
        }
        await frames(1);
        return true;
      }
      case "wait":
        await sleep(step.ms);
        return true;
      case "waitFrames":
        await frames(step.frames);
        return true;
      case "waitFor":
        await waitForSelector(step.selector, step.gone ?? false, step.timeoutMs ?? 10000);
        return true;
      case "theme": {
        // Preferred: click the app's own toggle, so React state and the button label stay in step.
        const current = document.querySelector(".app-shell[data-theme], [data-theme]")?.getAttribute("data-theme");
        if (step.toggle && current !== step.theme) {
          const el = await waitForSelector(step.toggle, false, 5000);
          if (el) pointerSequence(el);
        } else if (!step.toggle) {
          document.documentElement.setAttribute("data-theme", step.theme);
          document.querySelectorAll("[data-theme]").forEach((e) => e.setAttribute("data-theme", step.theme));
        }
        await frames(2);
        return true;
      }
      case "resize":
        await host.resize?.(step.width, step.height);
        await sleep(250);
        await frames(2);
        return true;
      case "hook":
        await callHook(step.name, step.args ?? []);
        return true;
      case "firstrunSeek":
        await callHook("__armillaryFirstRun.seek", [step.ms]);
        return true;
      case "tourEmit":
        await callHook("__armillaryTour.emit", [step.name]);
        return true;
      case "tourAdvanceLive":
        await callHook("__armillaryTour.advanceLive", [step.step]);
        return true;
      case "seekAnimations":
        seekAnimations(step.atMs);
        await frames(1);
        return true;
      case "playAnimations":
        playAnimations();
        return true;
      case "snapshot":
        await snap(step.name, step.settleFrames ?? 2);
        return true;
      case "burst": {
        const start = performance.now();
        const max = step.maxFrames ?? 10000;
        for (let i = 1; i <= max && performance.now() - start < step.durationMs; i++) {
          await snap(`${step.name}-${pad(i)}`, 0, Math.round(performance.now() - start));
        }
        return true;
      }
      case "sequence": {
        let i = 0;
        for (let t = step.fromMs; t <= step.toMs + 1e-6; t += step.stepMs) {
          i++;
          await seekTo(step.seek, t);
          await snap(`${step.name}-${pad(i)}`, step.settleFrames ?? 2);
        }
        return true;
      }
      case "quit":
        return false;
    }
  };

  let exitCode = 0;
  const budget = tour.timeoutMs ?? 120_000;
  const timer = setTimeout(() => {
    failure = `tour exceeded its ${budget} ms budget`;
    exitCode = 3;
    void host.report?.(JSON.stringify(finish(), null, 2)).finally(() => host.quit?.(3));
  }, budget);

  const finish = (): RunReport => {
    const framesTaken = timings.filter((f) => /-\d{4}$/.test(f.name));
    const mean = framesTaken.length ? framesTaken.reduce((a, f) => a + f.ms, 0) / framesTaken.length : null;
    return {
      tour: tour.name ?? "tour",
      ok: failure === undefined,
      error: failure,
      devicePixelRatio: window.devicePixelRatio,
      innerWidth: window.innerWidth,
      innerHeight: window.innerHeight,
      outerWidth: window.outerWidth,
      outerHeight: window.outerHeight,
      screenAvail: `${screen.availWidth}x${screen.availHeight}`,
      clientHeight: document.documentElement.clientHeight,
      totalMs: Math.round(performance.now() - t0),
      steps: results,
      frames: timings,
      meanFrameMs: mean === null ? null : Math.round(mean * 10) / 10,
    };
  };

  try {
    await waitForSelector(tour.readySelector ?? "#root > *", false, 30_000);
    const win = tour.window ?? DEFAULT_WINDOW;
    await host.resize?.(win.width, win.height);
    await sleep(300);
    document.documentElement.setAttribute("data-theme", tour.theme ?? "dark");
    await frames(2);

    for (let index = 0; index < tour.steps.length; index++) {
      const step = tour.steps[index];
      const s = performance.now();
      try {
        const keepGoing = await runStep(step);
        results.push({ index, op: step.op, ms: Math.round(performance.now() - s) });
        if (!keepGoing) {
          exitCode = step.op === "quit" ? step.code ?? 0 : 0;
          break;
        }
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        results.push({ index, op: step.op, ms: Math.round(performance.now() - s), error: message });
        failure = `step ${index} (${step.op}): ${message}`;
        exitCode = 1;
        break;
      }
    }
  } catch (e) {
    failure = e instanceof Error ? e.message : String(e);
    exitCode = 1;
  } finally {
    clearTimeout(timer);
  }

  const report = finish();
  await host.report?.(JSON.stringify(report, null, 2));
  if (exitCode !== 3) await host.quit?.(exitCode);
  return report;
}
