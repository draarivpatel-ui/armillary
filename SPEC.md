# Armillary (working name): every AI agent you use, in one observatory

Status: v0.1 design and contract. "Armillary" is a working name; the live view inside it is called the Orrery. This file is the design contract that the code, tests and documentation refer to.

## 0. Decisions at a glance

- **Name:** Armillary (working name). The live view inside it is called the Orrery.
- **What it is:** a desktop app (macOS only in v0.1; Windows and Linux are not supported yet) that finds every AI agent on the machine (terminal CLIs, desktop apps, IDE agents, cloud agents; 80 built-in catalogue entries at v0.1, niche ones included; the count is the number of TOML files in `crates/adapters/src/builtins`, so read it from `agents_list()` rather than typing it), imports their session history into one private local archive, shows what is running right now, and lets the user search, read, launch and configure them from one place.
- **How it looks:** an antique observatory at night. Deep ink, gilt line work, vermilion for anything that needs the user, parchment for documents. Not a terminal, not a generic dashboard. Celestial instruments, star charts and gilt hairlines.
- **Signature view:** the Orrery. Each project is a sun; each live agent session is a planet orbiting it; orbit speed follows activity; a session that needs the user swings to the front, turns vermilion and rings a small bell.
- **Stack:** Tauri v2 (Rust core) + React 19 + TypeScript + Vite; SQLite with FTS5 for the archive; Canvas 2D for the orrery; xterm.js + portable-pty for embedded terminals. No Tailwind and no component kit: a custom design system (section 3).
- **Privacy:** everything stays on the machine. No network calls from the app (except an opt-in update check later). Agent data is read-only; the app never modifies an agent's files except through the Switchboard with explicit confirmation and a backup. Credential files are never opened.

## 1. Who it is for and why it wins

Developers who use several AI agents (Claude Code plus Codex plus Cursor plus a niche CLI or two). Today their history is scattered across a dozen formats and folders, live state is invisible unless a terminal is in front of them, and every agent has its own rules file and MCP config. Existing tools tend to cover a few agents each. Armillary aims for: (1) breadth: the largest catalogue of agents, niche ones included, each with an honest coverage level; (2) one archive and one search across all of them; (3) a presentation people want to leave open; (4) one place to see and align rules and MCP servers across agents.

## 2. Surfaces (v0.1 unless marked later)

1. **Orrery (live).** Suns are projects (git roots or working folders), planets are sessions active in the last few minutes, moons are subagents. Planet colour = agent family (section 3.2), size = turns in this session, orbit speed = recent activity. States: working (orbiting), waiting for the user (planet swings to the front of its orbit, vermilion halo, a soft bell glint once, a "needs you" label with how long), idle (slow, dim), done (settles into a ring of finished sessions around the sun for the day). Click a planet: the Folio opens beside it. Keyboard: arrow keys move between planets, Enter opens.
2. **Almanac (history).** A calendar of days; each day lists its sessions grouped by project, with agent glyphs, durations, turns and touched files. Filters: agent, project, date, status, model.
3. **Folio (reader).** A session rendered as a beautiful document, not a log: user prompts as headed paragraphs, assistant replies as body text, tool calls and file edits as marginalia notes with expandable diffs, plans and to-do lists as checklists, errors as red marginal marks, token usage in the footer. Export to Markdown or HTML with an optional redaction pass.
4. **Field Guide (agents).** An illustrated entry per known agent (80 at v0.1): installed or not, version, where its data lives on this OS, what Armillary can do with it (coverage level: detect, history, live, config), docs link. A new install shows up automatically.
5. **Switchboard (config).** Every agent's MCP servers and rules files (AGENTS.md, CLAUDE.md, GEMINI.md, .cursor/rules and others) side by side, with differences highlighted. v0.1 read-only; v0.2 copy a server or rule to other agents with a preview diff and an automatic backup.
6. **Launchpad.** Start any installed CLI agent in an embedded terminal inside a project, styled to match. Later: **Chorus** (send one prompt to several agents at once and compare their diffs) and **Relay** (start another agent with a context packet built from a session).
7. **Search.** One box over everything (SQLite FTS5): prompts, replies, tool names, file paths; filters by agent, project and date; results open in the Folio at the hit.

