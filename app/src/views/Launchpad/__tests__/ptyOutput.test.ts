import { describe, it, expect, vi } from "vitest";

const { mockListen } = vi.hoisted(() => ({ mockListen: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: (...args: unknown[]) => mockListen(...args),
}));

import { createPtyOutputHub } from "../ptyOutput";

describe("createPtyOutputHub", () => {
  it("ignores output that arrives after a session is closed (sol-loop N8)", async () => {
    let emit: ((event: { payload: { id: string; data: string } }) => void) | null = null;
    mockListen.mockImplementation((_event: string, cb: typeof emit) => {
      emit = cb;
      return Promise.resolve(() => {});
    });
    const hub = createPtyOutputHub();
    await hub.ready();
    const sink = vi.fn();
    const unsubscribe = hub.subscribe("pty-1", sink);
    emit!({ payload: { id: "pty-1", data: "before close" } });
    unsubscribe();
    hub.forget("pty-1");
    // The reader thread flushes its last bytes after pty_close returned.
    emit!({ payload: { id: "pty-1", data: "late tail" } });
    const later = vi.fn();
    hub.subscribe("pty-1", later);
    await Promise.resolve();
    expect(sink.mock.calls).toEqual([["before close"]]);
    expect(later).not.toHaveBeenCalled();
    // Other sessions still queue until their tab subscribes.
    emit!({ payload: { id: "pty-2", data: "early" } });
    const other = vi.fn();
    hub.subscribe("pty-2", other);
    await Promise.resolve();
    expect(other.mock.calls).toEqual([["early"]]);
  });
});
