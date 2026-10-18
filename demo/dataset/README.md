# Armillary presentation dataset

A fictional developer's HOME, in the real folder layouts of eleven agents, rich enough for the demo recordings and the
screenshots. The app reads it through the REAL importer, the REAL live detector and the REAL Switchboard scanner.
Everything in it is invented: no real people, companies, hosts, credentials or paths.

```bash
python3 -I demo/dataset/generate.py /tmp/armillary-demo-home                       # live files relative to the current time
python3 -I demo/dataset/generate.py /tmp/armillary-demo-home --now 2026-10-12T18:00:00Z   # fixed, byte-identical output
```

Never point the app, the importer or a scan at a real home folder. Run the app with `HOME=<generated dir>`.

## What is in it

- **Persona:** Alex Mercer, `alex.mercer@fictional-dev.invalid` (RFC 2606 reserved TLD). Work hours are US Central, so
  sessions start between 14:00Z and 02:00Z.
- **Window:** 14 days up to the fixed reference `2026-10-12T18:00:00Z` (a Monday): busy Tuesday to Thursday, a quiet
  Friday, nothing on Saturday 3 Oct or Sunday 11 Oct, one short evening session on Sunday 4 Oct and one on Saturday 10 Oct.
- **Sessions:** 60 (56 history + 4 live), durations from about 5 to 90 minutes, messages minutes apart.
- **Five projects** under `/Users/fictional-dev/projects` (the cwd inside the records; the folder does not exist):
  `skyline-weather` (anchor "Doppler radar sweep"), `nexus-gateway` ("token bucket rate limiter"),
  `aurora-docs` ("interactive API playground"), `vortex-pipeline` ("parquet zero-copy deserializer"),
  `zenith-cli` ("distributed consensus ping").
- **Uneven on purpose:** each project is led by two or three agents, some agents work in one project only, there is a long
  tail. Mix (agent: sessions, aider and amp are stored without a project, see the limits): skyline-weather claude-code 4, cursor-cli 3, qwen-code 2, amp 2; nexus-gateway codex-cli 5,
  claude-code 2, gemini-cli 2, github-copilot-cli 2, aider 1; aurora-docs claude-code 3, cline 3, opencode 2, cursor-cli 1,
  github-copilot-cli 1, aider 1; vortex-pipeline goose 4, codex-cli 3, gemini-cli 3, qwen-code 1, cline 1, aider 1;
  zenith-cli opencode 3, claude-code 3, codex-cli 3, gemini-cli 1, github-copilot-cli 1, cline 1, aider 1.
  Per agent: claude-code 12, codex-cli 11, gemini-cli 6, opencode 5, cline 5, cursor-cli 4, github-copilot-cli 4, goose 4, aider 4, qwen-code 3, amp 2.
- **Models** are illustrative names, not claims about real releases.

## Hero sessions (the ones to show)

Listed with their keys in `demo-manifest.json` (`heroes`). All have tool calls, token usage, Markdown replies with code blocks.

| key | agent | project | what it shows |
|---|---|---|---|
| `hero/claude-skyline-radar-jitter` | Claude Code | skyline-weather | the Folio hero, 64 min: a TodoWrite plan updated three times, Read/Grep/Glob/Bash, a Task subagent, a Write, four Edits (one is a long multi hunk replacement), two failing test runs then a passing one, token usage per turn |
| `hero/claude-nexus-burst-multiplier` | Claude Code | nexus-gateway | a rustc `error[E0308]` result, the fix, a passing `cargo test` |
| `hero/claude-zenith-diagnostics-plan` | Claude Code | zenith-cli | a checklist plan ticked off over three TodoWrite updates, a plan document, a new test |
| `hero/codex-nexus-bucket-refill` | Codex CLI | nexus-gateway | shell commands with output, an `apply_patch` edit, plan updates as checklists, a failing then passing `cargo test`, a native completion event |
| `hero/gemini-vortex-allocator` | Gemini CLI | vortex-pipeline | allocation profile before and after, three edits, a results table in the summary |
| `hero/cline-aurora-copy-button` | Cline | aurora-docs | failing command (`is_error`), `replace_in_file` diffs, a fix, a passing run |
| `hero/opencode-zenith-ping-timeout` | OpenCode | zenith-cli | a todo list, a failing test result, a design fix found by the failure |

## Live sessions and the needs-you swing

Four files are written relative to `--now` (default: the current time), two working and two waiting:

| manifest key | agent | project | state |
|---|---|---|---|
| `live/claude-skyline-waiting` | Claude Code | skyline-weather | waiting: last record is a `permission_prompt` |
| `live/codex-nexus-waiting` | Codex CLI | nexus-gateway | waiting: last record is a `request_approval` |
| `live/claude-aurora-working` | Claude Code | aurora-docs | working: last write 6 s before `--now` |
| `live/codex-vortex-working` | Codex CLI | vortex-pipeline | working: last write 11 s before `--now` |

**`processes.json`** (in the HOME root, never inside an agent folder) is a synthetic process table: fictional pids, the binaries
`claude` and `codex`, cwd = the fictional project roots, start times relative to `--now`. The presentation exporter feeds it to
the real `LiveDetector` through its `FakeProcessScanner` (`{pid, binary, cwd, started_at}`), with
`history_roots = {claude-code: <home>/.claude, codex-cli: <home>/.codex}`.

**The swing** (a working session becomes "needs you" at a time you choose):

```bash
python3 -I demo/dataset/generate.py <home> --append-live claude-aurora-working --now 2026-10-12T18:00:40Z
python3 -I demo/dataset/generate.py <home> --append-live codex-vortex-working   --now 2026-10-12T18:01:10Z
```

`--append-live` does not regenerate: it appends the agent's native waiting record to the existing file (a `permission_prompt` for
Claude Code, a `request_approval` for Codex), sets the file's mtime to `--now` and updates `demo-manifest.json`. From Python:
`dsgen.live.append_live(home, key, now_datetime)`. The next detector scan reports the session as `waiting`.

Known detector behaviour to plan around: `LiveDetector` treats every history file whose project cwd matches a live process as alive,
so older sessions in the same project (for example the other Claude sessions in aurora-docs) are also reported as `idle`. The exporter
should keep only the sessions it wants to show.

## Switchboard configs

`generate.py` writes real-looking setups where each agent reads them (`app/src-tauri/src/config_scan.rs` is the reader):

- Global: `~/.claude.json` (+ per-project server lists keyed by the fictional absolute paths), `~/.codex/config.toml`,
  `~/.gemini/settings.json`, `~/.cursor/mcp.json`, `~/.config/opencode/opencode.json`, `~/.copilot/mcp-config.json`,
  `~/.codeium/windsurf/mcp_config.json`, `~/.cline/data/settings/cline_mcp_settings.json`, plus a global rules file for each.
- Project files live in **`<home>/projects/<slug>/`** (the fictional `/Users/fictional-dev/...` folders do not exist on the machine).
  Pass those eight folders as the scan's `project_roots`. They hold `.mcp.json`, `CLAUDE.md`, `AGENTS.md`, `GEMINI.md`,
  `.cursor/mcp.json`, `.cursor/rules/*.mdc`, `.codex/config.toml`, `.gemini/settings.json`, `opencode.json`,
  `.github/copilot-instructions.md`, `.github/mcp.json`, `.clinerules/*.md`, `.cline/mcp.json`, `.windsurfrules`.
- The mix: `filesystem` and `fetch` are in all eight agents (`filesystem` is wired differently in Cline), `postgres-readonly` in four,
  `playwright` is disabled in Cursor, `docs-search` is disabled in Codex, remote servers use HTTP and SSE, project servers
  (`weather-fixtures`, `redis-inspector`, `openapi-lint`, `parquet-peek`, `cluster-sim`) appear in some agents only.
- Masking: two values trip the scanner's masking (an `api_key` query parameter in the OpenCode `docs-search` URL, an `--auth-token`
  argument in Cline's `sentry-lite`) and one rules file carries a token assignment. All use `demo-placeholder-not-a-secret`.
- Rules differ on purpose: `skyline-weather/CLAUDE.md` says pnpm, `AGENTS.md` says npm.

## Output files besides the agent folders

- `demo-manifest.json`: every session (agent, project, key, native id, file, start and end), the heroes, the live sessions, the
  project roots. Use it to find sessions instead of guessing.
- `processes.json`: see above.

## Layout written (as each adapter reads it)