## 3. Design system ("Observatory")

### 3.1 Palette (dark is the default; light is "Day almanac")

| Token | Dark | Light | Use |
|---|---|---|---|
| ink-0 | #0B1220 | #F3EBDA | window background |
| ink-1 | #111A2E | #EADFC8 | panels |
| ink-2 | #18233B | #DFD1B4 | raised panels, hover |
| line | #2A3756 | #C9B78F | hairlines, dividers |
| gilt | #C9A24A | #8A6A22 | primary accent, active lines, focus rings |
| gilt-soft | #E2C77E | #A88634 | highlights |
| vermilion | #D2462E | #B83A24 | needs-you, alerts, destructive |
| verdigris | #3E8E7E | #2F6F62 | done, success |
| star | #F4F1E8 | #1D1A14 | primary text |
| dust | #8E9AB4 | #6B6152 | secondary text |
| parchment | #F1E8D5 | #FBF6EA | Folio page |

Contrast: text on backgrounds at least 4.5:1 (WCAG AA); check every pair in a test.

### 3.2 Agent families (planet colours; both themes)

Anthropic #D08A5C, OpenAI #6FB7A8, Google #7A9CE0, GitHub/Microsoft #9C8ADE, Cursor #B9B2A6, open-source CLIs #C9A24A, Chinese labs #D46A6A, other #8E9AB4. Each agent also has a monochrome glyph (a small engraved symbol) so colour is never the only cue.

### 3.3 Type (open licence, bundled locally with their OFL files)

Display: Cormorant (Garamond family, OFL) for titles, day names and numbers. UI and body: Instrument Sans (OFL). Mono: Commit Mono (OFL) for code, paths and the terminal. Sizes on an 8 px rhythm; body 14 px; Folio body 16 px with 1.6 line height.

### 3.4 Texture and line

Gilt hairlines at 0.75 px; engraved hatching (SVG patterns) for shading on illustrations; a very faint star-field grain on dark backgrounds and paper grain on the Folio page (2 to 3 percent opacity). No drop shadows on dark; depth comes from ink steps and hairlines.

### 3.5 Motion

Orbits move continuously and slowly (a full orbit in 40 to 120 s depending on activity). UI transitions 220 ms with cubic-bezier(0.25, 0.1, 0.25, 1). A needs-you planet swings forward over 600 ms, its halo pulses once, then stays steady. Nothing loops just to look busy. `prefers-reduced-motion`: planets hold still at their positions and state changes cross-fade.

## 3A. First run: the observatory opens (the signature animation)

The first run is the product's first impression, so it is choreographed like a title sequence and driven by REAL progress (detection and import), never a fake timer. Target 60 fps on a 2020 laptop; WebGL2 with a Canvas 2D fallback; every scene has a reduced-motion version (static frames and cross-fades) and can be skipped with Escape or a visible Skip.

1. **Night falls (0 to 2.5 s).** Black window; a deep star field fades in on three parallax layers with slow twinkle; a gilt hairline frame draws itself around the window (stroked path, ease-out), with degree ticks appearing in sequence like an engraver's burin.
2. **The instrument assembles (2.5 to 6.5 s).** An armillary sphere builds at the centre, ring by ring: the equator ring draws, the meridian swings in on its axis with slight overshoot, the ecliptic tilts to 23.4 degrees, the horizon ring settles; engraved tick marks and numerals etch along each ring; a specular glint travels along the gilt; faint hatching shades the rings' undersides. The name ARMILLARY engraves beneath it letter by letter in Cormorant.
3. **What Armillary reads (consent).** A parchment plaque lowers on two gilt chains: the two lists (reads / never reads), the folders it will look in, and the choice to continue. Nothing is scanned before this.
4. **Scanning the sky (real detection).** A telescope beam sweeps the sphere; each agent found on the machine ignites as a star at its place on the celestial sphere (a flare with diffraction spikes in its family colour, its glyph and name engraving in beside it); agents not found remain faint chart dots with their names in dust; a counter tallies 'agents found'. Each found agent then gathers its history: an arc fills around its star as its sessions import (real counts), with a soft chime-free pulse when it completes; errors show as a vermilion tick with the reason.
5. **Constellations (import done).** Agents used in the same project connect with gilt lines drawn star to star, forming constellations named after the projects; the sphere slowly rotates to show them.
6. **Into the Orrery (transition).** The camera dollies in; the constellations unfold into the Orrery: each project's constellation collapses into its sun, live sessions spin out onto their orbits, the frame and degree scale morph into the Orrery's frame. Continuous, no cut.

