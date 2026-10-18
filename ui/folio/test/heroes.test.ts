import { createElement } from "react";
import { render, fireEvent } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { ContentBlock, Message as CMessage, Session as CSession } from "@armillary/model";
import { fromContract } from "../src/contract";
import { buildBlocks, type MarginalNote } from "../src/blockify";
import { parseUnifiedDiff } from "../src/diff";
import { Folio } from "../src/Folio";

const here = dirname(fileURLToPath(import.meta.url));
const fixture = JSON.parse(readFileSync(join(here, "fixtures/heroes.json"), "utf8")) as {
  heroes: Record<string, { session: CSession; messages: CMessage[] }>;
};

function load(id: string) {
  const hero = fixture.heroes[id];
  const out = fromContract(hero.session, hero.messages);
  const plan = buildBlocks(out.messages, out.toolCalls);
  return { hero, out, plan, notes: plan.marginalia };
}

const byKind = (notes: MarginalNote[], kind: MarginalNote["kind"]) => notes.filter((n) => n.kind === kind);
const diffOf = (note: MarginalNote, index = 0) => parseUnifiedDiff(note.edits[index].raw);
const addedTexts = (note: MarginalNote) =>
  note.edits.flatMap((_, i) => diffOf(note, i).lines.filter((l) => l.kind === "add").map((l) => l.text));
const deletedTexts = (note: MarginalNote) =>
  note.edits.flatMap((_, i) => diffOf(note, i).lines.filter((l) => l.kind === "del").map((l) => l.text));

describe("hero sessions: every one renders", () => {
  for (const id of Object.keys(fixture.heroes)) {
    it(`${id} converts and renders without throwing`, () => {
      const { out } = load(id);
      expect(() =>
        render(
          createElement(Folio, {
            session: out.session,
            messages: out.messages,
            toolCalls: out.toolCalls,
            virtualize: false,
            height: 900,
          }),
        ),
      ).not.toThrow();
    });
  }

  it("no hero note prints undefined, null or raw conflict markers", () => {
    for (const id of Object.keys(fixture.heroes)) {
      const { notes } = load(id);
      for (const note of notes) {
        const shown = [note.tool, note.input, ...note.files].join("\n");
        expect(shown, id).not.toMatch(/\bundefined\b|\[object Object\]/);
        for (const edit of note.edits) {
          expect(edit.raw, id).not.toMatch(/<<<<<<<|>>>>>>> REPLACE|^=======$/m);
        }
      }
    }
  });
});

