import { describe, expect, it } from "vitest";
import { makeLongSession } from "../src/data/makeLongSession";
import { renderFolio, scrollTo } from "./helpers";

const COUNT = 2000;

describe("long sessions", () => {
  it("renders 2000 messages without freezing", () => {
    const session = makeLongSession(COUNT);
    const start = performance.now();
    const view = renderFolio(session, { virtualize: true });
    const elapsed = performance.now() - start;
    expect(view.rows().length).toBeGreaterThan(0);
    expect(elapsed).toBeLessThan(1200);
  });

  it("only keeps a window of the page in the DOM", () => {
    const session = makeLongSession(COUNT);
    const view = renderFolio(session, { virtualize: true });
    expect(view.rows().length).toBeGreaterThan(4);
    expect(view.rows().length).toBeLessThan(60);
    expect(view.container.textContent).toContain(`Step 1:`);
  });

  it("swaps the window as the reader scrolls", async () => {
    const session = makeLongSession(COUNT);
    const view = renderFolio(session, { virtualize: true });
    const first = Number(view.rows()[0].dataset.messageIndex);
    await scrollTo(view.scrollArea(), 40000);
    const after = Number(view.rows()[0].dataset.messageIndex);
    expect(after).toBeGreaterThan(first);
    expect(view.rows().length).toBeLessThan(60);
    const indexes = view.rows().map((row) => Number(row.dataset.messageIndex));
    expect(indexes).toEqual([...indexes].sort((a, b) => a - b));
  });

  it("keeps marginalia aligned while virtualised", async () => {
    const session = makeLongSession(COUNT);
    const view = renderFolio(session, { virtualize: true });
    await scrollTo(view.scrollArea(), 12000);
    for (const row of view.rows()) {
      for (const note of row.querySelectorAll("[data-marginalia]")) {
        expect(Number(note.getAttribute("data-anchor-seq"))).toBe(Number(row.dataset.seq));
      }
    }
  });

  it("renders a short session in full without a window", () => {
    const session = makeLongSession(12);
    const view = renderFolio(session, { virtualize: false });
    expect(view.rows()).toHaveLength(12);
  });

  it("keeps the footer outside the window so usage is always readable", async () => {
    const session = makeLongSession(COUNT);
    const view = renderFolio(session, { virtualize: true });
    await scrollTo(view.scrollArea(), 90000);
    const footer = view.container.querySelector("footer")!;
    expect(footer.textContent).toContain("qwen-3.8-coder");
  });
});
