import { describe, it, expect } from "vitest";
import {
  INITIAL_SYNTHETIC_SESSIONS,
  MockArchiveClient,
  deriveDisplayTitle,
  type Session,
  type SyntheticMessageRecord,
} from "./archive";

const base = INITIAL_SYNTHETIC_SESSIONS[0];
const T = 1_700_000_000_000;

function session(id: string, title: string | null): Session {
  return { ...base, id, title };
}

function record(session_id: string, seq: number, text: string, at: number, kind: "message" | "tool" = "message"): SyntheticMessageRecord {
  return { session_id, seq, kind, text, at };
}

describe("mock sessions carry the derived fields like the core", () => {
  it("a native title wins and is marked native", async () => {
    const client = new MockArchiveClient([session("s1", "Native title")], [record("s1", 1, "Some prompt. More.", T + 1000)]);
    const got = await client.session_get("s1");
    expect(got?.display_title).toBe("Native title");
    expect(got?.title_source).toBe("native");
    const page = await client.sessions_query();
    expect(page.items[0].display_title).toBe("Native title");
    expect(page.items[0].title_source).toBe("native");
  });

  it("a missing title is derived from the first user message and the contract title stays null", async () => {
    const client = new MockArchiveClient(
      [session("s1", null)],
      [record("s1", 1, "Fix the flaky login test. It fails on CI only.", T + 1000), record("s1", 2, "assistant reply", T + 2000)],
    );
    const got = await client.session_get("s1");
    expect(got?.title).toBeNull();
    expect(got?.display_title).toBe("Fix the flaky login test.");
    expect(got?.title_source).toBe("first_prompt");
  });

  it("no user text leaves the display title null", async () => {
    const client = new MockArchiveClient([session("s1", null)], [record("s1", 2, "assistant reply", T + 2000)]);
    const got = await client.session_get("s1");
    expect(got?.display_title).toBeNull();
    expect(got?.title_source).toBeNull();
  });

  it("the activity span is the smallest and largest message time, null when unknown", async () => {
    const client = new MockArchiveClient(
      [session("s1", "a"), session("s2", "b")],
      [record("s1", 1, "x", T + 5000), record("s1", 2, "y", T + 1000), record("s1", 3, "z", T + 9000)],
    );
    const s1 = await client.session_get("s1");
    expect([s1?.first_activity_at, s1?.last_activity_at]).toEqual([T + 1000, T + 9000]);
    const s2 = await client.session_get("s2");
    expect([s2?.first_activity_at, s2?.last_activity_at]).toEqual([null, null]);
    expect(s1?.ended_at).toBe(base.ended_at);
  });
});

describe("deriveDisplayTitle", () => {
  it("picks the shorter of the first sentence and the first line", () => {
    expect(deriveDisplayTitle("Fix the bug. Then deploy it.")).toBe("Fix the bug.");
    expect(deriveDisplayTitle("Refactor the parser\nso that it handles tabs. More.")).toBe("Refactor the parser");
    expect(deriveDisplayTitle("Open main.rs and read it")).toBe("Open main.rs and read it");
  });

  it("collapses whitespace and returns null for blank text", () => {
    expect(deriveDisplayTitle("  \n  Add   retry\t logic  \n second line")).toBe("Add retry logic");
    expect(deriveDisplayTitle("")).toBeNull();
    expect(deriveDisplayTitle(" \n\t ")).toBeNull();
  });

  it("cuts long text at a word boundary with a plain ... within 70 characters", () => {
    const long = Array.from({ length: 40 }, (_, i) => `word${i + 1}`).join(" ");
    const got = deriveDisplayTitle(long)!;
    expect([...got].length).toBeLessThanOrEqual(70);
    expect(got.endsWith("...")).toBe(true);
    const head = got.slice(0, -3);
    expect(long.startsWith(head)).toBe(true);
    expect(long[head.length]).toBe(" ");
    const exact = "a".repeat(70);
    expect(deriveDisplayTitle(exact)).toBe(exact);
    const token = deriveDisplayTitle("x".repeat(200))!;
    expect([...token].length).toBeLessThanOrEqual(70);
    expect(token.endsWith("...")).toBe(true);
  });
});
