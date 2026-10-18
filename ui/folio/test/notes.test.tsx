import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { act, render, screen, within } from "@testing-library/react";
import { Folio } from "../src/index";
import { Marginalia } from "../src/components/Marginalia";
import { Row } from "../src/components/Row";
import { planOf } from "../src/blockify";
import { buildFind, EMPTY_FIND } from "../src/find";
import { FOLIO_CSS } from "../src/styles/stylesheet";
import { exportHtml } from "../src/export";
import { MAX_NOTE_DRIFT, planSidenotes } from "../src/components/sidenotes";
import { makeLongSession } from "../src/data/makeLongSession";
import type { NormalizedSession, ToolCall } from "../src/types";
import { user } from "./user";

const base = { session_id: "s-notes", input_summary: "", result_summary: "", files: [] as string[] };

function sessionWith(calls: Partial<ToolCall>[], messageCount = 3): NormalizedSession {
  const messages = Array.from({ length: messageCount }, (_, index) => ({
    session_id: "s-notes",
    seq: index * 10,
    role: index % 2 === 0 ? ("user" as const) : ("assistant" as const),
    text: index % 2 === 0 ? `Task ${index}\n\nBody of the task.` : `Reply number ${index}.`,
    at: null,
  }));
  return {
    session: {
      id: "s-notes",
      agent_id: "claude-code",
      project_root: null,
      title: "Notes",
      started_at: null,
      ended_at: null,
      model: null,
      status: "done",
      turns: 1,
      tokens_in: null,
      tokens_out: null,
      parent_id: null,
    },
    messages,
    toolCalls: calls.map((call, index) => ({ ...base, seq: index * 10 + 1, name: "Bash", ...call })),
  };
}

function noteOf(call: Partial<ToolCall>) {
  return planOf(sessionWith([call])).marginalia[0];
}

// ---- geometry stubs (jsdom has no layout) ----
let textOverflows = false;
const heights: Record<string, number> = {};
const originals: Record<string, PropertyDescriptor | undefined> = {};

function stubGeometry() {
  const proto = HTMLElement.prototype;
  for (const key of ["scrollHeight", "clientHeight", "offsetTop", "offsetHeight"]) {
    originals[key] = Object.getOwnPropertyDescriptor(proto, key);
  }
  originals.rect = Object.getOwnPropertyDescriptor(Element.prototype, "getBoundingClientRect");
  Object.defineProperty(proto, "scrollHeight", {
    configurable: true,
    get(this: HTMLElement) {
      return this.classList.contains("folio-note__text") ? 120 : 0;
    },
  });
  Object.defineProperty(proto, "clientHeight", {
    configurable: true,
    get(this: HTMLElement) {
      return this.classList.contains("folio-note__text") ? (textOverflows ? 70 : 120) : 0;
    },
  });
  Object.defineProperty(proto, "offsetTop", {
    configurable: true,
    get(this: HTMLElement) {
      return this.classList.contains("folio-margin") ? 14 : 0;
    },
  });
  Object.defineProperty(proto, "offsetHeight", {
    configurable: true,
    get(this: HTMLElement) {
      return this.classList.contains("folio-row") ? 100 : this.classList.contains("folio-margin") ? marginHeight(this) : 0;
    },
  });
  Element.prototype.getBoundingClientRect = function (this: Element) {
    const el = this as HTMLElement;
    let top = 0;
    let height = 0;
    if (el.classList.contains("folio-row")) {
      top = Number(el.dataset.messageIndex) * 100 + pushedBy(el);
      height = 100;
    } else if (el.classList.contains("folio-margin")) {
      height = marginHeight(el);
    } else if (el.classList.contains("folio-page")) {
      height = 300;
    }
    return { x: 0, y: top, top, left: 0, right: 0, bottom: top + height, width: 0, height, toJSON: () => ({}) } as DOMRect;
  };
}

