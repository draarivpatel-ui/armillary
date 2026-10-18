/**
 * A stand-in for the Tauri IPC layer at the window.__TAURI_INTERNALS__ level, so the app's real client
 * code (@tauri-apps/api invoke and event listen, through app/src/api/client.ts) runs unchanged against
 * a different answerer: the presentation snapshot, or a fake core in tests.
 *
 * It answers `plugin:event|listen` / `plugin:event|unlisten` itself and delivers events the way the
 * Tauri runtime does (by calling the window callback registered with transformCallback).
 */

export type CommandHandler = (command: string, args: Record<string, unknown>) => unknown | Promise<unknown>;

export interface IpcShim {
  /** Deliver an event to every listener registered for it. Returns how many listeners got it. */
  emit(event: string, payload: unknown): number;
  /** Number of live listeners for an event. */
  listenerCount(event: string): number;
  /** Every command invoked so far (event plugin commands excluded). */
  readonly calls: Array<{ command: string; args: Record<string, unknown> }>;
  /** Remove the shim (restores whatever was there before). */
  uninstall(): void;
}

type Internals = {
  invoke?: (command: string, args?: Record<string, unknown>, options?: unknown) => Promise<unknown>;
  transformCallback?: (callback?: (payload: unknown) => void, once?: boolean) => number;
  metadata?: unknown;
};

type ShimWindow = Window & { __TAURI_INTERNALS__?: Internals } & Record<string, unknown>;

export function installIpcShim(handler: CommandHandler): IpcShim {
  const w = window as unknown as ShimWindow;
  const previous = w.__TAURI_INTERNALS__;
  const listeners = new Map<string, Map<number, number>>(); // event -> eventId -> callback id
  const callbacks = new Map<number, (payload: unknown) => void>();
  const calls: Array<{ command: string; args: Record<string, unknown> }> = [];
  let nextCallback = 1;
  let nextEventId = 1;

  const internals: Internals = {
    metadata: { currentWindow: { label: "main" }, currentWebview: { windowLabel: "main", label: "main" } },
    transformCallback(callback, once = false) {
      const id = nextCallback++;
      callbacks.set(id, (payload: unknown) => {
        if (once) callbacks.delete(id);
        callback?.(payload);
      });
      return id;
    },
    async invoke(command: string, args: Record<string, unknown> = {}) {
      if (command === "plugin:event|listen") {
        const event = String(args.event);
        const eventId = nextEventId++;
        const byEvent = listeners.get(event) ?? new Map<number, number>();
        byEvent.set(eventId, Number(args.handler));
        listeners.set(event, byEvent);
        return eventId;
      }
      if (command === "plugin:event|unlisten") {
        listeners.get(String(args.event))?.delete(Number(args.eventId));
        return null;
      }
      if (command.startsWith("plugin:event|")) return null;
      calls.push({ command, args });
      return handler(command, args);
    },
  };
  w.__TAURI_INTERNALS__ = internals;

  return {
    calls,
    emit(event, payload) {
      const byEvent = listeners.get(event);
      if (!byEvent) return 0;
      let delivered = 0;
      for (const [eventId, callbackId] of byEvent) {
        const cb = callbacks.get(callbackId);
        if (cb) {
          cb({ event, id: eventId, payload });
          delivered += 1;
        }
      }
      return delivered;
    },
    listenerCount(event) {
      return listeners.get(event)?.size ?? 0;
    },
    uninstall() {
      if (previous === undefined) delete w.__TAURI_INTERNALS__;
      else w.__TAURI_INTERNALS__ = previous;
    },
  };
}
