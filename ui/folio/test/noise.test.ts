import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { ContentBlock, Message as CMessage, Session as CSession } from "@armillary/model";
import { fromContract } from "../src/contract";
import { buildBlocks } from "../src/blockify";

const here = dirname(fileURLToPath(import.meta.url));
const fixture = JSON.parse(readFileSync(join(here, "fixtures/heroes.json"), "utf8")) as {
  heroes: Record<string, { session: CSession; messages: CMessage[] }>;
};

function load(id: string) {
  const hero = fixture.heroes[id];
  const out = fromContract(hero.session, hero.messages);
  const plan = buildBlocks(out.messages, out.toolCalls);
  return { hero, out, notes: plan.marginalia };
}

function cSession(): CSession {
  const base = fixture.heroes["claude-skyline-radar-jitter"].session;
  return { ...base, project_root: "/p" };
}

const text = (t: string): ContentBlock => ({ type: "text", text: t });
const call = (id: string, name: string, input: unknown): ContentBlock => ({
  type: "tool_call",
  call_id: id,
  name,
  input,
  files: [],
});
const result = (id: string, output: unknown, is_error?: boolean): ContentBlock => ({
  type: "tool_result",
  call_id: id,
  output,
  ...(is_error === undefined ? {} : { is_error }),
});

function one(name: string, input: unknown, output: unknown, is_error?: boolean) {
  const messages: CMessage[] = [
    { id: "m1", seq: 1, role: "assistant", session_id: "s1", blocks: [text("go"), call("c1", name, input), result("c1", output, is_error)] },
  ];
  const out = fromContract(cSession(), messages);
  const plan = buildBlocks(out.messages, out.toolCalls);
  return { call: out.toolCalls[0], note: plan.marginalia[0], count: out.toolCalls.length };
}

const TODO_OK =
  "Todos have been modified successfully. Ensure that you continue to use the todo list to track your progress. Please proceed with the current tasks if applicable";
const TODOS = { todos: [{ content: "Do it", status: "pending", activeForm: "Doing it" }] };
const WRITE = { file_path: "/p/src/a.ts", content: "export const a = 1;\n" };
const EDIT = { file_path: "/p/src/a.ts", old_string: "a = 1", new_string: "a = 2" };
const EDIT_OK =
  "The file /p/src/a.ts has been updated. Here's the result of running `cat -n` on a snippet of the edited file:\n     1→export const a = 2;\n     2→";

describe("boilerplate results on the hero sessions", () => {
  const { notes, hero } = load("claude-skyline-radar-jitter");

  it("TodoWrite notes show no acknowledgement text", () => {
    const todos = notes.filter((n) => n.tool === "TodoWrite");
    expect(todos).toHaveLength(3);
    for (const n of todos) {
      expect(n.result).toBe("");
      expect(n.result).not.toContain("Todos have been modified");
    }
  });

  it("Write and Edit notes with diffs show no success line or cat -n snippet", () => {
    const edited = notes.filter((n) => (n.tool === "Write" || n.tool === "Edit") && n.edits.length > 0);
    expect(edited.length).toBeGreaterThanOrEqual(5);
    for (const n of edited) {
      expect(n.result).not.toMatch(/File created successfully|has been updated|cat -n/);
      expect(n.result).toBe("");
    }
  });

  it("the Task note has a plain one-line result and the full Markdown in resultMarkdown", () => {
    const task = notes.find((n) => n.tool.startsWith("Task"))!;
    expect(task.result).not.toContain("|");
    expect(task.result).not.toContain("\n");
    expect(task.result.length).toBeGreaterThan(0);
    const raw = hero.messages
      .flatMap((m) => m.blocks)
      .find((b) => b.type === "tool_result" && typeof b.output === "string" && b.output.includes("| file | line | assumes |"));
    expect(raw).toBeDefined();
    expect(task.resultMarkdown).toBe((raw as { output: string }).output);
    expect(task.resultMarkdown).toContain("| src/alerts/cellTracker.ts | 17 |");
  });

  it("keeps the failing and passing Bash results", () => {
    expect(notes.filter((n) => n.tool === "Bash" && n.isError)).toHaveLength(2);
    expect(notes.filter((n) => n.tool === "Bash" && n.result.includes("TileCache.test.ts")).length).toBeGreaterThanOrEqual(1);
  });
});

