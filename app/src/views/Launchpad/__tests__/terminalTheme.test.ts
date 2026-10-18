import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { getContrastRatio } from "@orrery/design";
import { buildTerminalTheme, currentTerminalTheme, ensureContrast, watchTheme } from "../terminalTheme";

/** The real token values, read from design/src/tokens.css so the test cannot drift from the palette. */
const CSS = readFileSync(resolve(__dirname, "../../../../../design/src/tokens.css"), "utf8");

function block(startsWith: string): Record<string, string> {
  const start = CSS.indexOf(startsWith);
  const body = CSS.slice(CSS.indexOf("{", start) + 1, CSS.indexOf("\n}", start));
  const out: Record<string, string> = {};
  for (const m of body.matchAll(/(--[\w-]+):\s*([^;]+);/g)) out[m[1]] = m[2].trim();
  return out;
}

const families = block(":root {\n  /* 3.2 Agent Families */");
const dark = { ...families, ...block(":root,\n[data-theme=\"dark\"]") };
const light = { ...families, ...block("[data-theme=\"light\"],") };

const reader = (tokens: Record<string, string>) => (name: string) => tokens[name] ?? "";

const TEXT_COLOURS = [
  "foreground",
  "red",
  "green",
  "yellow",
  "blue",
  "magenta",
  "cyan",
  "brightBlack",
  "brightRed",
  "brightGreen",
  "brightYellow",
  "brightBlue",
  "brightMagenta",
  "brightCyan",
] as const;

describe("terminal theme from the design tokens", () => {
  it("reads the real token files (self-check)", () => {
    expect(dark["--color-ink-0"]).toBe("#0B1220");
    expect(light["--color-ink-0"]).toBe("#F3EBDA");
    expect(dark["--family-google"]).toBeTruthy();
  });

  for (const [name, tokens] of [
    ["night", dark],
    ["Day almanac", light],
  ] as const) {
    describe(name, () => {
      const theme = buildTerminalTheme(reader(tokens));

      it("grounds the terminal on ink-0 with star text and a gilt cursor", () => {
        expect(theme.background).toBe(tokens["--color-ink-0"].toUpperCase());
        expect(theme.foreground).toBe(tokens["--color-star"].toUpperCase());
        expect(theme.cursor).toBe(tokens["--color-gilt"].toUpperCase());
      });

      it("keeps every text colour at AA (4.5:1) on the terminal ground", () => {
        for (const key of TEXT_COLOURS) {
          const ratio = getContrastRatio(theme[key] as string, theme.background as string);
          expect(ratio, `${key} ${theme[key]} on ${theme.background}`).toBeGreaterThanOrEqual(4.5);
        }
      });

      it("defines all sixteen ANSI colours as hex", () => {
        for (const key of [
          "black", "red", "green", "yellow", "blue", "magenta", "cyan", "white",
          "brightBlack", "brightRed", "brightGreen", "brightYellow", "brightBlue", "brightMagenta", "brightCyan", "brightWhite",
        ] as const) {
          expect(theme[key], key).toMatch(/^#[0-9A-F]{6}$/);
        }
      });
    });
  }

  it("is a parchment ground with dark ink text in the light theme", () => {
    const theme = buildTerminalTheme(reader(light));
    expect(theme.background).toBe("#F3EBDA");
    expect(getContrastRatio(theme.foreground as string, theme.background as string)).toBeGreaterThan(10);
  });

  it("falls back to the night palette when a token cannot be read", () => {
    const theme = buildTerminalTheme(() => "");
    expect(theme.background).toBe("#0B1220");
    expect(theme.foreground).toBe("#F4F1E8");
  });

  it("ensureContrast leaves a passing colour alone and darkens a failing one toward the ink", () => {
    expect(ensureContrast("#F4F1E8", "#0B1220", "#F4F1E8")).toBe("#F4F1E8");
    const fixed = ensureContrast("#7A9CE0", "#F3EBDA", "#1D1A14");
    expect(getContrastRatio(fixed, "#F3EBDA")).toBeGreaterThanOrEqual(4.5);
  });
});

describe("following the page theme", () => {
  const root = document.documentElement;
  beforeEach(() => {
    root.removeAttribute("data-theme");
  });
  afterEach(() => {
    root.removeAttribute("style");
    root.removeAttribute("data-theme");
  });

  it("reads the live CSS custom properties", () => {
    root.style.setProperty("--color-ink-0", "#F3EBDA");
    root.style.setProperty("--color-star", "#1D1A14");
    const theme = currentTerminalTheme();
    expect(theme.background).toBe("#F3EBDA");
    expect(theme.foreground).toBe("#1D1A14");
  });

  it("notifies when data-theme changes", async () => {
    let calls = 0;
    const stop = watchTheme(() => calls++);
    root.setAttribute("data-theme", "light");
    await new Promise((r) => setTimeout(r, 0));
    expect(calls).toBeGreaterThan(0);
    stop();
    const before = calls;
    root.setAttribute("data-theme", "dark");
    await new Promise((r) => setTimeout(r, 0));
    expect(calls).toBe(before);
  });
});
