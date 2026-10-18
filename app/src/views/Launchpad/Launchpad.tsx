import React, { useState, useEffect, useId, useRef } from "react";
import { AgentGlyph, Button, CloseIcon, Figure, FigureGroup, IconButton, Mark } from "@orrery/design";
import { CliAgentInfo, TerminalSession, RecentLaunch } from "./types";
import { agents_list, isCoreAvailable } from "../../api/agents";
import { appNow, call } from "../../api/client";
import { useProjectRoots } from "../../api/hooks";
import { useDisplayPath } from "../../api/paths";
import { AgentSelector } from "./AgentSelector";
import { TerminalTab } from "./TerminalTab";
import "./launchpad.css";

/**
 * A failed launch in plain words. The core's message is shown without the error class name; the
 * missing-folder case (the core repeats its reason, then names the path) reads as one sentence.
 */
export function launchFailureText(err: unknown): string {
  const message = err instanceof Error ? err.message : typeof err === "string" ? err : "The terminal could not start.";
  if (/working directory does not exist/i.test(message)) {
    const path = message.split(": ").pop()?.trim();
    return path && /^[~/]|^[A-Za-z]:\\/.test(path)
      ? `That project folder does not exist: ${path}`
      : "That project folder does not exist.";
  }
  return message.replace(/^ApiError:\s*/, "");
}

