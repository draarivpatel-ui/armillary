/** Live demo of the first run in the browser, replaying the recorded (mock) event log. */
import { createRoot } from "react-dom/client";
import logJson from "./data/mockEventLog.json";
import { FirstRun } from "./host/FirstRun";
import { RecordedSource } from "./sources";

const params = new URLSearchParams(location.search);
const source = RecordedSource.fromJson(logJson);
const renderer = (params.get("renderer") as "auto" | "webgl2" | "canvas2d" | null) ?? "auto";
const reduced = params.get("reduced") === "1" ? true : undefined;
const fps = params.get("fps") === "1";

createRoot(document.getElementById("root")!).render(
  <FirstRun
    source={source}
    renderer={renderer}
    reducedMotion={reduced}
    fpsLog={fps ? (line) => console.log("[armillary-fps] " + line) : undefined}
    onComplete={(r) => console.log("first run complete", r)}
  />,
);
