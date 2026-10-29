import { listen } from "@tauri-apps/api/event";
import type { PtyDataEvent } from "./types";

/** Characters kept per session while no terminal shows it yet; the oldest go first past this. */
const MAX_PENDING = 1 << 20;

export interface PtyOutputHub {
  /** Starts the one `pty:data` listener. Awaited before `pty_open`, so no early output is lost. */
  ready(): Promise<void>;
  /** Sends a session's output to `sink`, starting with what arrived before it subscribed. */
  subscribe(id: string, sink: (data: string) => void): () => void;
  /** Drops a closed session's sink and anything still waiting for it, and ignores its later output. */
  forget(id: string): void;
  dispose(): void;
}

/**
 * The Launchpad's terminal output: one listener for every session, started before a PTY opens.
 * A tab mounts only after `pty_open` returns and React renders it, and a program prints its first
 * lines (a shell prompt, a banner) in that gap; they wait here until the tab subscribes.
 */
export function createPtyOutputHub(): PtyOutputHub {
  const sinks = new Map<string, (data: string) => void>();
  const pending = new Map<string, string[]>();
  // Closed sessions. Their reader thread is not joined, so output (its last bytes at EOF) can
  // still arrive after `pty_close`; it would otherwise wait forever for a tab that is gone.
  // Session ids are never reused while the app runs.
  const closed = new Set<string>();
  let listening: Promise<() => void> | null = null;

  const deliver = ({ id, data }: PtyDataEvent) => {
    if (closed.has(id)) return;
    const sink = sinks.get(id);
    // Output that waits for a subscriber is delivered first, so later output queues behind it.
    if (sink && !pending.has(id)) {
      sink(data);
      return;
    }
    const queue = pending.get(id) ?? [];
    queue.push(data);
    let size = queue.reduce((n, chunk) => n + chunk.length, 0);
    while (size > MAX_PENDING && queue.length > 1) size -= queue.shift()!.length;
    pending.set(id, queue);
  };

  return {
    ready() {
      if (!listening) {
        // Inside a promise, so a listen that throws (no core in this window) is a rejection too.
        listening = Promise.resolve().then(() =>
          listen<PtyDataEvent>("pty:data", (event) => deliver(event.payload)),
        );
        listening.catch(() => {
          listening = null;
        });
      }
      return listening.then(() => undefined);
    },
    subscribe(id, sink) {
      sinks.set(id, sink);
      // StrictMode runs a tab's effect, its cleanup (disposing that terminal) and the effect again
      // in one go. The queue is handed over only after that, to the subscription that stayed.
      if (pending.has(id)) {
        queueMicrotask(() => {
          if (sinks.get(id) !== sink) return;
          const queued = pending.get(id);
          pending.delete(id);
          queued?.forEach((chunk) => sink(chunk));
        });
      }
      return () => {
        if (sinks.get(id) === sink) sinks.delete(id);
      };
    },
    forget(id) {
      closed.add(id);
      sinks.delete(id);
      pending.delete(id);
    },
    dispose() {
      const current = listening;
      listening = null;
      current?.then((unlisten) => unlisten()).catch(() => {});
      sinks.clear();
      pending.clear();
    },
  };
}
