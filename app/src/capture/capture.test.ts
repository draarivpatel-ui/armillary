import { afterEach, describe, expect, it, vi } from "vitest";
import example from "../../../tools/capture-app/example-tour.json";
import proof from "../../../tools/capture-app/proof-tour.json";
import { parseKey, runTour, type TourHost } from "./runner";
import { validateTour, type Tour } from "./tour";

function host(): TourHost & { shots: string[]; resized: Array<[number, number]>; quit: ReturnType<typeof vi.fn> } {
  const shots: string[] = [];
  const resized: Array<[number, number]> = [];
  return {
    shots,
    resized,
    snapshot: async (name) => void shots.push(name),
    resize: async (w, h) => void resized.push([w, h]),
    quit: vi.fn(async () => {}),
    report: async () => {},
  };
}

afterEach(() => {
  document.body.innerHTML = "";
  delete (window as unknown as Record<string, unknown>).__t;
});

describe("tour schema", () => {
  it("accepts the shipped example and proof tours", () => {
    expect(validateTour(example)).toEqual([]);
    expect(validateTour(proof)).toEqual([]);
  });

  it("rejects unknown ops, bad names, duplicate names and bad sequences", () => {
    const problems = validateTour({
      version: 1,
      steps: [
        { op: "teleport" },
        { op: "snapshot", name: "../x" },
        { op: "snapshot", name: "a" },
        { op: "snapshot", name: "a" },
        { op: "navigate", view: "nowhere" },
        { op: "sequence", name: "s", fromMs: 0, toMs: 10, stepMs: 0, seek: { kind: "hook" } },
      ],
    });
    expect(problems.length).toBeGreaterThanOrEqual(5);
    expect(problems.join("\n")).toMatch(/not a known op/);
    expect(problems.join("\n")).toMatch(/safe file stem/);
    expect(problems.join("\n")).toMatch(/used twice/);
  });

  it("rejects a non-object and a missing steps array", () => {
    expect(validateTour(null)).not.toEqual([]);
    expect(validateTour({ version: 1 })).not.toEqual([]);
    expect(validateTour({ version: 2, steps: [] })).toContain("version must be 1");
  });
});

describe("parseKey", () => {
  it("parses plain keys and combinations", () => {
    expect(parseKey("1")).toMatchObject({ key: "1", code: "Digit1", metaKey: false });
    expect(parseKey("Meta+k")).toMatchObject({ key: "k", code: "KeyK", metaKey: true });
    expect(parseKey("Ctrl+Shift+p")).toMatchObject({ key: "p", ctrlKey: true, shiftKey: true });
    expect(parseKey("Escape")).toMatchObject({ key: "Escape" });
    expect(parseKey("+")).toMatchObject({ key: "+" });
  });
});

describe("runTour", () => {
  const base = (steps: Tour["steps"]): Tour => ({ version: 1, readySelector: "body", steps });

  it("navigates with the rail shortcut, snapshots by name and quits", async () => {
    const keys: string[] = [];
    window.addEventListener("keydown", (e) => keys.push(e.key));
    const h = host();
    const report = await runTour(
      base([
        { op: "navigate", view: "folio" },
        { op: "snapshot", name: "folio" },
        { op: "quit", code: 0 },
      ]),
      h,
    );
    expect(keys).toContain("3");
    expect(h.shots).toEqual(["folio"]);
    expect(h.resized).toEqual([[1440, 900]]);
    expect(report.ok).toBe(true);
    expect(h.quit).toHaveBeenCalledWith(0);
  });

  it("clicks, types per character and waits for selectors", async () => {
    document.body.innerHTML = `<button id="b">go</button><input id="i" />`;
    let clicked = 0;
    document.getElementById("b")!.addEventListener("click", () => clicked++);
    const h = host();
    const report = await runTour(
      base([
        { op: "click", selector: "#b" },
        { op: "type", selector: "#i", text: "abc", delayMs: 1 },
        { op: "waitFor", selector: "#i" },
        { op: "quit" },
      ]),
      h,
    );
    expect(clicked, JSON.stringify(report)).toBe(1);
    expect((document.getElementById("i") as HTMLInputElement).value).toBe("abc");
  });

  it("runs a hook sequence frame by frame and names the files with four digits", async () => {
    const seen: number[] = [];
    (window as unknown as Record<string, unknown>).__t = { seek: (ms: number) => void seen.push(ms) };
    const h = host();
    await runTour(
      base([
        { op: "sequence", name: "fr", fromMs: 0, toMs: 100, stepMs: 50, seek: { kind: "hook", hook: "__t.seek" } },
        { op: "firstrunSeek", ms: 1 },
      ]),
      h,
    );
    expect(seen).toEqual([0, 50, 100]);
    expect(h.shots).toEqual(["fr-0001", "fr-0002", "fr-0003"]);
  });

  it("records the failing step, stops, and quits with code 1", async () => {
    const h = host();
    const report = await runTour(
      base([{ op: "hook", name: "__nope.missing" }, { op: "snapshot", name: "never" }]),
      h,
    );
    expect(report.ok).toBe(false);
    expect(report.error).toMatch(/step 0 \(hook\)/);
    expect(h.shots).toEqual([]);
    expect(h.quit).toHaveBeenCalledWith(1);
  });

  it("bursts for the requested time and reports mean frame ms", async () => {
    const h = host();
    const report = await runTour(base([{ op: "burst", name: "b", durationMs: 60 }]), h);
    expect(h.shots.length).toBeGreaterThanOrEqual(1);
    expect(h.shots[0]).toBe("b-0001");
    expect(report.meanFrameMs).not.toBeNull();
  });
});