| Adapter | Where | Notes |
|---|---|---|
| Claude Code | `~/.claude/projects/<cwd with / as ->/<sessionId>.jsonl` | `message.usage` per assistant record, `tool_use`/`tool_result` with `is_error` |
| Codex CLI | `~/.codex/sessions/YYYY/MM/DD/rollout-<time>-<id>.jsonl` | `session_meta`, `event_msg` items, cumulative `token_count`, `session_completed` |
| Gemini CLI | `~/.gemini/tmp/<sha256 of project path>/chats/session-<time>-<id>.jsonl` | `toolCalls`, `tokens` |
| Cursor CLI | `~/.cursor/chats/<md5 of project path>/<id>/{meta.json,store.db}` | blobs of message arrays |
| OpenCode | `~/.local/share/opencode/opencode.db` | `session`, `message`, `part` tables |
| Goose | `~/.local/share/goose/sessions/sessions.sqlite` | `sessions`, `messages` |
| Aider | `~/.aider/.aider.chat.history.md` | one Markdown file, `#### ` prompts, `> ` tool lines (banner, Tokens), SEARCH/REPLACE blocks, `/run` commands |
| Qwen Code | `~/.qwen/projects/<slug>/chats/<id>.jsonl` | |
| GitHub Copilot CLI | `~/.copilot/session-state/<id>/events.jsonl` | |
| Cline | `~/.cline/data/sessions/<id>/<id>.json` + `.messages.json` | |
| Amp | `~/.local/share/amp/threads/T-<id>.json` | |

## Adapter limits found while building this (data is not faked around them)

These come from how the current adapters read the files (`crates/adapters/src/builtins/*.toml`, `modules/*.rs`):

- **Block kinds.** `edit`, `checklist` and `error` content blocks only exist when a record literally carries `{"type":"edit"}` etc.; no
  agent writes that. Real files carry edits as tool calls (`Edit` with `old_string`/`new_string`, `apply_patch`, `replace_in_file`),
  plans as `TodoWrite`/`todowrite` calls (or Markdown `- [x]` lists in Codex messages) and failures as `tool_result` with
  `is_error`. The dataset writes the real shapes; turning them into diffs, checklists and error notes is the UI contract adapter's job.
- **Claude Code.** Fixed by RV-ADP (adapter 1.1.0): `files` now come from `file_path`, `notebook_path` and `path`.
- **Codex.** `is_error` is only read from the record itself, never from `exit_code`, so failing commands import as plain results
  (the failure is in the output text). Plan updates (`todo_list` items) are not mapped; the dataset writes them as Markdown checklists
  in `agent_message`.
- **Gemini.** Fixed by RV-ADP (adapter 0.2.0-unverified): tool calls read `args` and `result`, files from `args/file_path`; the
  dataset no longer writes the extra `input` copy. **Qwen.** Real Qwen records are `message.parts` with `functionCall` and `functionResponse`
  parts, which the declarative mapping cannot express (open); the dataset keeps writing `toolCalls` with `input` for it.
- **Copilot CLI, Goose, Cursor CLI, Amp.** Tool calls import, tool results do not. Copilot imports `command` only (no input for
  `view` or `edit`).
- **Time.** Cursor CLI stamps every message with the chat's creation time (duration 0). Aider and Amp keep a time on the first
  message only (Amp also an end time from its usage ledger). Aider's history has no per-message times at all.
- **Project root.** Aider and Amp sessions carry no project root, so they appear unassigned (decision: left as is; real aider
  history has no cwd).
- **Aider format.** Fixed by RV-ADP (adapter 1.1.0): the module and this renderer follow aider's real history (`#### ` is the user,
  `> ` is tool output, `Tokens:` lines are per-message usage). `/run` output never reaches the real file, so the dataset writes only the
  command and the `Added N lines of output` note. A session's native id is now `<file>#<start time>`.
- **Goose.** Message times need an offset (`...Z`) to parse; real Goose's `YYYY-MM-DD HH:MM:SS` would import with no time.

## Tests

`app/src-tauri/tests/g12_demo_dataset.rs` generates a fresh HOME, imports it through the production importer and checks counts, time,
the hero sessions, search, live detection and the swing, `processes.json`, the Switchboard scan, determinism and a dash sweep:

```bash
cargo test --manifest-path app/src-tauri/Cargo.toml --test g12_demo_dataset
# write every imported session and its block kinds to a file:
ARMILLARY_DEMO_DUMP=/tmp/armillary-dump.txt cargo test --manifest-path app/src-tauri/Cargo.toml --test g12_demo_dataset
```

`python3 -I demo/dataset/dsgen/check.py catalog` lints the session definitions (window, working hours, turn order, text hygiene).
