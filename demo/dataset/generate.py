#!/usr/bin/env python3
"""
Armillary presentation dataset: a fictional developer's HOME in the real agent folder layouts.

    python3 -I demo/dataset/generate.py <home-dir> [--now ISO-8601] [--append-live KEY]

Persona: Alex Mercer <alex.mercer@fictional-dev.invalid>, five fictional projects, eleven agents,
about sixty sessions over fourteen days (2026-09-28 to 2026-10-12, a fixed reference date), seven of them
hero sessions with plans, real diffs, failing and passing test runs and token usage. Four live sessions
(two working, two waiting) are written relative to --now, together with processes.json, a synthetic
process table for the live detector. See demo/dataset/README.md.

Everything is fictional: no real people, companies, credentials or paths. The same arguments always give
byte-identical output. Without --now the live files use the current time (the real app's behaviour).
"""

import argparse
import datetime
import json
import os
import sys
import time
from pathlib import Path

sys.dont_write_bytecode = True
sys.path.insert(0, str(Path(__file__).resolve().parent))

from dsgen import configs, live, model as m, render as r  # noqa: E402
from dsgen.catalog import all_sessions  # noqa: E402

REFERENCE_NOW = "2026-10-12T18:00:00Z"


def parse_now(text):
    if text is None:
        return datetime.datetime.fromtimestamp(int(time.time()), m.UTC)
    t = text.strip().replace("Z", "+00:00")
    dt = datetime.datetime.fromisoformat(t)
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=m.UTC)
    return dt.astimezone(m.UTC)


def generate_dataset(home_dir, now_dt):
    home = Path(home_dir).resolve()
    home.mkdir(parents=True, exist_ok=True)
    sessions = sorted(all_sessions(), key=lambda s: (s.start, s.key))
    entries = []
    aider = []
    ocode = r.OpenCodeDb(home)
    goose = r.GooseDb(home)

    for s in sessions:
        ent = {"key": s.key, "agent": s.agent, "project": s.project, "hero": s.hero,
               "live": False, "title": s.title, "model": s.model}
        tm = m.schedule(s)
        ent["start_ms"], ent["end_ms"] = tm.start_ms, tm.end_ms
        if s.agent == "aider":
            aider.append((s, ent))
            continue
        if s.agent == "opencode":
            native, end = ocode.add(s)
            ent["native_id"] = native
            ent["path"] = "opencode.db"
        elif s.agent == "goose":
            native, end = goose.add(s)
            ent["native_id"] = native
            ent["path"] = "goose sessions.sqlite"
        else:
            path, end, files, native = r.RENDERERS[s.agent](home, s)
            ent["native_id"] = native
            ent["path"] = str(path.relative_to(home))
            for f in (files if isinstance(files, list) and files and isinstance(files[0], Path) else [path]):
                r.set_mtime(f, end)
        entries.append(ent)

    # Aider: one append-only Markdown file holding every session
    aider_end = 0
    if aider:
        chunks = []
        for s, ent in aider:
            text, end = r.render_aider_session(s)
            chunks.append(text)
            # the module names a session by its file (relative to ~/.aider) and its header time
            ent["native_id"] = ".aider.chat.history.md#" + m.iso(ent["start_ms"], False).replace("T", " ").replace("Z", "")
            ent["path"] = ".aider/.aider.chat.history.md"
            aider_end = max(aider_end, end)
            entries.append(ent)
        d = home / ".aider"
        d.mkdir(parents=True, exist_ok=True)
        (d / ".aider.chat.history.md").write_text("\n".join(chunks), encoding="utf-8")
        r.set_mtime(d / ".aider.chat.history.md", aider_end)
    r.set_mtime(ocode.close(), ocode.last_ms)
    r.set_mtime(goose.close(), max((e["end_ms"] for e in entries if e["agent"] == "goose"), default=0))

    live_entries, procs = live.write_live(home, now_dt)
    configs.write_all(home)

    now_ms = int(now_dt.timestamp() * 1000)
    manifest = {
        "persona": {"name": "Alex Mercer", "email": "alex.mercer@fictional-dev.invalid"},
        "reference_now": REFERENCE_NOW,
        "now": m.iso(now_ms, False),
        "project_roots_in_home": {slug: f"projects/{slug}" for slug in m.PROJECT_SLUGS},
        "fictional_project_roots": {slug: m.project_cwd(slug) for slug in m.PROJECT_SLUGS},
        "sessions": [{k: e[k] for k in sorted(e)} for e in entries],
        "heroes": [{k: e[k] for k in sorted(e)} for e in entries if e["hero"]],
        "live": live_entries,
    }
    (home / "demo-manifest.json").write_text(json.dumps(manifest, indent=2, ensure_ascii=False) + "\n")
    (home / "processes.json").write_text(json.dumps(procs, indent=2) + "\n")
    for name in ("demo-manifest.json", "processes.json"):
        r.set_mtime(home / name, now_ms)  # no wall clock anywhere: same arguments, same bytes and mtimes
    print(f"Generated Armillary demo dataset in {home}")
    print(f"{len(entries) + len(live_entries)} sessions ({len(live_entries)} live), "
          f"{sum(1 for e in entries if e['hero'])} hero sessions, now = {m.iso(now_ms, False)}")


def main(argv=None):
    p = argparse.ArgumentParser(description="Generate the fictional Armillary presentation dataset.")
    p.add_argument("home", nargs="?", default="/tmp/armillary-demo-home")
    p.add_argument("--now", help="ISO-8601 time that the live sessions are relative to (default: the current time)")
    p.add_argument("--append-live", metavar="KEY", choices=sorted(live.LIVE_KEYS),
                   help="do not regenerate; append the waiting record to an existing working live session "
                        "(claude-aurora-working or codex-vortex-working) and set its mtime to --now")
    args = p.parse_args(argv)
    now_dt = parse_now(args.now)
    if args.append_live:
        home = Path(args.home).resolve()
        live.append_live(home, args.append_live, now_dt)
        print(f"Appended the waiting signal to {args.append_live} at {m.iso(int(now_dt.timestamp() * 1000), False)}")
        return
    generate_dataset(args.home, now_dt)


if __name__ == "__main__":
    main()