describe("claude-skyline-radar-jitter", () => {
  const { notes, out } = load("claude-skyline-radar-jitter");

  it("shows each TodoWrite as a plan note with states", () => {
    const plans = byKind(notes, "plan");
    expect(plans).toHaveLength(3);
    expect(plans[0].tool).toBe("TodoWrite");
    expect(plans[0].plan!.items).toHaveLength(5);
    expect(plans[0].plan!.items[0]).toEqual({
      text: "Reproduce the freeze with a fake-timer test",
      done: false,
      state: "in_progress",
    });
    expect(plans[0].plan!.items.slice(1).every((i) => i.done === false && (i as { state?: string }).state === "pending")).toBe(true);
    const mid = plans[1].plan!.items as { done: boolean; state?: string }[];
    expect(mid.map((i) => i.state)).toEqual(["done", "done", "done", "in_progress", "pending"]);
    expect(mid.filter((i) => i.done)).toHaveLength(3);
    expect((plans[2].plan!.items as { state?: string }[]).every((i) => i.state === "done")).toBe(true);
  });

  it("shows the RadarSweep Edit as a diff with at least two hunks", () => {
    const sweep = notes.find((n) => n.kind === "edit" && n.seq === 12 && n.files.some((f) => f.endsWith("RadarSweep.ts")));
    expect(sweep).toBeDefined();
    const parsed = diffOf(sweep!);
    expect(parsed.hunks.length).toBeGreaterThanOrEqual(2);
    expect(parsed.additions).toBeGreaterThan(0);
    expect(parsed.deletions).toBeGreaterThan(0);
  });

  it("has exactly two error notes, with the failing line from each output", () => {
    const errors = byKind(notes, "error");
    expect(errors).toHaveLength(2);
    expect(errors[0].error).toBe("AssertionError: expected 0 to be greater than 30");
    expect(errors[1].error).toBe("AssertionError: expected 366 to be less than 360");
    expect(errors.every((e) => e.tool === "Bash")).toBe(true);
  });

  it("keeps a later passing Bash result as a plain ok note", () => {
    const lastError = byKind(notes, "error").at(-1)!;
    const passing = notes.filter((n) => n.tool === "Bash" && n.kind === "tool" && n.seq > lastError.seq && !n.isError);
    expect(passing.length).toBeGreaterThanOrEqual(1);
    expect(passing.some((n) => n.result.includes("TileCache.test.ts"))).toBe(true);
    expect(passing.every((n) => n.error === null)).toBe(true);
  });

  it("names the subagent type on the Task note and prefers its description", () => {
    const task = notes.find((n) => n.tool.startsWith("Task"));
    expect(task).toBeDefined();
    expect(task!.tool).toBe("Task (general-purpose)");
    expect(task!.input).toBe("Survey callers of TileCache.refresh");
  });

  it("shows paths relative to the project root, from the input when files is empty", () => {
    const edit = notes.find((n) => n.seq === 14 && n.kind === "edit")!;
    expect(edit.files).toEqual(["src/radar/RadarSweep.ts"]);
    expect(edit.edits[0].path).toBe("src/radar/RadarSweep.ts");
    const read = notes.find((n) => n.tool === "Read")!;
    expect(read.files).toHaveLength(1);
    expect(read.files[0].startsWith("src/")).toBe(true);
    // the archive side is untouched: the first Edit's raw before/after survive
    expect(out.toolCalls.find((t) => t.seq === 14 && t.name === "Edit")!.edits![0].before).toContain("(now - this.startedAt)");
  });
});

describe("claude-nexus-burst-multiplier", () => {
  const { notes } = load("claude-nexus-burst-multiplier");

  it("has an error note that starts with the compiler error, followed by an edit", () => {
    const errors = byKind(notes, "error");
    expect(errors).toHaveLength(1);
    expect(errors[0].error!.startsWith("error[E0308]: mismatched types")).toBe(true);
    const next = notes.filter((n) => n.seq > errors[0].seq)[0];
    expect(next.kind).toBe("edit");
    expect(addedTexts(next)).toContain("        self.capacity = scaled as u64;");
    expect(deletedTexts(next)).toContain("        self.capacity = scaled;");
  });
});

describe("codex-nexus-bucket-refill", () => {
  const { notes, plan } = load("codex-nexus-bucket-refill");
  const patches = notes.filter((n) => n.tool === "apply_patch");

  it("turns each apply_patch heredoc into an apply_patch edit note", () => {
    expect(patches).toHaveLength(2);
    expect(patches.every((n) => n.kind === "edit")).toBe(true);
    expect(patches.every((n) => n.edits.length === 1 && n.edits[0].path === "crates/limiter/src/lib.rs")).toBe(true);
    expect(patches[0].files).toEqual(["crates/limiter/src/lib.rs"]);
    expect(notes.filter((n) => n.tool === "command_execution")).toHaveLength(6);
    expect(notes.filter((n) => n.tool === "command_execution").every((n) => n.edits.length === 0)).toBe(true);
  });

  it("writes a unified diff that parseUnifiedDiff reads, added lines as + lines", () => {
    const first = diffOf(patches[0]);
    expect(first.oldPath).toBe("a/crates/limiter/src/lib.rs");
    expect(first.newPath).toBe("b/crates/limiter/src/lib.rs");
    expect(first.hunks).toHaveLength(1);
    expect(first.deletions).toBe(0);
    expect(first.additions).toBe(16);
    expect(addedTexts(patches[0])).toContain("    fn idle_gap_then_merge_never_exceeds_capacity() {");
    expect(first.hunks[0].header).toMatch(/^@@ -\d+,\d+ \+\d+,\d+ @@/);

    const second = diffOf(patches[1]);
    expect(second.deletions).toBe(1);
    expect(second.additions).toBe(3);
    expect(deletedTexts(patches[1])).toEqual(["        self.tokens = self.tokens.min(remote_tokens) + self.pending_refund;"]);
    expect(addedTexts(patches[1])).toContain("        let merged = self.tokens.min(remote_tokens) + self.pending_refund;");
    // header counts agree with the body
    const header = /^@@ -(\d+),(\d+) \+(\d+),(\d+) @@/.exec(second.hunks[0].header)!;
    const body = second.hunks[0].lines;
    expect(Number(header[2])).toBe(body.filter((l) => l.kind !== "add").length);
    expect(Number(header[4])).toBe(body.filter((l) => l.kind !== "del").length);
  });

  it("leaves the Markdown plan text in the message body", () => {
    const withPlan = plan.blocks.filter((b) => b.text.includes("Updated plan"));
    expect(withPlan).toHaveLength(2);
    expect(withPlan[0].checklists).toHaveLength(1);
    expect(withPlan[0].checklists[0].items).toHaveLength(3);
    expect(withPlan[1].bodyText).toContain("- [x] Clamp merged tokens to the bucket capacity");
    expect(byKind(notes, "plan")).toHaveLength(0);
  });
});

