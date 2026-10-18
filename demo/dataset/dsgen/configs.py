"""Switchboard data: MCP server configs and rules files for the fictional agents and projects.

Global files go in the fictional HOME exactly where each agent reads them. Project files go in
<home>/projects/<slug>/ (the fictional project root /Users/fictional-dev/projects/<slug> does not exist
on the machine, so the Switchboard scan gets <home>/projects/<slug> as its project root).

The mix is deliberate: two servers are configured in all eight agents (one with identical wiring, one with a
different folder in Cline), some are in only a few, one is disabled in two agents, two carry a value that the
scanner masks, and the rules files for the same project say different things in CLAUDE.md and AGENTS.md.
Secret-shaped values are all the obviously fake "demo-placeholder-not-a-secret".
"""

import json
import os
from pathlib import Path

from . import model as m

PLACEHOLDER = "demo-placeholder-not-a-secret"
OLD = int(m.at("2026-09-20", "15:00").timestamp())

# ---------------------------------------------------------------------------
# helpers


def put(home, rel, text):
    p = home / rel
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(text if text.endswith("\n") else text + "\n", encoding="utf-8")
    os.utime(p, (OLD, OLD))


def jdump(obj):
    return json.dumps(obj, indent=2, ensure_ascii=False)


def stdio(command, *args, env=None, **extra):
    d = {"type": "stdio", "command": command, "args": list(args)}
    if env:
        d["env"] = env
    d.update(extra)
    return d


NPX_FS = ["-y", "@modelcontextprotocol/server-filesystem", "/Users/fictional-dev/projects"]
FS = stdio("npx", *NPX_FS)
FETCH = stdio("uvx", "mcp-server-fetch")
PG = stdio("uvx", "mcp-server-postgres", "--dsn", "postgres://readonly@localhost:5432/appdb",
           env={"PGSSLMODE": "disable"})
PLAYWRIGHT = stdio("npx", "-y", "@playwright/mcp@0.0.41")
GIT_HOST_URL = "https://mcp.git-host.invalid/v1/"
DOCS_URL = "https://mcp.docs-search.invalid/v1"

# ---------------------------------------------------------------------------
# global MCP configs


def claude_global():
    return {
        "numStartups": 214,
        "theme": "dark",
        "mcpServers": {
            "filesystem": FS,
            "fetch": FETCH,
            "postgres-readonly": PG,
            "playwright": PLAYWRIGHT,
            "github": {"type": "http", "url": GIT_HOST_URL,
                       "headers": {"Authorization": "Bearer ${GIT_HOST_TOKEN}"}},
            "docs-search": {"type": "http", "url": DOCS_URL},
            "sentry-lite": {"type": "sse", "url": "https://mcp.sentry-lite.invalid/sse"},
        },
        "projects": {
            m.project_cwd("skyline-weather"): {
                "allowedTools": [],
                "mcpServers": {"weather-fixtures": stdio("python3", "-m", "skyline.mcp_fixtures", "--port", "8089")},
            },
            m.project_cwd("nexus-gateway"): {
                "allowedTools": [],
                "mcpServers": {"redis-inspector": stdio("npx", "-y", "@nexus/redis-inspector-mcp", "--url", "redis://localhost:6379/0")},
            },
        },
    }


def codex_toml():
    return f'''model = "gpt-6.1"
approval_policy = "on-request"
sandbox_mode = "workspace-write"

[mcp_servers.filesystem]
command = "npx"
args = ["-y", "@modelcontextprotocol/server-filesystem", "/Users/fictional-dev/projects"]

[mcp_servers.fetch]
command = "uvx"
args = ["mcp-server-fetch"]

[mcp_servers.postgres-readonly]
command = "uvx"
args = ["mcp-server-postgres", "--dsn", "postgres://readonly@localhost:5432/appdb"]
env = {{ PGSSLMODE = "disable" }}

[mcp_servers.playwright]
command = "npx"
args = ["-y", "@playwright/mcp@0.0.41"]

[mcp_servers.github]
url = "{GIT_HOST_URL}"
bearer_token_env_var = "GIT_HOST_TOKEN"

[mcp_servers.docs-search]
url = "{DOCS_URL}"
enabled = false
'''