/** What a browser does with a row's extra top margin: it and every row after it move down. */
function pushedBy(row: HTMLElement): number {
  let total = 0;
  for (const sibling of Array.from(row.parentElement?.children ?? [])) {
    total += parseFloat((sibling as HTMLElement).style.getPropertyValue("--note-push")) || 0;
    if (sibling === row) break;
  }
  return total;
}

function marginHeight(margin: HTMLElement): number {
  const row = margin.closest<HTMLElement>(".folio-row");
  return heights[row?.dataset.messageIndex ?? ""] ?? 0;
}

function restoreGeometry() {
  const proto = HTMLElement.prototype;
  for (const key of ["scrollHeight", "clientHeight", "offsetTop", "offsetHeight"]) {
    if (originals[key]) Object.defineProperty(proto, key, originals[key]!);
    else delete (proto as unknown as Record<string, unknown>)[key];
  }
  if (originals.rect) Object.defineProperty(Element.prototype, "getBoundingClientRect", originals.rect);
}

beforeEach(() => {
  textOverflows = false;
  for (const key of Object.keys(heights)) delete heights[key];
});
afterEach(() => restoreGeometry());

function shifts(container: HTMLElement): (string | null)[] {
  return [...container.querySelectorAll<HTMLElement>(".folio-margin")].map((margin) =>
    margin.childElementCount === 0 ? null : margin.style.getPropertyValue("--note-shift"),
  );
}

function pushes(container: HTMLElement): number[] {
  return [...container.querySelectorAll<HTMLElement>(".folio-row")].map(
    (row) => parseFloat(row.style.getPropertyValue("--note-push")) || 0,
  );
}

function renderSession(session: NormalizedSession, props: { virtualize?: boolean | "auto"; height?: number } = {}) {
  return render(
    <Folio
      session={session.session}
      messages={session.messages}
      toolCalls={session.toolCalls}
      theme="dark"
      virtualize={props.virtualize ?? false}
      height={props.height ?? 900}
      showContents={false}
    />,
  );
}

async function relayout() {
  await act(async () => {
    window.dispatchEvent(new Event("resize"));
  });
}

describe("sidenote layout: styles", () => {
  const margin = FOLIO_CSS.match(/\n\.folio-row--sidenotes \.folio-margin \{[^}]*\}/)?.[0] ?? "";
  const narrow = FOLIO_CSS.slice(FOLIO_CSS.indexOf("@media (max-width: 960px)"));

  it("takes the margin out of flow so a tall note cannot stretch its row", () => {
    expect(margin).toMatch(/position: absolute;/);
    expect(margin).toMatch(/width: var\(--margin-width\)/);
    expect(margin).toMatch(/transform: translateY\(var\(--note-shift, 0px\)\)/);
  });

  it("keeps the notes in flow on a narrow screen", () => {
    expect(narrow).toMatch(/\.folio-row--sidenotes \.folio-margin \{[^}]*position: static;[^}]*transform: none;/);
  });

  it("lets the page grow a bottom padding for the last note group", () => {
    expect(FOLIO_CSS).toMatch(/\.folio-page \{[\s\S]*?padding: 36px 0 calc\(28px \+ var\(--note-overflow, 0px\)\);/);
  });

  it("styles the more toggle as quiet gilt Instrument Sans 12 px text, underlined on hover", () => {
    expect(FOLIO_CSS).toMatch(/\.folio-note__more \{[^}]*font-family: var\(--font-body\);[^}]*font-size: 12px;[^}]*color: var\(--page-gilt\);/);
    expect(FOLIO_CSS).toMatch(/\.folio-note__more:hover \{[^}]*text-decoration: underline;/);
  });

  it("clamps note text to four lines and caps an open diff at about sixteen lines", () => {
    expect(FOLIO_CSS).toMatch(/\.folio-note__text \{[^}]*-webkit-line-clamp: 4;/);
    expect(FOLIO_CSS).toMatch(/\.folio-note__text--open \{[^}]*-webkit-line-clamp: unset;/);
    expect(FOLIO_CSS).toMatch(/\.folio-diff__body--scroll \{[^}]*max-height: calc\(16 \* 1\.5 \* 12px \+ 12px\);[^}]*overflow-y: auto;/);
  });
});

