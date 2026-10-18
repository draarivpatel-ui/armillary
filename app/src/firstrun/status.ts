import type { FirstRunStatus } from "@orrery/firstrun";

export const FIRSTRUN_STORAGE_KEY = "armillary.firstrun";

const FRESH: FirstRunStatus = { consented: false, completed: false };

export function readLocalStatus(): FirstRunStatus {
  try {
    const raw = window.localStorage.getItem(FIRSTRUN_STORAGE_KEY);
    if (!raw) return { ...FRESH };
    const v = JSON.parse(raw) as Partial<FirstRunStatus> | null;
    return { consented: v?.consented === true, completed: v?.completed === true };
  } catch {
    return { ...FRESH };
  }
}

export function writeLocalStatus(patch: Partial<FirstRunStatus>): void {
  try {
    window.localStorage.setItem(FIRSTRUN_STORAGE_KEY, JSON.stringify({ ...readLocalStatus(), ...patch }));
  } catch {
    // storage unavailable: the first run will simply show again next time
  }
}

export function firstRunForced(search: string): boolean {
  return new URLSearchParams(search).get("firstrun") === "1";
}

export function shouldShowFirstRun({ forced, status }: { forced: boolean; status: FirstRunStatus }): boolean {
  return forced || !status.completed;
}