def gemini_settings():
    return {
        "theme": "Default",
        "mcpServers": {
            "filesystem": FS | {"trust": False},
            "fetch": {"command": "uvx", "args": ["mcp-server-fetch"]},
            "postgres-readonly": {"command": "uvx", "args": ["mcp-server-postgres", "--dsn", "postgres://readonly@localhost:5432/appdb"],
                                  "env": {"PGSSLMODE": "disable"}},
            "playwright": {"command": "npx", "args": ["-y", "@playwright/mcp@0.0.41"]},
            "github": {"httpUrl": GIT_HOST_URL, "headers": {"Authorization": "Bearer ${GIT_HOST_TOKEN}"}},
            "context-notes": {"command": "node", "args": ["/Users/fictional-dev/tools/context-notes-mcp/index.js"]},
        },
        "context": {"fileName": ["GEMINI.md", "AGENTS.md"]},
        "telemetry": {"enabled": False},
    }


def cursor_global():
    return {"mcpServers": {
        "filesystem": FS,
        "fetch": FETCH,
        "postgres-readonly": PG,
        "playwright": PLAYWRIGHT | {"disabled": True},
        "figma-bridge": {"url": "http://localhost:3845/sse"},
    }}


def opencode_global():
    return {"$schema": "https://opencode.ai/config.json", "mcp": {
        "filesystem": {"type": "local", "command": ["npx", *NPX_FS], "enabled": True},
        "fetch": {"type": "local", "command": ["uvx", "mcp-server-fetch"]},
        "playwright": {"type": "local", "command": ["npx", "-y", "@playwright/mcp@0.0.41"]},
        "docs-search": {"type": "remote", "url": DOCS_URL + "?api_key=" + PLACEHOLDER,
                        "headers": {"X-Client": "opencode"}},
        "context-notes": {"type": "local", "command": ["node", "/Users/fictional-dev/tools/context-notes-mcp/index.js"], "enabled": True},
    }}


def copilot_global():
    return {"mcpServers": {
        "filesystem": FS,
        "fetch": FETCH,
        "github": {"type": "http", "url": GIT_HOST_URL, "headers": {"Authorization": "Bearer ${GIT_HOST_TOKEN}"}},
        "context-notes": {"type": "stdio", "command": "node", "args": ["/Users/fictional-dev/tools/context-notes-mcp/index.js"]},
    }}


def windsurf_global():
    return {"mcpServers": {
        "filesystem": FS,
        "fetch": FETCH,
        "docs-search": {"serverUrl": DOCS_URL},
        "context-notes": {"command": "node", "args": ["/Users/fictional-dev/tools/context-notes-mcp/index.js"]},
        "figma-bridge": {"serverUrl": "http://localhost:3845/sse"},
    }}


def cline_global():
    return {"mcpServers": {
        # same name as everywhere else, different wiring: Cline points the filesystem server at one project only
        "filesystem": {"command": "npx", "args": ["-y", "@modelcontextprotocol/server-filesystem", "/Users/fictional-dev/projects/aurora-docs"],
                       "disabled": False, "autoApprove": []},
        "fetch": {"command": "uvx", "args": ["mcp-server-fetch"], "disabled": False, "autoApprove": ["fetch"]},
        "sentry-lite": {"command": "npx", "args": ["-y", "@sentry-lite/mcp", "--auth-token", PLACEHOLDER],
                        "disabled": False, "autoApprove": []},
    }}


# ---------------------------------------------------------------------------
# project MCP configs

