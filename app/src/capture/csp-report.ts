/**
 * Capture builds only (VITE_ARMILLARY_CAPTURE=1): reports Content Security Policy violations and
 * uncaught errors from inside the page, through the existing `ui_trace` command, so a launch under
 * ARMILLARY_TRACE_IPC=1 prints them to stderr. Used by the SEC stream to validate the CSP in the
 * built app (tools/capture-app/csp-tour.json). A normal bundle contains none of this.
 */
import { invoke } from "@tauri-apps/api/core";

const seen = new Set<string>();

function send(line: string): void {
  if (seen.has(line)) return;
  seen.add(line);
  void invoke("ui_trace", { line: `csp ${line}` }).catch(() => {});
}

document.addEventListener("securitypolicyviolation", (e) => {
  send(
    `violation ${e.violatedDirective} blocked=${e.blockedURI || "inline"} at=${(e.sourceFile || "").split("/").pop()}:${e.lineNumber} sample=${JSON.stringify((e.sample || "").slice(0, 60))}`,
  );
});
window.addEventListener("error", (e) => send(`error ${e.message}`));
window.addEventListener("unhandledrejection", (e) => send(`rejection ${String(e.reason).slice(0, 160)}`));

/** Tour hook: `__armillaryCsp.mark` writes a labelled line so violations can be tied to a step. */
(window as unknown as Record<string, unknown>).__armillaryCsp = {
  mark: (label: string) => {
    void invoke("ui_trace", { line: `csp mark ${label}` }).catch(() => {});
  },
};
/** Tour hook: calls a command with no arguments and traces whether Tauri let it through. */
(window as unknown as Record<string, unknown>).__armillaryProbe = async (command: string) => {
  try {
    await invoke(command);
    await invoke("ui_trace", { line: `csp probe ${command} -> reached the handler (ok)` });
  } catch (e) {
    await invoke("ui_trace", { line: `csp probe ${command} -> ${String(e).slice(0, 140)}` }).catch(() => {});
  }
};
send("listener installed");
