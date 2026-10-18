import { createElement } from "react";
import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { Session as CSession, Message as CMessage, ContentBlock } from "@armillary/model";
import { anchorSeqFor, fromContract } from "../src/contract";
import { buildBlocks } from "../src/blockify";
import { Folio } from "../src/Folio";
import { exportMarkdown } from "../src/export";
import { parseMarkdown } from "../src/markdown";

function cSession(over: Partial<CSession> = {}): CSession {
  return {
    agent_id: "claude",
    id: "s1",
    provenance: {
      adapter_id: "test",
      adapter_version: "1",
      checkpoint: { digest: "d", offset: 0, records: 0, revision: 1 },
      file_identity: "f",
      generation: 1,
      source_id: "src",
      source_path: "a.jsonl",
      store: { canonical_root: "fixture://root", id: "st", namespace: "ns", profile_id: "p" },
    },
    status: "unknown",
    turns: 1,
    usage: { observations: [], semantics: "unknown" },
    ...over,
  };
}

function cMsg(seq: number, role: string, blocks: ContentBlock[], at?: number | null): CMessage {
  return { id: `msg-${seq}`, seq, role, blocks, session_id: "s1", ...(at === undefined ? {} : { at }) };
}

const text = (t: string): ContentBlock => ({ type: "text", text: t });
const call = (id: string, name: string, input: unknown, files: string[] = []): ContentBlock => ({
  type: "tool_call",
  call_id: id,
  name,
  input,
  files,
});
const result = (id: string, output: unknown, is_error?: boolean): ContentBlock => ({
  type: "tool_result",
  call_id: id,
  output,
  ...(is_error === undefined ? {} : { is_error }),
});

function renderContract(s: CSession, m: CMessage[], extra: { anchorSeq?: number | null } = {}) {
  const out = fromContract(s, m);
  const node = (anchorSeq?: number | null) =>
    createElement(Folio, {
      session: out.session,
      messages: out.messages,
      toolCalls: out.toolCalls,
      virtualize: false,
      height: 900,
      anchorSeq,
    });
  const view = render(node(extra.anchorSeq));
  return { ...view, out, again: (anchorSeq: number | null) => view.rerender(node(anchorSeq)) };
}

describe("fromContract: session", () => {
  it("copies identity fields and keeps nulls null", () => {
    const { session } = fromContract(
      cSession({ project_root: "/p", title: "T", started_at: 10, ended_at: 20, model: "m", turns: 3, parent_id: null }),
      [],
    );
    expect(session).toMatchObject({
      id: "s1",
      agent_id: "claude",
      project_root: "/p",
      title: "T",
      started_at: 10,
      ended_at: 20,
      model: "m",
      turns: 3,
      parent_id: null,
    });
    const bare = fromContract(cSession(), []).session;
    expect(bare.project_root).toBeNull();
    expect(bare.title).toBeNull();
    expect(bare.started_at).toBeNull();
    expect(bare.ended_at).toBeNull();
    expect(bare.model).toBeNull();
    expect(bare.parent_id).toBeNull();
  });

  it("keeps unknown usage null and an explicit zero as zero", () => {
    expect(fromContract(cSession(), []).session).toMatchObject({ tokens_in: null, tokens_out: null });
    const zero = fromContract(cSession({ usage: { input_tokens: 0, output_tokens: 0, observations: [], semantics: "cumulative" } }), []);
    expect(zero.session).toMatchObject({ tokens_in: 0, tokens_out: 0 });
    const half = fromContract(cSession({ usage: { input_tokens: 7, output_tokens: null, observations: [], semantics: "cumulative" } }), []);
    expect(half.session).toMatchObject({ tokens_in: 7, tokens_out: null });
  });

  it("maps status onto the Folio union", () => {
    const status = (value: string) => fromContract(cSession({ status: value }), []).session.status;
    for (const keep of ["working", "waiting", "idle", "done", "unknown"]) expect(status(keep)).toBe(keep);
    for (const done of ["completed", "complete", "ended", "finished"]) expect(status(done)).toBe("done");
    expect(status("exploded")).toBe("unknown");
    expect(status("")).toBe("unknown");
  });
});

