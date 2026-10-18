import type { Theme } from "../types";

export type ThemeName = Theme;

export type TokenName =
  | "ink-0"
  | "ink-1"
  | "ink-2"
  | "line"
  | "gilt"
  | "gilt-soft"
  | "vermilion"
  | "verdigris"
  | "star"
  | "dust"
  | "parchment"
  | "page-ink"
  | "page-muted"
  | "page-gilt"
  | "page-verdigris"
  | "gilt-text"
  | "verdigris-text"
  | "vermilion-text"
  | "vermilion-page"
  | "page-line"
  | "page-edge";

export type TokenTable = Record<TokenName, string>;

const DARK: TokenTable = {
  "ink-0": "#0B1220",
  "ink-1": "#111A2E",
  "ink-2": "#18233B",
  line: "#2A3756",
  gilt: "#C9A24A",
  "gilt-soft": "#E2C77E",
  vermilion: "#D2462E",
  verdigris: "#3E8E7E",
  star: "#F4F1E8",
  dust: "#8E9AB4",
  parchment: "#F1E8D5",
  "page-ink": "#1D1A14",
  "page-muted": "#454034",
  "page-gilt": "#6E5417",
  "page-verdigris": "#2F6F62",
  "gilt-text": "#C9A24A",
  "verdigris-text": "#57B3A2",
  "vermilion-text": "#E5715A",
  "vermilion-page": "#B83A24",
  "page-line": "#CDBB94",
  "page-edge": "#E4D7BC",
};

const LIGHT: TokenTable = {
  "ink-0": "#F3EBDA",
  "ink-1": "#EADFC8",
  "ink-2": "#DFD1B4",
  line: "#C9B78F",
  gilt: "#8A6A22",
  "gilt-soft": "#A88634",
  vermilion: "#B83A24",
  verdigris: "#2F6F62",
  star: "#1D1A14",
  dust: "#63594A",
  parchment: "#FBF6EA",
  "page-ink": "#1D1A14",
  "page-muted": "#454034",
  "page-gilt": "#6E5417",
  "page-verdigris": "#2F6F62",
  "gilt-text": "#6E5417",
  "verdigris-text": "#2F6F62",
  "vermilion-text": "#B83A24",
  "vermilion-page": "#B83A24",
  "page-line": "#D6C6A2",
  "page-edge": "#EFE5D0",
};

export const palette: Record<ThemeName, TokenTable> = { dark: DARK, light: LIGHT };

export const TOKEN_NAMES = Object.keys(DARK) as TokenName[];

/** Font stacks. The design package bundles the real faces; until it lands these fall back to the system. */
export const fontStacks = {
  display: "'Cormorant Garamond', 'Cormorant', 'Iowan Old Style', Palatino, Georgia, serif",
  body: "'Instrument Sans', 'Helvetica Neue', Helvetica, Arial, sans-serif",
  mono: "'Commit Mono', ui-monospace, 'SF Mono', Menlo, Consolas, monospace",
};

/** Type sizes on the 8 px rhythm: UI 14, Folio body 16 at 1.6 line height. */
export const typeScale = {
  small: 12,
  ui: 14,
  folioBody: 16,
  prompt: 20,
  title: 24,
  display: 32,
  rhythm: 8,
};

function channel(value: number): number {
  const v = value / 255;
  return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
}

