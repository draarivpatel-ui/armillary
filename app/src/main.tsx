import React from "react";
import ReactDOM from "react-dom/client";
import { App } from "./App";
import { FirstRunGate } from "./firstrun/FirstRunGate";
import "@orrery/design/tokens.css";
import "@orrery/design/fonts.css";
import "@orrery/design/primitives.css";
import "./App.css";

// Presentation mode (INT): `?presentation=1` answers the app's commands from the exported snapshot of the
// synthetic dataset (app/src/presentation/bridge.ts). The bridge and the snapshot are lazy chunks, loaded
// only in that mode, and installed before the first render so every view starts on the snapshot.
// Capture build only: report CSP violations from inside the page (see capture/csp-report.ts).
if (import.meta.env.VITE_ARMILLARY_CAPTURE === "1") {
  void import("./capture/csp-report");
}

// Only a presentation build (VITE_ARMILLARY_PRESENTATION=1) contains the bridge and the snapshot at all.
const presentation =
  import.meta.env.VITE_ARMILLARY_PRESENTATION === "1" &&
  new URLSearchParams(window.location.search).get("presentation") === "1";

async function boot(): Promise<void> {
  if (presentation) {
    const { installPresentationFromBuild } = await import("./presentation/bridge");
    const installed = await installPresentationFromBuild();
    if (!installed) console.warn("presentation=1 but this build has no demo/presentation/snapshot.json");
  }
  const rootElement = document.getElementById("root");
  if (rootElement) {
    ReactDOM.createRoot(rootElement).render(
      <React.StrictMode>
        <FirstRunGate sampleData={presentation}>
          {(api) => (
            <App
              sampleData={presentation}
              onReplayFirstRun={api.replay}
              accessGranted={api.accessGranted}
              onDeleteArchive={presentation ? undefined : api.deleteArchive}
            />
          )}
        </FirstRunGate>
      </React.StrictMode>
    );
  }
}

void boot();

// Capture build only (tools/capture-app): the flag is replaced at build time, so a normal bundle
// drops this branch and contains none of the capture runner.
if (import.meta.env.VITE_ARMILLARY_CAPTURE === "1") {
  void import("./capture/boot").then((m) => m.startCapture());
}
