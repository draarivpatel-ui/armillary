// Home-relative paths for the UI: the pure helper and the hook that loads display_context once.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanup, renderHook, waitFor } from "@testing-library/react";
import { displayPath, resetDisplayContext, useDisplayPath } from "../src/api/paths";
import { installIpcShim, type IpcShim } from "../src/presentation/ipcShim";

describe("displayPath", () => {
  it("replaces a leading home with ~ on a path-component boundary", () => {
    expect(displayPath("/Users/a/b", ["/Users/a"])).toBe("~/b");
    expect(displayPath("/Users/a/b/c.txt", ["/Users/a"])).toBe("~/b/c.txt");
  });

  it("turns exactly the home into ~", () => {
    expect(displayPath("/Users/a", ["/Users/a"])).toBe("~");
    expect(displayPath("/Users/a/", ["/Users/a"])).toBe("~/");
  });

  it("does not touch a sibling that only shares a prefix", () => {
    expect(displayPath("/Users/ab", ["/Users/a"])).toBe("/Users/ab");
    expect(displayPath("/Users/ab/x", ["/Users/a"])).toBe("/Users/ab/x");
  });

  it("tries the longest matching home first", () => {
    expect(displayPath("/private/tmp/h/.aider", ["/tmp/h", "/private/tmp/h"])).toBe("~/.aider");
    expect(displayPath("/private/tmp/h/x", ["/private", "/private/tmp/h"])).toBe("~/x");
  });

  it("handles a home given with a trailing slash", () => {
    expect(displayPath("/Users/a/b", ["/Users/a/"])).toBe("~/b");
    expect(displayPath("/Users/a", ["/Users/a/"])).toBe("~");
  });

  it("handles Windows-style homes and backslash paths", () => {
    expect(displayPath("C:\\Users\\a\\b", ["C:\\Users\\a"])).toBe("~\\b");
    expect(displayPath("C:\\Users\\a", ["C:\\Users\\a"])).toBe("~");
    expect(displayPath("C:\\Users\\ab\\b", ["C:\\Users\\a"])).toBe("C:\\Users\\ab\\b");
  });

  it("leaves non-absolute input, empty input and a missing home alone", () => {
    expect(displayPath("~/x", ["/Users/a"])).toBe("~/x");
    expect(displayPath("relative/x", ["/Users/a"])).toBe("relative/x");
    expect(displayPath(".crush/crush.db", ["/Users/a"])).toBe(".crush/crush.db");
    expect(displayPath("", ["/Users/a"])).toBe("");
    expect(displayPath("/Users/a/b", [])).toBe("/Users/a/b");
    expect(displayPath("/Users/a/b", [""])).toBe("/Users/a/b");
  });

  it("never turns the filesystem root into a home", () => {
    expect(displayPath("/etc/hosts", ["/"])).toBe("/etc/hosts");
  });
});

describe("useDisplayPath", () => {
  let shim: IpcShim | null = null;

  beforeEach(() => {
    resetDisplayContext();
  });

  afterEach(() => {
    cleanup();
    shim?.uninstall();
    shim = null;
    resetDisplayContext();
  });

  it("is the identity without a core", () => {
    const { result } = renderHook(() => useDisplayPath());
    expect(result.current("/Users/a/b")).toBe("/Users/a/b");
  });

  it("uses both home and home_canonical from display_context, and asks only once per app", async () => {
    shim = installIpcShim((command) =>
      command === "display_context" ? { home: "/tmp/h", home_canonical: "/private/tmp/h" } : null,
    );
    const first = renderHook(() => useDisplayPath());
    const second = renderHook(() => useDisplayPath());
    await waitFor(() => expect(first.result.current("/private/tmp/h/.aider")).toBe("~/.aider"));
    await waitFor(() => expect(second.result.current("/tmp/h/x")).toBe("~/x"));
    expect(first.result.current("/elsewhere/y")).toBe("/elsewhere/y");
    expect(shim.calls.filter((c) => c.command === "display_context")).toHaveLength(1);
    const third = renderHook(() => useDisplayPath());
    await waitFor(() => expect(third.result.current("/tmp/h/z")).toBe("~/z"));
    expect(shim.calls.filter((c) => c.command === "display_context")).toHaveLength(1);
  });

  it("stays the identity when display_context fails or answers nothing", async () => {
    shim = installIpcShim((command) =>
      command === "display_context" ? Promise.reject({ code: "boom", message: "no" }) : null,
    );
    const { result } = renderHook(() => useDisplayPath());
    await waitFor(() => expect(shim!.calls.some((c) => c.command === "display_context")).toBe(true));
    expect(result.current("/Users/a/b")).toBe("/Users/a/b");
  });
});
