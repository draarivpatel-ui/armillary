# Armillary 0.1.0: release notes

Version from `app/src-tauri/tauri.conf.json` (`version` 0.1.0, bundle identifier `com.armillary.app`, product name "Armillary"). This is the first, early release: builds are unsigned and there is no downloadable binary yet.

macOS only. The build produces an unsigned `Armillary.app` (about 16 MB). It is not signed with an Apple Developer ID and not notarized, so macOS needs the one-time "Open Anyway" step described in README.md.

## What is in 0.1.0

- **The first run, "the observatory opens".** A WebGL2 title sequence: night falls, an armillary sphere assembles ring by ring, a consent plaque lists what Armillary reads and never does, each agent it finds ignites as a star while its history imports, constellations form around your projects, and the view hands over to the Orrery. Driven by the real detection and import. Skip with Escape. Replay any time from the rail. Nothing is scanned until you consent.
- **Seven views:** Orrery (live sessions as planets around project suns, with a "needs you" state), Almanac (history by day), Folio (a session read as a parchment document), Field Guide (80 built-in agents, with where each keeps its data and how much Armillary can do), Switchboard (MCP servers and rules files side by side, read-only), Launchpad (start a command-line agent or a shell in an embedded terminal in a project), Search (one full-text search over every imported session).
- **History import for 22 agents:** Aider, Amp, Antigravity CLI, Claude Code, Cline, Continue, Crush, Cursor CLI, Factory Droid, Gemini CLI, GitHub Copilot CLI, Goose, Hermes Agent CLI, iFlow CLI, Kilo Code, Kimi Code CLI, Open Interpreter, OpenAI Codex CLI, OpenCode, Qoder CLI, Qwen Code, Roo Code. The other 58 catalogue entries are detected, not imported.
- **One private archive** (SQLite with full-text search) in the app's data folder, owner-only permissions, imports that do not overwrite newer complete history with an incomplete read, and a shared data contract (`crates/model/CONTRACT.md`, namespace `armillary.cf.v1`) between importers, archive and interface.
- **Two themes:** night, and the light "Day almanac".
- **Privacy by construction:** consent before any read, checked in the core for every command that reads agent folders, with a clear "not given access" state after Not now; credential files never opened, also through links; links that leave an agent's folder or project not followed; read-only access to agent files; a content security policy that allows connections only to the app itself; no network calls, telemetry or update check in the app. Details and caveats: PRIVACY.md.
- **Delete archive and reset** in the rail stops the watcher, the live detector and any import (a running live-detector pass and an import that is about to start stop immediately; a file already being read finishes and nothing new is read), then removes the archive (with any copies kept by "Move it aside"), the first-run choice and the app's local storage after a confirmation. A damaged archive, or one from a newer version, is explained with a way to move it aside instead of stopping the launch.
- **Safer launching:** the Launchpad only starts agents from an allow-list or a plain shell, with a resolved executable path, and ends every terminal when the app quits. Generic program names (for example `zero`, `happy`, `jan`) are not reported as installed agents without corroborating evidence.

## Known limits

- **Not externally audited.** Internal safety reviews found consent, link, export and deletion problems that this version fixes; no independent third-party audit has been done.
- **No export yet.** Export of a session to Markdown or HTML (with a Redact pass) is planned; it is switched off in 0.1.0 because saving the file was not finished.
- **64 MiB and 250,000 records per file.** Each history file, and each SQLite database or write-ahead log, is read whole and skipped above 64 MiB or 250,000 records, for every imported agent; the Field Guide shows "Skipped, too large" with the limit and the file's name. Very long sessions in one file are not imported. For Roo Code, Kilo Code and Cline, whose conversation spans several files, a task whose conversation file is too large can appear with fewer messages.
- **Not now, a later decline and Delete archive and reset.** Choosing "Not now", declining on a Replay, or choosing Delete archive and reset stops the watcher, the live detector and any import: a running live-detector pass and an import that is about to start stop immediately; a file already being read finishes and nothing new is read. After "Not now" or a later decline, sessions imported earlier stay in the archive (and in the Almanac, Folio and Search) until Delete archive and reset.
- **The archive keeps deleted transcripts.** When an agent deletes or prunes its own transcript, the archive keeps its copy until you use Delete archive and reset. There is no per-session delete.
- **Verified on sample data.** The built app was run end to end on a synthetic home folder (an invented developer and five invented projects). It has had little exercise against real agent folders.
- **Importer fidelity.** The importers were tested against synthetic files shaped like each agent's real layout, not against every real release. Known gaps: Codex failures and plan updates are not mapped; Qwen's real message format is not expressible; Copilot CLI, Goose, Cursor CLI and Amp import tool calls but not their results; Aider and Amp sessions have no project; Cursor CLI times are the chat's creation time; Goose timestamps need an offset. Full list: `demo/dataset/README.md`.
- **"Needs you"** appears only from an agent's own waiting signal; otherwise a session shows as working, idle or unknown.
- **Windows and Linux are not supported in 0.1.** Windows history reads fail closed by design.
- **Switchboard is read-only.** Copying a server or rule between agents (with a diff preview and backup) is planned for 0.2. Chorus and Relay are not built.
- **The archive is not encrypted** and holds a copy of the imported transcripts. A secret that was typed into a transcript is copied with it.
- **Sample-data mark.** When the interface runs on the built-in presentation snapshot (the browser build with `?presentation=1`, as in the screenshots), the rail shows a small "Sample data" mark.
- The code is MIT licensed (see LICENSE).

## Tests

Run `tools/test-all.sh` to run every suite (the Rust workspace, the Tauri app crate and vitest in app, design, ui/orrery, ui/folio and ui/firstrun) and print one total.