describe("compact notes", () => {
  it("clamps the note text but shows no toggle while everything fits", () => {
    render(<Marginalia compact note={noteOf({ input_summary: "ls", result_summary: "short" })} />);
    expect(document.querySelector(".folio-note__text")).not.toBeNull();
    expect(screen.queryByRole("button", { name: /Show (more|less) of/ })).toBeNull();
  });

  it("offers a toggle only when the text really overflows the clamp", async () => {
    textOverflows = true;
    stubGeometry();
    render(<Marginalia compact note={noteOf({ name: "Grep", result_summary: "line ".repeat(200) })} />);
    const toggle = screen.getByRole("button", { name: "Show more of Grep" });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(document.querySelector(".folio-note__text")).not.toHaveClass("folio-note__text--open");

    await user.click(toggle);
    const opened = screen.getByRole("button", { name: "Show less of Grep" });
    expect(opened).toHaveAttribute("aria-expanded", "true");
    expect(document.querySelector(".folio-note__text")).toHaveClass("folio-note__text--open");

    await user.click(opened);
    expect(screen.getByRole("button", { name: "Show more of Grep" })).toHaveAttribute("aria-expanded", "false");
  });

  it("rechecks the overflow when the window is resized", async () => {
    stubGeometry();
    render(<Marginalia compact note={noteOf({ result_summary: "line ".repeat(200) })} />);
    expect(screen.queryByRole("button", { name: /Show more of/ })).toBeNull();
    textOverflows = true;
    await relayout();
    expect(screen.getByRole("button", { name: "Show more of Bash" })).toBeInTheDocument();
  });

  it("shows the first three files and folds the rest into the toggle", async () => {
    const files = ["a.ts", "b.ts", "c.ts", "d.ts", "e.ts"];
    render(<Marginalia compact note={noteOf({ name: "Read", files })} />);
    const list = document.querySelector(".folio-note__files") as HTMLElement;
    expect(within(list).getAllByRole("listitem").map((li) => li.textContent)).toEqual(["a.ts", "b.ts", "c.ts"]);
    const toggle = screen.getByRole("button", { name: "Show +2 more of Read" });
    expect(toggle).toHaveTextContent("+2 more");
    await user.click(toggle);
    expect(within(list).getAllByRole("listitem")).toHaveLength(5);
    expect(screen.getByRole("button", { name: "Show less of Read" })).toBeInTheDocument();
  });

  it("shows up to five checklist items and keeps the rest behind the toggle", async () => {
    const items = Array.from({ length: 8 }, (_, index) => ({ text: `Step ${index + 1}`, done: index < 2 }));
    render(<Marginalia compact note={noteOf({ name: "TodoWrite", items })} />);
    expect(screen.getAllByRole("checkbox", { hidden: true })).toHaveLength(5);
    await user.click(screen.getByRole("button", { name: "Show +3 more of TodoWrite" }));
    expect(screen.getAllByRole("checkbox", { hidden: true })).toHaveLength(8);
  });

  it("opens a note by itself when a search hit sits in the hidden part", () => {
    const files = ["a.ts", "b.ts", "c.ts", "d.ts", "needle-file.ts"];
    const plan = planOf(sessionWith([{ name: "Read", files }]));
    const find = buildFind(plan, "needle", 0);
    expect(find.matches.length).toBeGreaterThan(0);
    render(<Marginalia compact note={plan.marginalia[0]} find={find} />);
    expect(document.querySelector(".folio-note__files")?.querySelectorAll("li")).toHaveLength(5);
  });

  it("is not compact in a static export: nothing clamped, nothing folded, no toggle", () => {
    const session = sessionWith([{ name: "Read", result_summary: "r ".repeat(100), files: ["a", "b", "c", "d", "e"] }]);
    const html = exportHtml(session, { redact: false, theme: "dark" });
    expect(html).not.toContain('class="folio-note__text');
    expect(html).not.toContain('class="folio-note__more"');
    expect(html.match(/<li><span>[a-e]<\/span><\/li>/g)).toHaveLength(5);
  });

  it("caps an open diff with its own focusable, named scroll group", async () => {
    const lines = Array.from({ length: 40 }, (_, index) => `+line ${index}`).join("\n");
    render(
      <Marginalia
        compact
        note={noteOf({ name: "Edit", edits: [{ path: "src/app.ts", diff: `--- a/src/app.ts\n+++ b/src/app.ts\n@@ -1 +1,40 @@\n${lines}` }] })}
      />,
    );
    await user.click(screen.getByRole("button", { name: /diff for app\.ts/i }));
    const region = screen.getByRole("group", { name: /diff for app\.ts/i });
    expect(region).toHaveAttribute("tabindex", "0");
    expect(region).toHaveClass("folio-diff__body--scroll");
  });
});