describe("boilerplate results on the other agents", () => {
  const BOILERPLATE =
    /^Success\. Updated the following files|^Edit applied successfully|^The content was successfully saved to|^File created successfully|^Todos have been modified/;

  it("no hero note keeps a standard acknowledgement as its result", () => {
    for (const id of Object.keys(fixture.heroes)) {
      for (const n of load(id).notes) {
        if (n.isError) continue;
        expect(n.result, `${id} ${n.tool} ${n.seq}`).not.toMatch(BOILERPLATE);
        expect(n.result, `${id} ${n.tool} ${n.seq}`).not.toMatch(/has been updated\. Here's the result/);
      }
    }
  });

  it("the opencode todowrite note does not echo its todos as JSON", () => {
    const todos = load("opencode-zenith-ping-timeout").notes.filter((n) => n.tool === "todowrite");
    expect(todos).toHaveLength(2);
    for (const n of todos) expect(n.result).toBe("");
  });

  it("Codex apply_patch keeps the diff and drops the Success line", () => {
    const patches = load("codex-nexus-bucket-refill").notes.filter((n) => n.tool === "apply_patch");
    expect(patches).toHaveLength(2);
    for (const n of patches) {
      expect(n.edits).toHaveLength(1);
      expect(n.result).toBe("");
    }
  });

  it("an informative result next to a diff is still shown", () => {
    const bash = load("codex-nexus-bucket-refill").notes.filter((n) => n.tool === "command_execution" && n.result !== "");
    expect(bash.length).toBeGreaterThanOrEqual(3);
  });
});

describe("boilerplate rules", () => {
  it.each([
    ["Claude TodoWrite", "TodoWrite", TODOS, TODO_OK],
    ["Claude TodoWrite without the last sentence", "TodoWrite", TODOS, "Todos have been modified successfully."],
    ["Claude Write", "Write", WRITE, "File created successfully at: /p/src/a.ts"],
    ["Claude Edit", "Edit", EDIT, EDIT_OK],
    ["Cline save", "write_to_file", { path: "/p/src/a.ts", content: "x\n" }, "The content was successfully saved to /p/src/a.ts."],
    ["opencode edit", "edit", { filePath: "/p/src/a.ts", oldString: "a = 1", newString: "a = 2" }, "Edit applied successfully."],
  ])("%s", (_label, name, input, output) => {
    const { call: made, note } = one(name, input, output);
    expect(made.result_summary).toBe("");
    expect(note.result).toBe("");
    expect(note.isError).toBe(false);
  });

  it("opencode todowrite JSON of the same todos is dropped", () => {
    const todos = [{ content: "Do it", status: "pending" }];
    const { note } = one("todowrite", { todos }, JSON.stringify(todos));
    expect(note.kind).toBe("plan");
    expect(note.result).toBe("");
  });

  it("Codex apply_patch Success line is dropped only when the note shows that file's diff", () => {
    const patch = "apply_patch <<'EOF'\n*** Begin Patch\n*** Update File: src/a.ts\n@@\n-a = 1\n+a = 2\n*** End Patch\nEOF";
    const shown = one("command_execution", { command: patch }, "Success. Updated the following files:\nM src/a.ts\n");
    expect(shown.note.edits).toHaveLength(1);
    expect(shown.note.result).toBe("");
    const other = one("command_execution", { command: patch }, "Success. Updated the following files:\nM src/other.ts\n");
    expect(other.note.result).toContain("src/other.ts");
    const none = one("command_execution", { command: "echo hi" }, "Success. Updated the following files:\nM src/a.ts\n");
    expect(none.note.result).toContain("Success. Updated the following files");
  });

  it("never suppresses an error result, even one that looks like boilerplate", () => {
    for (const [name, input, output] of [
      ["TodoWrite", TODOS, TODO_OK],
      ["Write", WRITE, "File created successfully at: /p/src/a.ts"],
      ["Edit", EDIT, EDIT_OK],
      ["write_to_file", { path: "/p/a.ts", content: "x" }, "The content was successfully saved to /p/a.ts."],
      ["edit", { filePath: "/p/a.ts", oldString: "a", newString: "b" }, "Edit applied successfully."],
    ] as const) {
      const { call: made, note } = one(name, input, output, true);
      expect(made.status, name).toBe("error");
      expect(made.result_summary, name).not.toBe("");
      expect(note.isError, name).toBe(true);
      expect(note.error, name).toBeTruthy();
    }
  });

  it("keeps the remainder when boilerplate is followed by a warning", () => {
    const write = one("Write", WRITE, "File created successfully at: /p/src/a.ts\n\nwarning: unused variable `a` (lint/no-unused)");
    expect(write.note.result).toBe("warning: unused variable `a` (lint/no-unused)");
    const edit = one("Edit", EDIT, `${EDIT_OK}\n\nLinter: src/a.ts:1:14 error TS2322 type mismatch`);
    expect(edit.note.result).toBe("Linter: src/a.ts:1:14 error TS2322 type mismatch");
    expect(edit.note.result).not.toContain("cat -n");
    const todo = one("TodoWrite", TODOS, `${TODO_OK}\nNote: 2 items are blocked`);
    expect(todo.note.result).toBe("Note: 2 items are blocked");
  });

  it("anchors the patterns: similar text inside other output is kept", () => {
    const text1 = "Todos have been modified successfully, then the lock failed";
    expect(one("TodoWrite", TODOS, text1).note.result).toBe(text1);
    const text2 = "the log says: File created successfully at: /p/x";
    expect(one("Bash", { command: "cat log" }, text2).note.result).toBe(text2);
    const text3 = "Edit applied successfully. 3 of 5 hunks were skipped";
    expect(one("edit", { filePath: "/p/a.ts", oldString: "a", newString: "b" }, text3).note.result).toBe(text3);
  });

  it("does not touch an orphan result", () => {
    const out = fromContract(cSession(), [
      { id: "m1", seq: 1, role: "user", session_id: "s1", blocks: [result("zz", "File created successfully at: /p/x")] },
    ]);
    expect(out.toolCalls[0]).toMatchObject({ name: "Result", result_summary: "File created successfully at: /p/x" });
  });
});

describe("subagent results", () => {
  const task = (output: string, is_error?: boolean) => one("Task", { subagent_type: "general-purpose", description: "d", prompt: "p" }, output, is_error);

  it("turns a leading table into its header cells and a row count", () => {
    const md = "| file | line | assumes |\n|---|---|---|\n| a.ts | 1 | x |\n| b.ts | 2 | y |\n| c.ts | 3 | z |";
    const { call: made, note } = task(md);
    expect(made.result_summary).toBe("file / line / assumes, 3 rows");
    expect(note.result).toBe("file / line / assumes, 3 rows");
    expect(made.resultMarkdown).toBe(md);
    expect(note.resultMarkdown).toBe(md);
  });

  it("says 1 row for a single row", () => {
    expect(task("| a | b |\n|---|---|\n| 1 | 2 |").note.result).toBe("a / b, 1 row");
  });

  it("turns a heading and inline markup into plain text", () => {
    const md = "## Findings for `refresh()`\n\n- **first** point\n- second point";
    const { note } = task(md);
    expect(note.result).toBe("Findings for refresh()");
    expect(note.resultMarkdown).toBe(md);
  });

  it("skips blank lines and rules before the first meaningful line", () => {
    expect(task("\n\n---\n\n# Done\nbody").note.result).toBe("Done");
  });

  it("does not add resultMarkdown when the summary already is the whole result", () => {
    const { call: made, note } = task("All three callers are fine.");
    expect(note.result).toBe("All three callers are fine.");
    expect(made.resultMarkdown).toBeUndefined();
    expect(note.resultMarkdown).toBeUndefined();
  });

  it("leaves an error result alone", () => {
    const { call: made, note } = task("| a | b |\n|---|---|\n| 1 | 2 |", true);
    expect(made.status).toBe("error");
    expect(made.resultMarkdown).toBeUndefined();
    expect(note.isError).toBe(true);
  });

  it("does not rewrite a table printed by another tool", () => {
    const md = "| a | b |\n|---|---|\n| 1 | 2 |";
    const { call: made, note } = one("Bash", { command: "cat t.md" }, md);
    expect(made.resultMarkdown).toBeUndefined();
    expect(note.resultMarkdown).toBeUndefined();
    expect(note.result).toBe(md);
  });

  it("keeps the summary within the result limit", () => {
    const { note } = task(`${"word ".repeat(100)}\n\n| a | b |\n|---|---|\n| 1 | 2 |`);
    expect(note.result.length).toBeLessThanOrEqual(240);
  });
});
