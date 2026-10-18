import { createContext } from "react";

/** The room kept between two note groups. */
export const NOTE_GAP = 12;

/** Breakpoint under which the notes sit under their message in the normal flow (matches the stylesheet). */
export const NARROW_QUERY = "(max-width: 960px)";

/**
 * Child to parent signal: a note opened, closed or changed size, so the page should stack its notes again.
 * The default is a no-op so a static rendering (the HTML export) needs no provider.
 */
export const SidenoteLayoutContext = createContext<() => void>(() => {});

/** The farthest a note group may sit below the top of the message it annotates; past it the reading column yields. */
export const MAX_NOTE_DRIFT = 80;

export interface NoteGroup {
  /** Where the group would sit if nothing were in its way. */
  top: number;
  height: number;
}

/** Walk the groups in reading order: each lands at its own top, or below the group before it plus the gap. */
export function stackGroups(groups: NoteGroup[], gap: number = NOTE_GAP): number[] {
  const placed: number[] = [];
  let previousBottom = Number.NEGATIVE_INFINITY;
  for (const group of groups) {
    const top = Math.max(group.top, previousBottom + gap);
    placed.push(top);
    previousBottom = top + group.height;
  }
  return placed;
}

export interface SidenoteRow {
  /** The row's top with no push applied, relative to the page. */
  top: number;
  /** The notes column's own CSS top inside the row. */
  offset: number;
  /** The height of the row's note group, or null when the row has none. */
  height: number | null;
}

export interface SidenotePlan {
  /** Extra top margin for each row, so the reading column yields to a tall group above. */
  pushes: number[];
  /** Vertical shift for each row's notes column from where it sits once the row has moved. */
  shifts: number[];
  /** Bottom of the last group, and how far every row has moved down in total. */
  groupBottom: number | null;
  pushed: number;
}

/**
 * Bounded drift. A group wants max(its anchor, the group above plus the gap). If that is at most `drift` below its
 * anchor the text flows on and the group sits there. If more, its row moves down by the excess so the group sits
 * exactly `drift` below the row's new top; every later row (and anchor) moves with it. Pure: the pushes are
 * recomputed from natural row tops each time, so they never accumulate across passes.
 */
export function planSidenotes(
  rows: SidenoteRow[],
  drift: number = MAX_NOTE_DRIFT,
  gap: number = NOTE_GAP,
): SidenotePlan {
  const pushes: number[] = [];
  const shifts: number[] = [];
  let moved = 0;
  let previousBottom = Number.NEGATIVE_INFINITY;
  let groupBottom: number | null = null;
  for (const row of rows) {
    if (row.height === null) {
      pushes.push(0);
      shifts.push(0);
      continue;
    }
    const anchor = row.top + moved + row.offset;
    const desired = Math.max(anchor, previousBottom + gap);
    const excess = desired - anchor;
    const push = excess > drift ? excess - drift : 0;
    moved += push;
    pushes.push(push);
    shifts.push(desired - (anchor + push));
    previousBottom = desired + row.height;
    groupBottom = previousBottom;
  }
  return { pushes, shifts, groupBottom, pushed: moved };
}

function isNarrow(): boolean {
  return typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia(NARROW_QUERY).matches;
}

function setIfChanged(node: HTMLElement, name: string, value: string): void {
  if (node.style.getPropertyValue(name) !== value) node.style.setProperty(name, value);
}

function numberVar(node: HTMLElement, name: string): number {
  return parseFloat(node.style.getPropertyValue(name)) || 0;
}

/**
 * Stack the notes of every row in a page. Notes are absolutely positioned beside their row, so the rows keep the
 * height of their message bodies; a group that would drift more than MAX_NOTE_DRIFT from its anchor makes that row
 * yield with an extra top margin (--note-push). The pass writes a push on each row, a vertical shift on each notes
 * column and, for a page that is fully rendered, a bottom overflow so the last group still sits on the leaf.
 * Natural row tops are the measured tops minus the pushes written last time, so running it again is a no-op.
 * A windowed (virtualised) page places rows with translateY, which margins cannot move: there groups only stack
 * within the window and a far-away note is clipped at its edge instead of pushing the text.
 */
export function layoutSidenotes(page: HTMLElement): void {
  const rows = [...page.children].filter(
    (child): child is HTMLElement => child instanceof HTMLElement && child.classList.contains("folio-row--sidenotes"),
  );
  const pageTop = page.getBoundingClientRect().top;
  const narrow = isNarrow();
  const windowed = page.dataset.virtualized === "true";

  const measured: SidenoteRow[] = [];
  const margins: (HTMLElement | null)[] = [];
  let currentPush = 0;
  let lastNaturalBottom = 0;
  for (const row of rows) {
    currentPush += numberVar(row, "--note-push");
    const rect = row.getBoundingClientRect();
    const margin =
      [...row.children].find(
        (child): child is HTMLElement => child instanceof HTMLElement && child.classList.contains("folio-margin"),
      ) ?? null;
    const grouped = margin !== null && margin.childElementCount > 0 && !narrow;
    margins.push(margin);
    lastNaturalBottom = rect.bottom - pageTop - currentPush;
    measured.push({
      top: rect.top - pageTop - currentPush,
      offset: margin?.offsetTop ?? 0,
      height: grouped ? margin!.getBoundingClientRect().height : null,
    });
  }

  const plan = planSidenotes(measured, windowed ? Number.POSITIVE_INFINITY : MAX_NOTE_DRIFT);
  rows.forEach((row, index) => {
    setIfChanged(row, "--note-push", `${plan.pushes[index]}px`);
    const margin = margins[index];
    if (margin) setIfChanged(margin, "--note-shift", `${plan.shifts[index]}px`);
  });

  // only a whole page can run out of leaf under the last note: pad for what hangs past the last row
  let overflow = 0;
  if (!windowed && plan.groupBottom !== null) {
    overflow = Math.max(0, Math.ceil(plan.groupBottom - (lastNaturalBottom + plan.pushed)));
  }
  setIfChanged(page, "--note-overflow", `${overflow}px`);
}
