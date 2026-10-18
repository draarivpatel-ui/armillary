import { AgentFamily, OrreryTheme } from './types';

export interface ObservatoryPalette {
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
  /** Text tokens (WCAG AA on the ink steps); raw accents are for lines and fills only. */
  giltText: string;
  vermilionText: string;
  verdigrisText: string;
  agents: Record<AgentFamily, string>;
}

export const FALLBACK_DARK: ObservatoryPalette = {
  ink0: '#0B1220',
  ink1: '#111A2E',
  ink2: '#18233B',
  line: '#2A3756',
  gilt: '#C9A24A',
  giltSoft: '#E2C77E',
  vermilion: '#D2462E',
  verdigris: '#3E8E7E',
  star: '#F4F1E8',
  dust: '#8E9AB4',
  parchment: '#F1E8D5',
  giltText: '#C9A24A',
  vermilionText: '#F06B52',
  verdigrisText: '#4EBAA4',
  agents: {
    anthropic: '#D08A5C',
    openai: '#6FB7A8',
    google: '#7A9CE0',
    github: '#9C8ADE',
    cursor: '#B9B2A6',
    'open-source': '#C9A24A',
    chinese: '#D46A6A',
    other: '#8E9AB4',
  },
};

export const FALLBACK_LIGHT: ObservatoryPalette = {
  ink0: '#F3EBDA',
  ink1: '#EADFC8',
  ink2: '#DFD1B4',
  line: '#C9B78F',
  gilt: '#8A6A22',
  giltSoft: '#A88634',
  vermilion: '#B83A24',
  verdigris: '#2F6F62',
  star: '#1D1A14',
  dust: '#63594A',
  parchment: '#FBF6EA',
  giltText: '#5C4410',
  vermilionText: '#872210',
  verdigrisText: '#1E584D',
  agents: {
    anthropic: '#D08A5C',
    openai: '#6FB7A8',
    google: '#7A9CE0',
    github: '#9C8ADE',
    cursor: '#B9B2A6',
    'open-source': '#C9A24A',
    chinese: '#D46A6A',
    other: '#8E9AB4',
  },
};

/**
 * Reads CSS variables from the DOM element (or document root) at runtime,
 * falling back to the canonical SPEC tokens if not in a browser environment or
 * variables are undefined.
 */
export function getPalette(
  theme: OrreryTheme = 'dark',
  container?: HTMLElement | null
): ObservatoryPalette {
  const fallback = theme === 'dark' ? FALLBACK_DARK : FALLBACK_LIGHT;

  if (typeof window === 'undefined' || typeof document === 'undefined') {
    return fallback;
  }

  const target = container || document.documentElement;
  const style = window.getComputedStyle(target);

  const getVar = (varName: string, fallbackVal: string): string => {
    const val = style.getPropertyValue(varName).trim();
    return val || fallbackVal;
  };

  return {
    ink0: getVar('--ink-0', fallback.ink0),
    ink1: getVar('--ink-1', fallback.ink1),
    ink2: getVar('--ink-2', fallback.ink2),
    line: getVar('--line', fallback.line),
    gilt: getVar('--gilt', fallback.gilt),
    giltSoft: getVar('--gilt-soft', fallback.giltSoft),
    vermilion: getVar('--vermilion', fallback.vermilion),
    verdigris: getVar('--verdigris', fallback.verdigris),
    star: getVar('--star', fallback.star),
    dust: getVar('--dust', fallback.dust),
    parchment: getVar('--parchment', fallback.parchment),
    giltText: getVar('--gilt-text', fallback.giltText),
    vermilionText: getVar('--vermilion-text', fallback.vermilionText),
    verdigrisText: getVar('--verdigris-text', fallback.verdigrisText),
    agents: {
      anthropic: getVar('--agent-anthropic', fallback.agents.anthropic),
      openai: getVar('--agent-openai', fallback.agents.openai),
      google: getVar('--agent-google', fallback.agents.google),
      github: getVar('--agent-github', fallback.agents.github),
      cursor: getVar('--agent-cursor', fallback.agents.cursor),
      'open-source': getVar('--agent-open-source', fallback.agents['open-source']),
      chinese: getVar('--agent-chinese', fallback.agents.chinese),
      other: getVar('--agent-other', fallback.agents.other),
    },
  };
}
