/** Redaction pass for exports: paths, emails, tokens and keys are masked by pattern. */

export type RedactionLabel = "path" | "email" | "key" | "token";

export interface RedactionPattern {
  label: RedactionLabel;
  pattern: RegExp;
  /** Groups whose content is kept (the label prefix), everything else is masked. */
  keep?: number[];
}

export const REDACTED: Record<RedactionLabel, string> = {
  path: "[masked path]",
  email: "[masked email]",
  key: "[masked key]",
  token: "[masked token]",
};

export const REDACTION_PATTERNS: RedactionPattern[] = [
  { label: "key", pattern: /\bBearer\s+[A-Za-z0-9._~+/-]+=*\s*[A-Za-z0-9._~+/=-]{8,}/g, keep: [0] },
  {
    label: "key",
    pattern: /\b(?:api[_-]?key|access[_-]?token|secret[_-]?key|client[_-]?secret|password)\b\s*[:=]\s*["']?[A-Za-z0-9._~+/=-]*["']?/gi,
  },
  { label: "key", pattern: /\bsk-(?:proj-|live-|test-)?[A-Za-z0-9_-]{16,}/g },
  { label: "key", pattern: /\b(AKIA|ASIA|SA)[0-9A-Z]{16,}\b/g },
  { label: "key", pattern: /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g },
  { label: "key", pattern: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g },
  { label: "email", pattern: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g },
  { label: "path", pattern: /(?:[A-Za-z]:\\(?:[^\\/:*?"<>|\s]+\\?)+)/g },
  { label: "path", pattern: /(?:\/(?:Users|home|var|opt|private|mnt|Volumes)\/[^\s"'`,;:)]+)/g },
  { label: "path", pattern: /(?:~\/[^\s"'`,;:)]+)/g },
];

const MATCHER = new RegExp(
  REDACTION_PATTERNS.map((entry) => `(${entry.pattern.source.replace(/^(\^|\$)/, "")})`).join("|"),
  "gi",
);

function labelFor(text: string): RedactionLabel {
  if (/@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/.test(text) && !text.startsWith("/")) {
    const atIndex = text.lastIndexOf("@");
    const local = text.slice(0, atIndex);
    if (/^[A-Za-z0-9._%+-]+$/.test(local)) return "email";
  }
  if (/^(?:[A-Za-z]:\\|\/(?:Users|home|var|opt|private|mnt|Volumes)\/|~\/)/.test(text)) return "path";
  if (/^Bearer\b/i.test(text)) return "token";
  if (/\b(api[_-]?key|access[_-]?token|secret[_-]?key|client[_-]?secret|password)\b/i.test(text)) return "key";
  return "key";
}

/** Mask every path, email, token and key found in the text. */
export function redact(text: string): string {
  if (!text) return text;
  return text.replace(MATCHER, (matched) => {
    const label = labelFor(matched);
    if (label === "key") {
      const pair = /^(\s*(?:[A-Za-z0-9_-]+\s*[:=]\s*))(.*)$/s.exec(matched);
      if (pair) return `${pair[1]}${REDACTED.key}`;
    }
    if (label === "token") return REDACTED.token;
    return REDACTED[label];
  });
}

export interface RedactionSummary {
  counts: Record<RedactionLabel, number>;
  total: number;
}

export function redactionSummary(text: string): RedactionSummary {
  const counts: Record<RedactionLabel, number> = { path: 0, email: 0, key: 0, token: 0 };
  for (const match of text.matchAll(MATCHER)) {
    counts[labelFor(match[0])] += 1;
  }
  return { counts, total: counts.path + counts.email + counts.key + counts.token };
}

export function containsSensitive(text: string): boolean {
  MATCHER.lastIndex = 0;
  return MATCHER.test(text);
}
