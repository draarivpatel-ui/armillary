import { Terminal } from "@xterm/xterm";
import type { ITerminalOptions } from "@xterm/xterm";
import { currentTerminalTheme } from "./terminalTheme";

/**
 * Hardening for the embedded terminal. Everything a program prints into the
 * terminal is untrusted data. Facts below were checked against the installed
 * @xterm/xterm 6.0.0 sources (node_modules/@xterm/xterm/src):
 *
 * - No clipboard addon is loaded and xterm core has no OSC 52 handler, so the
 *   sequence would already be dropped; we still register an explicit handler
 *   that claims it (returns true) so this never depends on a library default.
 * - xterm has no copy-on-select option in 6.0.0, so there is nothing to set.
 *   The only clipboard write is the browser "copy" event, which xterm answers
 *   by filling event.clipboardData from the selection (user-triggered only).
 * - windowOptions defaults to {} (every CSI t operation disabled); we keep it
 *   that way explicitly.
 * - OSC 8 hyperlinks are ON by default (OscLinkProvider, http/https only,
 *   click opens window.open after confirm()). We swallow OSC 8 and also install
 *   an inert linkHandler, so links are plain text in v0.1. No web-links addon is loaded.
 * - OSC 0/1/2 only fire Terminal.onTitleChange; nothing here subscribes, so
 *   document.title and the DOM outside the terminal are never touched.
 * - xterm does NOT sanitise pasted text: it normalises newlines and wraps in
 *   ESC[200~ ... ESC[201~ when bracketed paste is on, so a payload containing
 *   ESC[201~ ends the bracket early. installPasteGuard() strips control bytes.
 */

/** Terminal options. The theme here is the night fallback; createSecureTerminal() swaps in the token-based one. */
export function secureTerminalOptions(): ITerminalOptions {
  return {
    cursorBlink: true,
    cursorStyle: "block",
    fontFamily: '"Commit Mono", monospace',
    fontSize: 13,
    lineHeight: 1.4,
    // Every CSI t window operation stays disabled (xterm default, made explicit).
    windowOptions: {},
    // Proposed APIs stay off.
    allowProposedApi: false,
    // Honour bracketed paste when the program asks for it.
    ignoreBracketedPasteMode: false,
    // Inert OSC 8 handler: even if a hyperlink were ever registered, clicking
    // does nothing, and non-http(s) schemes are never linkified.
    linkHandler: {
      activate: () => {},
      allowNonHttpProtocols: false,
    },
    theme: {
      background: "#0B1220", // ink-0
      foreground: "#F4F1E8", // star
      cursor: "#C9A24A", // gilt
      cursorAccent: "#0B1220",
      selectionBackground: "rgba(201, 162, 74, 0.3)",
      black: "#0B1220",
      red: "#D2462E", // vermilion
      green: "#3E8E7E", // verdigris
      yellow: "#C9A24A", // gilt
      blue: "#7A9CE0",
      magenta: "#9C8ADE",
      cyan: "#6FB7A8",
      white: "#F4F1E8",
      brightBlack: "#8E9AB4", // dust
      brightRed: "#E05A42",
      brightGreen: "#4EA896",
      brightYellow: "#E2C77E",
      brightBlue: "#94B2F5",
      brightMagenta: "#B4A4EE",
      brightCyan: "#87CCC0",
      brightWhite: "#FFFFFF",
    },
  };
}

/** Builds the terminal and swallows the sequences that act outside it. */
export function createSecureTerminal(): Terminal {
  // Same options, with the theme read from the design tokens of whichever theme the page shows now.
  const term = new Terminal({ ...secureTerminalOptions(), theme: currentTerminalTheme() });
  // Optional chaining only so the hand-written Terminal mock in
  // Launchpad.test.tsx (which has no parser) keeps working.
  const parser = (term as Partial<Terminal>).parser;
  // A handler that returns true claims the sequence and stops the search.
  parser?.registerOscHandler(52, () => true); // clipboard read/write
  parser?.registerOscHandler(8, () => true); // hyperlinks: plain text only
  return term;
}

/**
 * Pasted text goes to the shell as if typed. Strip ESC (so ESC[201~ cannot end
 * bracketed paste), every other C0 control except tab, LF and CR, DEL, and the
 * C1 range (0x80 to 0x9F, includes the 8-bit CSI). CRLF becomes CR.
 */
export function sanitizePaste(text: string): string {
  return (
    text
      .replace(/\r\n/g, "\r")
      .replace(/\n/g, "\r")
      // eslint-disable-next-line no-control-regex
      .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/g, "")
  );
}

/**
 * Intercepts paste events (capture phase, before xterm's own listeners on its
 * textarea and element), sanitises the text and hands it to term.paste(), which
 * brackets it when the program enabled bracketed paste. Returns a disposer.
 */
export function installPasteGuard(term: Terminal, container: HTMLElement): () => void {
  const onPaste = (event: Event) => {
    const clipboardData = (event as ClipboardEvent).clipboardData;
    if (!clipboardData) return;
    event.preventDefault();
    event.stopPropagation();
    const text = sanitizePaste(clipboardData.getData("text/plain"));
    if (text) term.paste(text);
  };
  container.addEventListener("paste", onPaste, true);
  return () => container.removeEventListener("paste", onPaste, true);
}