def project_mcp(home):
    root = lambda slug: f"projects/{slug}"
    # skyline-weather
    put(home, f"{root('skyline-weather')}/.mcp.json", jdump({"mcpServers": {
        "weather-fixtures": stdio("python3", "-m", "skyline.mcp_fixtures", "--port", "8089")}}))
    put(home, f"{root('skyline-weather')}/.gemini/settings.json", jdump({"mcpServers": {
        "weather-fixtures": {"command": "python3", "args": ["-m", "skyline.mcp_fixtures", "--port", "8089"]}}}))
    put(home, f"{root('skyline-weather')}/.codex/config.toml",
        '[mcp_servers.weather-fixtures]\ncommand = "python3"\nargs = ["-m", "skyline.mcp_fixtures", "--port", "8089"]\n')
    put(home, f"{root('skyline-weather')}/.cursor/mcp.json", jdump({"mcpServers": {
        "weather-fixtures": {"command": "python3", "args": ["-m", "skyline.mcp_fixtures", "--port", "8089"]}}}))
    # nexus-gateway
    put(home, f"{root('nexus-gateway')}/opencode.json", jdump({"$schema": "https://opencode.ai/config.json", "mcp": {
        "redis-inspector": {"type": "local", "command": ["npx", "-y", "@nexus/redis-inspector-mcp", "--url", "redis://localhost:6379/0"]}}}))
    put(home, f"{root('nexus-gateway')}/.gemini/settings.json", jdump({"mcpServers": {
        "redis-inspector": {"command": "npx", "args": ["-y", "@nexus/redis-inspector-mcp", "--url", "redis://localhost:6379/1"]}}}))
    put(home, f"{root('nexus-gateway')}/.mcp.json", jdump({"mcpServers": {
        "config-lint": stdio("npx", "-y", "@nexus/config-lint-mcp")}}))
    # aurora-docs
    put(home, f"{root('aurora-docs')}/.mcp.json", jdump({"mcpServers": {
        "openapi-lint": stdio("npx", "-y", "@aurora/openapi-lint-mcp", "--spec", "openapi/aurora.yaml")}}))
    put(home, f"{root('aurora-docs')}/.cursor/mcp.json", jdump({"mcpServers": {
        "openapi-lint": {"command": "npx", "args": ["-y", "@aurora/openapi-lint-mcp", "--spec", "openapi/aurora.yaml"]}}}))
    put(home, f"{root('aurora-docs')}/.cline/mcp.json", jdump({"mcpServers": {
        "openapi-lint": {"command": "npx", "args": ["-y", "@aurora/openapi-lint-mcp"], "disabled": True}}}))
    # vortex-pipeline
    put(home, f"{root('vortex-pipeline')}/.mcp.json", jdump({"mcpServers": {
        "parquet-peek": stdio("cargo", "run", "-q", "-p", "parquet-peek-mcp")}}))
    put(home, f"{root('vortex-pipeline')}/.codex/config.toml",
        '[mcp_servers.parquet-peek]\ncommand = "cargo"\nargs = ["run", "-q", "-p", "parquet-peek-mcp"]\n')
    # zenith-cli
    put(home, f"{root('zenith-cli')}/.mcp.json", jdump({"mcpServers": {
        "cluster-sim": stdio("cargo", "run", "-q", "--bin", "cluster-sim-mcp")}}))
    put(home, f"{root('zenith-cli')}/.github/mcp.json", jdump({"mcpServers": {
        "cluster-sim": {"type": "stdio", "command": "cargo", "args": ["run", "-q", "--bin", "cluster-sim-mcp"]}}}))


# ---------------------------------------------------------------------------
# rules

GLOBAL_CLAUDE = '''# Alex's global preferences

- Be direct. Say what you changed and why in a few lines, not an essay.
- Never run destructive git commands (reset --hard, clean -fd, push --force) without asking.
- Prefer small commits with a one line subject in the imperative mood.
- When a test fails, show the failing assertion before you change anything.
- Do not add dependencies without saying why.
'''

GLOBAL_CODEX = '''# Codex defaults

- Ask before running anything that touches the network or production configs.
- Keep patches small; one concern per patch.
- Run the project's test command before saying a change works.
- No dependency changes unless asked.
'''

GLOBAL_GEMINI = '''# Gemini defaults

- Explain the plan in two or three bullets before editing.
- Prefer reading files over guessing.
- Do not rewrite files you were not asked to touch.
'''

GLOBAL_CURSOR = '''---
description: Alex's global Cursor rules
globs:
alwaysApply: true
---

- Match the existing naming style of a file before adding your own.
- Never log a token, even in debug builds.
- Leave a TODO with a name if you stop halfway.
'''

GLOBAL_OPENCODE = '''# OpenCode defaults

- Short answers. Link to the file and line instead of pasting large blocks.
- Run the formatter before finishing.
'''

GLOBAL_COPILOT = '''# Copilot CLI instructions

- Suggest commands first, run them only when asked.
- Prefer the repository's own scripts over ad hoc commands.
'''

GLOBAL_WINDSURF = '''# Windsurf global rules

- Keep diffs minimal and reviewable.
- Name tests after the behaviour they pin down.
'''

