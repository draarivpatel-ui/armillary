import { describe, expect, it } from "vitest";
import { screen } from "@testing-library/react";
import { FOLIO_CSS } from "../src/styles/stylesheet";
import { mockSessions } from "../src/data/mockSessions";
import { renderFolio } from "./helpers";

describe("Folio presentation (DS)", () => {
  it("unrolls from the top: a sheet keyed to the session with a decorative roll", () => {
    const { container } = renderFolio(mockSessions.refactor);
    const sheet = container.querySelector("[data-folio-sheet]");
    expect(sheet).not.toBeNull();
    const roll = sheet!.querySelector(".folio-roll");
    expect(roll).toHaveAttribute("aria-hidden", "true");
    expect(sheet!.querySelector("[data-folio-scroll]")).not.toBeNull();
    expect(FOLIO_CSS).toMatch(/@keyframes folio-unroll/);
    expect(FOLIO_CSS).toMatch(/prefers-reduced-motion[\s\S]*\.folio-roll \{ animation: none; display: none; \}/);
  });

  it("gives every diff toggle a stable tour target and an accessible name with its counts", () => {
    renderFolio(mockSessions.refactor);
    const toggles = document.querySelectorAll("[data-folio-diff-toggle]");
    expect(toggles.length).toBeGreaterThan(0);
    const first = toggles[0] as HTMLButtonElement;
    // the accessible name is the visible text plus a hidden verb, so it always contains what is shown (axe)
    expect(first.hasAttribute("aria-label")).toBe(false);
    const visible = Array.from(first.querySelectorAll(".folio-diff__file, .folio-diff__counts"))
      .map((n) => n.textContent ?? "")
      .join(" ")
      .replace(/\s+/g, " ")
      .trim();
    expect(first.textContent?.replace(/\s+/g, " ").trim()).toBe(`Show diff for ${visible}`);
  });

  it("marks errors in the margin rather than colouring the whole note", () => {
    expect(FOLIO_CSS).toMatch(/\.folio-note--error::before \{[\s\S]*?background: var\(--vermilion-page\)/);
    expect(FOLIO_CSS).not.toMatch(/\.folio-note--error \{[^}]*[\s;{]color: var\(--vermilion-page\)/);
  });

  it("ships 0.1.0 with no Export or Redact controls (R2-REV-2: export wrote no file)", () => {
    renderFolio(mockSessions.refactor);
    expect(screen.queryByRole("group", { name: "Export" })).toBeNull();
    expect(screen.queryByRole("button", { name: /Export/i })).toBeNull();
    expect(screen.queryByRole("checkbox", { name: /redact/i })).toBeNull();
    expect(screen.queryByText(/written as/i)).toBeNull();
  });

  it("styles the toolbar controls (export, redact, find) without native chrome", () => {
    // The export code stays behind the build flag (off for 0.1.0); the prop turns it on here.
    renderFolio(mockSessions.refactor, { exportEnabled: true });
    expect(screen.getByRole("group", { name: "Export" })).toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: /redact/i })).toHaveClass("folio-check__box");
    expect(FOLIO_CSS).toMatch(/\.folio-check__box \{[\s\S]*?appearance: none;/);
    for (const name of [/previous match/i, /next match/i, /clear find/i]) {
      expect(screen.getByRole("button", { name }).querySelector("svg")).not.toBeNull();
    }
  });
});
