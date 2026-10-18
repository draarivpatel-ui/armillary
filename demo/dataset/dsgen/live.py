"""The four live sessions, the synthetic process table, and the append hook.

Live sessions are written relative to `now`, so the app sees them as just written:
two working (last write seconds ago) and two waiting (last record is a native waiting signal).
`append_live` turns a working session into a waiting one at a time of the caller's choosing.
"""

import datetime
import json
import os
from pathlib import Path

from . import model as m
from .model import asst, bash, edit, grep, read, user, todo, UTC
from .render import dumps, render_claude, render_codex, set_mtime


def _live_sessions(now_dt):
    """(Sess, agent-specific render options, lag seconds since the last write)."""
    out = []

    # 1. Claude Code, skyline-weather: waiting for a permission (native permission_prompt as last record)
    lag = 95
    mins = 21
    s = m.Sess(
        key="live/claude-skyline-waiting", agent="claude-code", project="skyline-weather",
        start=now_dt - datetime.timedelta(minutes=mins, seconds=lag), minutes=mins,
        model="claude-sonnet-5-5", title=None, branch="radar-feed-ingest",
        turns=[
            user("Run a live check of the radar tile ingestion endpoint against the mock Doppler radar feed. "
                 "The staging poller keeps timing out after the 2.3 deploy and I want to see the raw responses."),
            asst("I'll start with the ingestion script and the mock feed config so I know what the check hits.", [
                read("scripts/test_radar_feed.sh",
                     "#!/usr/bin/env bash\nset -euo pipefail\n\nFEED_URL=\"${FEED_URL:-http://localhost:8089/feed}\"\nTILES_URL=\"${TILES_URL:-http://localhost:3000/api/tiles/ingest}\"\n\necho \"Polling $FEED_URL every 2s for 30s\"\nfor i in $(seq 1 15); do\n  curl -sS --max-time 3 \"$FEED_URL\" | jq -c '{frame: .frame, sweep: .sweep_deg, tiles: (.tiles | length)}'\n  sleep 2\ndone\n\ncurl -sS -X POST \"$TILES_URL\" -H 'content-type: application/json' --data @fixtures/doppler-frame.json\n"),
                read("fixtures/mock-feed.config.json",
                     "{\n  \"port\": 8089,\n  \"frameIntervalMs\": 1000,\n  \"sweepDegreesPerFrame\": 6,\n  \"dropRate\": 0.08,\n  \"latencyMs\": { \"min\": 120, \"max\": 900 }\n}\n"),
            ]),
            asst("The mock feed drops 8 percent of frames and adds up to 900 ms of latency, which would explain the "
                 "poller timeouts if the ingest timeout is below that. Let me check the poller's configured timeout.", [
                grep("timeoutMs", "src/ingest", "src/ingest/poller.ts:14:  timeoutMs: 750,\nsrc/ingest/poller.ts:41:    signal: AbortSignal.timeout(opts.timeoutMs),\nsrc/ingest/config.ts:9:export const DEFAULT_POLL = { intervalMs: 2000, timeoutMs: 750, retries: 2 };"),
            ]),
            asst("The poller aborts at 750 ms while the mock feed can answer in up to 900 ms, so roughly one frame in "
                 "ten is abandoned. I'd like to run the feed check against the live mock to confirm. This runs a local "
                 "script that makes HTTP calls to localhost only.", [
                bash("./scripts/test_radar_feed.sh", "", desc="Run the live radar feed check against the local mock"),
            ]),
        ],
    )
    out.append((s, {"pending_last": True, "tail": [lambda sid, cwd, tm: _claude_permission(
        sid, cwd, tm, "Claude needs your permission to use Bash: ./scripts/test_radar_feed.sh")]}, lag))

    # 2. Codex CLI, nexus-gateway: waiting for command approval (request_approval as last record)
    lag = 70
    mins = 17
    s = m.Sess(
        key="live/codex-nexus-waiting", agent="codex-cli", project="nexus-gateway",
        start=now_dt - datetime.timedelta(minutes=mins, seconds=lag), minutes=mins,
        model="gpt-6.1", completed=False,
        turns=[
            user("Apply the routing config update that raises the token bucket rate limiter burst for the /v2/forecast "
                 "route to 120 and lower the refill to 40 per second. Plan first, then apply."),
            asst("I'll look at the current route table and the Terraform module that renders it.", [
                grep("forecast", "deploy/routes", "deploy/routes/prod.tfvars:31:  \"/v2/forecast\" = { burst = 60, refill_per_s = 80, upstream = \"forecast-svc\" }"),
                read("deploy/routes/prod.tfvars",
                     "routes = {\n  \"/v2/alerts\"   = { burst = 200, refill_per_s = 120, upstream = \"alerts-svc\" }\n  \"/v2/forecast\" = { burst = 60, refill_per_s = 80, upstream = \"forecast-svc\" }\n  \"/v2/radar\"    = { burst = 30, refill_per_s = 25, upstream = \"radar-svc\" }\n}\n", start=28, limit=6),
            ]),
            asst("Updating the forecast route and running a plan so you can review the diff before anything changes.", [
                edit("deploy/routes/prod.tfvars",
                     "  \"/v2/forecast\" = { burst = 60, refill_per_s = 80, upstream = \"forecast-svc\" }",
                     "  \"/v2/forecast\" = { burst = 120, refill_per_s = 40, upstream = \"forecast-svc\" }"),
                bash("terraform plan -var-file=deploy/routes/prod.tfvars -out=tfplan",
                     "Terraform will perform the following actions:\n\n  # module.gateway.nexus_route.forecast will be updated in-place\n  ~ resource \"nexus_route\" \"forecast\" {\n      ~ burst         = 60 -> 120\n      ~ refill_per_s  = 80 -> 40\n        # (3 unchanged attributes hidden)\n    }\n\nPlan: 0 to add, 1 to change, 0 to destroy.\n"),
            ]),
            asst("The plan changes exactly one route. Applying it needs your approval because it touches the production gateway.", [
                bash("terraform apply tfplan", ""),
            ]),
        ],
    )
    out.append((s, {"pending_last": True, "tail": [lambda sid, cwd, tm: _codex_request_approval(
        tm, "terraform apply tfplan")]}, lag))

    # 3. Claude Code, aurora-docs: working (last write seconds ago)
    lag = 6
    mins = 33
    s = m.Sess(
        key="live/claude-aurora-working", agent="claude-code", project="aurora-docs",
        start=now_dt - datetime.timedelta(minutes=mins, seconds=lag), minutes=mins,
        model="claude-sonnet-5-5", title=None, branch="playground-dark-mode",
        turns=[
            user("Add dark mode tokens to the interactive API playground headers. The request/response panes should "
                 "follow the site theme and keep 4.5:1 contrast on the method badges."),
            asst("Let me find where the playground gets its colours today.", [
                grep("--pg-", "src", "src/styles/playground.css:3:  --pg-bg: #ffffff;\nsrc/styles/playground.css:4:  --pg-fg: #1b2330;\nsrc/styles/playground.css:5:  --pg-border: #d6dbe4;\nsrc/styles/playground.css:6:  --pg-badge-get: #0b6e4f;\nsrc/styles/playground.css:7:  --pg-badge-post: #1f5fbf;\nsrc/components/ApiPlayground.tsx:58:      style={{ background: \"var(--pg-bg)\", color: \"var(--pg-fg)\" }}"),
                read("src/styles/playground.css",
                     ":root {\n  --pg-bg: #ffffff;\n  --pg-fg: #1b2330;\n  --pg-border: #d6dbe4;\n  --pg-badge-get: #0b6e4f;\n  --pg-badge-post: #1f5fbf;\n}\n\n.pg-header {\n  display: flex;\n  align-items: center;\n  gap: 0.75rem;\n  padding: 0.5rem 0.75rem;\n  border-bottom: 1px solid var(--pg-border);\n}\n"),
            ]),
            asst("The playground has its own light-only palette and ignores the site's `data-theme` attribute. I'll add dark values under that selector and map the badges to colours that clear 4.5:1 on the dark surface.", [
                edit("src/styles/playground.css",
                     ":root {\n  --pg-bg: #ffffff;\n  --pg-fg: #1b2330;\n  --pg-border: #d6dbe4;\n  --pg-badge-get: #0b6e4f;\n  --pg-badge-post: #1f5fbf;\n}",
                     ":root {\n  --pg-bg: #ffffff;\n  --pg-fg: #1b2330;\n  --pg-border: #d6dbe4;\n  --pg-badge-get: #0b6e4f;\n  --pg-badge-post: #1f5fbf;\n}\n\n[data-theme=\"dark\"] {\n  --pg-bg: #12161d;\n  --pg-fg: #e6e9ef;\n  --pg-border: #2b3340;\n  --pg-badge-get: #5ad1a1;\n  --pg-badge-post: #7db2ff;\n}"),
            ]),
            asst("Now I'll run the docs build to make sure the new selector survives the CSS minifier and the contrast check in CI.", [
                bash("npm run build:docs -- --check-contrast", ""),
            ]),
        ],
    )
    out.append((s, {"pending_last": True}, lag))

    # 4. Codex CLI, vortex-pipeline: working
    lag = 11
    mins = 26
    s = m.Sess(
        key="live/codex-vortex-working", agent="codex-cli", project="vortex-pipeline",
        start=now_dt - datetime.timedelta(minutes=mins, seconds=lag), minutes=mins,
        model="gpt-6.1", completed=False,
        turns=[
            user("Profile the parquet zero-copy deserializer for cache misses on the L3 cache. Ring buffer batches "
                 "of 4096 rows, I want to know if the column chunk iterator is the problem."),
            asst("I'll find the bench target first.", [
                bash("ls crates/reader/benches && rg -n 'criterion_group' crates/reader/benches",
                     "cache_profiling.rs\nparquet_throughput.rs\ncrates/reader/benches/cache_profiling.rs:41:criterion_group!(benches, bench_chunk_iter, bench_ring_fill);\ncrates/reader/benches/parquet_throughput.rs:58:criterion_group!(benches, bench_decode);"),
            ]),
            asst("Two benches in the cache profile: the chunk iterator and the ring fill. Running the chunk iterator with hardware counters.", [
                bash("perf stat -e cache-references,cache-misses,LLC-load-misses -- cargo bench --bench cache_profiling -- chunk_iter --warm-up-time 1 --measurement-time 4",
                     "chunk_iter/4096          time:   [212.4 us 213.8 us 215.3 us]\n\n Performance counter stats for 'cargo bench --bench cache_profiling -- chunk_iter':\n\n    41,882,106      cache-references\n     6,904,311      cache-misses              #   16.48% of all cache refs\n     2,011,937      LLC-load-misses\n"),
            ]),
            asst("16.5 percent cache miss rate on the chunk iterator. I'll run the ring fill the same way for comparison.", [
                bash("perf stat -e cache-references,cache-misses,LLC-load-misses -- cargo bench --bench cache_profiling -- ring_fill --warm-up-time 1 --measurement-time 4", ""),
            ]),
        ],
    )
    out.append((s, {"pending_last": True}, lag))
    return out


