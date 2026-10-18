// SEC: the Tauri capability file, the command manifest in build.rs and the CSP in
// tauri.conf.json are checked against what the frontend and main.rs actually use, so a new
// command or event cannot ship with a forgotten (or over-broad) permission.
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

// APP_TAURI_DIR lets the checks run against another copy of src-tauri (used to show the
// tests fail on the pre-hardening files).
const TAURI = process.env.APP_TAURI_DIR ?? path.resolve(__dirname, "../src-tauri");
const SRC = path.resolve(__dirname, "../src");

const read = (...parts: string[]) => readFileSync(path.join(TAURI, ...parts), "utf8");
const json = (...parts: string[]) => JSON.parse(read(...parts));

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.(ts|tsx)$/.test(name) && !/\.test\.(ts|tsx)$/.test(name) && !full.includes("__tests__")) {
      out.push(full);
    }
  }
  return out;
}

function manifestCommands(): string[] {
  const build = read("build.rs");
  const block = /const COMMANDS: &\[&str\] = &\[([\s\S]*?)\];/.exec(build);
  if (!block) return [];
  return [...block[1].matchAll(/^\s*"([a-z0-9_]+)",/gm)].map((m) => m[1]);
}

// Commands that exist only in a `--features capture` build (screenshot and video tooling).
function captureCommands(): string[] {
  const build = read("build.rs");
  const block = /const CAPTURE_COMMANDS: &\[&str\] = &\[([\s\S]*?)\];/.exec(build);
  if (!block) return [];
  return [...block[1].matchAll(/^\s*"([a-z0-9_]+)",/gm)].map((m) => m[1]);
}

const allow = (command: string) => `allow-${command.replace(/_/g, "-")}`;

describe("tauri capabilities", () => {
  const capability = () => json("capabilities", "default.json");

  it("does not use the broad core:default set or any plugin permission", () => {
    const permissions: string[] = capability().permissions;
    expect(permissions).not.toContain("core:default");
    for (const permission of permissions) {
      expect(permission).not.toMatch(/^core:(window|webview|path|menu|tray|app|image|resources):/);
      expect(permission).not.toMatch(/^(fs|shell|dialog|opener|http|os|process|clipboard-manager|global-shortcut):/);
    }
  });

  it("allows event listen and unlisten but not emit", () => {
    const permissions: string[] = capability().permissions;
    expect(permissions).toContain("core:event:allow-listen");
    expect(permissions).toContain("core:event:allow-unlisten");
    expect(permissions.filter((p) => p.startsWith("core:event:") && !/allow-(listen|unlisten)$/.test(p))).toEqual([]);
  });

  it("applies to the main window only", () => {
    expect(capability().windows).toEqual(["main"]);
  });

  it("grants exactly the commands declared in the build.rs manifest", () => {
    const commands = manifestCommands();
    expect(commands.length).toBeGreaterThanOrEqual(21);
    const granted = (capability().permissions as string[]).filter((p) => p.startsWith("allow-"));
    expect([...granted].sort()).toEqual(commands.map(allow).sort());
  });

  it("keeps the capture commands out of the normal capability", () => {
    const permissions: string[] = capability().permissions;
    expect(permissions.some((p) => p.includes("capture"))).toBe(false);
    expect(manifestCommands().some((c) => c.startsWith("capture_"))).toBe(false);
  });

  it("covers every command main.rs registers", () => {
    // `#[cfg(feature = "capture")]` attributes sit inside the handler list; drop them before parsing.
    const main = read("src", "main.rs").replace(/#\[[^\]]*\]/g, "");
    const handler = /generate_handler!\[([\s\S]*?)\]/.exec(main);
    expect(handler).not.toBeNull();
    const registered = handler![1]
      .split(",")
      .map((entry) => entry.trim().split("::").pop() ?? "")
      .filter(Boolean);
    expect(registered.length).toBeGreaterThan(0);
    const declared = new Set([...manifestCommands(), ...captureCommands()]);
    for (const command of registered) {
      expect(declared.has(command), `${command} is registered in main.rs but missing from build.rs COMMANDS`).toBe(true);
    }
  });

  it("grants the capture commands only through capabilities-capture, exactly as declared", () => {
    const capture = json("capabilities-capture", "capture.json");
    expect(capture.windows).toEqual(["main"]);
    expect([...capture.permissions].sort()).toEqual(captureCommands().map(allow).sort());
    expect(captureCommands().length).toBeGreaterThanOrEqual(5);
  });

  it("covers every command the frontend invokes", () => {
    const declared = new Set([...manifestCommands(), ...captureCommands()]);
    const called = new Set<string>();
    for (const file of walk(SRC)) {
      const text = readFileSync(file, "utf8");
      for (const m of text.matchAll(/\b(?:invoke|call)(?:<[^>]*>)?\(\s*["']([a-z0-9_]+)["']/g)) called.add(m[1]);
    }
    expect(called.size).toBeGreaterThan(5);
    for (const command of called) {
      expect(declared.has(command), `frontend invokes ${command}, which is not in build.rs COMMANDS`).toBe(true);
    }
  });
});

describe("content security policy", () => {
  const security = () => json("tauri.conf.json").app.security;
  const directives = (): Map<string, string[]> => {
    const csp = security().csp;
    expect(typeof csp).toBe("string");
    const map = new Map<string, string[]>();
    for (const part of (csp as string).split(";")) {
      const [name, ...values] = part.trim().split(/\s+/);
      if (name) map.set(name, values);
    }
    return map;
  };

  it("is set, not null", () => {
    expect(security().csp).not.toBeNull();
  });

  it("allows only the app itself by default", () => {
    expect(directives().get("default-src")).toEqual(["'self'"]);
    expect(directives().get("script-src")).toEqual(["'self'"]);
  });

  it("names no remote origin and no wildcard anywhere", () => {
    const csp = security().csp as string;
    expect(csp).not.toMatch(/https?:\/\/(?!ipc\.localhost)/);
    expect(csp).not.toMatch(/(^|\s)\*(\s|;|$)/);
    expect(csp).not.toMatch(/wss?:/);
    expect(csp).not.toContain("unsafe-eval");
  });

  it("limits images, fonts and connections", () => {
    expect(directives().get("img-src")).toEqual(["'self'", "data:", "blob:"]);
    expect(directives().get("font-src")).toEqual(["'self'"]);
    expect(directives().get("connect-src")).toEqual(["ipc:", "http://ipc.localhost"]);
  });

  it("blocks plugins, base rewriting, frames and form posts", () => {
    for (const name of ["object-src", "base-uri", "frame-src", "form-action"]) {
      expect(directives().get(name), name).toEqual(["'none'"]);
    }
  });

  it("allows inline <style> elements (xterm and the Folio create them) but no style attributes, and no inline script", () => {
    // xterm 6 injects <style> elements at runtime and has no nonce option, so style-src-elem keeps
    // 'unsafe-inline'; inline style="" attributes are blocked (React and xterm set styles through the CSSOM).
    expect(directives().get("style-src")).toEqual(["'self'"]);
    expect(directives().get("style-src-elem")).toEqual(["'self'", "'unsafe-inline'"]);
    expect(directives().get("style-src-attr")).toEqual(["'none'"]);
    expect(directives().get("script-src")).not.toContain("'unsafe-inline'");
  });

  it("keeps the dev server's extra allowances in devCsp only", () => {
    const csp = security().csp as string;
    expect(csp).not.toContain("localhost:5173");
    expect(typeof security().devCsp).toBe("string");
    expect(security().devCsp).toContain("ws://localhost:5173");
  });
});
