import type { FamilyKey } from "../events";
import type { RGB } from "./types";

const hex = (h: string): RGB => [parseInt(h.slice(1, 3), 16) / 255, parseInt(h.slice(3, 5), 16) / 255, parseInt(h.slice(5, 7), 16) / 255];

/** SPEC 3.1, dark (the first run is always the night sky). */
export const C = {
  ink0: hex("#0B1220"),
  ink1: hex("#111A2E"),
  ink2: hex("#18233B"),
  line: hex("#2A3756"),
  gilt: hex("#C9A24A"),
  giltSoft: hex("#E2C77E"),
  giltDeep: hex("#8A6A22"),
  vermilion: hex("#D2462E"),
  verdigris: hex("#3E8E7E"),
  star: hex("#F4F1E8"),
  dust: hex("#8E9AB4"),
  parchment: hex("#F1E8D5"),
  /** Day almanac ink-0, for the light-theme hand-over. */
  parchmentInk: hex("#F3EBDA"),
  engraveInk: hex("#2B1F08"),
} as const;

/** SPEC 3.2 family colours. */
export const FAMILY: Record<FamilyKey, RGB> = {
  anthropic: hex("#D08A5C"),
  openai: hex("#6FB7A8"),
  google: hex("#7A9CE0"),
  "github-microsoft": hex("#9C8ADE"),
  cursor: hex("#B9B2A6"),
  "open-source-clis": hex("#C9A24A"),
  "chinese-labs": hex("#D46A6A"),
  other: hex("#8E9AB4"),
};

export const css = (c: RGB, a = 1): string =>
  `rgba(${Math.round(c[0] * 255)}, ${Math.round(c[1] * 255)}, ${Math.round(c[2] * 255)}, ${Math.max(0, Math.min(1, a)).toFixed(3)})`;

export const mixRGB = (a: RGB, b: RGB, t: number): RGB => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];

/** Fonts (design/fonts, bundled with their OFL licences). */
export const FONT = {
  display: '"Cormorant Garamond", "Cormorant", Georgia, serif',
  sans: '"Instrument Sans", system-ui, sans-serif',
  mono: '"Commit Mono", ui-monospace, monospace',
} as const;
