/// <reference types="vite/client" />
interface ImportMetaEnv {
  /** "1" in the capture frontend build only (tools/capture-app/run.sh). */
  readonly VITE_ARMILLARY_CAPTURE?: string;
}
