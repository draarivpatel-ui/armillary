/**
 * Groups the adapters' raw session statuses into the handful of labels the Almanac shows.
 * Matching ignores case and surrounding whitespace. A raw status that matches no known word
 * becomes its own group, keyed `other:<normalised>` and labelled in sentence case.
 */

export type StatusGroupKey = "open" | "needs" | "finished" | "failed" | "unknown" | `other:${string}`;

export interface StatusGroup {
  key: StatusGroupKey;
  label: string;
}

const FINISHED = ["completed", "complete", "done", "finished", "closed", "success", "succeeded", "ended"];
const OPEN = ["active", "working", "open", "running", "in_progress", "in progress", "live"];
const NEEDS = ["waiting"];
const FAILED = ["failed", "failure", "error", "errored", "crashed", "aborted"];
const UNKNOWN = ["unknown", ""];

const KNOWN: ReadonlyArray<[string[], StatusGroup]> = [
  [OPEN, { key: "open", label: "Open" }],
  [NEEDS, { key: "needs", label: "Needs you" }],
  [FINISHED, { key: "finished", label: "Finished" }],
  [FAILED, { key: "failed", label: "Failed" }],
  [UNKNOWN, { key: "unknown", label: "Unknown" }],
];

/** Fixed groups in display order; anything else follows, alphabetically by label. */
const FIXED_ORDER: readonly StatusGroupKey[] = ["open", "needs", "finished", "failed", "unknown"];

/** Trimmed and lower-cased; null and undefined become the empty string. */
export function normaliseStatus(raw: string | null | undefined): string {
  return (raw ?? "").trim().toLowerCase();
}

function capitaliseFirst(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** The group a raw status belongs to. */
export function statusGroupOf(raw: string | null | undefined): StatusGroup {
  const s = normaliseStatus(raw);
  for (const [words, group] of KNOWN) {
    if (words.includes(s)) return group;
  }
  return { key: `other:${s}`, label: capitaliseFirst(s) };
}

/** Display order: the fixed groups first, then the others A to Z by label. */
export function compareStatusGroups(a: StatusGroup, b: StatusGroup): number {
  const ia = FIXED_ORDER.indexOf(a.key);
  const ib = FIXED_ORDER.indexOf(b.key);
  if (ia !== -1 || ib !== -1) {
    if (ia === -1) return 1;
    if (ib === -1) return -1;
    return ia - ib;
  }
  return a.label.localeCompare(b.label);
}

/** One entry per group present in `raws`, in display order. */
export function groupStatuses(raws: readonly string[]): StatusGroup[] {
  const byKey = new Map<string, StatusGroup>();
  for (const raw of raws) {
    const group = statusGroupOf(raw);
    if (!byKey.has(group.key)) byKey.set(group.key, group);
  }
  return Array.from(byKey.values()).sort(compareStatusGroups);
}

/** The exact raw statuses in `raws` that belong to the group `key`. */
export function rawStatusesIn(key: string, raws: readonly string[]): string[] {
  return raws.filter((raw) => statusGroupOf(raw).key === key);
}