export const Launchpad: React.FC = () => {
  const titleId = useId();
  const displayPath = useDisplayPath();
  const launchCounts = useRef<Record<string, number>>({});
  const [agentsLoaded, setAgentsLoaded] = useState<boolean>(false);
  const [hasCore] = useState<boolean>(() => isCoreAvailable());
  const [agents, setAgents] = useState<CliAgentInfo[]>([]);
  const [selectedAgentId, setSelectedAgentId] = useState<string>("claude");
  const [projectFolder, setProjectFolder] = useState<string>("");
  const [folderTouched, setFolderTouched] = useState<boolean>(false);
  const projectRoots = useProjectRoots();

  // Default to the first real project root, unless the user already chose a folder
  useEffect(() => {
    if (!folderTouched && projectRoots.length > 0) {
      setProjectFolder(projectRoots[0].root);
    }
  }, [projectRoots, folderTouched]);
  const [sessions, setSessions] = useState<TerminalSession[]>([]);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [showConfig, setShowConfig] = useState<boolean>(true);
  const [isLaunching, setIsLaunching] = useState<boolean>(false);
  const [launchError, setLaunchError] = useState<string | null>(null);
  const [recentLaunches, setRecentLaunches] = useState<RecentLaunch[]>(() => {
    try {
      if (typeof window !== "undefined" && window.localStorage) {
        const stored = window.localStorage.getItem("armillary:recent_launches");
        if (stored) {
          const parsed = JSON.parse(stored);
          if (Array.isArray(parsed)) return parsed;
        }
      }
    } catch {
      // Fallback
    }
    return [];
  });

  // Load agents using typed agents_list client
  useEffect(() => {
    let isMounted = true;
    agents_list()
      .then((data) => {
        if (isMounted && Array.isArray(data) && data.length > 0) {
          // Only terminal agents can run in the Launchpad; the backend also accepts
          // the literal "shell", which is not in the registry, so add it here.
          const cliAgents: CliAgentInfo[] = data
            .filter((a) => !a.kind || a.kind === "cli")
            .map((a) => ({
              id: a.id,
              name: a.name,
              installed: Boolean((a as any).installed ?? true),
              family: (a.family as any) || "other",
            }));
          const list: CliAgentInfo[] = [
            ...cliAgents,
            {
              id: "shell",
              name: "System Shell",
              installed: true,
              family: "other",
              binary: "$SHELL",
              description: "Interactive shell terminal inside project directory",
            },
          ];
          setAgents(list);
          setAgentsLoaded(true);
          // Only an installed agent can be selected: fall back to the first one that is
          if (!list.some((a) => a.id === selectedAgentId && a.installed)) {
            const firstInstalled = list.find((a) => a.installed);
            if (firstInstalled) setSelectedAgentId(firstInstalled.id);
          }
        }
      })
      .catch(() => {});
    return () => {
      isMounted = false;
    };
  }, []);

  const handleLaunch = async () => {
    setIsLaunching(true);
    setLaunchError(null);

    const selectedAgent =
      agents.find((a) => a.id === selectedAgentId) || {
        id: selectedAgentId,
        name: selectedAgentId,
        family: "other" as const,
        installed: true,
      };

    try {
      let sessionId = `pty-${sessions.length + 1}`;
      try {
        const result = await call<{ id: string; agent_id?: string; cwd?: string }>(
          "pty_open",
          {
            agentId: selectedAgentId,
            agent_id: selectedAgentId,
            cwd: projectFolder.trim() || undefined,
          }
        );
        if (result && result.id) {
          sessionId = result.id;
        }
      } catch (err) {
        // In web preview environments (outside Tauri desktop runtime), provide browser mock
        if (isCoreAvailable()) {
          throw err;
        }
      }

      // "Claude Code", then "Claude Code 2", and so on: a tab name that never repeats
      const ordinal = (launchCounts.current[selectedAgentId] = (launchCounts.current[selectedAgentId] ?? 0) + 1);
      const newSession: TerminalSession = {
        id: sessionId,
        title: ordinal === 1 ? selectedAgent.name : `${selectedAgent.name} ${ordinal}`,
        agentId: selectedAgentId,
        agentName: selectedAgent.name,
        family: selectedAgent.family,
        cwd: projectFolder,
        status: "connected",
      };

      const launchedAt = appNow();
      const newRecent: RecentLaunch = {
        id: `launch-${launchedAt}`,
        agentId: selectedAgentId,
        agentName: selectedAgent.name,
        family: selectedAgent.family,
        projectFolder: projectFolder.trim(),
        timestamp: launchedAt,
      };

      setRecentLaunches((prev) => {
        const next = [
          newRecent,
          ...prev.filter(
            (item) => !(item.agentId === newRecent.agentId && item.projectFolder === newRecent.projectFolder)
          ),
        ].slice(0, 10);
        try {
          if (typeof window !== "undefined" && window.localStorage) {
            window.localStorage.setItem("armillary:recent_launches", JSON.stringify(next));
          }
        } catch {
          // Ignore
        }
        return next;
      });

      setSessions((prev) => [...prev, newSession]);
      setActiveSessionId(newSession.id);
      setShowConfig(false);
    } catch (err) {
      setLaunchError(launchFailureText(err));
    } finally {
      setIsLaunching(false);
    }
  };

  const handleCloseSession = async (sessionId: string) => {
    try {
      await call("pty_close", { id: sessionId });
    } catch {
      // Ignored
    }

    setSessions((prev) => {
      const next = prev.filter((s) => s.id !== sessionId);
      if (activeSessionId === sessionId) {
        if (next.length > 0) {
          setActiveSessionId(next[next.length - 1].id);
          setShowConfig(false);
        } else {
          setActiveSessionId(null);
          setShowConfig(true);
        }
      }
      return next;
    });
  };

  const activeSession = sessions.find((s) => s.id === activeSessionId);
  const installedCount = agents.filter((a) => a.installed && a.id !== "shell").length;
  return (
    <section className="view launchpad-view" aria-labelledby={titleId}>
      <header className="view-head">
        <div>
          <p className="view-eyebrow">Terminals</p>
          <h2 id={titleId} className="view-title">
            The Launchpad
          </h2>
          <p className="view-lede">Start an installed agent in a terminal, inside one of your projects.</p>
        </div>
        {agentsLoaded && (
          <FigureGroup className="view-figures" aria-label="Summary">
            <Figure value={installedCount} label="CLI agents installed" />
            {sessions.length > 0 && <Figure value={sessions.length} label="terminals open" />}
          </FigureGroup>
        )}
      </header>

      {launchError && (
        <p className="launchpad-error" role="alert">
          <Mark tone="alert" shape="diamond" emphasis>
            Could not launch
          </Mark>
          <span>{launchError}</span>
        </p>
      )}

      {sessions.length > 0 && (
        <div className="launchpad-tabs">
          <ul aria-label="Terminals" className="launchpad-tablist">
            {sessions.map((session) => {
              const isActive = session.id === activeSessionId && !showConfig;
              return (
                <li key={session.id} className={`launchpad-tab${isActive ? " launchpad-tab--active" : ""}`}>
                  <button
                    type="button"
                    aria-current={isActive ? "true" : undefined}
                    className="launchpad-tab__label"
                    data-testid="terminal-tab"
                    onClick={() => {
                      setActiveSessionId(session.id);
                      setShowConfig(false);
                    }}
                  >
                    <span style={{ color: `var(--family-${session.family})`, display: "inline-flex" }}>
                      <AgentGlyph family={session.family} size={16} />
                    </span>
                    {session.title}
                  </button>
                  <IconButton
                    aria-label={`Close ${session.title}`}
                    className="launchpad-tab__close"
                    onClick={() => handleCloseSession(session.id)}
                  >
                    <CloseIcon size={12} />
                  </IconButton>
                </li>
              );
            })}
          </ul>
          <Button size="sm" variant="ghost" onClick={() => setShowConfig(true)}>
            New terminal
          </Button>
        </div>
      )}

      {(showConfig || sessions.length === 0) && (
        <AgentSelector
          agents={agents}
          selectedAgentId={selectedAgentId}
          onSelectAgent={setSelectedAgentId}
          projectFolder={projectFolder}
          onChangeProjectFolder={(value) => {
            setFolderTouched(true);
            setProjectFolder(value);
          }}
          projectRoots={projectRoots}
          onLaunch={handleLaunch}
          isLaunching={isLaunching}
          hasCore={hasCore}
          recentLaunches={recentLaunches}
          onSelectRecentLaunch={(item) => {
            setSelectedAgentId(item.agentId);
            setFolderTouched(true);
            setProjectFolder(item.projectFolder);
          }}
          onClearRecentLaunches={() => {
            try {
              if (typeof window !== "undefined" && window.localStorage) {
                window.localStorage.removeItem("armillary:recent_launches");
              }
            } catch {
              // Ignore
            }
            setRecentLaunches([]);
          }}
        />
      )}

      {/* The terminals stay mounted while the launcher is showing, so a running session keeps its screen. */}
      {sessions.length > 0 && (
        <div
          role="region"
          aria-label={activeSession ? `Terminal: ${activeSession.title}` : "Terminal"}
          className="terminal-frame"
          data-testid="terminal-frame"
          hidden={showConfig || !activeSession}
        >
          <div className="terminal-frame__head">
            {activeSession && (
              <>
                <span style={{ color: `var(--family-${activeSession.family})`, display: "inline-flex" }}>
                  <AgentGlyph family={activeSession.family} size={16} />
                </span>
                <code className="terminal-frame__cwd" data-testid="terminal-cwd" title={displayPath(activeSession.cwd)}>
                  {displayPath(activeSession.cwd)}
                </code>
              </>
            )}
          </div>
          {sessions.map((session) => (
            <TerminalTab key={session.id} session={session} isActive={session.id === activeSessionId && !showConfig} />
          ))}
        </div>
      )}
    </section>
  );
};

export default Launchpad;
