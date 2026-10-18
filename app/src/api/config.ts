import goldenSnapshot from "../../../fixtures/switchboard/expected/snapshot.json";
import type { Agent, Install } from "@armillary/model";
import type { ConfigSnapshot } from "../views/Switchboard/types";
import { call, isCoreAvailable } from "./client";

export type { Agent, Install };
export * from "../views/Switchboard/types";

export interface ConfigListOptions {
  agentId?: string | null;
  projectRoots?: string[] | null;
}

/** True when a core answers config_list (the desktop app, or the presentation snapshot). */
export function isDesktopShell(): boolean {
  return isCoreAvailable();
}

/** True when the application is falling back to the synthetic fixture snapshot. */
export function isUsingFixtureData(): boolean {
  return !isDesktopShell();
}

/**
 * Fetch the normalized configuration snapshot.
 * In desktop Tauri shell, invokes the Rust config_list command.
 * Outside desktop shell (vite dev, tests, screenshot builds), returns the synthetic switchboard fixture.
 */
export async function configList(options: ConfigListOptions = {}): Promise<ConfigSnapshot> {
  if (isDesktopShell()) {
    const agentId = options.agentId ?? null;
    const projectRoots =
      options.projectRoots && options.projectRoots.length > 0 ? options.projectRoots : null;
    // Errors reach the caller: the desktop app never shows the fixture instead of real data.
    return call<ConfigSnapshot>("config_list", { agentId, projectRoots });
  }
  return structuredClone(goldenSnapshot as unknown as ConfigSnapshot);
}