def _claude_permission(sid, cwd, tm, text):
    return {"type": "permission_prompt", "sessionId": sid, "cwd": cwd,
            "timestamp": m.iso(tm.end_ms + 1000),
            "message": {"role": "assistant", "content": [{"type": "text", "text": text}]}}


def _codex_request_approval(tm, command):
    return {"timestamp": m.iso(tm.end_ms + 1000), "type": "event_msg",
            "payload": {"type": "request_approval", "timestamp": m.iso(tm.end_ms + 1000),
                        "item": {"type": "command_execution", "command": command}}}


LIVE_KEYS = {
    "claude-skyline-waiting": "live/claude-skyline-waiting",
    "codex-nexus-waiting": "live/codex-nexus-waiting",
    "claude-aurora-working": "live/claude-aurora-working",
    "codex-vortex-working": "live/codex-vortex-working",
}

# Process table: the agents' own binary names, cwd = the project root the session was started in.
_PROC = {
    "live/claude-skyline-waiting": ("claude", 48211, 3 * 3600 + 14 * 60),
    "live/codex-nexus-waiting": ("codex", 48377, 2 * 3600 + 5 * 60),
    "live/claude-aurora-working": ("claude", 49102, 51 * 60),
    "live/codex-vortex-working": ("codex", 49366, 29 * 60),
}


