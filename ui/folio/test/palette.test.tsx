import { describe, expect, it } from "vitest";
import { contrastRatio, palette, TEXT_PAIRS, fontStacks } from "../src/styles/palette";
import { FOLIO_CSS } from "../src/styles/stylesheet";
import { mockSessions } from "../src/data/mockSessions";
import { renderFolio } from "./helpers";

describe("Observatory palette", () => {
  it("carries the SPEC token values for both themes", () => {
    expect(palette.dark["ink-0"]).toBe("#0B1220");
    expect(palette.dark.parchment).toBe("#F1E8D5");
    expect(palette.light["ink-0"]).toBe("#F3EBDA");
    expect(palette.light.parchment).toBe("#FBF6EA");
    expect(palette.dark.gilt).toBe("#C9A24A");
    expect(palette.light.gilt).toBe("#8A6A22");
    expect(palette.dark.star).toBe("#F4F1E8");
    expect(palette.light.star).toBe("#1D1A14");
  });

  it("keeps every text pair at 4.5:1 or better", () => {
    const failures = TEXT_PAIRS.filter((pair) => contrastRatio(pair.fg, pair.bg, pair.theme) < 4.5);
    expect(failures).toEqual([]);
    expect(TEXT_PAIRS.length).toBeGreaterThanOrEqual(12);
  });

  it("checks the contrast helper itself", () => {
    expect(Number(contrastRatio("#000000", "#FFFFFF").toFixed(1))).toBe(21);
    expect(contrastRatio("#777777", "#777777")).toBeCloseTo(1, 2);
  });

  it("exposes the display, body and mono stacks with system fallbacks", () => {
    expect(fontStacks.display).toMatch(/^'Cormorant Garamond'/); // the bundled face's family name (design/src/fonts.css)
    expect(fontStacks.display).toMatch(/Georgia/);
    expect(fontStacks.display).toMatch(/serif$/);
    expect(fontStacks.body).toMatch(/^'Instrument Sans'/);
    expect(fontStacks.body).toMatch(/sans-serif$/);
    expect(fontStacks.mono).toMatch(/^'Commit Mono'/);
    expect(fontStacks.mono).toMatch(/monospace$/);
  });

  it("emits the palette as CSS variables for both themes", () => {
    expect(FOLIO_CSS).toContain("--ink-0: #0B1220");
    expect(FOLIO_CSS).toContain('[data-theme="light"]');
    expect(FOLIO_CSS).toContain("--ink-0: #F3EBDA");
    expect(FOLIO_CSS).toContain("--parchment: #F1E8D5");
  });
});

describe("typography and copy rules", () => {
  it("uses the Folio body size and line height from the 8 px rhythm", () => {
    const styles = FOLIO_CSS;
    expect(styles).toMatch(/\.folio-page\s*\{[\s\S]*?font-size: 16px;[\s\S]*?line-height: 1\.6;/);
    expect(styles).toMatch(/font-size: 14px;/);
    const sizes = new Set([...styles.matchAll(/font-size: (\d+)px/g)].map((m) => Number(m[1])));
    const scale = new Set([8, 12, 14, 16, 20, 24, 32, 40]);
    for (const size of sizes) expect(scale.has(size)).toBe(true);
    expect(sizes.has(15)).toBe(false);
  });

  it("sets display type in Cormorant and code in Commit Mono", () => {
    expect(FOLIO_CSS).toMatch(/\.folio-prompt__title\s*\{[\s\S]*?var\(--font-display\)/);
    expect(FOLIO_CSS).toMatch(/\.folio-code\s*\{[\s\S]*?var\(--font-mono\)/);
  });

  it("renders in the Folio page without any em or en dashes", () => {
    for (const session of Object.values(mockSessions)) {
      const { page } = renderFolio(session);
      const text = page().textContent ?? "";
      expect(text).not.toMatch(/[–—−]/u);
      expect(text).not.toMatch(/\s--\s/);
    }
  });

  it("keeps the stylesheet free of network references", () => {
    expect(FOLIO_CSS).not.toMatch(/https?:/);
    expect(FOLIO_CSS).not.toMatch(/@import/);
  });
});
