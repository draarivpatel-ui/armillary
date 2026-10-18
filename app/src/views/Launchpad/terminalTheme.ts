import type { ITheme } from "@xterm/xterm";
import { getContrastRatio } from "@orrery/design";

/**
 * The terminal's colours come from the design tokens, so the terminal follows the theme: ink and star for
 * the ground and text, the family and accent palette for the ANSI colours. Every ANSI colour that can carry
 * text is nudged toward the foreground until it reads at WCAG AA (4.5:1) on the terminal ground, which is
 * what keeps blue and cyan legible on the parchment of the Day almanac.
 *
 * Only the theme object lives here. The terminal's security options stay in terminalSecurity.ts.
 */

/** Night values, used when a token cannot be read (no stylesheet, tests) or is not a plain hex colour. */
const FALLBACK: Record<string, string> = {
  "--color-ink-0": "#0B1220",
  "--color-ink-2": "#18233B",
  "--color-star": "#F4F1E8",
  "--color-dust": "#8E9AB4",
  "--color-parchment": "#F1E8D5",
  "--color-gilt": "#C9A24A",
  "--color-gilt-text": "#C9A24A",
  "--color-vermilion-text": "#F06B52",
  "--color-verdigris-text": "#4EBAA4",
  "--family-google": "#7A9CE0",
  "--family-github-microsoft": "#9C8ADE",
  "--family-openai": "#6FB7A8",
};

export type TokenReader = (name: string) => string;

const HEX = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i;

function normalizeHex(value: string): string | null {
  const v = value.trim();
  if (!HEX.test(v)) return null;
  if (v.length === 4) return `#${v[1]}${v[1]}${v[2]}${v[2]}${v[3]}${v[3]}`.toUpperCase();
  return v.toUpperCase();
}

function toRgb(hex: string): [number, number, number] {
  return [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)) as [number, number, number];
}

function toHex(rgb: number[]): string {
  return `#${rgb.map((c) => Math.round(Math.max(0, Math.min(255, c))).toString(16).padStart(2, "0")).join("")}`.toUpperCase();
}

/** `amount` of `to` mixed into `from` (0 keeps `from`, 1 gives `to`). */
function mix(from: string, to: string, amount: number): string {
  const a = toRgb(from);
  const b = toRgb(to);
  return toHex(a.map((c, i) => c + (b[i] - c) * amount));
}

/** Nudge `color` toward `toward` in small steps until it reads at `min` on `background`. */
export function ensureContrast(color: string, background: string, toward: string, min = 4.5): string {
  let out = color;
  for (let step = 1; step <= 20 && getContrastRatio(out, background) < min; step++) {
    out = mix(color, toward, step * 0.05);
  }
  return out;
}

export function buildTerminalTheme(read: TokenReader): ITheme {
  const token = (name: string): string => normalizeHex(read(name)) ?? FALLBACK[name];

  const background = token("--color-ink-0");
  const foreground = token("--color-star");
  const gilt = token("--color-gilt");
  const lightGround = getContrastRatio("#FFFFFF", background) < getContrastRatio("#000000", background);

  const ansi = (color: string): string => ensureContrast(color, background, foreground);
  const bright = (color: string): string => ensureContrast(mix(color, foreground, 0.22), background, foreground);

  const red = ansi(token("--color-vermilion-text"));
  const green = ansi(token("--color-verdigris-text"));
  const yellow = ansi(token("--color-gilt-text"));
  const blue = ansi(token("--family-google"));
  const magenta = ansi(token("--family-github-microsoft"));
  const cyan = ansi(token("--family-openai"));
  const [r, g, b] = toRgb(gilt);

  return {
    background,
    foreground,
    cursor: gilt,
    cursorAccent: background,
    selectionBackground: `rgba(${r}, ${g}, ${b}, 0.3)`,
    // Black and white are the paired ground and ink of the palette: the terminal's own text colours.
    black: lightGround ? foreground : token("--color-ink-2"),
    red,
    green,
    yellow,
    blue,
    magenta,
    cyan,
    white: lightGround ? token("--color-ink-2") : foreground,
    brightBlack: ensureContrast(token("--color-dust"), background, foreground),
    brightRed: bright(red),
    brightGreen: bright(green),
    brightYellow: bright(yellow),
    brightBlue: bright(blue),
    brightMagenta: bright(magenta),
    brightCyan: bright(cyan),
    brightWhite: token("--color-parchment"),
  };
}

/** The theme for whatever the page shows right now (reads the live CSS custom properties). */
export function currentTerminalTheme(root: Element = document.documentElement): ITheme {
  const style = getComputedStyle(root);
  return buildTerminalTheme((name) => style.getPropertyValue(name));
}

/** Calls `onChange` whenever the page switches theme (data-theme or the day-almanac class). Returns a disposer. */
export function watchTheme(onChange: () => void, root: HTMLElement = document.documentElement): () => void {
  if (typeof MutationObserver === "undefined") return () => {};
  const observer = new MutationObserver(onChange);
  observer.observe(root, { attributes: true, attributeFilter: ["data-theme", "class"] });
  return () => observer.disconnect();
}