describe("sidenote stacking", () => {
  const three = () =>
    sessionWith([
      { name: "Read", result_summary: "one" },
      { name: "Edit", result_summary: "two" },
      { name: "Grep", result_summary: "three" },
    ]);

  it("rows carry the sidenote class and the notes stay in row order in the DOM", () => {
    const { container } = renderSession(three());
    const rows = [...container.querySelectorAll<HTMLElement>(".folio-row")];
    expect(rows.length).toBe(3);
    for (const row of rows) {
      expect(row).toHaveClass("folio-row--sidenotes");
      expect(row.children[0]).toHaveClass("folio-body");
      expect(row.children[1]).toHaveClass("folio-margin");
    }
  });

  it("places each group at its row's top, pushed below the previous group plus 12 px", () => {
    stubGeometry();
    heights["0"] = 150;
    heights["1"] = 150;
    heights["2"] = 150;
    const { container } = renderSession(three());
    // naturals 14, 114, 214. group 0: 14..164. group 1: 176 (62 below its anchor, within the 80 px drift) ..326.
    // group 2 wants 338, 124 below its anchor: its row yields 44 px and the group sits the 80 px allowed below it
    expect(shifts(container)).toEqual(["0px", "62px", "80px"]);
    expect(pushes(container)).toEqual([0, 0, 44]);
  });

  it("leaves a group where it is when there is room", () => {
    stubGeometry();
    heights["0"] = 40;
    heights["1"] = 40;
    heights["2"] = 40;
    const { container } = renderSession(three());
    expect(shifts(container)).toEqual(["0px", "0px", "0px"]);
    expect(container.querySelector<HTMLElement>(".folio-page")!.style.getPropertyValue("--note-overflow")).toBe("0px");
  });

  it("gives the page bottom padding when the last group runs past the end of the page", () => {
    stubGeometry();
    heights["0"] = 150;
    heights["1"] = 150;
    heights["2"] = 150;
    const { container } = renderSession(three());
    // last row bottom 300 + 44 pushed = 344, last group bottom 488
    expect(container.querySelector<HTMLElement>(".folio-page")!.style.getPropertyValue("--note-overflow")).toBe("144px");
  });

  it("never touches the reading rows: they stay exactly as tall as their bodies", () => {
    stubGeometry();
    heights["0"] = 400;
    heights["1"] = 400;
    heights["2"] = 400;
    const { container } = renderSession(three());
    for (const row of container.querySelectorAll<HTMLElement>(".folio-row")) {
      expect(row.style.height).toBe("");
      expect(row.style.minHeight).toBe("");
      expect(row.style.paddingBottom).toBe("");
      expect(row.offsetHeight).toBe(100);
    }
  });

  it("re-stacks when a note expands", async () => {
    textOverflows = true;
    stubGeometry();
    heights["0"] = 60;
    heights["1"] = 60;
    heights["2"] = 60;
    const session = sessionWith([
      { name: "Grep", result_summary: "line ".repeat(200) },
      { name: "Edit", result_summary: "two" },
      { name: "Read", result_summary: "three" },
    ]);
    const { container } = renderSession(session);
    expect(shifts(container)).toEqual(["0px", "0px", "0px"]);
    heights["0"] = 200;
    await user.click(screen.getByRole("button", { name: "Show more of Grep" }));
    // group 0 now 14..214, so group 1 wants 226 (112 below its anchor): its row yields 32 px, shift 80.
    // group 2's anchor is 214 + 32 = 246; it wants 226 + 60 + 12 = 298, 52 below it, within the drift
    expect(shifts(container)).toEqual(["0px", "80px", "52px"]);
    expect(pushes(container)).toEqual([0, 32, 0]);
  });

  it("re-stacks on a container resize", async () => {
    stubGeometry();
    heights["0"] = 150;
    heights["1"] = 20;
    heights["2"] = 20;
    const { container } = renderSession(three());
    expect(shifts(container)).toEqual(["0px", "62px", "0px"]);
    heights["0"] = 20;
    await relayout();
    expect(shifts(container)).toEqual(["0px", "0px", "0px"]);
  });

  it("does not stack when the notes column is switched off", () => {
    stubGeometry();
    heights["0"] = 150;
    const session = three();
    const { container } = render(
      <Folio session={session.session} messages={session.messages} toolCalls={session.toolCalls} marginalia={false} virtualize={false} showContents={false} />,
    );
    expect(container.querySelectorAll("[data-marginalia]")).toHaveLength(0);
    expect(container.querySelector<HTMLElement>(".folio-page")!.style.getPropertyValue("--note-overflow")).toBe("0px");
  });

  it("stacks within the rendered window of a virtualised session, never overlapping", () => {
    stubGeometry();
    const long = makeLongSession(300);
    for (let index = 0; index < 400; index++) heights[String(index)] = 130;
    const { container } = renderSession(long, { virtualize: true });
    const margins = [...container.querySelectorAll<HTMLElement>(".folio-margin")].filter((m) => m.childElementCount > 0);
    expect(margins.length).toBeGreaterThan(1);
    let previousBottom = -Infinity;
    for (const margin of margins) {
      const row = margin.closest<HTMLElement>(".folio-row")!;
      const top = Number(row.dataset.messageIndex) * 100 + 14 + parseFloat(margin.style.getPropertyValue("--note-shift"));
      expect(top).toBeGreaterThanOrEqual(previousBottom + 12 - 0.001);
      previousBottom = top + 130;
    }
  });

  it("keeps the data attributes the tours and tests rely on", () => {
    const { container } = renderSession(sessionWith([{ name: "Edit", edits: [{ path: "a.ts", diff: "@@ -1 +1 @@\n-a\n+b" }] }]));
    expect(container.querySelector("[data-marginalia]")).not.toBeNull();
    expect(container.querySelector("[data-folio-diff-toggle]")).not.toBeNull();
  });

  it("a Row without the sidenotes flag keeps its notes full and in flow (export)", () => {
    const plan = planOf(sessionWith([{ name: "Read", files: ["a", "b", "c", "d"] }]));
    const { container } = render(<Row block={plan.blocks[0]} notes={plan.marginalia} find={EMPTY_FIND} />);
    expect(container.querySelector(".folio-row")).not.toHaveClass("folio-row--sidenotes");
    expect(container.querySelectorAll(".folio-note__files li")).toHaveLength(4);
  });
});

