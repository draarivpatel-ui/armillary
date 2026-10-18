import React, { useState } from "react";
import {
  Button,
  IconButton,
  Panel,
  Tabs,
  TabList,
  Tab,
  TabPanel,
  List,
  ListItem,
  Badge,
  Tooltip,
  Dialog,
  TextField,
  Toggle,
  Kbd,
} from "./primitives";
import { AgentGlyph, AGENT_FAMILIES } from "./glyphs";
import { familyColors } from "./tokens";

export interface GalleryProps {
  theme?: "dark" | "light";
  onThemeChange?: (theme: "dark" | "light") => void;
  showThemeSwitcher?: boolean;
}

export const Gallery: React.FC<GalleryProps> = ({
  theme: controlledTheme,
  onThemeChange,
  showThemeSwitcher = true,
}) => {
  const [internalTheme, setInternalTheme] = useState<"dark" | "light">("dark");
  const [isDialogOpen, setIsDialogOpen] = useState(false);
  const [selectedListItem, setSelectedListItem] = useState("session-1");
  const [toggleState, setToggleState] = useState(true);
  const [textValue, setTextValue] = useState("");

  const currentTheme = controlledTheme !== undefined ? controlledTheme : internalTheme;

  const handleThemeToggle = (newTheme: "dark" | "light") => {
    if (controlledTheme === undefined) {
      setInternalTheme(newTheme);
    }
    onThemeChange?.(newTheme);
  };

  return (
    <div
      className="obs-gallery"
      data-theme={currentTheme}
      style={{
        backgroundColor: "var(--color-ink-0)",
        color: "var(--color-star)",
        minHeight: "100vh",
        padding: "var(--space-6)",
        fontFamily: "var(--font-sans)",
      }}
    >
      {/* Header */}
      <header
        style={{
          borderBottom: "var(--border-hairline)",
          paddingBottom: "var(--space-4)",
          marginBottom: "var(--space-6)",
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
        }}
      >
        <div>
          <h1
            style={{
              margin: 0,
              fontFamily: "var(--font-display)",
              fontSize: "var(--text-3xl)",
              letterSpacing: "0.03em",
              color: "var(--color-star)",
            }}
          >
            Observatory Design System
          </h1>
          <p
            style={{
              margin: "var(--space-1) 0 0 0",
              color: "var(--color-dust)",
              fontSize: "var(--text-base)",
            }}
          >
            SPEC section 3 primitives, tokens, and agent glyph set in{" "}
            <span style={{ color: "var(--color-gilt-soft)", fontWeight: 600 }}>
              {currentTheme === "dark" ? "Dark (Default)" : "Light (Day Almanac)"}
            </span>{" "}
            theme
          </p>
        </div>

        {showThemeSwitcher && (
          <div style={{ display: "flex", alignItems: "center", gap: "var(--space-3)" }}>
            <span style={{ fontSize: "var(--text-xs)", color: "var(--color-dust)", textTransform: "uppercase" }}>
              Theme:
            </span>
            <Button
              variant={currentTheme === "dark" ? "gilt" : "default"}
              size="sm"
              onClick={() => handleThemeToggle("dark")}
            >
              Dark Default
            </Button>
            <Button
              variant={currentTheme === "light" ? "gilt" : "default"}
              size="sm"
              onClick={() => handleThemeToggle("light")}
            >
              Day Almanac
            </Button>
          </div>
        )}
      </header>

      {/* Grid of Sections */}
      <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-6)" }}>
        {/* 1. Agent Glyphs */}
        <Panel title="Agent Family Glyphs (SPEC 3.2)">
          <p style={{ color: "var(--color-dust)", fontSize: "var(--text-sm)", marginTop: 0, marginBottom: "var(--space-4)" }}>
            Engraved-style monochrome SVGs for 8 agent families. Color is an accent; glyph is never the only cue.
          </p>
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))",
              gap: "var(--space-4)",
            }}
          >
            {AGENT_FAMILIES.map((family) => {
              const hex = familyColors[family];
              return (
                <div
                  key={family}
                  style={{
                    backgroundColor: "var(--color-ink-0)",
                    border: "var(--border-hairline)",
                    borderRadius: "var(--radius-sm)",
                    padding: "var(--space-3)",
                    display: "flex",
                    flexDirection: "column",
                    gap: "var(--space-2)",
                  }}
                >
                  <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                    <span style={{ fontWeight: 600, fontSize: "var(--text-sm)", textTransform: "capitalize" }}>
                      {family.replace("-", " ")}
                    </span>
                    <span
                      style={{
                        display: "inline-block",
                        width: "12px",
                        height: "12px",
                        borderRadius: "50%",
                        backgroundColor: hex,
                        border: "0.5px solid var(--color-line)",
                      }}
                      title={hex}
                    />
                  </div>
                  <div
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: "var(--space-4)",
                      padding: "var(--space-2) 0",
                    }}
                  >
                    <div style={{ display: "flex", alignItems: "center", gap: "var(--space-2)" }}>
                      <span style={{ color: "var(--color-dust)", fontSize: "var(--text-xs)" }}>16px:</span>
                      <div style={{ color: hex }}>
                        <AgentGlyph family={family} size={16} />
                      </div>
                    </div>
                    <div style={{ display: "flex", alignItems: "center", gap: "var(--space-2)" }}>
                      <span style={{ color: "var(--color-dust)", fontSize: "var(--text-xs)" }}>24px:</span>
                      <div style={{ color: hex }}>
                        <AgentGlyph family={family} size={24} />
                      </div>
                    </div>
                  </div>
                  <div style={{ fontSize: "var(--text-xs)", color: "var(--color-dust)", fontFamily: "var(--font-mono)" }}>
                    {hex}
                  </div>
                </div>
              );
            })}
          </div>
        </Panel>

        {/* 2. Buttons and Icon Buttons */}
        <Panel title="Buttons & Controls">
          <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-4)" }}>
            <div>
              <h4 style={{ margin: "0 0 var(--space-2) 0", color: "var(--color-dust)", fontSize: "var(--text-xs)", textTransform: "uppercase" }}>
                Button Variants
              </h4>
              <div style={{ display: "flex", flexWrap: "wrap", gap: "var(--space-3)", alignItems: "center" }}>
                <Button variant="default">Default Ink</Button>
                <Button variant="gilt">Gilt Accent</Button>
                <Button variant="destructive">Vermilion Alert</Button>
                <Button variant="ghost">Ghost Hairline</Button>
                <Button disabled>Disabled Action</Button>
              </div>
            </div>

            <div>
              <h4 style={{ margin: "0 0 var(--space-2) 0", color: "var(--color-dust)", fontSize: "var(--text-xs)", textTransform: "uppercase" }}>
                Button Sizes
              </h4>
              <div style={{ display: "flex", flexWrap: "wrap", gap: "var(--space-3)", alignItems: "center" }}>
                <Button size="sm" variant="gilt">Small (24px)</Button>
                <Button size="md" variant="gilt">Medium (32px)</Button>
                <Button size="lg" variant="gilt">Large (40px)</Button>
              </div>
            </div>

            <div>
              <h4 style={{ margin: "0 0 var(--space-2) 0", color: "var(--color-dust)", fontSize: "var(--text-xs)", textTransform: "uppercase" }}>
                Icon Buttons & Tooltips
              </h4>
              <div style={{ display: "flex", gap: "var(--space-3)", alignItems: "center" }}>
                <Tooltip content="Launch Celestial Orrery">
                  <IconButton aria-label="Launch Orrery">
                    <AgentGlyph family="anthropic" size={16} />
                  </IconButton>
                </Tooltip>
                <Tooltip content="Search Historical Sessions">
                  <IconButton aria-label="Search Archives">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <circle cx="11" cy="11" r="8" />
                      <line x1="21" y1="21" x2="16.65" y2="16.65" />
                    </svg>
                  </IconButton>
                </Tooltip>
                <Tooltip content="Switchboard MCP Config">
                  <IconButton aria-label="Configure Switchboard">
                    <AgentGlyph family="open-source-clis" size={16} />
                  </IconButton>
                </Tooltip>
                <IconButton aria-label="Disabled Action" disabled>
                  <AgentGlyph family="cursor" size={16} />
                </IconButton>
              </div>
            </div>
          </div>
        </Panel>

        {/* 3. Form Inputs & Toggles */}
        <Panel title="Form Inputs & Toggles">
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))", gap: "var(--space-5)" }}>
            <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-3)" }}>
              <TextField
                label="Observatory Query"
                placeholder="Search sessions, prompts, tools..."
                value={textValue}
                onChange={(e) => setTextValue(e.target.value)}
                helperText="Example helper text"
              />
              <TextField
                label="Target Worktree Path"
                value="/invalid/path/agent.json"
                error="Path does not exist on this machine"
                readOnly
              />
              <TextField
                label="Readonly Project Root"
                value="~/Projects/orrery"
                disabled
              />
            </div>

            <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-3)" }}>
              <h4 style={{ margin: "0 0 var(--space-2) 0", color: "var(--color-dust)", fontSize: "var(--text-xs)", textTransform: "uppercase" }}>
                Toggles & Keyboard Badges
              </h4>
              <Toggle
                label="Celestial Motion (40 to 120s orbits)"
                checked={toggleState}
                onChange={setToggleState}
              />
              <Toggle
                label="Day Almanac Light Theme"
                checked={currentTheme === "light"}
                onChange={(checked) => handleThemeToggle(checked ? "light" : "dark")}
              />
              <Toggle
                label="Example toggle"
                checked={false}
                disabled
              />
              <div style={{ marginTop: "var(--space-2)", display: "flex", gap: "var(--space-2)", alignItems: "center", flexWrap: "wrap" }}>
                <span style={{ fontSize: "var(--text-xs)", color: "var(--color-dust)" }}>Shortcuts:</span>
                <span><Kbd>Cmd</Kbd> + <Kbd>K</Kbd> Search</span>
                <span><Kbd>1</Kbd> Orrery</span>
                <span><Kbd>Esc</Kbd> Close</span>
              </div>
            </div>
          </div>
        </Panel>

        {/* 4. Tabs, Lists, Badges, and Modal */}
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(320px, 1fr))", gap: "var(--space-6)" }}>
          <Panel title="Navigation Tabs & Badges">
            <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-4)" }}>
              <div>
                <h4 style={{ margin: "0 0 var(--space-2) 0", color: "var(--color-dust)", fontSize: "var(--text-xs)", textTransform: "uppercase" }}>
                  Status Badges
                </h4>
                <div style={{ display: "flex", flexWrap: "wrap", gap: "var(--space-2)" }}>
                  <Badge variant="verdigris">Active Orbit</Badge>
                  <Badge variant="vermilion">Needs You</Badge>
                  <Badge variant="gilt">Example</Badge>
                  <Badge variant="default">Idle</Badge>
                </div>
              </div>

              <div>
                <h4 style={{ margin: "0 0 var(--space-2) 0", color: "var(--color-dust)", fontSize: "var(--text-xs)", textTransform: "uppercase" }}>
                  Observatory Tabs
                </h4>
                <Tabs defaultValue="live">
                  <TabList aria-label="Session status">
                    <Tab value="live">Live</Tab>
                    <Tab value="waiting">Waiting</Tab>
                    <Tab value="archive">Archive</Tab>
                  </TabList>
                  <TabPanel value="live">
                    <p style={{ margin: 0, fontSize: "var(--text-sm)", color: "var(--color-dust)" }}>
                      Example panel content for the Live tab.
                    </p>
                  </TabPanel>
                  <TabPanel value="waiting">
                    <p style={{ margin: 0, fontSize: "var(--text-sm)", color: "var(--color-vermilion)" }}>
                      Claude Code is waiting for confirmation on git commit.
                    </p>
                  </TabPanel>
                  <TabPanel value="archive">
                    <p style={{ margin: 0, fontSize: "var(--text-sm)", color: "var(--color-dust)" }}>
                      Example panel content for the Archive tab.
                    </p>
                  </TabPanel>
                </Tabs>
              </div>
            </div>
          </Panel>

          <Panel
            variant="raised"
            title="Interactive List & Modal Dialog"
            footer={
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <span>Selected: {selectedListItem}</span>
                <Button size="sm" variant="gilt" onClick={() => setIsDialogOpen(true)}>
                  Open Dialog
                </Button>
              </div>
            }
          >
            <List aria-label="Agent Session List">
              <ListItem
                selected={selectedListItem === "session-1"}
                onClick={() => setSelectedListItem("session-1")}
              >
                <div style={{ display: "flex", alignItems: "center", gap: "var(--space-2)" }}>
                  <AgentGlyph family="anthropic" size={16} />
                  <span>Claude Code (spike harness)</span>
                </div>
                <Badge variant="vermilion">Needs You</Badge>
              </ListItem>

              <ListItem
                selected={selectedListItem === "session-2"}
                onClick={() => setSelectedListItem("session-2")}
              >
                <div style={{ display: "flex", alignItems: "center", gap: "var(--space-2)" }}>
                  <AgentGlyph family="openai" size={16} />
                  <span>Codex CLI (archive test)</span>
                </div>
                <Badge variant="verdigris">Orbiting</Badge>
              </ListItem>

              <ListItem
                selected={selectedListItem === "session-3"}
                onClick={() => setSelectedListItem("session-3")}
              >
                <div style={{ display: "flex", alignItems: "center", gap: "var(--space-2)" }}>
                  <AgentGlyph family="cursor" size={16} />
                  <span>Cursor Session (editor)</span>
                </div>
                <Badge variant="default">Idle</Badge>
              </ListItem>
            </List>
          </Panel>
        </div>
      </div>

      {/* Modal Dialog */}
      <Dialog
        isOpen={isDialogOpen}
        onClose={() => setIsDialogOpen(false)}
        title="Switchboard Configuration Preview"
        footer={
          <>
            <Button variant="ghost" onClick={() => setIsDialogOpen(false)}>
              Cancel
            </Button>
            <Button variant="gilt" onClick={() => setIsDialogOpen(false)}>
              Apply Settings
            </Button>
          </>
        }
      >
        <p style={{ margin: "0 0 var(--space-3) 0" }}>
          This dialog illustrates modal presentation with antique observatory hairlines,
          gilt focus rings, and proper keyboard focus management.
        </p>
        <p style={{ margin: 0, color: "var(--color-dust)", fontSize: "var(--text-sm)" }}>
          Press <Kbd>Esc</Kbd> or click the close button to dismiss.
        </p>
      </Dialog>
    </div>
  );
};