Everywhere else, motion is crafted but quiet: the left rail's gilt marker slides between views; views cross-fade with a slight parallax; Almanac days stagger in; search hits twinkle once; opening a session in the Folio unrolls the parchment from the top; the Orrery's needs-you swing (section 2.1). Motion never loops just to look busy after the first run.

## 4. Architecture and frozen shared contract

The Rust workspace uses `crates/model` (`armillary-model`) as the single source of truth for normalized data and identity. `crates/adapters` and `crates/archive` consume and re-export it. The Tauri application has its own workspace and must add a path dependency on this crate. Application TypeScript types are generated from its JSON Schema at `crates/model/generated/contract.ts`; do not maintain independent mirrored interfaces. The complete builder contract is `crates/model/CONTRACT.md`, namespace `armillary.cf.v1`.

The normalized model includes Agent catalogue metadata; Install identity, executable/version, profile and stores; StoreIdentity namespace, canonical root and profile; SourceProvenance adapter ID/version, source-relative path, file identity, generation and checkpoint; Session with retained optional native session/parent IDs; ordered Message content blocks; Usage and explicit observation semantics; and Live with unknown state, evidence, observed time, confidence, process identity and expiry. Optional times and metrics remain unknown rather than zero. Times are Unix milliseconds and integer values must fit JavaScript's safe integer range.

Messages contain ordered text, code, tool call, correlated tool result, structured edit/diff, checklist, error and attachment-reference blocks. Tool calls/results share event order and call IDs; there is no independent tool sequence. Search anchors use message ID, sequence and block index. Session completion requires native evidence, not a quiet file, last message or assistant reply.

IDs use one SHA-256 algorithm: length-prefix each UTF-8 string with its u64 big-endian byte length, in order `armillary.cf.v1`, kind, inputs; retain all 64 hex characters. Store inputs are namespace, canonical STORE root and opaque profile ID. Native session inputs are store ID and native ID; source-path fallback has a separate kind and leaves native ID null. Source IDs use store ID and relative source path. Native message IDs use session ID and native event identity; source-position messages and usage have separate kinds with session, source key, generation and record position inputs. CLI/desktop surfaces reading one store share its identity; different profiles cannot collide. Adapter version and importer installation do not change identity.

Imports are complete snapshots or append deltas with exact base checkpoints. A failed/incomplete read updates diagnostics only. Older generations/revisions, conflicting replay, unobserved file rotation and truncation are refused. Integration persists monotonic counters, independent of mtime. Snapshots replace only explicitly included source/session content; rotation retains prior history, and missing files/sessions on a scan never imply deletion. Confirmed source deletion requires the exact accepted provenance and evidence, removes content and FTS together, and leaves a tombstone against delayed watcher work. Session/message/FTS/checkpoint/live changes are transactional, including rollback on write failure.

The archive migrates v1 to v2 atomically, preserving transcript content in an unresolved legacy store and recording identity/lifecycle diagnostics rather than guessing profiles or promoting old live state to evidence. Private archive and SQLite snapshot permissions are enforced and tested on macOS. Logical deletion is immediate; compaction and the application's private retention policy govern free-page remnants.

## 5. Adapters and read boundaries

