import { describe, expect, it } from "vitest";
import logJson from "../src/data/mockEventLog.json";
import { FIRSTRUN_EVENT, normaliseFamily, parseCoreEvent, parsePlan, parseRecordedLog } from "../src/events";
import { RecordedSource } from "../src/sources";

describe("event parsing", () => {
  it("parses every event of the recorded log, catalogue first and done last", () => {
    const log = parseRecordedLog(logJson)!;
    expect(log.source.startsWith("mock:")).toBe(true);
    expect(log.events[0].name).toBe(FIRSTRUN_EVENT.catalogue);
    expect(log.events[log.events.length - 1].name).toBe(FIRSTRUN_EVENT.done);
    for (const e of log.events) expect(parseCoreEvent(e.name, e.payload)).not.toBeNull();
  });

  it("takes the catalogue from the registry recording, never a hard-coded list", () => {
    const log = parseRecordedLog(logJson)!;
    const cat = parseCoreEvent(log.events[0].name, log.events[0].payload)!;
    if (cat.name !== FIRSTRUN_EVENT.catalogue) throw new Error("expected catalogue");
    const agents = log.events.filter((e) => e.name === FIRSTRUN_EVENT.agent);
    expect(agents).toHaveLength(cat.payload.entries.length);
    expect(log.plan.entries.map((e) => e.id)).toEqual(cat.payload.entries.map((e) => e.id));
    const done = parseCoreEvent(log.events[log.events.length - 1].name, log.events[log.events.length - 1].payload)!;
    if (done.name !== FIRSTRUN_EVENT.done) throw new Error("expected done");
    expect(done.payload.catalogueSize).toBe(cat.payload.entries.length);
  });

  it("rejects malformed payloads and normalises unknown families", () => {
    expect(parseCoreEvent("firstrun:agent", { id: 3, found: true })).toBeNull();
    expect(parseCoreEvent("firstrun:import", { agentId: "x", phase: "exploded" })).toBeNull();
    expect(parseCoreEvent("firstrun:unknown", {})).toBeNull();
    expect(parseCoreEvent("firstrun:done", null)).toBeNull();
    expect(normaliseFamily("Anthropic")).toBe("other");
    expect(normaliseFamily("anthropic")).toBe("anthropic");
    const imp = parseCoreEvent("firstrun:import", { agentId: "a", phase: "progress", sessionsImported: -4, sessionsKnown: "x" });
    expect(imp && imp.name === "firstrun:import" && imp.payload.sessionsImported).toBe(0);
    expect(parsePlan({ entries: [{ id: "a", name: "A", family: "zzz" }], folders: ["~/.a"] })!.entries[0].family).toBe("other");
  });

  it("fills constellation members from agents when an older payload has none", () => {
    const ev = parseCoreEvent("firstrun:done", { constellations: [{ name: "p", root: "/x/p", agents: ["a", "b"], sessions: 3 }] });
    if (!ev || ev.name !== "firstrun:done") throw new Error("expected done");
    expect(ev.payload.constellations[0].members.map((m) => m.agentId)).toEqual(["a", "b"]);
  });

  it("the recorded source replays events with their offsets", async () => {
    const src = RecordedSource.fromJson(logJson);
    const got: number[] = [];
    await src.scan((_e, off) => got.push(off ?? -1));
    expect(got.length).toBeGreaterThan(80);
    expect(got.every((x) => x >= 0)).toBe(true);
    expect(got).toEqual(got.slice().sort((a, b) => a - b));
  });
});