PROJECT_RULES = {
    "skyline-weather": {
        "CLAUDE.md": '''# skyline-weather

TypeScript, Vite, MapLibre GL. Package manager: pnpm.

- Test: `pnpm test` (vitest, files sit next to the source).
- The Doppler radar sweep clock must never wait on the network; tile refresh runs beside it.
- Every new radar function gets a fake-timer test, no real sleeps.
- Do not touch `src/ingest/config.ts` defaults without checking the staging poller.
- Commit style: `radar: ...`, `alerts: ...`, `ingest: ...`.
''',
        "AGENTS.md": '''# skyline-weather agents

TypeScript web app. Package manager: npm (the CI image has no pnpm).

- Test: `npm test`
- Lint: `npm run lint`, type check: `npm run typecheck`
- Keep PRs under 300 changed lines.
- Local mock feed: `./scripts/test_radar_feed.sh` (needs the mock on :8089).
- export RADAR_TOKEN=''' + PLACEHOLDER + '''   # local mock only
''',
        "GEMINI.md": '''# skyline-weather (Gemini)

Read `src/radar` before suggesting changes to the sweep. Tests: `npm test`.
''',
    },
    "nexus-gateway": {
        "CLAUDE.md": '''# nexus-gateway

Rust workspace. Gateway hot path: be careful with allocations.

- Test: `cargo test --workspace`; lint: `cargo clippy --workspace --all-targets -- -D warnings`.
- The token bucket rate limiter lives in `crates/limiter`; its public API is frozen.
- Prefer `Instant` injection over reading the clock inside limiter code.
- Benchmarks in `benches/` must be run with `--release`.
- Terraform under `deploy/` is production: plan only, never apply from an agent.
''',
        "AGENTS.md": '''# nexus-gateway agents

Rust workspace.

- Test: `cargo nextest run --workspace` (falls back to `cargo test`).
- Format: `cargo fmt --all` before every commit.
- Production routing config is read only for agents.
''',
        "GEMINI.md": '''# nexus-gateway (Gemini)

Audit before editing: list the files you will change. gRPC settings are in `crates/grpc`.
''',
    },
    "aurora-docs": {
        "CLAUDE.md": '''# aurora-docs

React docs site with an OpenAPI 3.1 viewer. pnpm, Vite, vitest, Playwright.

- Unit tests: `pnpm test`; end to end: `pnpm e2e` (starts the dev server itself).
- The interactive API playground must work without JavaScript errors on plain HTTP previews.
- Keep 4.5:1 contrast on every badge and button, in both themes.
- Do not reformat generated files under `src/openapi/generated`.
''',
        "AGENTS.md": '''# aurora-docs agents

- Install with `pnpm install --frozen-lockfile`.
- Test: `pnpm test`, e2e: `pnpm e2e`.
- Accessibility changes need an axe check in the same PR.
''',
        "GEMINI.md": '''# aurora-docs (Gemini)

Docs site. Search index is built by `scripts/build-search-index.ts`.
''',
    },
    "vortex-pipeline": {
        "CLAUDE.md": '''# vortex-pipeline

Rust plus Python. The parquet zero-copy deserializer is the hot path.

- Rust tests: `cargo test --workspace --release` (debug is too slow for the fixtures).
- Python tests: `cd py/ingest && pytest -q`.
- Never allocate per chunk in `crates/reader`; reuse the scratch buffer.
- Schema changes need a migration in `migrations/` and a test.
''',
        "AGENTS.md": '''# vortex-pipeline agents

- Rust: `cargo test --workspace --release`.
- Python: `pytest -q` in `py/ingest`.
- Profile with `--features dhat-heap` before claiming a speed up.
''',
        "GEMINI.md": '''# vortex-pipeline (Gemini)

Measure first. Use the `batch_profile` binary for allocation numbers.
''',
    },
    "zenith-cli": {
        "CLAUDE.md": '''# zenith-cli

Rust CLI built with clap. Output goes through `src/output`.

- Test: `cargo test`; integration tests in `tests/`.
- Every command that prints must support `--format json`.
- Keep the distributed consensus ping read only; it never changes cluster state.
- Errors are `anyhow::Result` at the edge, typed errors inside `src/consensus.rs`.
''',
        "AGENTS.md": '''# zenith-cli agents

- Test: `cargo test`; lint: `cargo clippy -- -D warnings`.
- Do not add new dependencies without a note in the PR.
''',
        "GEMINI.md": '''# zenith-cli (Gemini)

Cluster admin CLI. Fixtures for tests are in `tests/fixtures`.
''',
    },
}