describe("bounded drift: the pure maths", () => {
  const row = (top: number, height: number | null) => ({ top, offset: 14, height });

  it("lets small groups flow beside their anchors with no push", () => {
    const plan = planSidenotes([row(0, 40), row(100, 40), row(200, 40)]);
    expect(plan.pushes).toEqual([0, 0, 0]);
    expect(plan.shifts).toEqual([0, 0, 0]);
  });

  it("keeps a group that is pushed down by the one above within the drift", () => {
    // group 0: 14..164. group 1 anchor 114, wants 176: 62 below, within 80
    const plan = planSidenotes([row(0, 150), row(100, 40)]);
    expect(plan.pushes).toEqual([0, 0]);
    expect(plan.shifts).toEqual([0, 62]);
  });

  it("makes the reading column yield when a tall group would push the next past the drift", () => {
    // group 0: 14..314. group 1 anchor 114, wants 326: 212 below. The row moves down 132, the group sits 80 below it
    const plan = planSidenotes([row(0, 300), row(100, 40)]);
    expect(plan.pushes).toEqual([0, 132]);
    expect(plan.shifts).toEqual([0, MAX_NOTE_DRIFT]);
    // anchor now 114 + 132 = 246; the group lands at 326 either way
    expect(246 + plan.shifts[1]).toBe(326);
  });

  it("applies the shift of earlier pushes to every later anchor", () => {
    // pushes 132 on row 1, so row 2's anchor is 214 + 132 = 346. Group 1: 326..366. Row 2 wants 378: 32 below, no push
    const plan = planSidenotes([row(0, 300), row(100, 40), row(200, 40)]);
    expect(plan.pushes).toEqual([0, 132, 0]);
    expect(plan.shifts).toEqual([0, 80, 32]);
  });

  it("carries the cumulative push through rows without notes", () => {
    // row 1 has no group, row 2 anchors at 214 + 0 (nothing pushed yet) and wants 326 + 0: group 0 is 14..314, +12
    const plan = planSidenotes([row(0, 300), row(100, null), row(200, 40)]);
    expect(plan.pushes[1]).toBe(0);
    expect(plan.pushes[2]).toBe(326 - 214 - MAX_NOTE_DRIFT);
    expect(plan.shifts[2]).toBe(MAX_NOTE_DRIFT);
  });

  it("never lets a group exceed the drift, whatever the sizes", () => {
    const heights = [500, 20, 700, 30, 30, 900, 10];
    const rows = heights.map((height, index) => row(index * 90, height));
    const plan = planSidenotes(rows);
    expect(Math.max(...plan.shifts)).toBeLessThanOrEqual(MAX_NOTE_DRIFT);
    // and no two groups meet
    let bottom = -Infinity;
    let cumulative = 0;
    rows.forEach((r, index) => {
      cumulative += plan.pushes[index];
      const top = r.top + cumulative + r.offset + plan.shifts[index];
      expect(top).toBeGreaterThanOrEqual(bottom + 12 - 0.001);
      bottom = top + (r.height ?? 0);
    });
  });

  it("is recomputed from natural positions: running the pass twice gives the same pushes", async () => {
    stubGeometry();
    for (const key of ["0", "1", "2"]) heights[key] = 300;
    const { container } = renderSession(
      sessionWith([{ name: "Read" }, { name: "Edit" }, { name: "Grep" }]),
    );
    const first = pushes(container);
    expect(first.some((value) => value > 0)).toBe(true);
    await relayout();
    await relayout();
    expect(pushes(container)).toEqual(first);
  });

  it("gives the margin back when the notes shrink", async () => {
    stubGeometry();
    for (const key of ["0", "1", "2"]) heights[key] = 300;
    const { container } = renderSession(sessionWith([{ name: "Read" }, { name: "Edit" }, { name: "Grep" }]));
    expect(pushes(container).some((value) => value > 0)).toBe(true);
    for (const key of ["0", "1", "2"]) heights[key] = 20;
    await relayout();
    expect(pushes(container)).toEqual([0, 0, 0]);
    expect(shifts(container)).toEqual(["0px", "0px", "0px"]);
  });

  it("does not push rows of a virtualised window (they are placed by translateY)", () => {
    stubGeometry();
    for (let index = 0; index < 400; index++) heights[String(index)] = 400;
    const { container } = renderSession(makeLongSession(300), { virtualize: true });
    expect(pushes(container).every((value) => value === 0)).toBe(true);
  });

  it("the stylesheet turns the push into a top margin on the row", () => {
    expect(FOLIO_CSS).toMatch(/\.folio-row--sidenotes \{[^}]*margin-top: var\(--note-push, 0px\);/);
    expect(FOLIO_CSS).toMatch(/\.folio-row--sidenotes \+ \.folio-row--sidenotes\[data-block-kind="prompt"\] \{[^}]*margin-top: calc\(12px \+ var\(--note-push, 0px\)\);/);
  });
});