describe("cline-aurora-copy-button", () => {
  const { notes } = load("cline-aurora-copy-button");

  it("turns SEARCH/REPLACE blocks into -/+ lines, one edit per block", () => {
    const replaces = notes.filter((n) => n.tool === "replace_in_file");
    expect(replaces).toHaveLength(3);
    expect(replaces.every((n) => n.kind === "edit" && n.edits.length === 1)).toBe(true);
    const first = replaces.find((n) => addedTexts(n).includes('        <CopyButton text={body} label="Copy response body" />'))!;
    expect(first).toBeDefined();
    expect(deletedTexts(first)).toEqual([]);
    expect(first.edits[0].path).toBe("src/components/ApiPlayground.tsx");
    const imp = replaces.find((n) => addedTexts(n).includes('import { CopyButton } from "./CopyButton";'))!;
    expect(deletedTexts(imp)).toEqual([]);
    expect(addedTexts(imp)).toContain("");
    const fallback = replaces.find((n) => deletedTexts(n).includes("    await navigator.clipboard.writeText(text);"))!;
    expect(fallback).toBeDefined();
    expect(addedTexts(fallback)).toContain("    if (navigator.clipboard?.writeText) {");
  });

  it("shows write_to_file as an all-added diff", () => {
    const writes = notes.filter((n) => n.tool === "write_to_file");
    expect(writes).toHaveLength(2);
    for (const w of writes) {
      expect(w.kind).toBe("edit");
      expect(diffOf(w).deletions).toBe(0);
      expect(diffOf(w).additions).toBeGreaterThan(5);
    }
  });

  it("has one error note whose line is the failing assertion", () => {
    const errors = byKind(notes, "error");
    expect(errors).toHaveLength(1);
    expect(errors[0].error).toBe("TypeError: Cannot read properties of undefined (reading 'writeText')");
    expect(errors[0].tool).toBe("execute_command");
  });
});

describe("gemini-vortex-allocator", () => {
  const { notes } = load("gemini-vortex-allocator");

  it("shows replace as an edit diff with the removed and added lines", () => {
    const replaces = notes.filter((n) => n.tool === "replace");
    expect(replaces).toHaveLength(2);
    expect(replaces.every((n) => n.kind === "edit")).toBe(true);
    const dict = replaces.find((n) => n.files.some((f) => f.endsWith("dict.rs")))!;
    expect(dict.files).toEqual(["crates/reader/src/dict.rs"]);
    expect(deletedTexts(dict)).toContain("        let mut staged: Vec<Vec<u8>> = Vec::new();");
    expect(addedTexts(dict)).toContain("        out.reserve(indices.len() * self.avg_value_len());");
  });

  it("has no error notes", () => {
    expect(byKind(notes, "error")).toHaveLength(0);
  });
});

