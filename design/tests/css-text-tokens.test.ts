import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Lint: the raw accents (vermilion, verdigris, gilt-soft) are for lines, fills and washes.
// Text must use the *-text tokens (vermilion-text, verdigris-text, gilt-text) because the raw
// accents fail WCAG AA 4.5:1 on the ink backgrounds. Only the `color` property is checked;
// border-color, background-color, outline-color and custom properties are allowed.

const here = path.dirname(fileURLToPath(import.meta.url));
const FILES = [
  { label: "design/src/primitives.css", file: path.resolve(here, "../src/primitives.css") },
  { label: "design/src/controls.css", file: path.resolve(here, "../src/controls.css") },
  { label: "app/src/App.css", file: path.resolve(here, "../../app/src/App.css") },
];

const FORBIDDEN_TEXT_ACCENT = /var\(\s*--color-(vermilion|verdigris|gilt-soft)\s*[,)]/;

interface Offender {
  line: number;
  selector: string;
  value: string;
}

/** Replace each comment with spaces, keeping newlines, so line numbers match the real file. */
function stripComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, (comment) => comment.replace(/[^\n]/g, " "));
}

function findTextAccentOffenders(css: string): Offender[] {
  const text = stripComments(css);
  const offenders: Offender[] = [];
  // `color` must start a declaration: preceded by start of file, whitespace, ; { or }.
  // That excludes border-color, background-color, --color, and selectors like .color:hover.
  const declaration = /(?<=^|[\s;{}])color\s*:\s*([^;}]*)/g;
  for (const match of text.matchAll(declaration)) {
    const value = match[1].trim();
    if (!FORBIDDEN_TEXT_ACCENT.test(value)) continue;
    const index = match.index ?? 0;
    const before = text.slice(0, index);
    const open = before.lastIndexOf("{");
    const boundary = Math.max(
      before.lastIndexOf("}", open),
      before.lastIndexOf("{", open - 1),
      before.lastIndexOf(";", open),
    );
    const selector = open === -1 ? "(top level)" : text.slice(boundary + 1, open).replace(/\s+/g, " ").trim();
    offenders.push({ line: before.split("\n").length, selector, value });
  }
  return offenders;
}

describe("text colour lint: accent tokens are never used as text", () => {
  describe("scanner self-check", () => {
    it("flags a text color that uses a raw accent", () => {
      const found = findTextAccentOffenders(".a {\n  color: var(--color-vermilion);\n}");
      expect(found).toEqual([{ line: 2, selector: ".a", value: "var(--color-vermilion)" }]);
    });

    it("ignores non-text properties, the *-text tokens and comments", () => {
      const css = [
        ".b { border-color: var(--color-vermilion); background-color: var(--color-verdigris); }",
        ".c { color: var(--color-vermilion-text); }",
        ".d { fill: var(--color-gilt-soft); }",
        "/* .e { color: var(--color-verdigris); } */",
      ].join("\n");
      expect(findTextAccentOffenders(css)).toEqual([]);
    });
  });

  for (const { label, file } of FILES) {
    it(`${label}: no color declaration uses vermilion, verdigris or gilt-soft`, () => {
      const offenders = findTextAccentOffenders(readFileSync(file, "utf8")).map(
        (o) => `${label}:${o.line} ${o.selector} { color: ${o.value} }`,
      );
      expect(offenders, "use vermilion-text, verdigris-text or gilt-text for text").toEqual([]);
    });
  }
});