describe("fromContract: message text", () => {
  it("joins text, code and checklist blocks in order with blank lines", () => {
    const { messages } = fromContract(cSession(), [
      cMsg(1, "assistant", [
        text("Intro"),
        { type: "code", code: "const a = 1;", language: "ts" },
        { type: "checklist", items: [{ checked: true, text: "done" }, { checked: false, text: "multi\nline" }] },
        text("Outro"),
      ], 500),
    ]);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({ session_id: "s1", seq: 1, role: "assistant", at: 500 });
    expect(messages[0].text).toBe(
      "Intro\n\n```ts\nconst a = 1;\n```\n\n- [x] done\n- [ ] multi line\n\nOutro",
    );
  });

  it("drops a language that is not plain and omits it when absent", () => {
    const one = (language: string | null | undefined) =>
      fromContract(cSession(), [cMsg(1, "assistant", [{ type: "code", code: "x", language }])]).messages[0].text;
    expect(one("c++")).toBe("```c++\nx\n```");
    expect(one("type script")).toBe("```\nx\n```");
    expect(one("ts\n```")).toBe("```\nx\n```");
    expect(one(null)).toBe("```\nx\n```");
    expect(one(undefined)).toBe("```\nx\n```");
  });

  it("cannot be broken out of by a fence line inside code", () => {
    const code = "line one\n```\n## not a heading\n```js\nline last";
    const { messages } = fromContract(cSession(), [
      cMsg(1, "assistant", [text("before"), { type: "code", code, language: "sh" }, text("after")]),
    ]);
    const blocks = parseMarkdown(messages[0].text);
    expect(blocks.map((b) => b.type)).toEqual(["paragraph", "code", "paragraph"]);
    const fenced = blocks[1];
    expect(fenced.type === "code" && fenced.lang).toBe("sh");
    expect(fenced.type === "code" && fenced.text).toBe("line one\n ```\n## not a heading\n ```js\nline last");
    // the lines are only indented, nothing else is changed
    expect(fenced.type === "code" && fenced.text.replace(/^ ```/gm, "```")).toBe(code);
  });

  it("also keeps a trailing-space fence line inside the fence", () => {
    const { messages } = fromContract(cSession(), [cMsg(1, "assistant", [{ type: "code", code: "a\n```  \nb" }])]);
    const blocks = parseMarkdown(messages[0].text);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].type).toBe("code");
  });

  it("keeps user and system roles and maps every other role to assistant", () => {
    const roles = fromContract(cSession(), [
      cMsg(1, "user", [text("a")]),
      cMsg(2, "system", [text("b")]),
      cMsg(3, "assistant", [text("c")]),
      cMsg(4, "tool", [text("d")]),
      cMsg(5, "weird", [text("e")]),
    ]).messages.map((m) => m.role);
    expect(roles).toEqual(["user", "system", "assistant", "assistant", "assistant"]);
  });

  it("processes messages in seq order and keeps an unknown time null", () => {
    const { messages } = fromContract(cSession(), [
      cMsg(3, "assistant", [text("third")], null),
      cMsg(1, "user", [text("first")], 100),
      cMsg(2, "assistant", [text("second")]),
    ]);
    expect(messages.map((m) => m.seq)).toEqual([1, 2, 3]);
    expect(messages.map((m) => m.at)).toEqual([100, null, null]);
  });

  it("yields no Folio message for a message without body text", () => {
    const { messages, toolCalls } = fromContract(cSession(), [
      cMsg(1, "user", [text("hello")]),
      cMsg(2, "assistant", [call("c1", "Bash", { command: "ls" })]),
      cMsg(3, "user", [result("c1", "ok")]),
      cMsg(4, "assistant", [{ type: "attachment", reference: "file:///x/a.png" }]),
      cMsg(5, "assistant", [{ type: "error", message: "boom" }]),
    ]);
    expect(messages.map((m) => m.seq)).toEqual([1]);
    expect(toolCalls).toHaveLength(3);
  });

  it("renders no row for tool-only messages", () => {
    const view = renderContract(cSession(), [
      cMsg(1, "user", [text("Run it")]),
      cMsg(2, "assistant", [call("c1", "Bash", { command: "ls" })]),
      cMsg(3, "user", [result("c1", "ok")]),
      cMsg(4, "assistant", [text("Done")]),
    ]);
    const rows = [...view.container.querySelectorAll<HTMLElement>("[data-message-index]")];
    expect(rows.map((r) => r.dataset.seq)).toEqual(["1", "4"]);
    expect(view.container.querySelectorAll(".folio-prompt")).toHaveLength(1);
  });
});

