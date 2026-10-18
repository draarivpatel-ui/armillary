import { getProjectBasename, type Session } from "../../api/archive";

/**
 * Day pages: sessions grouped by calendar day (newest first, "Undated" last), then by project.
 * Every height here is exact, because the rows have fixed heights in the stylesheet: that is what lets the
 * virtual list place and window the days without measuring them.
 */

/** A session row: title line plus meta line. */
export const ROW_HEIGHT = 60;
/** A session row that also lists touched files. */
export const ROW_FILES_HEIGHT = 82;
/** Project name and path line. */
export const PROJECT_HEAD_HEIGHT = 36;
/** Space after a project group. */
export const PROJECT_GAP = 20;
export const DAY_PAD_TOP = 32;
export const DAY_PAD_BOTTOM = 12;
/** Least height of a day page (the left column: numeral, weekday, month). */
export const DAY_MIN_HEIGHT = 132;
/** Most files named on a row before "+N more". */
export const MAX_FILES = 3;

export interface ProjectGroup {
  key: string;
  /** Folder name, or "Unknown project" when the session has no root. */
  name: string;
  /** Full project root, or null when unknown. */
  root: string | null;
  sessions: Session[];
  height: number;
}

export interface DayGroup {
  /** YYYY-MM-DD in local time, or "undated". */
  key: string;
  dated: boolean;
  /** Local midnight of the day (0 when undated). */
  dayStartMs: number;
  sessionCount: number;
  projects: ProjectGroup[];
  top: number;
  height: number;
}

export interface DayLayout {
  days: DayGroup[];
  totalHeight: number;
  /** Every session in display order. */
  order: string[];
  /** Absolute offset of each session row from the top of the list. */
  sessionTop: Map<string, number>;
  projectCount: number;
  datedDayCount: number;
}

/** Files a session touched, when the data carries them (the contract does not yet). */
export function touchedFilesOf(session: Session): string[] {
  const value = (session as Session & { touched_files?: unknown }).touched_files;
  if (!Array.isArray(value)) return [];
  return value.filter((f): f is string => typeof f === "string" && f.length > 0);
}

export function fileBasename(path: string): string {
  const parts = path.replace(/[/\\]+$/, "").split(/[/\\]/);
  return parts[parts.length - 1] || path;
}

export function rowHeight(session: Session): number {
  return touchedFilesOf(session).length > 0 ? ROW_FILES_HEIGHT : ROW_HEIGHT;
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

export function dayKeyOf(startedAt: number): string {
  const d = new Date(startedAt);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** A length of time without zero parts: 42s, 48m, 1h 30m, 2h. Seconds are dropped from one minute on. */
export function formatSessionDuration(ms: number): string {
  const totalSecs = Math.max(0, Math.floor(ms / 1000));
  if (totalSecs < 60) return `${totalSecs}s`;
  const totalMins = Math.floor(totalSecs / 60);
  if (totalMins < 60) return `${totalMins}m`;
  const hours = Math.floor(totalMins / 60);
  const mins = totalMins % 60;
  return mins === 0 ? `${hours}h` : `${hours}h ${mins}m`;
}

/** Keeps the start and the end of a long path: /Users/me/.../final-folder. */
export function middleTruncate(text: string, max = 48): string {
  if (text.length <= max) return text;
  const keep = max - 3;
  const tail = Math.ceil(keep * 0.55);
  const head = keep - tail;
  return `${text.slice(0, head)}...${text.slice(text.length - tail)}`;
}

export function buildDayLayout(sessions: readonly Session[]): DayLayout {
  const dayMap = new Map<string, { dated: boolean; dayStartMs: number; sessions: Session[] }>();
  for (const session of sessions) {
    const dated = Boolean(session.started_at);
    const key = dated ? dayKeyOf(session.started_at as number) : "undated";
    let entry = dayMap.get(key);
    if (!entry) {
      let dayStartMs = 0;
      if (dated) {
        const d = new Date(session.started_at as number);
        dayStartMs = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
      }
      entry = { dated, dayStartMs, sessions: [] };
      dayMap.set(key, entry);
    }
    entry.sessions.push(session);
  }

  const ordered = Array.from(dayMap.entries()).sort(([, a], [, b]) => {
    if (a.dated !== b.dated) return a.dated ? -1 : 1;
    return b.dayStartMs - a.dayStartMs;
  });

  const days: DayGroup[] = [];
  const order: string[] = [];
  const sessionTop = new Map<string, number>();
  const roots = new Set<string>();
  let top = 0;
  let datedDayCount = 0;

  for (const [key, entry] of ordered) {
    if (entry.dated) datedDayCount += 1;

    const projectMap = new Map<string, Session[]>();
    for (const s of entry.sessions) {
      const projectKey = s.project_root || "";
      const list = projectMap.get(projectKey);
      if (list) list.push(s);
      else projectMap.set(projectKey, [s]);
      if (s.project_root) roots.add(s.project_root);
    }

    let cursor = top + DAY_PAD_TOP;
    const projects: ProjectGroup[] = [];
    for (const [root, list] of projectMap) {
      cursor += PROJECT_HEAD_HEIGHT;
      let rows = 0;
      for (const s of list) {
        sessionTop.set(s.id, cursor + rows);
        order.push(s.id);
        rows += rowHeight(s);
      }
      cursor += rows + PROJECT_GAP;
      projects.push({
        key: root || "unknown",
        name: root ? getProjectBasename(root) : "Unknown project",
        root: root || null,
        sessions: list,
        height: PROJECT_HEAD_HEIGHT + rows + PROJECT_GAP,
      });
    }

    const height = Math.max(DAY_MIN_HEIGHT, cursor + DAY_PAD_BOTTOM - top);
    days.push({
      key,
      dated: entry.dated,
      dayStartMs: entry.dayStartMs,
      sessionCount: entry.sessions.length,
      projects,
      top,
      height,
    });
    top += height;
  }

  return {
    days,
    totalHeight: top,
    order,
    sessionTop,
    projectCount: roots.size,
    datedDayCount,
  };
}
