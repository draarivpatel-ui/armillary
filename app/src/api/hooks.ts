/**
 * Small data hooks shared by the views. They hold no markup: views decide how to show the data.
 */
import { useEffect, useState } from "react";
import { getProjectBasename, sessionsQueryAll } from "./archive";

export interface ProjectRoot {
  /** The exact project_root the core filters on. */
  root: string;
  /** Folder name for display. */
  name: string;
  sessions: number;
}

/** Distinct project roots across the archive's sessions (unknown roots left out), sorted by name. */
export function projectRootsOf(sessions: ReadonlyArray<{ project_root?: string | null }>): ProjectRoot[] {
  const counts = new Map<string, number>();
  for (const s of sessions) {
    if (!s.project_root) continue;
    counts.set(s.project_root, (counts.get(s.project_root) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([root, n]) => ({ root, name: getProjectBasename(root), sessions: n }))
    .sort((a, b) => a.name.localeCompare(b.name) || a.root.localeCompare(b.root));
}

/** Every known project root, from the archive. Empty while loading or on error. */
export function useProjectRoots(): ProjectRoot[] {
  const [roots, setRoots] = useState<ProjectRoot[]>([]);
  useEffect(() => {
    let active = true;
    sessionsQueryAll({}, 5000)
      .then((page) => {
        if (active) setRoots(projectRootsOf(page.items));
      })
      .catch(() => {
        if (active) setRoots([]);
      });
    return () => {
      active = false;
    };
  }, []);
  return roots;
}
