import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Terminal } from "@xterm/xterm";
import {
  secureTerminalOptions,
  createSecureTerminal,
  installPasteGuard,
  sanitizePaste,
} from "../terminalSecurity";

// These tests drive the REAL xterm.js 6.0.0 Terminal (DOM renderer, jsdom),
// not a mock. Parser behaviour (OSC 52, OSC 8, paste bracketing) is therefore
// verified against the shipped library code.

const ESC = "\x1b";

// jsdom has no matchMedia, which xterm's DOM renderer calls on open().
if (typeof window.matchMedia !== "function") {
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    writable: true,
    value: (query: string) => ({
      matches: false,
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      onchange: null,
      dispatchEvent: () => false,
    }),
  });
}

function writeAndFlush(term: Terminal, data: string): Promise<void> {
  return new Promise((resolve) => term.write(data, resolve));
}

describe("terminal hardening (real xterm)", () => {
  let writeText: ReturnType<typeof vi.fn>;
  let container: HTMLDivElement;
  let term: Terminal;
  let disposePaste: () => void = () => {};
  let sent: string[];

  beforeEach(() => {
    writeText = vi.fn().mockResolvedValue(undefined);
    const clipboard = { writeText, readText: vi.fn().mockResolvedValue("") };
    Object.defineProperty(navigator, "clipboard", {
      value: clipboard,
      configurable: true,
    });
    container = document.createElement("div");
    document.body.appendChild(container);
    term = createSecureTerminal();
    term.open(container);
    disposePaste = installPasteGuard(term, container);
    sent = [];
    term.onData((d) => sent.push(d));
  });

  afterEach(() => {
    disposePaste();
    term.dispose();
    container.remove();
  });

  describe("OSC 52 (program clipboard write)", () => {
    it("ignores the BEL-terminated form without touching the clipboard", async () => {
      await expect(writeAndFlush(term, `${ESC}]52;c;aGVsbG8=\x07`)).resolves.toBeUndefined();
      expect(writeText).not.toHaveBeenCalled();
    });

    it("ignores the ST-terminated form without touching the clipboard", async () => {
      await expect(writeAndFlush(term, `${ESC}]52;c;aGVsbG8=${ESC}\\`)).resolves.toBeUndefined();
      expect(writeText).not.toHaveBeenCalled();
    });

    it("swallows OSC 52 query requests without answering the program", async () => {
      await writeAndFlush(term, `${ESC}]52;c;?\x07`);
      expect(sent).toEqual([]);
      expect(writeText).not.toHaveBeenCalled();
    });

    it("does not fall through to later handlers (handler claims the sequence)", async () => {
      const seen = vi.fn();
      // A handler registered later runs first in xterm; ours must still have
      // been registered, so register a probe and check ours returns true by
      // verifying nothing else is invoked when ours is the only one.
      const d = term.parser.registerOscHandler(52, () => {
        seen();
        return false; // let it fall through to the hardening handler
      });
      await writeAndFlush(term, `${ESC}]52;c;aGVsbG8=\x07`);
      d.dispose();
      expect(seen).toHaveBeenCalledTimes(1);
      expect(writeText).not.toHaveBeenCalled();
    });
  });

  describe("other sequences that could act outside the terminal", () => {
    it("OSC 0 and OSC 2 title changes never touch document.title", async () => {
      const before = document.title;
      await writeAndFlush(term, `${ESC}]0;pwned\x07${ESC}]2;pwned2\x07`);
      expect(document.title).toBe(before);
    });

    it("OSC 8 hyperlinks are swallowed so no link is ever rendered or activatable", async () => {
      const open = vi.spyOn(window, "open").mockReturnValue(null);
      const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true);
      await writeAndFlush(term, `${ESC}]8;;https://example.invalid/\x07click${ESC}]8;;\x07`);
      const line = term.buffer.active.getLine(0)!;
      expect(line.translateToString(true)).toBe("click");
      // Reach into xterm's link registry (private API, pinned at 6.0.0): a
      // swallowed OSC 8 must register no link entry at all.
      const links = (term as unknown as {
        _core: { _inputHandler: { _oscLinkService: { _dataByLinkId: Map<number, unknown> } } };
      })._core._inputHandler._oscLinkService._dataByLinkId;
      expect(links).toBeInstanceOf(Map);
      expect(links.size).toBe(0);
      expect(open).not.toHaveBeenCalled();
      expect(confirmSpy).not.toHaveBeenCalled();
      open.mockRestore();
      confirmSpy.mockRestore();
    });

    it("CSI t window manipulation is not acted on and not reported", async () => {
      // 21t asks for the title, 18t the size in chars, 14t pixels.
      await writeAndFlush(term, `${ESC}[21t${ESC}[14t${ESC}[8;50;200t${ESC}[1t`);
      expect(sent).toEqual([]);
      expect(term.cols).toBe(80);
    });
  });

  describe("options", () => {
    it("windowOptions are all disabled", () => {
      const wo = (term.options.windowOptions ?? {}) as Record<string, unknown>;
      for (const v of Object.values(wo)) expect(v).toBeFalsy();
      const built = secureTerminalOptions().windowOptions ?? {};
      for (const v of Object.values(built)) expect(v).toBeFalsy();
    });

    it("copy on select does not exist in xterm 6 and is not set; selecting never writes the clipboard", async () => {
      expect(Object.keys(secureTerminalOptions())).not.toContain("copyOnSelect");
      expect(Object.keys(term.options)).not.toContain("copyOnSelect");
      await writeAndFlush(term, "hello world");
      term.selectAll();
      expect(term.hasSelection()).toBe(true);
      expect(writeText).not.toHaveBeenCalled();
    });

    it("a copy event writes the selection only via the event's clipboardData", async () => {
      await writeAndFlush(term, "hello");
      term.select(0, 0, 5);
      const setData = vi.fn();
      const ev = new Event("copy", { bubbles: true, cancelable: true }) as ClipboardEvent;
      Object.defineProperty(ev, "clipboardData", { value: { setData } });
      term.textarea!.dispatchEvent(ev);
      expect(setData).toHaveBeenCalledWith("text/plain", "hello");
      expect(writeText).not.toHaveBeenCalled();
    });

    it("keeps bracketed paste honoured and the proposed API off", () => {
      const o = secureTerminalOptions();
      expect(o.ignoreBracketedPasteMode).not.toBe(true);
      expect(o.allowProposedApi ?? false).toBe(false);
    });

    it("has an inert OSC 8 link handler even if a hyperlink somehow got through", () => {
      const lh = secureTerminalOptions().linkHandler;
      expect(lh).toBeTruthy();
      const open = vi.spyOn(window, "open").mockReturnValue(null);
      lh!.activate(new MouseEvent("click"), "https://example.invalid/", {
        start: { x: 1, y: 1 },
        end: { x: 2, y: 1 },
      });
      expect(open).not.toHaveBeenCalled();
      expect(lh!.allowNonHttpProtocols).toBeFalsy();
      open.mockRestore();
    });

    it("keeps the Observatory theme and look options", () => {
      const o = secureTerminalOptions();
      expect(o.theme?.background).toBe("#0B1220");
      expect(o.fontSize).toBe(13);
    });
  });

  describe("no link affordances (links are plain text in v0.1)", () => {
    it("the terminal sources import no link or clipboard addon and register no link provider", () => {
      const dir = resolve(__dirname, "..");
      for (const f of ["TerminalTab.tsx", "terminalSecurity.ts"]) {
        const src = readFileSync(resolve(dir, f), "utf8");
        expect(src).not.toMatch(/addon-web-links|WebLinksAddon|addon-clipboard|ClipboardAddon/);
        expect(src).not.toMatch(/registerLinkProvider|registerLinkMatcher/);
      }
    });

    it("a plain URL written to the terminal is not turned into a link", async () => {
      await writeAndFlush(term, "see https://example.invalid/path now");
      const links = container.querySelectorAll("a");
      expect(links.length).toBe(0);
    });
  });

  describe("paste", () => {
    function pasteEvent(text: string): Event {
      const ev = new Event("paste", { bubbles: true, cancelable: true });
      Object.defineProperty(ev, "clipboardData", {
        value: { getData: (t: string) => (t === "text/plain" ? text : "") },
      });
      return ev;
    }

    it("sanitizePaste strips ESC, other C0 controls and C1 controls, keeps \\t, normalises newlines", () => {
      expect(sanitizePaste(`a${ESC}[201~b`)).toBe("a[201~b");
      expect(sanitizePaste("a\x03b\x04c\x07d\x08e\x00f\x7fg")).toBe("abcdefg");
      expect(sanitizePaste("a\u009bb\u0085c")).toBe("abc");
      expect(sanitizePaste("a\tb")).toBe("a\tb");
      expect(sanitizePaste("a\r\nb\nc\rd")).toBe("a\rb\rc\rd");
      expect(sanitizePaste("plain text")).toBe("plain text");
    });

    it("a paste event with ESC[201~ cannot close bracketed paste early", async () => {
      await writeAndFlush(term, `${ESC}[?2004h`);
      expect(term.modes.bracketedPasteMode).toBe(true);
      const payload = `safe${ESC}[201~; rm -rf /tmp/x\n`;
      term.textarea!.dispatchEvent(pasteEvent(payload));
      const all = sent.join("");
      expect(all.startsWith(`${ESC}[200~`)).toBe(true);
      expect(all.endsWith(`${ESC}[201~`)).toBe(true);
      // exactly one end marker: the genuine one at the very end
      expect(all.split(`${ESC}[201~`).length - 1).toBe(1);
      expect(all.split(`${ESC}[200~`).length - 1).toBe(1);
      expect(all).toContain("safe[201~; rm -rf /tmp/x\r");
    });

    it("the guard intercepts the event before xterm's own paste handler runs", async () => {
      await writeAndFlush(term, `${ESC}[?2004h`);
      // The DOM paste event is the real entry point; the guard must run first.
      term.textarea!.dispatchEvent(pasteEvent(`x${ESC}[201~y`));
      expect(sent.join("")).not.toContain(`x${ESC}[201~y`);
    });

    it("a paste event on the container element itself is sanitised too", async () => {
      await writeAndFlush(term, `${ESC}[?2004h`);
      container.querySelector(".xterm")!.dispatchEvent(pasteEvent(`x${ESC}[201~y`));
      const all = sent.join("");
      expect(all.split(`${ESC}[201~`).length - 1).toBe(1);
    });

    it("without bracketed mode, controls are still stripped and nothing is bracketed", async () => {
      term.textarea!.dispatchEvent(pasteEvent(`ls${ESC}[A\x03`));
      expect(sent.join("")).toBe("ls[A");
    });

    it("an empty clipboard sends nothing", () => {
      term.textarea!.dispatchEvent(pasteEvent(""));
      expect(sent.join("")).toBe("");
    });

    it("disposing the guard restores xterm's own paste path", async () => {
      disposePaste();
      term.textarea!.dispatchEvent(pasteEvent("abc"));
      expect(sent.join("")).toBe("abc");
      disposePaste = () => {};
    });
  });
});
