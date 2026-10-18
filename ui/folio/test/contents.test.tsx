import { describe, expect, it } from "vitest";
import { makeLongSession } from "../src/data/makeLongSession";
import { mockSessions } from "../src/data/mockSessions";
import { renderFolio, screen, tocNav, user } from "./helpers";

describe("contents rail", () => {
  it("lists a link per user prompt plus the major headings", () => {
    renderFolio(mockSessions.refactor);
    const links = screen.getAllByRole("link").filter((el) => tocNav().contains(el));
    expect(links).toHaveLength(3);
    expect(links.map((l) => l.textContent?.trim()).slice(0, 2)).toEqual([
      "Split src/payments.ts into an adapter for the gateway and a store for local",
      "Plan",
    ]);
  });

  it("jumps to a section on Enter and marks it current", async () => {
    const { rows } = renderFolio(mockSessions.refactor);
    const links = [...tocNav().querySelectorAll("a")];
    links[0].focus();
    await user.keyboard("{Enter}");
    expect(links[0]).toHaveAttribute("aria-current", "true");
    expect(rows()[0].getAttribute("data-current")).toBe("true");

    links[2].focus();
    await user.keyboard("{Enter}");
    expect(links[2]).toHaveAttribute("aria-current", "true");
    expect(rows()[5].dataset.messageIndex).toBe("5");
    expect(rows()[5].getAttribute("data-current")).toBe("true");
  });

  it("moves focus with arrow keys, Home and End", async () => {
    renderFolio(mockSessions.planning);
    const links = [...tocNav().querySelectorAll("a")];
    links[0].focus();
    await user.keyboard("{ArrowDown}");
    expect(document.activeElement).toBe(links[1]);
    await user.keyboard("{ArrowDown}");
    expect(document.activeElement).toBe(links[2]);
    await user.keyboard("{End}");
    expect(document.activeElement).toBe(links[links.length - 1]);
    await user.keyboard("{ArrowDown}");
    expect(document.activeElement).toBe(links[links.length - 1]);
    await user.keyboard("{Home}");
    expect(document.activeElement).toBe(links[0]);
    await user.keyboard("{ArrowUp}");
    expect(document.activeElement).toBe(links[0]);
  });

  it("activates with Space as well as Enter", async () => {
    renderFolio(mockSessions.planning);
    const links = [...tocNav().querySelectorAll("a")];
    links[1].focus();
    await user.keyboard(" ");
    expect(links[1]).toHaveAttribute("aria-current", "true");
  });

  it("reaches a block far down a virtualised session", async () => {
    const { rows, scrollArea } = renderFolio(makeLongSession(2000));
    const links = [...tocNav().querySelectorAll("a")];
    const last = links[links.length - 1];
    last.focus();
    await user.keyboard("{Enter}");
    expect(last).toHaveAttribute("aria-current", "true");
    expect(scrollArea().scrollTop).toBeGreaterThan(0);
    expect(rows().some((row) => row.getAttribute("data-current") === "true")).toBe(true);
  });

  it("is a labelled navigation landmark", () => {
    renderFolio(mockSessions.refactor);
    expect(tocNav()).toHaveAccessibleName("Session contents");
  });
});