describe("opencode-zenith-ping-timeout", () => {
  const { notes } = load("opencode-zenith-ping-timeout");

  it("shows todowrite as a checklist with states", () => {
    const plans = byKind(notes, "plan");
    expect(plans).toHaveLength(2);
    expect(plans[0].tool).toBe("todowrite");
    expect((plans[0].plan!.items as { state?: string }[]).map((i) => i.state)).toEqual([
      "in_progress",
      "pending",
      "pending",
      "pending",
    ]);
    const last = plans[1].plan!.items as { done: boolean; state?: string }[];
    expect(last.map((i) => i.state)).toEqual(["done", "done", "done", "in_progress"]);
    expect(last.map((i) => i.done)).toEqual([true, true, true, false]);
  });

  it("shows edit calls as diffs and has one error", () => {
    const edits = notes.filter((n) => n.tool === "edit");
    expect(edits).toHaveLength(3);
    expect(edits.every((n) => n.kind === "edit" && diffOf(n).additions > 0)).toBe(true);
    expect(edits[0].files).toEqual(["src/consensus.rs"]);
    const errors = byKind(notes, "error");
    expect(errors).toHaveLength(1);
    expect(errors[0].error).toBe("test slow_link_is_not_reported_dead ... FAILED");
  });
});

describe("claude-zenith-diagnostics-plan", () => {
  const { notes } = load("claude-zenith-diagnostics-plan");

  it("shows TodoWrite as plan notes, two in progress at once when the agent says so", () => {
    const plans = byKind(notes, "plan");
    expect(plans).toHaveLength(3);
    const second = plans[1].plan!.items as { state?: string }[];
    expect(second.filter((i) => i.state === "in_progress")).toHaveLength(2);
    const third = plans[2].plan!.items as { state?: string }[];
    expect(third.map((i) => i.state)).toEqual(["done", "done", "in_progress", "pending", "in_progress"]);
  });

  it("shows Write and Edit as edit notes", () => {
    expect(notes.filter((n) => n.tool === "Write" && n.kind === "edit")).toHaveLength(2);
    expect(notes.filter((n) => n.tool === "Edit" && n.kind === "edit")).toHaveLength(4);
  });
});

