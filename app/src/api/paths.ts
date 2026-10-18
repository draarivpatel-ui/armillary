/**
 * Home-relative paths for the UI. Logic (filters, commands) keeps absolute paths; only what is printed
 * goes through `displayPath`, so the app and its screenshots never show `/Users/<name>/...`.
 *
 * The core's `display_context` command reports the home folder (and its canonical spelling, since macOS
 * temp folders appear as /private/tmp/...). In presentation mode the bridge answers it with the snapshot's
 * demo home. Without a core there is nothing to replace and every path is shown as given.
 */
import { useCallback, useEffect, useState } from "react";
import { call, isCoreAvailable } from "./client";

const SEPARATOR = /[\\/]/;
const ABSOLUTE = /^(?:[\\/]|[A-Za-z]:[\\/])/;

/** A home without its trailing separators; null when nothing usable is left (empty, or a filesystem root). */
function normalizeHome(home: string): string | null {
  if (!ABSOLUTE.test(home)) return null;
  const trimmed = home.replace(/[\\/]+$/, "");
  if (trimmed === "" || /^[A-Za-z]:$/.test(trimmed)) return null;
  return trimmed;
}

/**
 * Replace a leading home folder with "~", on a path-component boundary (longest matching home first).
 * Paths that are not absolute, or do not start inside a home, are returned unchanged.
 */
export function displayPath(path: string, homes: readonly string[]): string {
  if (!ABSOLUTE.test(path)) return path;
  const candidates = homes
    .map(normalizeHome)
    .filter((h): h is string => h !== null)
    .sort((a, b) => b.length - a.length);
  for (const home of candidates) {
    if (path === home) return "~";
    if (path.startsWith(home) && SEPARATOR.test(path.charAt(home.length))) {
      return `~${path.slice(home.length)}`;
    }
  }
  return path;
}

// ---------------------------------------------------------------------------------------------------------
// display_context, loaded once per app
// ---------------------------------------------------------------------------------------------------------

type TauriWindow = { __TAURI_INTERNALS__?: unknown };

/** The current core. A different core (tests swap fake ones) invalidates what was loaded from the old one. */
function coreIdentity(): unknown {
  return typeof window === "undefined" ? null : (window as unknown as TauriWindow).__TAURI_INTERNALS__;
}

const NO_HOMES: readonly string[] = [];

let loaded: { core: unknown; homes: readonly string[] } | null = null;
let inflight: { core: unknown } | null = null;
const listeners = new Set<() => void>();

function currentHomes(): readonly string[] {
  return loaded !== null && loaded.core === coreIdentity() ? loaded.homes : NO_HOMES;
}

function ensureLoaded(): void {
  const core = coreIdentity();
  if (!isCoreAvailable()) return;
  if (loaded?.core === core || inflight?.core === core) return;
  const mine = { core };
  inflight = mine;
  const finish = (homes: string[]) => {
    if (inflight !== mine) return; // reset, or another core took over, while this was in flight
    inflight = null;
    loaded = { core, homes };
    listeners.forEach((notify) => notify());
  };
  call<{ home?: string | null; home_canonical?: string | null } | null>("display_context").then(
    (ctx) => finish([ctx?.home, ctx?.home_canonical].filter((h): h is string => typeof h === "string" && h !== "")),
    () => finish([]), // best effort: show paths as they are
  );
}

/** Test helper: forget the loaded home so the next hook asks the core again. */
export function resetDisplayContext(): void {
  loaded = null;
  inflight = null;
}

/** Returns a function that shows a path home-relative. The identity until display_context has loaded, and without a core. */
export function useDisplayPath(): (path: string) => string {
  const [, setVersion] = useState(0);
  useEffect(() => {
    const notify = () => setVersion((v) => v + 1);
    listeners.add(notify);
    ensureLoaded();
    return () => {
      listeners.delete(notify);
    };
  }, []);
  const homes = currentHomes();
  return useCallback((path: string) => displayPath(path, homes), [homes]);
}
