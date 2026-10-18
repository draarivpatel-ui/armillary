import { describe, expect, it } from "vitest";
import { makeLongSession } from "../src/data/makeLongSession";
import { mockSessions } from "../src/data/mockSessions";
import { renderFolio, scrollTo } from "./helpers";

describe("virtualised page", () => {
  const long = makeLongSession(2000);

  it("turns virtualisation on automatically for long sessions", () => {
    const { page, scrollArea } = renderFolio(long);
    expect(page().getAttribute("data-virtualized")).toBe("true");
    expect(Number(scrollArea().getAttribute("data-total-blocks"))).toBe(2000);
  });

  it("renders only a window of the blocks", () => {
    const { rows, page } = renderFolio(long);
    const rendered = rows();
    expect(rendered.length).toBeGreaterThan(3);
    expect(rendered.length).toBeLessThanOrEqual(40);
    expect(Number(page().getAttribute("data-rendered-blocks"))).toBe(rendered.length);
    // later messages are not on the page yet
    expect(page().textContent).not.toContain("Step 1999:");
  });

  it("stays under half a second to mount", () => {
    const start = performance.now();
    renderFolio(long);
    const elapsed = performance.now() - start;
    expect(elapsed).toBeLessThan(500);
  });

  it("swaps the window when the reader scrolls", async () => {
    const { rows, scrollArea } = renderFolio(long);
    const before = rows().map((row) => row.dataset.messageIndex);
    await scrollTo(scrollArea(), 120_000);
    const after = rows().map((row) => row.dataset.messageIndex);
    expect(after).not.toEqual(before);
    expect(Number(after[0])).toBeGreaterThan(0);
    expect(after.length).toBeLessThanOrEqual(40);
    // the first block of the session has left the DOM
    expect(after).not.toContain(before[0]);
  });

  it("shows the whole document when the session is short", () => {
    const { rows, page } = renderFolio(mockSessions.refactor);
    expect(page().getAttribute("data-virtualized")).toBe("false");
    expect(rows()).toHaveLength(mockSessions.refactor.messages.length);
  });

  it("lets the reader force a plain page", () => {
    const { page, rows } = renderFolio(makeLongSession(30), { virtualize: false });
    expect(page().getAttribute("data-virtualized")).toBe("false");
    expect(rows()).toHaveLength(30);
  });

  it("keeps marginalia inside their row while virtualised", async () => {
    const { rows, scrollArea } = renderFolio(long);
    await scrollTo(scrollArea(), 40_000);
    for (const row of rows()) {
      for (const note of row.querySelectorAll("[data-marginalia]")) {
        expect(Number(note.getAttribute("data-anchor-seq"))).toBe(Number(row.dataset.seq));
      }
    }
  });
});