describe("rendered hero margin", () => {
  it("shows diff toggles and plan checklists in the margin", () => {
    const { out } = load("claude-skyline-radar-jitter");
    const view = render(
      createElement(Folio, {
        session: out.session,
        messages: out.messages,
        toolCalls: out.toolCalls,
        virtualize: false,
        height: 900,
      }),
    );
    const margin = [...view.container.querySelectorAll<HTMLElement>("[data-marginalia]")];
    expect(margin.length).toBeGreaterThan(5);
    const toggles = view.container.querySelectorAll<HTMLButtonElement>("button.folio-diff__path");
    expect(toggles).toHaveLength(6);
    expect(toggles[0].getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(toggles[0]);
    expect(toggles[0].getAttribute("aria-expanded")).toBe("true");
    expect(view.container.querySelector(".folio-diff__body")).not.toBeNull();

    const plans = view.container.querySelectorAll('[data-note-kind="plan"] .folio-checklist');
    expect(plans).toHaveLength(3);
    expect(plans[0].querySelectorAll("input[type=checkbox]")).toHaveLength(5);
    expect(view.container.querySelectorAll('[data-note-kind="error"]')).toHaveLength(2);
    expect(view.container.querySelector('[data-tool="Task (general-purpose)"]')).not.toBeNull();
  });
});

// ---- tool shapes outside the heroes (inputs seen in the presentation snapshot) ----

function minimalSession(over: Partial<CSession> = {}): CSession {
  const hero = fixture.heroes["claude-nexus-burst-multiplier"].session;
  return { ...hero, project_root: "/w/proj", ...over };
}
let seqCounter = 0;
function one(name: string, input: unknown, files: string[] = [], output?: unknown, is_error?: boolean) {
  seqCounter += 1;
  const id = `c${seqCounter}`;
  const blocks: ContentBlock[] = [{ type: "tool_call", call_id: id, name, input, files }];
  if (output !== undefined) blocks.push({ type: "tool_result", call_id: id, output, ...(is_error === undefined ? {} : { is_error }) });
  const msg: CMessage = { id: `m${seqCounter}`, seq: 1, role: "assistant", blocks, session_id: "s" };
  const out = fromContract(minimalSession(), [msg]);
  return { call: out.toolCalls[0], note: buildBlocks(out.messages, out.toolCalls).marginalia[0] };
}

describe("other tool shapes", () => {
  it("handles opencode write, Gemini write_file, Cline write_to_file, Cursor create_file", () => {
    for (const [name, input] of [
      ["write", { filePath: "/w/proj/a.ts", content: "x\ny" }],
      ["write_file", { file_path: "/w/proj/a.ts", path: "/w/proj/a.ts", content: "x\ny" }],
      ["write_to_file", { path: "/w/proj/a.ts", content: "x\ny" }],
      ["create_file", { path: "a.ts", content: "x\ny" }],
    ] as const) {
      const { note } = one(name, input);
      expect(note.kind, name).toBe("edit");
      expect(note.edits[0].path, name).toBe("a.ts");
      expect(addedTexts(note), name).toEqual(["x", "y"]);
    }
  });

  it("handles Goose text_editor str_replace and write, ignores view", () => {
    const replace = one("developer__text_editor", { command: "str_replace", path: "/w/proj/e.rs", old_str: "a\nb", new_str: "a\nc" }).note;
    expect(replace.kind).toBe("edit");
    expect(deletedTexts(replace)).toEqual(["b"]);
    expect(addedTexts(replace)).toEqual(["c"]);
    const write = one("developer__text_editor", { command: "write", path: "/w/proj/e.rs", file_text: "k" }).note;
    expect(addedTexts(write)).toEqual(["k"]);
    const view = one("developer__text_editor", { command: "view", path: "/w/proj/e.rs" }, ["/w/proj/e.rs"]).note;
    expect(view.kind).toBe("tool");
    expect(view.edits).toHaveLength(0);
    expect(view.files).toEqual(["e.rs"]);
  });

  it("handles Cursor edit_file with old_str/new_str and with a SEARCH/REPLACE diff that has a header suffix", () => {
    const pair = one("edit_file", { path: "/w/proj/g.glsl", old_str: "a", new_str: "b" }).note;
    expect(deletedTexts(pair)).toEqual(["a"]);
    const blocks = one("edit_file", {
      path: "crates/limiter/src/bucket.rs",
      diff: "<<<<<<< SEARCH FILE crates/limiter/src/bucket.rs\nold1\nkeep\n=======\nnew1\nkeep\n>>>>>>> REPLACE\n<<<<<<< SEARCH\nold2\n=======\nnew2\n>>>>>>> REPLACE",
    }).note;
    expect(blocks.edits).toHaveLength(2);
    expect(deletedTexts(blocks)).toEqual(["old1", "old2"]);
    expect(addedTexts(blocks)).toEqual(["new1", "new2"]);
  });

  it("parses an apply_patch with Add, Delete and Move sections and an object command", () => {
    const patch = [
      "apply_patch <<'EOF'",
      "*** Begin Patch",
      "*** Add File: src/new.rs",
      "+fn a() {}",
      "+",
      "*** Update File: src/old.rs",
      "*** Move to: src/moved.rs",
      "@@ fn keep()",
      " keep",
      "-gone",
      "+here",
      "@@",
      "-second",
      "+SECOND",
      "*** Delete File: src/dead.rs",
      "*** End Patch",
      "EOF",
    ].join("\n");
    for (const input of [patch, { command: patch }, { cmd: patch }]) {
      const { note } = one("command_execution", input);
      expect(note.tool).toBe("apply_patch");
      expect(note.edits.map((e) => e.path)).toEqual(["src/new.rs", "src/moved.rs", "src/dead.rs"]);
      expect(note.files).toEqual(["src/new.rs", "src/moved.rs", "src/dead.rs"]);
      const added = parseUnifiedDiff(note.edits[0].raw);
      expect(added.additions).toBe(2);
      const moved = parseUnifiedDiff(note.edits[1].raw);
      expect(moved.hunks).toHaveLength(2);
      expect(moved.oldPath).toBe("a/src/old.rs");
      expect(moved.newPath).toBe("b/src/moved.rs");
      expect(moved.hunks[0].header).toMatch(/^@@ -1,2 \+1,2 @@/);
    }
  });

  it("never throws on unusable edit inputs and keeps the plain note", () => {
    const weird: [string, unknown][] = [
      ["Edit", { file_path: "/w/proj/a", old_string: 3 }],
      ["Edit", null],
      ["edit", null],
      ["replace_in_file", { path: "/w/proj/a", diff: "no markers here" }],
      ["replace_in_file", { path: "/w/proj/a", diff: 7 }],
      ["MultiEdit", { file_path: "/w/proj/a", edits: "nope" }],
      ["TodoWrite", { todos: "nope" }],
      ["TodoWrite", { todos: [null, 3, {}] }],
      ["command_execution", "apply_patch <<'EOF'\n*** Begin Patch\n*** Update File: x\n"],
      ["command_execution", { command: 12 }],
      ["developer__text_editor", { command: "str_replace", path: "/w/proj/a" }],
    ];
    for (const [name, input] of weird) {
      expect(() => one(name, input), `${name} ${JSON.stringify(input)}`).not.toThrow();
    }
    expect(one("Edit", { file_path: "/w/proj/a", old_string: 3 }).note.kind).toBe("tool");
    expect(one("command_execution", { command: 12 }).note.tool).toBe("command_execution");
    expect(one("TodoWrite", { todos: [null, 3, {}] }).note.kind).toBe("tool");
  });

  it("maps unknown todo statuses to pending and keeps order", () => {
    const { call } = one("TodoWrite", {
      todos: [
        { content: "a", status: "completed" },
        { content: "b", status: "cancelled" },
        { content: "c", status: "in_progress", activeForm: "doing c" },
        { content: "d" },
      ],
    });
    expect(call.items).toEqual([
      { text: "a", done: true, state: "done" },
      { text: "b", done: false, state: "pending" },
      { text: "c", done: false, state: "in_progress" },
      { text: "d", done: false, state: "pending" },
    ]);
  });

  it("does not infer errors from output text when is_error is not true", () => {
    const text = "error[E0308]: mismatched types\nFAILED";
    expect(one("Bash", { command: "x" }, [], text).call.status).toBe("ok");
    expect(one("Bash", { command: "x" }, [], text, false).call.status).toBe("ok");
    expect(one("Bash", { command: "x" }, [], text, true).call.error).toBe("error[E0308]: mismatched types");
  });

  it("picks a meaningful error line and falls back to the first non-empty line", () => {
    expect(one("Bash", { command: "x" }, [], "Exit code 2\nmake: *** [all] Error 2", true).call.error).toBe("make: *** [all] Error 2");
    expect(one("Bash", { command: "x" }, [], "\n\n  plain failure\nmore", true).call.error).toBe("plain failure");
    expect(one("Bash", { command: "x" }, [], "Exit code 1", true).call.error).toBe("Exit code 1");
    expect(one("Bash", { command: "x" }, [], { code: 3 }, true).call.error).toBe('{"code":3}');
  });

  it("does not relativize paths outside the project root", () => {
    expect(one("Read", { file_path: "/elsewhere/a.ts" }).note.files).toEqual(["/elsewhere/a.ts"]);
    expect(one("Read", { file_path: "/w/projx/a.ts" }).note.files).toEqual(["/w/projx/a.ts"]);
    expect(one("Read", { file_path: "/w/proj/a.ts" }).note.files).toEqual(["a.ts"]);
    expect(one("Grep", { target_file: "/w/proj/sub/b.ts", pattern: "p" }).note.files).toEqual(["sub/b.ts"]);
  });

  it("Task without a subagent type keeps the plain name", () => {
    expect(one("Task", { description: "d", prompt: "p" }).note.tool).toBe("Task");
  });
});