CURSOR_PROJECT = {
    "skyline-weather": {
        "testing.mdc": '---\ndescription: Radar tests\nglobs: src/radar/**\nalwaysApply: false\n---\n\nUse fake timers for anything that sweeps. No real sleeps.\n',
        "style.mdc": '---\ndescription: TypeScript style\nglobs: **/*.ts\nalwaysApply: true\n---\n\nPrefer `type` imports. No default exports in new files.\n',
    },
    "nexus-gateway": {
        "rust.mdc": '---\ndescription: Rust style\nglobs: **/*.rs\nalwaysApply: true\n---\n\nNo `unwrap()` outside tests. Inject `Instant` into limiter code.\n',
    },
    "aurora-docs": {
        "a11y.mdc": '---\ndescription: Accessibility\nglobs: src/components/**\nalwaysApply: true\n---\n\nEvery interactive element is keyboard reachable and has an accessible name.\n',
    },
}

COPILOT_PROJECT = {
    "skyline-weather": "# Copilot instructions for skyline-weather\n\nUse `npm test` to verify. Prefer small functions in `src/radar`.\n",
    "nexus-gateway": "# Copilot instructions for nexus-gateway\n\nRust workspace. Run `cargo clippy` before suggesting a patch is done.\n",
    "aurora-docs": "# Copilot instructions for aurora-docs\n\nThe playground must stay usable without a mouse.\n",
}

CLINE_PROJECT = {
    "aurora-docs": {"playground.md": "# Playground rules\n\n- Run `pnpm test` after every component change.\n- Never edit generated OpenAPI types by hand.\n"},
    "zenith-cli": {"cli.md": "# CLI rules\n\n- `cargo test` before attempt_completion.\n- Print machine readable output only with `--format json`.\n"},
}

WINDSURFRULES = {"skyline-weather": "Keep the radar layer code in src/radar. Ask before changing the ingest poller.\n"}


def write_all(home):
    # global MCP
    put(home, ".claude.json", jdump(claude_global()))
    put(home, ".codex/config.toml", codex_toml())
    put(home, ".gemini/settings.json", jdump(gemini_settings()))
    put(home, ".cursor/mcp.json", jdump(cursor_global()))
    put(home, ".config/opencode/opencode.json", jdump(opencode_global()))
    put(home, ".copilot/mcp-config.json", jdump(copilot_global()))
    put(home, ".codeium/windsurf/mcp_config.json", jdump(windsurf_global()))
    put(home, ".cline/data/settings/cline_mcp_settings.json", jdump(cline_global()))
    # global rules
    put(home, ".claude/CLAUDE.md", GLOBAL_CLAUDE)
    put(home, ".codex/AGENTS.md", GLOBAL_CODEX)
    put(home, ".gemini/GEMINI.md", GLOBAL_GEMINI)
    put(home, ".cursor/rules/000-global.mdc", GLOBAL_CURSOR)
    put(home, ".config/opencode/AGENTS.md", GLOBAL_OPENCODE)
    put(home, ".copilot/copilot-instructions.md", GLOBAL_COPILOT)
    put(home, ".codeium/windsurf/global_rules.md", GLOBAL_WINDSURF)
    # project MCP and rules
    project_mcp(home)
    for slug, files in PROJECT_RULES.items():
        for name, text in files.items():
            put(home, f"projects/{slug}/{name}", text)
    for slug, files in CURSOR_PROJECT.items():
        for name, text in files.items():
            put(home, f"projects/{slug}/.cursor/rules/{name}", text)
    for slug, text in COPILOT_PROJECT.items():
        put(home, f"projects/{slug}/.github/copilot-instructions.md", text)
    for slug, files in CLINE_PROJECT.items():
        for name, text in files.items():
            put(home, f"projects/{slug}/.clinerules/{name}", text)
    for slug, text in WINDSURFRULES.items():
        put(home, f"projects/{slug}/.windsurfrules", text)
