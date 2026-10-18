/**
 * Entry for the capture runner. Imported dynamically from main.tsx only in a frontend build made
 * with VITE_ARMILLARY_CAPTURE=1 (tools/capture-app/run.sh), and only acts when the Rust core
 * (built with --features capture) answers capture_config with a tour. A normal build contains
 * none of this code.
 */
import { invoke } from "@tauri-apps/api/core";
import { runTour, type TourHost } from "./runner";
import { removeProbe, webglProbe } from "./probes";
import { validateTour, type Tour } from "./tour";

const tauriHost: TourHost = {
  snapshot: (name) =>
    invoke<string>("capture_snapshot", { name, viewport: { width: window.innerWidth, height: window.innerHeight } }),
  resize: (width, height) => invoke("capture_resize", { width, height }),
  quit: (code) => invoke("capture_quit", { code }),
  report: async (json) => {
    await invoke("capture_report", { json });
  },
};

export async function startCapture(): Promise<void> {
  const raw = await invoke<string | null>("capture_config").catch(() => null);
  if (!raw) return;
  let tour: Tour;
  try {
    tour = JSON.parse(raw) as Tour;
  } catch (e) {
    await tauriHost.report?.(JSON.stringify({ ok: false, error: `tour is not valid JSON: ${String(e)}` }));
    await tauriHost.quit?.(2);
    return;
  }
  const problems = validateTour(tour);
  if (problems.length > 0) {
    await tauriHost.report?.(JSON.stringify({ ok: false, error: "invalid tour", problems }, null, 2));
    await tauriHost.quit?.(2);
    return;
  }
  (window as unknown as Record<string, unknown>).__armillaryCapture = { webglProbe, removeProbe };
  await runTour(tour, tauriHost);
}
