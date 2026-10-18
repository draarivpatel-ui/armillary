import React, { useState, useEffect } from "react";
import { createRoot } from "react-dom/client";
import { Folio } from "./Folio";
import { mockSessions } from "./data/mockSessions";
import { makeLongSession } from "./data/makeLongSession";
import type { NormalizedSession, Theme } from "./types";
import { injectFolioCss } from "./styles/stylesheet";

type SessionKey = "refactor" | "debugging" | "planning" | "long";

function getInitialParams(): { sessionKey: SessionKey; theme: Theme } {
  if (typeof window === "undefined") {
    return { sessionKey: "refactor", theme: "dark" };
  }
  const params = new URLSearchParams(window.location.search);
  const s = params.get("session");
  const t = params.get("theme");
  const sessionKey: SessionKey =
    s === "debugging" || s === "planning" || s === "long" ? s : "refactor";
  const theme: Theme = t === "light" ? "light" : "dark";
  return { sessionKey, theme };
}

export function DemoApp() {
  const initial = getInitialParams();
  const [sessionKey, setSessionKey] = useState<SessionKey>(initial.sessionKey);
  const [theme, setTheme] = useState<Theme>(initial.theme);
  const [marginalia, setMarginalia] = useState(true);
  const [showContents, setShowContents] = useState(true);

  useEffect(() => {
    injectFolioCss();
  }, []);

  const sessionData: NormalizedSession = React.useMemo(() => {
    switch (sessionKey) {
      case "debugging":
        return mockSessions.debugging;
      case "planning":
        return mockSessions.planning;
      case "long":
        return makeLongSession(2000);
      case "refactor":
      default:
        return mockSessions.refactor;
    }
  }, [sessionKey]);

  const updateUrl = (newKey: SessionKey, newTheme: Theme) => {
    const params = new URLSearchParams(window.location.search);
    params.set("session", newKey);
    params.set("theme", newTheme);
    const newUrl = `${window.location.pathname}?${params.toString()}`;
    window.history.replaceState(null, "", newUrl);
  };

  const handleSelectSession = (key: SessionKey) => {
    setSessionKey(key);
    updateUrl(key, theme);
  };

  const handleToggleTheme = () => {
    const nextTheme: Theme = theme === "dark" ? "light" : "dark";
    setTheme(nextTheme);
    updateUrl(sessionKey, nextTheme);
  };

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        height: "100vh",
        width: "100vw",
        overflow: "hidden",
        backgroundColor: theme === "dark" ? "#0B1220" : "#F3EBDA",
        color: theme === "dark" ? "#F4F1E8" : "#1D1A14",
      }}
    >
      <header
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          padding: "8px 16px",
          borderBottom: `1px solid ${theme === "dark" ? "#2A3756" : "#C9B78F"}`,
          backgroundColor: theme === "dark" ? "#111A2E" : "#EADFC8",
          fontFamily: "'Instrument Sans', sans-serif",
          fontSize: "13px",
          flexShrink: 0,
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: "12px" }}>
          <strong style={{ letterSpacing: "0.06em", textTransform: "uppercase" }}>
            Orrery Folio
          </strong>
          <span style={{ opacity: 0.6 }}>|</span>
          <label style={{ display: "flex", alignItems: "center", gap: "6px" }}>
            <span>Session:</span>
            <select
              value={sessionKey}
              onChange={(e) => handleSelectSession(e.target.value as SessionKey)}
              style={{
                background: theme === "dark" ? "#18233B" : "#DFD1B4",
                color: theme === "dark" ? "#F4F1E8" : "#1D1A14",
                border: `1px solid ${theme === "dark" ? "#2A3756" : "#C9B78F"}`,
                borderRadius: "3px",
                padding: "3px 8px",
                fontFamily: "inherit",
                fontSize: "13px",
              }}
            >
              <option value="refactor">Refactor (edits and diffs)</option>
              <option value="debugging">Debugging (errors and retries)</option>
              <option value="planning">Planning (to-do checklists)</option>
              <option value="long">Long session (2,000 virtualized)</option>
            </select>
          </label>
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: "12px" }}>
          <label style={{ display: "flex", alignItems: "center", gap: "4px", cursor: "pointer" }}>
            <input
              type="checkbox"
              checked={marginalia}
              onChange={(e) => setMarginalia(e.target.checked)}
            />
            <span>Marginalia</span>
          </label>
          <label style={{ display: "flex", alignItems: "center", gap: "4px", cursor: "pointer" }}>
            <input
              type="checkbox"
              checked={showContents}
              onChange={(e) => setShowContents(e.target.checked)}
            />
            <span>Contents rail</span>
          </label>
          <button
            type="button"
            onClick={handleToggleTheme}
            style={{
              background: theme === "dark" ? "#18233B" : "#DFD1B4",
              color: theme === "dark" ? "#C9A24A" : "#8A6A22",
              border: `1px solid ${theme === "dark" ? "#2A3756" : "#C9B78F"}`,
              borderRadius: "3px",
              padding: "4px 10px",
              fontFamily: "inherit",
              fontSize: "12px",
              cursor: "pointer",
            }}
          >
            Theme: {theme === "dark" ? "Dark (Ink)" : "Light (Almanac)"}
          </button>
        </div>
      </header>

      <div style={{ flex: 1, minHeight: 0 }}>
        <Folio
          session={sessionData.session}
          messages={sessionData.messages}
          toolCalls={sessionData.toolCalls}
          theme={theme}
          marginalia={marginalia}
          showContents={showContents}
          virtualize="auto"
        />
      </div>
    </div>
  );
}

const rootEl = document.getElementById("root");
if (rootEl) {
  createRoot(rootEl).render(<DemoApp />);
}
