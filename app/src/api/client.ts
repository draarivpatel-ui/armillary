/**
 * The one door between the UI and the Armillary core.
 *
 * Every Tauri command goes through `call` and every core event through `subscribe`, both built on the
 * official @tauri-apps/api (which talks to window.__TAURI_INTERNALS__). The desktop app answers them
 * from Rust; the presentation build (`?presentation=1`) installs a shim at the same window level that
 * answers from a snapshot exported by the real Rust code, so the same client code runs in both.
 *
 * Errors are normalised to `ApiError` with the core's machine-readable `code`
 * (invalid_input, not_found, import_failed, archive_failed, live_failed, consent_required, ...).
 */

import { invoke as tauriInvoke } from "@tauri-apps/api/core";
import { listen as tauriListen } from "@tauri-apps/api/event";

/** Event names emitted by the core (SPEC section 6). */
export type CoreEvent = "import:progress" | "live:update" | "pty:data" | `firstrun:${string}`;

export type Unsubscribe = () => void;

/** Typed error for every failed command. */
export class ApiError extends Error {
  readonly code: string;
  readonly command: string;

  constructor(command: string, code: string, message: string) {
    super(message);
    this.name = "ApiError";
    this.code = code;
    this.command = command;
  }
}

type TauriWindow = {
  __TAURI_INTERNALS__?: { invoke?: unknown };
  __ARMILLARY_PRESENTATION__?: boolean;
  __ARMILLARY_NOW__?: unknown;
};

function tauriWindow(): TauriWindow | null {
  return typeof window === "undefined" ? null : (window as unknown as TauriWindow);
}

/**
 * True when a core answers commands: the desktop app, or the presentation shim.
 * False in a plain browser preview, tests without a fake core, and CI.
 */
export function isCoreAvailable(): boolean {
  return typeof tauriWindow()?.__TAURI_INTERNALS__?.invoke === "function";
}

/** True when the core is the presentation snapshot shim (sample data, shown with a "Sample data" mark). */
export function isPresentation(): boolean {
  return tauriWindow()?.__ARMILLARY_PRESENTATION__ === true;
}

/**
 * "Now" in Unix milliseconds for anything the UI anchors on today (date presets, the default month).
 * The presentation snapshot sets window.__ARMILLARY_NOW__ to its reference time; otherwise the real clock.
 */
export function appNow(): number {
  const pinned = tauriWindow()?.__ARMILLARY_NOW__;
  return typeof pinned === "number" && Number.isFinite(pinned) ? pinned : Date.now();
}

/** Where the data on screen comes from. "mock" only ever happens without a core. */
export type DataMode = "core" | "presentation" | "mock";

export function dataMode(): DataMode {
  if (!isCoreAvailable()) return "mock";
  return isPresentation() ? "presentation" : "core";
}

/** Turn whatever a command rejected with (an ApiError object, a string, an Error) into ApiError. */
export function toApiError(command: string, raw: unknown): ApiError {
  if (raw instanceof ApiError) return raw;
  if (raw && typeof raw === "object") {
    const obj = raw as { code?: unknown; message?: unknown };
    if (typeof obj.code === "string") {
      return new ApiError(command, obj.code, typeof obj.message === "string" ? obj.message : obj.code);
    }
    if (raw instanceof Error) return new ApiError(command, "error", raw.message);
  }
  if (typeof raw === "string") return new ApiError(command, "error", raw);
  return new ApiError(command, "error", `${command} failed`);
}

/** Invoke one core command. Rejects with ApiError; throws "core_unavailable" without a core. */
export async function call<T>(command: string, args: Record<string, unknown> = {}): Promise<T> {
  if (!isCoreAvailable()) {
    throw new ApiError(command, "core_unavailable", "the Armillary core is not running");
  }
  try {
    return await tauriInvoke<T>(command, args);
  } catch (raw) {
    throw toApiError(command, raw);
  }
}

const tracedEvents = new Set<string>();

/**
 * Report the first delivery of each event name to the core's IPC trace (stderr, only when the app runs
 * with ARMILLARY_TRACE_IPC=1; the command is a no-op otherwise). Never sends payload content.
 */
function traceFirstDelivery(event: string): void {
  if (tracedEvents.has(event)) return;
  tracedEvents.add(event);
  call("ui_trace", { line: `event ${event} received by the frontend` }).catch(() => {
    // tracing is best effort
  });
}

/** Subscribe to a core event. Resolves to an unsubscribe function; a no-op without a core. */
export async function subscribe<T>(event: CoreEvent, handler: (payload: T) => void): Promise<Unsubscribe> {
  if (!isCoreAvailable()) return () => {};
  const unlisten = await tauriListen<T>(event, (e) => {
    traceFirstDelivery(event);
    handler(e.payload);
  });
  return unlisten;
}

/** Test helper: forget which events were traced. */
export function resetClientState(): void {
  tracedEvents.clear();
}
