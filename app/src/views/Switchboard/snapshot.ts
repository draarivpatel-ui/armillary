import {
  configList,
  isDesktopShell,
  isUsingFixtureData,
  type ConfigListOptions,
} from "../../api/config";
import type { ConfigSnapshot } from "./types";

export { isDesktopShell, isUsingFixtureData };
export type LoadOptions = ConfigListOptions;

export async function loadConfigSnapshot(options: LoadOptions = {}): Promise<ConfigSnapshot> {
  return configList(options);
}
