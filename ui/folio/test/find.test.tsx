import { describe, expect, it } from "vitest";
import { mockSessions } from "../src/data/mockSessions";
import { findInput, renderFolio, screen, user } from "./helpers";

function status() {
  return screen.getByRole("status", { name: /matches/i });
}

function total() {
  return Number(status().textContent?.split(" of ")[1]);
}

describe("find in session", () => {
  it("counts matches across the whole session", async () => {
    const { page } = renderFolio(mockSessions.refactor);
    await user.type(findInput(), "adapter");
    expect(status().textContent).toMatch(/^\d+ of \d+$/);
    expect(total()).toBeGreaterThan(3);
    expect(status().textContent).toBe(`1 of ${total()}`);
    expect(page().querySelectorAll("[data-find-match]")).toHaveLength(total());
    expect(page().querySelector("[data-find-match='active']")).not.toBeNull();
  });

  it("highlights every occurrence inside a block", async () => {
    const { page } = renderFolio(mockSessions.refactor);
    await user.type(findInput(), "pending");
    const marks = page().querySelectorAll("[data-find-match]");
    expect(marks.length).toBeGreaterThan(1);
    for (const mark of marks) expect(mark.tagName).toBe("MARK");
  });

  it("walks matches with next and previous, wrapping around", async () => {
    const { page } = renderFolio(mockSessions.refactor);
    await user.type(findInput(), "gateway");
    expect(total()).toBeGreaterThan(2);
    expect(status().textContent).toBe(`1 of ${total()}`);
    expect(page().querySelectorAll("[data-find-match]")).toHaveLength(total());

    const next = screen.getByRole("button", { name: /next match/i });
    const previous = screen.getByRole("button", { name: /previous match/i });
    const first = page().querySelector("[data-find-match='active']")!.textContent;
    expect(first).toBe("gateway");

    await user.click(next);
    expect(status().textContent).toBe(`2 of ${total()}`);
    expect(page().querySelector("[data-find-match='active']")!.textContent).toBe(first);

    for (let step = 2; step < total(); step++) await user.click(next);
    expect(status().textContent).toBe(`${total()} of ${total()}`);

    await user.click(next);
    expect(status().textContent).toBe(`1 of ${total()}`);
    await user.click(previous);
    expect(status().textContent).toBe(`${total()} of ${total()}`);
  });

  it("reports no matches and leaves the page intact", async () => {
    const { page } = renderFolio(mockSessions.refactor);
    await user.type(findInput(), "zebrafish");
    expect(status().textContent).toBe("0 of 0");
    expect(page().querySelectorAll("[data-find-match]")).toHaveLength(0);
    expect(page().textContent).toContain("I will do this in three steps.");
  });

  it("clears the query and its marks", async () => {
    const { page } = renderFolio(mockSessions.refactor);
    await user.type(findInput(), "adapter");
    await user.click(screen.getByRole("button", { name: /clear find/i }));
    expect(findInput().value).toBe("");
    expect(page().querySelectorAll("[data-find-match]")).toHaveLength(0);
    expect(status().textContent).toBe("0 of 0");
  });

  it("is case insensitive", async () => {
    const { page } = renderFolio(mockSessions.refactor);
    await user.type(findInput(), "adapter");
    const lower = total();
    await user.click(screen.getByRole("button", { name: /clear find/i }));
    await user.type(findInput(), "Adapter");
    expect(total()).toBeGreaterThan(0);
    expect(total()).toBe(lower);
    expect(page().querySelectorAll("[data-find-match]")).toHaveLength(lower);
  });

  it("searches marginal notes as well as the body", async () => {
    const { page } = renderFolio(mockSessions.refactor);
    await user.type(findInput(), "npm test");
    const marks = [...page().querySelectorAll("[data-find-match]")];
    expect(marks.length).toBeGreaterThan(1);
    expect(marks.some((mark) => mark.closest("[data-marginalia]"))).toBe(true);
  });

  it("jumps the virtualised page to the match block", async () => {
    const { makeLongSession } = await import("../src/data/makeLongSession");
    const { rows, scrollArea } = renderFolio(makeLongSession(600));
    await user.type(findInput(), "Step 480");
    await user.click(screen.getByRole("button", { name: /next match/i }));
    expect(scrollArea().scrollTop).toBeGreaterThan(0);
    expect(rows().some((row) => row.textContent?.includes("Step 480"))).toBe(true);
  });
});