describe("fromContract: marginal notes", () => {
  it("correlates a call with its inline result into one note", () => {
    const { toolCalls } = fromContract(cSession(), [
      cMsg(2, "assistant", [text("Running"), call("c1", "Bash", { command: "ls -la" }, ["/p/a.txt"]), result("c1", "file.txt")], 900),
    ]);
    expect(toolCalls).toHaveLength(1);
    expect(toolCalls[0]).toMatchObject({
      session_id: "s1",
      seq: 2,
      name: "Bash",
      input_summary: "ls -la",
      result_summary: "file.txt",
      files: ["/p/a.txt"],
      status: "ok",
      at: 900,
    });
  });

  it("correlates a later result in a later tool-only user message with the earlier call", () => {
    const { messages, toolCalls } = fromContract(cSession(), [
      cMsg(1, "user", [text("go")]),
      cMsg(2, "assistant", [call("c1", "Read", { file_path: "/p/a.ts" })]),
      cMsg(3, "user", [result("c1", { lines: 3 })]),
    ]);
    expect(messages.map((m) => m.seq)).toEqual([1]);
    expect(toolCalls).toHaveLength(1);
    expect(toolCalls[0]).toMatchObject({ seq: 2, name: "Read", input_summary: "/p/a.ts", result_summary: '{"lines":3}', status: "ok" });
  });

  it("pairs by call id, never by position", () => {
    const { toolCalls } = fromContract(cSession(), [
      cMsg(1, "assistant", [call("a", "One", { command: "one" }), call("b", "Two", { command: "two" })]),
      cMsg(2, "user", [result("b", "result b"), result("a", "result a")]),
    ]);
    expect(toolCalls.map((t) => [t.name, t.result_summary])).toEqual([
      ["One", "result a"],
      ["Two", "result b"],
    ]);
  });

  it("gives an orphan result its own Result note at its own seq", () => {
    const { toolCalls } = fromContract(cSession(), [
      cMsg(1, "assistant", [call("a", "Bash", { command: "ls" })]),
      cMsg(5, "user", [result("never-seen", "stray output")]),
    ]);
    expect(toolCalls).toHaveLength(2);
    expect(toolCalls[0]).toMatchObject({ name: "Bash", result_summary: "" });
    expect(toolCalls[1]).toMatchObject({ name: "Result", seq: 5, result_summary: "stray output", status: "ok" });
    const bad = fromContract(cSession(), [cMsg(5, "user", [result("zz", "nope", true)])]).toolCalls;
    expect(bad).toHaveLength(1);
    expect(bad[0]).toMatchObject({ name: "Result", status: "error" });
  });

  it("does not pair a result that comes before its call", () => {
    const { toolCalls } = fromContract(cSession(), [
      cMsg(1, "user", [result("c1", "early")]),
      cMsg(2, "assistant", [call("c1", "Bash", { command: "ls" })]),
    ]);
    expect(toolCalls.map((t) => t.name)).toEqual(["Result", "Bash"]);
    expect(toolCalls[1].result_summary).toBe("");
  });

  it("marks an erroring result as an error note", () => {
    const { toolCalls } = fromContract(cSession(), [
      cMsg(1, "assistant", [call("c1", "Bash", { command: "false" }), result("c1", "exit status 1", true)]),
    ]);
    expect(toolCalls[0]).toMatchObject({ status: "error", error: "exit status 1", result_summary: "exit status 1" });
    const plan = buildBlocks(
      [{ session_id: "s1", seq: 1, role: "assistant", text: "x", at: null }],
      toolCalls,
    );
    expect(plan.marginalia[0]).toMatchObject({ kind: "error", isError: true });
  });

  it("summarises input by preferred key, then compact JSON", () => {
    const summary = (input: unknown) =>
      fromContract(cSession(), [cMsg(1, "assistant", [call("c", "T", input)])]).toolCalls[0].input_summary;
    expect(summary({ path: "/p", command: "make" })).toBe("make");
    expect(summary({ url: "http://x", query: "q" })).toBe("q");
    expect(summary({ description: "d", pattern: "p" })).toBe("p");
    expect(summary({ file_path: "/f", path: "/g" })).toBe("/f");
    expect(summary({ cmd: "c1", file_path: "/f" })).toBe("c1");
    expect(summary({ a: 1, b: [2] })).toBe('{"a":1,"b":[2]}');
    expect(summary(null)).toBe("null");
    expect(summary({ command: "line1\nline2" })).toBe("line1 line2");
  });

  it("cuts long summaries on a word boundary with three dots", () => {
    const long = Array.from({ length: 100 }, (_, i) => `word${i}`).join(" ");
    const input = fromContract(cSession(), [cMsg(1, "assistant", [call("c", "T", { command: long }), result("c", long)])]).toolCalls[0];
    for (const [value, max] of [[input.input_summary, 160], [input.result_summary, 240]] as const) {
      expect(value.length).toBeLessThanOrEqual(max);
      expect(value.length).toBeGreaterThan(max - 30);
      expect(value.endsWith("...")).toBe(true);
      expect(value).not.toContain("…");
      const kept = value.slice(0, -3);
      expect(long.startsWith(kept)).toBe(true);
      expect(long[kept.length]).toBe(" ");
    }
    const short = fromContract(cSession(), [cMsg(1, "assistant", [call("c", "T", { command: "short" })])]).toolCalls[0];
    expect(short.input_summary).toBe("short");
  });

  it("attaches display edits for Edit, MultiEdit and Write inputs", () => {
    const edit = fromContract(cSession(), [
      cMsg(1, "assistant", [call("e", "Edit", { file_path: "/p/a.ts", old_string: "a", new_string: "b" })]),
    ]).toolCalls[0];
    expect(edit.edits).toEqual([{ path: "/p/a.ts", before: "a", after: "b" }]);

    const multi = fromContract(cSession(), [
      cMsg(1, "assistant", [
        call("m", "MultiEdit", {
          file_path: "/p/a.ts",
          edits: [
            { old_string: "a", new_string: "b" },
            { old_string: "c", new_string: "d" },
          ],
        }),
      ]),
    ]).toolCalls[0];
    expect(multi.edits).toEqual([
      { path: "/p/a.ts", before: "a", after: "b" },
      { path: "/p/a.ts", before: "c", after: "d" },
    ]);

    const write = fromContract(cSession(), [
      cMsg(1, "assistant", [call("w", "Write", { file_path: "/p/n.ts", content: "hello" })]),
    ]).toolCalls[0];
    expect(write.edits).toEqual([{ path: "/p/n.ts", after: "hello" }]);

    const plain = fromContract(cSession(), [cMsg(1, "assistant", [call("r", "Read", { file_path: "/p/n.ts" })])]).toolCalls[0];
    expect(plain.edits).toBeUndefined();
  });

  it("turns an edit block into an Edit note and omits null fields", () => {
    const { toolCalls } = fromContract(cSession(), [
      cMsg(4, "assistant", [
        { type: "edit", path: "/p/a.ts", before: "x", after: "y", diff: null },
        { type: "edit", path: "/p/b.ts", diff: "--- a\n+++ b" },
      ]),
    ]);
    expect(toolCalls).toHaveLength(2);
    expect(toolCalls[0]).toMatchObject({ name: "Edit", seq: 4, files: ["/p/a.ts"] });
    expect(toolCalls[0].edits).toStrictEqual([{ path: "/p/a.ts", before: "x", after: "y" }]);
    expect(toolCalls[1].edits).toStrictEqual([{ path: "/p/b.ts", diff: "--- a\n+++ b" }]);
  });

  it("turns an error block into an error note", () => {
    const { toolCalls } = fromContract(cSession(), [
      cMsg(2, "assistant", [
        { type: "error", message: "rate limited", code: "429" },
        { type: "error", message: "plain" },
      ]),
    ]);
    expect(toolCalls[0]).toMatchObject({ name: "Error", status: "error", error: "429: rate limited", input_summary: "", result_summary: "" });
    expect(toolCalls[1]).toMatchObject({ name: "Error", status: "error", error: "plain" });
  });

  it("keeps an attachment as plain margin text and never as markdown", () => {
    const ref = "file:///Users/x/shots/screen.png";
    const messages: CMessage[] = [
      cMsg(1, "user", [text("look at this"), { type: "attachment", reference: ref, label: "screen.png", mime_type: "image/png" }]),
      cMsg(2, "assistant", [{ type: "attachment", reference: "s3://bucket/key" }]),
    ];
    const out = fromContract(cSession(), messages);
    expect(out.messages).toHaveLength(1);
    expect(out.messages[0].text).toBe("look at this");
    expect(out.toolCalls[0]).toMatchObject({
      name: "Attachment",
      seq: 1,
      input_summary: "screen.png",
      result_summary: "image/png, reference only, not opened",
      files: [ref],
    });
    expect(out.toolCalls[1]).toMatchObject({
      name: "Attachment",
      input_summary: "attachment",
      result_summary: "unknown type, reference only, not opened",
      files: ["s3://bucket/key"],
    });
    for (const m of out.messages) {
      expect(m.text).not.toContain(ref);
      expect(m.text).not.toMatch(/!\[|\]\(/);
    }

    const view = renderContract(cSession(), messages);
    expect(view.container.querySelector(".folio-page")!.querySelector("img, a, iframe, object, embed, video, audio")).toBeNull();
    const note = view.container.querySelector("[data-tool='Attachment']") as HTMLElement;
    expect(note.textContent).toContain(ref);
    expect(view.container.querySelector("[data-folio-scroll] .folio-body")!.textContent).not.toContain(ref);
  });

  it("anchors notes under the message they happened under or the nearest earlier one", () => {
    const { messages, toolCalls } = fromContract(cSession(), [
      cMsg(1, "user", [text("go")]),
      cMsg(3, "assistant", [call("c", "Bash", { command: "ls" })]),
      cMsg(5, "assistant", [text("done")]),
    ]);
    const plan = buildBlocks(messages, toolCalls);
    expect(plan.marginalia[0]).toMatchObject({ seq: 3, anchorSeq: 1 });
    const early = fromContract(cSession(), [
      cMsg(1, "assistant", [call("c", "Bash", { command: "ls" })]),
      cMsg(2, "user", [text("later")]),
    ]);
    expect(buildBlocks(early.messages, early.toolCalls).marginalia[0]).toMatchObject({ anchorSeq: 2 });
  });

  it("exports redacted markdown for a contract session with unknowns", () => {
    const out = fromContract(cSession(), [cMsg(1, "user", [text("hi")])]);
    const md = exportMarkdown(out, { redact: false });
    expect(md).toContain("# Untitled session");
    expect(md).toContain("model unknown");
    expect(md).toContain("tokens unknown");
    expect(md).toContain("duration unknown");
    expect(md).not.toMatch(/\bnull\b|\bNaN\b|\b0 in\b/);
  });
});

describe("rendered Folio with unknowns", () => {
  it("says unknown in header and footer instead of printing zero", () => {
    const view = renderContract(cSession(), [cMsg(1, "user", [text("hi")])]);
    expect(view.container.querySelector(".folio-head__title")!.textContent).toBe("Untitled session");
    expect(view.container.querySelector(".folio-head__meta")!.textContent).toContain("model unknown");
    const foot = view.container.querySelector(".folio-foot")!;
    expect(foot.querySelector(".folio-foot__count")!.textContent).toBe("tokens unknown");
    expect(foot.querySelector(".folio-foot__model")!.textContent).toBe("model unknown");
    expect(foot.textContent).toContain("duration unknown");
    expect(foot.textContent).not.toMatch(/\bnull\b|NaN/);
  });

  it("says tokens unknown when only one count is known", () => {
    const view = renderContract(
      cSession({ usage: { input_tokens: 5, output_tokens: null, observations: [], semantics: "cumulative" } }),
      [cMsg(1, "user", [text("hi")])],
    );
    expect(view.container.querySelector(".folio-foot__count")!.textContent).toBe("tokens unknown");
  });

  it("prints an explicit zero as zero and known values as before", () => {
    const view = renderContract(
      cSession({
        title: "Real title",
        model: "claude-x",
        started_at: 1_000,
        ended_at: 1_000 + 5 * 60_000,
        usage: { input_tokens: 0, output_tokens: 1234, observations: [], semantics: "cumulative" },
      }),
      [cMsg(1, "user", [text("hi")])],
    );
    expect(view.container.querySelector(".folio-head__title")!.textContent).toBe("Real title");
    expect(view.container.querySelector(".folio-foot__count")!.textContent).toBe("0 in / 1,234 out");
    expect(view.container.querySelector(".folio-foot__model")!.textContent).toBe("claude-x");
    expect(view.container.querySelector(".folio-foot")!.textContent).toContain("5 min");
  });
});

describe("anchorSeq", () => {
  const messages = [
    cMsg(1, "user", [text("one")]),
    cMsg(3, "assistant", [text("three")]),
    cMsg(5, "user", [text("five")]),
    cMsg(7, "assistant", [text("seven")]),
  ];
  const current = (root: HTMLElement) =>
    [...root.querySelectorAll<HTMLElement>("[data-current='true']")].map((n) => n.dataset.seq);

  it("anchorSeqFor returns the seq of a message id or null", () => {
    expect(anchorSeqFor(messages, "msg-5")).toBe(5);
    expect(anchorSeqFor(messages, "nope")).toBeNull();
    expect(anchorSeqFor([], "msg-5")).toBeNull();
  });

  it("marks the row whose seq is the anchor as current on mount", () => {
    const view = renderContract(cSession(), messages, { anchorSeq: 5 });
    expect(current(view.container)).toEqual(["5"]);
  });

  it("falls back to the nearest earlier row when the anchor has no row", () => {
    const view = renderContract(cSession(), messages, { anchorSeq: 6 });
    expect(current(view.container)).toEqual(["5"]);
  });

  it("uses the first row when the anchor is before every row", () => {
    const view = renderContract(cSession(), messages, { anchorSeq: 0 });
    expect(current(view.container)).toEqual(["1"]);
  });

  it("follows the anchor when it changes", () => {
    const view = renderContract(cSession(), messages, { anchorSeq: 3 });
    expect(current(view.container)).toEqual(["3"]);
    view.again(7);
    expect(current(view.container)).toEqual(["7"]);
    view.again(4);
    expect(current(view.container)).toEqual(["3"]);
  });

  it("leaves the default current row alone when no anchor is given", () => {
    const view = renderContract(cSession(), messages);
    expect(current(view.container)).toEqual(["1"]);
  });
});
