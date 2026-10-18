/// <reference types="vite/client" />
interface ImportMetaEnv {
  /** "1" in the presentation web build only (web demo and its capture): bundles the bridge and the sample snapshot. */
  readonly VITE_ARMILLARY_PRESENTATION?: string;
}