export function relativeLuminance(hex: string): number {
  const digits = hex.replace("#", "");
  const full = digits.length === 3 ? digits.split("").map((c) => c + c).join("") : digits;
  const r = parseInt(full.slice(0, 2), 16);
  const g = parseInt(full.slice(2, 4), 16);
  const b = parseInt(full.slice(4, 6), 16);
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

function resolve(color: string, theme: ThemeName): string {
  if (color.startsWith("#")) return color;
  const table = palette[theme] as Record<string, string>;
  return table[color] ?? table[color.replace(/-/g, "")] ?? color;
}

/** WCAG 2.1 contrast ratio. Colours may be given as hex values or as token names. */
export function contrastRatio(foreground: string, background: string, theme: ThemeName = "dark"): number {
  const l1 = relativeLuminance(resolve(foreground, theme));
  const l2 = relativeLuminance(resolve(background, theme));
  const lighter = Math.max(l1, l2);
  const darker = Math.min(l1, l2);
  return (lighter + 0.05) / (darker + 0.05);
}

export interface TextPair {
  theme: ThemeName;
  fg: TokenName;
  bg: TokenName;
  label: string;
}

/** Every colour pair the Folio uses for text. All must clear 4.5:1. */
export const TEXT_PAIRS: TextPair[] = [
  { theme: "dark", fg: "star", bg: "ink-0", label: "shell text on the window" },
  { theme: "dark", fg: "star", bg: "ink-1", label: "shell text on a panel" },
  { theme: "dark", fg: "star", bg: "ink-2", label: "code text on a raised panel" },
  { theme: "dark", fg: "dust", bg: "ink-0", label: "secondary text on the window" },
  { theme: "dark", fg: "dust", bg: "ink-2", label: "comments and file lists" },
  { theme: "dark", fg: "gilt", bg: "ink-0", label: "gilt accent on the window" },
  { theme: "dark", fg: "gilt", bg: "ink-2", label: "code keywords" },
  { theme: "dark", fg: "gilt-soft", bg: "ink-0", label: "highlight on the window" },
  { theme: "dark", fg: "gilt-soft", bg: "ink-2", label: "numbers in code" },
  { theme: "dark", fg: "verdigris-text", bg: "ink-1", label: "strings and success on a panel" },
  { theme: "dark", fg: "verdigris-text", bg: "ink-2", label: "strings in code" },
  { theme: "dark", fg: "vermilion-text", bg: "ink-0", label: "alerts on the window" },
  { theme: "dark", fg: "vermilion-text", bg: "ink-1", label: "alerts on a panel" },
  { theme: "dark", fg: "page-ink", bg: "parchment", label: "Folio body on the page" },
  { theme: "dark", fg: "page-muted", bg: "parchment", label: "marginalia on the page" },
  { theme: "dark", fg: "vermilion-page", bg: "parchment", label: "error marks on the page" },
  { theme: "dark", fg: "page-gilt", bg: "parchment", label: "gilt accents on the page" },
  { theme: "dark", fg: "page-verdigris", bg: "parchment", label: "added lines on the page" },
  { theme: "light", fg: "star", bg: "ink-0", label: "shell text on the window" },
  { theme: "light", fg: "star", bg: "ink-1", label: "shell text on a panel" },
  { theme: "light", fg: "dust", bg: "ink-0", label: "secondary text on the window" },
  { theme: "light", fg: "dust", bg: "ink-1", label: "secondary text on a panel" },
  { theme: "light", fg: "gilt-text", bg: "ink-0", label: "gilt accent on the window" },
  { theme: "light", fg: "gilt-text", bg: "ink-1", label: "code keywords on a panel" },
  { theme: "light", fg: "verdigris-text", bg: "ink-0", label: "strings on the window" },
  { theme: "light", fg: "vermilion-text", bg: "ink-0", label: "alerts on the window" },
  { theme: "light", fg: "page-ink", bg: "parchment", label: "Folio body on the page" },
  { theme: "light", fg: "page-muted", bg: "parchment", label: "marginalia on the page" },
  { theme: "light", fg: "vermilion-page", bg: "parchment", label: "error marks on the page" },
  { theme: "light", fg: "page-gilt", bg: "parchment", label: "gilt accents on the page" },
  { theme: "light", fg: "page-verdigris", bg: "parchment", label: "added lines on the page" },
];

export function failingTextPairs(): TextPair[] {
  return TEXT_PAIRS.filter((pair) => contrastRatio(pair.fg, pair.bg, pair.theme) < 4.5);
}
