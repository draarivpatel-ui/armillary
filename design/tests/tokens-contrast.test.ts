import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { darkTokens, lightTokens, getContrastRatio, type ThemeTokens } from "../src/tokens";

// The CSS file is the source of truth. Colours are read from it directly, and tokens.ts
// is checked against it, so the contrast gate cannot drift from what the app actually paints.
const here = path.dirname(fileURLToPath(import.meta.url));
const tokensCss = readFileSync(path.resolve(here, "../src/tokens.css"), "utf8");

type Theme = "dark" | "light";
type CssMap = Record<string, string>; // "--color-ink-0" -> "#0B1220"

function stripComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, "");
}

/** Hex custom properties (#RRGGBB only) of the one rule whose selector list matches. */
function hexBlock(matches: (selectorList: string) => boolean, label: string): CssMap {
  const rules = [...stripComments(tokensCss).matchAll(/([^{}]+)\{([^{}]*)\}/g)].filter((m) =>
    matches(m[1].trim()),
  );
  if (rules.length !== 1) {
    throw new Error(`expected exactly one ${label} rule in tokens.css, found ${rules.length}`);
  }
  const map: CssMap = {};
  for (const decl of rules[0][2].matchAll(/--(color-[a-z0-9-]+)\s*:\s*(#[0-9A-Fa-f]{6})\b/g)) {
    map[`--${decl[1]}`] = decl[2].toUpperCase();
  }
  return map;
}

const cssTokens: Record<Theme, CssMap> = {
  dark: hexBlock((sel) => sel.startsWith(":root,"), "dark (:root, [data-theme=\"dark\"])"),
  light: hexBlock((sel) => sel.includes('[data-theme="light"]'), "light ([data-theme=\"light\"])"),
};

/** camelCase token key -> CSS custom property name, e.g. giltSoft -> --color-gilt-soft, ink0 -> --color-ink-0. */
function toCssName(key: string): string {
  return `--color-${key.replace(/([A-Z])/g, "-$1").replace(/(\d)/g, "-$1").toLowerCase()}`;
}

function cssColour(theme: Theme, name: string): string {
  const value = cssTokens[theme][`--color-${name}`];
  if (!value) throw new Error(`${theme}: --color-${name} is missing from tokens.css`);
  return value;
}

const themeTokens: Record<Theme, ThemeTokens> = { dark: darkTokens, light: lightTokens };

describe("tokens.ts mirrors tokens.css", () => {
  for (const theme of ["dark", "light"] as const) {
    describe(`${theme} theme`, () => {
      it("has exactly the CSS hex tokens, one per ThemeTokens key", () => {
        const fromTs = (Object.keys(themeTokens[theme]) as (keyof ThemeTokens)[])
          .map((key) => toCssName(key))
          .sort();
        expect(fromTs).toEqual(Object.keys(cssTokens[theme]).sort());
      });

      for (const key of Object.keys(themeTokens[theme]) as (keyof ThemeTokens)[]) {
        it(`${key} equals ${toCssName(key)} in tokens.css`, () => {
          expect(themeTokens[theme][key].toUpperCase()).toBe(cssTokens[theme][toCssName(key)]);
        });
      }
    });
  }
});

// Real component pairs. Each one is checked in both themes against WCAG AA 4.5:1.
const PAIRS = [
  { fg: "star", bg: "ink-0", note: "body text" },
  { fg: "star", bg: "ink-1", note: "rail labels, body" },
  { fg: "star", bg: "ink-2", note: "selected segment" },
  { fg: "dust", bg: "ink-0", note: "secondary text" },
  { fg: "dust", bg: "ink-1", note: "secondary text" },
  { fg: "dust", bg: "ink-2", note: "secondary text" },
  { fg: "gilt-text", bg: "ink-0", note: "selected tab" },
  { fg: "gilt-text", bg: "ink-1", note: "selected tab" },
  { fg: "gilt-text", bg: "ink-2", note: "gilt badge" },
  { fg: "list-selected-fg", bg: "ink-1", note: "active rail item" },
  { fg: "list-selected-fg", bg: "ink-2", note: "selected list" },
  { fg: "vermilion-text", bg: "ink-0", note: "needs-you figures, errors" },
  { fg: "vermilion-text", bg: "ink-1", note: "needs-you figures, errors" },
  { fg: "vermilion-text", bg: "ink-2", note: "needs-you figures, errors" },
  { fg: "verdigris-text", bg: "ink-0", note: "success marks" },
  { fg: "verdigris-text", bg: "ink-1", note: "success marks" },
  { fg: "verdigris-text", bg: "ink-2", note: "success marks" },
  { fg: "button-gilt-fg", bg: "gilt", note: "gilt button" },
  { fg: "button-destructive-fg", bg: "vermilion", note: "destructive button" },
] as const;

describe("Observatory component contrast gate (WCAG AA >= 4.5:1, parsed from tokens.css)", () => {
  for (const theme of ["dark", "light"] as const) {
    describe(`${theme} theme`, () => {
      for (const { fg, bg, note } of PAIRS) {
        it(`${theme}: ${fg} on ${bg} (${note})`, () => {
          const ratio = getContrastRatio(cssColour(theme, fg), cssColour(theme, bg));
          expect(ratio, `${fg} on ${bg} is ${ratio.toFixed(2)}:1`).toBeGreaterThanOrEqual(4.5);
        });
      }
    });
  }
});

// Documentation of the rule: the raw accents are fills, lines and washes. They are NOT text colours,
// which is why the *-text tokens exist. If one of these ever passes, revisit the rule before relying on it.
describe("raw accents fail as text (why the *-text tokens exist)", () => {
  it("dark: vermilion on ink-2 is below 4.5:1 (use vermilion-text)", () => {
    const ratio = getContrastRatio(cssColour("dark", "vermilion"), cssColour("dark", "ink-2"));
    expect(ratio, `ratio ${ratio.toFixed(2)}:1`).toBeLessThan(4.5);
  });

  it("dark: verdigris on ink-2 is below 4.5:1 (use verdigris-text)", () => {
    const ratio = getContrastRatio(cssColour("dark", "verdigris"), cssColour("dark", "ink-2"));
    expect(ratio, `ratio ${ratio.toFixed(2)}:1`).toBeLessThan(4.5);
  });

  it("light: gilt-soft on ink-2 is below 4.5:1 (use gilt-text)", () => {
    const ratio = getContrastRatio(cssColour("light", "gilt-soft"), cssColour("light", "ink-2"));
    expect(ratio, `ratio ${ratio.toFixed(2)}:1`).toBeLessThan(4.5);
  });
});
