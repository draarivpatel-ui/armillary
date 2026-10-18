/**
 * Capture page: the first run with no autoplay. A capture script drives it frame by frame through
 * window.__armillaryFirstRun (script, seek), so the same t always gives the same pixels.
 */
import { createRoot } from "react-dom/client";
import logJson from "./data/mockEventLog.json";
import { FirstRun } from "./host/FirstRun";
import { RecordedSource } from "./sources";

const params = new URLSearchParams(location.search);
const source = RecordedSource.fromJson(logJson);
const renderer = (params.get("renderer") as "auto" | "webgl2" | "canvas2d" | null) ?? "auto";
const reduced = params.get("reduced") === "1";
// ?autoplay=1 plays the scripted run in real time (consent at ?consent=, default 9600 ms) for
// frame-time measurement; ?fps=1 prints the frame-time percentiles to the console.
const autoplay = params.get("autoplay") === "1";
const fps = params.get("fps") === "1";

createRoot(document.getElementById("root")!).render(
  <FirstRun
    source={source}
    renderer={renderer}
    reducedMotion={reduced}
    capture
    fpsLog={fps ? (line) => console.log("[armillary-fps] " + line) : undefined}
    onComplete={() => undefined}
  />,
);

if (autoplay) {
  const start = () => {
    const api = window.__armillaryFirstRun;
    if (!api || !api.ready) return void requestAnimationFrame(start);
    void api.script({ consentAt: Number(params.get("consent") ?? 9600) }).then(() => {
      void api.seek(0).then(() => api.play());
    });
  };
  requestAnimationFrame(start);
}
