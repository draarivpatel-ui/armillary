export interface ThemeTokens {
  ink0: string;
  ink1: string;
  ink2: string;
  line: string;
  gilt: string;
  giltSoft: string;
  vermilion: string;
  verdigris: string;
  star: string;
  dust: string;
  parchment: string;
  // Semantic foreground tokens for accessible component contrast (WCAG AA >= 4.5:1)
  verdigrisText: string;
  vermilionText: string;
  giltText: string;
  listSelectedFg: string;
  buttonDestructiveFg: string;
  buttonGiltFg: string;
}

export const darkTokens: ThemeTokens = {
  ink0: "#0B1220",
  ink1: "#111A2E",
  ink2: "#18233B",
  line: "#2A3756",
  gilt: "#C9A24A",
  giltSoft: "#E2C77E",
  vermilion: "#D2462E",
  verdigris: "#3E8E7E",
  star: "#F4F1E8",
  dust: "#8E9AB4",
  parchment: "#F1E8D5",
  verdigrisText: "#4EBAA4",
  vermilionText: "#F06B52",
  giltText: "#C9A24A",
  listSelectedFg: "#E2C77E",
  buttonDestructiveFg: "#FFFFFF",
  buttonGiltFg: "#0B1220",
};

/**
 * Light "Day almanac" theme.
 * Note: dust is tuned to #63594A (from #6B6152) to guarantee >= 4.5:1 contrast
 * on ink-2 (#DFD1B4) per WCAG AA specification.
 */
export const lightTokens: ThemeTokens = {
  ink0: "#F3EBDA",
  ink1: "#EADFC8",
  ink2: "#DFD1B4",
  line: "#C9B78F",
  gilt: "#8A6A22",
  giltSoft: "#A88634",
  vermilion: "#B83A24",
  verdigris: "#2F6F62",
  star: "#1D1A14",
  dust: "#63594A",
  parchment: "#FBF6EA",
  verdigrisText: "#1E584D",
  vermilionText: "#872210",
  giltText: "#5C4410",
  listSelectedFg: "#5C4410",
  buttonDestructiveFg: "#FFFFFF",
  buttonGiltFg: "#FFFFFF",
};

export const familyColors = {
  anthropic: "#D08A5C",
  openai: "#6FB7A8",
  google: "#7A9CE0",
  "github-microsoft": "#9C8ADE",
  cursor: "#B9B2A6",
  "open-source-clis": "#C9A24A",
  "chinese-labs": "#D46A6A",
  other: "#8E9AB4",
} as const;

export type AgentFamily = keyof typeof familyColors;

export function getLuminance(hex: string): number {
  const cleanHex = hex.replace("#", "");
  const r = parseInt(cleanHex.substring(0, 2), 16) / 255;
  const g = parseInt(cleanHex.substring(2, 4), 16) / 255;
  const b = parseInt(cleanHex.substring(4, 6), 16) / 255;

  const toLinear = (c: number) =>
    c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);

  return 0.2126 * toLinear(r) + 0.7152 * toLinear(g) + 0.0722 * toLinear(b);
}

export function getContrastRatio(foreground: string, background: string): number {
  const l1 = getLuminance(foreground);
  const l2 = getLuminance(background);
  const brighter = Math.max(l1, l2);
  const darker = Math.min(l1, l2);
  return (brighter + 0.05) / (darker + 0.05);
}
