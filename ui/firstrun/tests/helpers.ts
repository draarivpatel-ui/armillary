import logJson from "../src/data/mockEventLog.json";
import { parseCoreEvent, parseRecordedLog, type CoreEvent, type RecordedLog } from "../src/events";
import { Scene } from "../src/scene/scene";
import type { HandoffTarget, SceneConfig, SceneInput } from "../src/scene/types";

export const LOG: RecordedLog = parseRecordedLog(logJson)!;

/** A deterministic text measure (no canvas in jsdom). */
export const measure: SceneConfig["measure"] = (font, text, tracking) => {
  const size = parseFloat(/([\d.]+)px/.exec(font)?.[1] ?? "14");
  return text.length * size * 0.56 + Math.max(0, text.length - 1) * tracking;
};

export function makeScene(opts: Partial<SceneConfig> = {}): Scene {
  return new Scene({ w: 1440, h: 900, reducedMotion: false, measure, ...opts });
}

export function coreEvents(log: RecordedLog = LOG): Array<{ at: number; event: CoreEvent }> {
  return log.events.map((e) => ({ at: e.at, event: parseCoreEvent(e.name, e.payload)! }));
}

/** The recorded scan, consented at `consentAt`, with optional extra inputs. */
export function scripted(consentAt = 9600, extra: SceneInput[] = []): SceneInput[] {
  const inputs: SceneInput[] = [{ kind: "plan", at: 0, plan: LOG.plan }, { kind: "consent", at: consentAt }];
  for (const e of coreEvents()) inputs.push({ kind: "core", at: consentAt + e.at, event: e.event });
  return inputs.concat(extra);
}

export const TARGET: HandoffTarget = {
  stage: { x: 240, y: 120, w: 1160, h: 700 },
  theme: "dark",
  suns: [
    { id: "sun-a", name: "aurora-docs", root: "/Users/fictional-dev/projects/aurora-docs", x: 500, y: 350, r: 24 },
    { id: "sun-b", name: "nexus-gateway", root: "/Users/fictional-dev/projects/nexus-gateway", x: 900, y: 600, r: 24 },
  ],
  planets: [
    { id: "p1", sunId: "sun-a", x: 600, y: 350, r: 8, color: "#D08A5C", orbit: { cx: 500, cy: 350, a: 100, b: 88, tilt: 0 }, angle: 0, done: false },
  ],
  frame: { outerInset: 10, innerInset: 24, minorTickDeg: 2, midTickDeg: 10, majorTickDeg: 30 },
};

/** Strip closures and reduce floats so frames compare structurally. */
export function snapshot(v: unknown): string {
  return JSON.stringify(v, (_k, x) => (typeof x === "number" ? Math.round(x * 1e6) / 1e6 : x));
}
