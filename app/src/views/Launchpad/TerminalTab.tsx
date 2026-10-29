import React, { useEffect, useRef } from "react";
import type { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { invoke } from "@tauri-apps/api/core";
import { TerminalSession } from "./types";
import type { PtyOutputHub } from "./ptyOutput";
import { createSecureTerminal, installPasteGuard } from "./terminalSecurity";
import { currentTerminalTheme, watchTheme } from "./terminalTheme";

interface TerminalTabProps {
  session: TerminalSession;
  /** The Launchpad's output hub: it holds what the session printed before this tab mounted. */
  output: PtyOutputHub;
  isActive: boolean;
}

export const TerminalTab: React.FC<TerminalTabProps> = ({ session, output, isActive }) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);

  useEffect(() => {
    if (!containerRef.current) return;

    // Security options and OSC filtering live in terminalSecurity.ts; the colours come from the design tokens
    const term = createSecureTerminal();
    // Follow the page when it switches between Night and Day almanac
    const stopWatchingTheme = watchTheme(() => {
      term.options.theme = currentTerminalTheme();
    });

    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);

    term.open(containerRef.current);
    const disposePasteGuard = installPasteGuard(term, containerRef.current);
    try {
      fitAddon.fit();
    } catch {
      // Container may not be measured yet in headless/test environments
    }

    terminalRef.current = term;
    fitAddonRef.current = fitAddon;

    // Send input from xterm to PTY
    const dataSub = term.onData((data) => {
      invoke("pty_write", { id: session.id, data }).catch(() => {
        // Handle gracefully if process exited
      });
    });

    // Initial resize notification
    if (term.cols && term.rows) {
      invoke("pty_resize", {
        id: session.id,
        cols: term.cols,
        rows: term.rows,
      }).catch(() => {});
    }

    // PTY output from the Rust backend, starting with anything printed before this tab mounted
    const unsubscribe = output.subscribe(session.id, (data) => term.write(data));

    // Resize observer (guarded for environments without ResizeObserver like jsdom)
    let resizeObserver: ResizeObserver | null = null;
    if (typeof ResizeObserver !== "undefined") {
      resizeObserver = new ResizeObserver(() => {
        if (!isActive) return;
        try {
          fitAddon.fit();
          if (term.cols && term.rows) {
            invoke("pty_resize", {
              id: session.id,
              cols: term.cols,
              rows: term.rows,
            }).catch(() => {});
          }
        } catch {
          // Ignored
        }
      });
      resizeObserver.observe(containerRef.current);
    }

    return () => {
      stopWatchingTheme();
      dataSub.dispose();
      disposePasteGuard();
      if (resizeObserver) {
        resizeObserver.disconnect();
      }
      unsubscribe();
      term.dispose();
      terminalRef.current = null;
      fitAddonRef.current = null;
    };
  }, [session.id]);

  useEffect(() => {
    if (isActive && fitAddonRef.current) {
      try {
        fitAddonRef.current.fit();
        if (terminalRef.current) {
          terminalRef.current.focus();
        }
      } catch {
        // Ignored
      }
    }
  }, [isActive]);

  return (
    <div
      ref={containerRef}
      className="terminal-container"
      data-testid="xterm-terminal-container"
      style={{ display: isActive ? "block" : "none" }}
    />
  );
};