Each adapter declares metadata, a format/version and source-specific platform paths. Detection-only entries keep parsing without importing speculative history. The engine supports JSONL, JSON, SQLite SELECT projections/grouping and Markdown sections, with documented JSON-pointer mappings, type/metadata/completion filters, text transforms, timestamp formats and explicit usage semantics. Unknown keys, unsupported values and unsupported combinations are rejected at load time. Cumulative totals take the latest known value, deltas sum with overflow checks, duplicate native usage events are deduplicated, and unknown/mixed semantics retain unknown totals.

Every source uses explicit approved roots and one filesystem read boundary. Canonical containment, credential-component refusal and POSIX no-follow directory-handle opens prevent safe-looking symlinks from escaping to files such as `../auth.json`. Only regular files are read, with byte/record limits and mutation checks. Reader, parser and directory errors are visible diagnostics; a successful prefix is never called a complete snapshot. Sources do not reread other sources' files, and fixture discovery excludes its `expected.json` oracle.

SQLite captures the database and WAL/SHM through the boundary into a private temporary snapshot, verifies source stability, then queries only the snapshot read-only. Source databases are never opened immutable or written. Reserved URI bytes are encoded. Write/ATTACH statements are rejected. Passive discovery never launches agent binaries; an explicit optional version probe needs an exact resolved trusted path, timeout and output cap.

Reference adapters Claude Code and Codex CLI have versioned CF specs and regenerated full synthetic goldens, including call/result chronology and explicit usage. Every other builtin continues loading; existing non-reference history goldens have labelled legacy text/count smoke checks pending their owners' full contract migration. Fixtures are synthetic only and establish parser behavior, not current-release compatibility. Actual Windows history reads/probes fail closed pending a tested native boundary; passive Windows detection/path tests remain available. Do not present unsupported or unverified coverage as operational.

## 6. Core to UI API and package integration

The archive ingestion boundary is `import_batch(ImportBatch)` plus `source_checkpoint`, source `diagnostics` and `confirm_source_deleted(ConfirmedSourceDeletion)`. The old lossy `SessionImport` reconstruction API is removed. Source integration registers catalogue agents and installs, establishes shared store/profile identity, approves roots per source, persists counters and accepted checkpoints, and explicitly confirms deletion. Discovery failure must not produce an accepted partial manifest.

Archive reads include `sessions_query`, `get_session`, ordered `session_messages`, `messages_page`, filtered paged search and `live_list`. Search results carry session ID, native message anchor, sequence, block index, optional time and highlighting. Tauri adapters should expose `agents_list()`, `sessions_query(filter)`, `session_get(id)`, `messages_page(id, limit, offset)`, `search(query, filter)`, `live_list()`, `import_diagnostics(source_key)`, and `import_now(agent_id?)`, with typed input/permission/capability errors and cancellation at the integration layer. Existing config/PTY commands remain separate packages' responsibilities: `config_list`, `pty_open`, `pty_write`, `pty_resize`, `pty_close`. These planned commands are not all wired by CF.

Live updates are explicit preserve, update or remove actions. Omission preserves a row; completion does not implicitly remove it. Known states require evidence/confidence, stale observations/removals are rejected, and unknown is a real display state. Live integration expires stale evidence and displays "needs you" only from a reliable native waiting signal. Events remain `live:update` (at most four per second), `import:progress`, and `pty:data`.

Folio and Search consume ordered blocks and call IDs, preserve structured content and open exact block anchors. Almanac preserves unknown dates, durations and usage. Orrery accepts unknown/evidenced live observations and explicit removals. All surfaces import generated CF types. Source Markdown, links, attachments, tool JSON and FTS snippets remain untrusted: renderers must escape content/highlight tokens, disable remote fetches and use narrow application permissions. Passing Rust tests does not certify desktop integration or rendered UI behavior.

## 7. Review gates

A change merges only when: its tests pass; the whole diff has been read; there are no network calls in app code; no credential file names are opened; there is no real user data in fixtures; there are no em or en dashes in user-facing text; and the UI looks right in both themes.