def write_live(home, now_dt):
    """Write the four live sessions. Returns manifest entries and process table rows."""
    now_ms = int(now_dt.timestamp() * 1000)
    entries = []
    procs = []
    for s, opts, lag in _live_sessions(now_dt):
        render = render_claude if s.agent == "claude-code" else render_codex
        path, end_ms, recs, native = render(home, s, **opts)
        set_mtime(path, now_ms - lag * 1000)
        state = "waiting" if opts.get("tail") else "working"
        entries.append({"key": s.key, "agent": s.agent, "project": s.project, "native_id": native,
                        "path": str(path.relative_to(home)), "state": state, "start_ms": int(s.start.timestamp() * 1000),
                        "last_write_ms": now_ms - lag * 1000, "hero": False, "live": True})
        binary, pid, age = _PROC[s.key]
        procs.append({"pid": pid, "binary": binary, "cwd": m.project_cwd(s.project),
                      "started_at": now_ms - age * 1000})
    return entries, procs


def append_live(home, key, now_dt):
    """Turn a working live session into a waiting one: append the agent's native waiting record to its
    file and set its mtime to `now`. Idempotent per call count: calling it twice appends two prompts.

    key: one of "claude-aurora-working" or "codex-vortex-working".
    """
    manifest = json.loads((home / "demo-manifest.json").read_text())
    full = LIVE_KEYS[key]
    entry = next(e for e in manifest["live"] if e["key"] == full)
    path = home / entry["path"]
    lines = [ln for ln in path.read_text(encoding="utf-8").split("\n") if ln.strip()]
    last = json.loads(lines[-1])
    now_ms = int(now_dt.timestamp() * 1000)
    stamp = m.iso(now_ms)
    if entry["agent"] == "claude-code":
        rec = {"parentUuid": last.get("uuid"), "isSidechain": False, "userType": "external", "cwd": last.get("cwd"),
               "sessionId": last.get("sessionId"), "version": "2.1.4", "gitBranch": last.get("gitBranch"),
               "type": "permission_prompt", "uuid": m.det_uuid(f"claude/{full}/append/{now_ms}"),
               "timestamp": stamp,
               "message": {"role": "assistant",
                           "content": [{"type": "text",
                                        "text": "Claude needs your permission to use Bash: npm run build:docs -- --check-contrast"}]}}
        extra = "claude-code"
    else:
        rec = {"timestamp": stamp, "type": "event_msg",
               "payload": {"type": "request_approval", "timestamp": stamp,
                           "item": {"type": "command_execution",
                                    "command": "perf stat -e cache-references,cache-misses,LLC-load-misses -- cargo bench --bench cache_profiling -- ring_fill --warm-up-time 1 --measurement-time 4"}}}
        extra = "codex-cli"
    with open(path, "a", encoding="utf-8") as f:
        f.write(dumps(rec) + "\n")
    set_mtime(path, now_ms)
    entry["state"] = "waiting"
    entry["last_write_ms"] = now_ms
    (home / "demo-manifest.json").write_text(json.dumps(manifest, indent=2, ensure_ascii=False) + "\n")
    set_mtime(home / "demo-manifest.json", now_ms)
    return extra
