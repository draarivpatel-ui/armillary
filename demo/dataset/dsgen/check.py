#!/usr/bin/env python3
"""Lint a session module before it joins the dataset.

    python3 -I demo/dataset/dsgen/check.py proj_skyline_weather [more modules]

Checks the rules the dataset promises (window, working hours, weekend gap, turn order, adapter limits,
text hygiene) and renders every session into a scratch folder so a broken session fails here, not in
the Rust test.
"""

import datetime
import importlib
import json
import re
import sys
import tempfile
from pathlib import Path

sys.dont_write_bytecode = True
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from dsgen import model as m, render as r  # noqa: E402

AGENTS = {"claude-code", "codex-cli", "gemini-cli", "cursor-cli", "opencode", "goose", "aider", "qwen-code",
          "github-copilot-cli", "cline", "amp"}
WINDOW_START = m.at("2026-09-28", "14:00")
WINDOW_END = m.at("2026-10-12", "17:30")
BAD_CHARS = ("—", "–")
BAD_SHAPES = ("sk-ant", "sk-proj", "sk_live", "ghp_", "gho_", "AKIA", "AIza", "xoxb-", "-----BEGIN", str(Path.home()),
              "@gmail.", "@yahoo.", "@outlook.", "password=", "Bearer ey")
MODELS = {"claude-sonnet-5-5", "claude-opus-5-5", "gpt-6.1", "gemini-3.8-flash", "gemini-3.8-pro", "qwen3-coder-plus",
          "claude-haiku-5"}


def strings_of(s):
    out = [s.title or ""]
    for t in s.turns:
        out.append(t.text)
        for c in t.calls:
            out.append(c.result)
            for v in c.args.values():
                if isinstance(v, str):
                    out.append(v)
                elif isinstance(v, (list, tuple)):
                    out.append(json.dumps(v, ensure_ascii=False))
    return out


def check(sessions, quiet=False):
    problems = []

    def bad(s, msg):
        problems.append(f"{s.key}: {msg}")

    keys = set()
    for s in sessions:
        if s.key in keys:
            bad(s, "duplicate key")
        keys.add(s.key)
        if s.agent not in AGENTS:
            bad(s, f"unknown agent {s.agent}")
        if s.project not in m.PROJECT_SLUGS:
            bad(s, f"unknown project {s.project}")
        if s.model and s.model not in MODELS:
            bad(s, f"model {s.model} not in the allowed list {sorted(MODELS)}")
        if not s.model:
            bad(s, "model missing")
        if s.start < WINDOW_START or s.start + datetime.timedelta(minutes=s.minutes) > WINDOW_END:
            bad(s, f"outside the window: {s.start} + {s.minutes} min")
        if s.start.date().isoformat() in ("2026-10-03", "2026-10-11"):
            bad(s, "the weekend gap days 2026-10-03 and 2026-10-11 stay empty")
        if 3 <= s.start.hour <= 10:
            bad(s, "starts in the small hours UTC (work hours are 14:00Z to 02:00Z)")
        if not (5 <= s.minutes <= 90):
            bad(s, f"minutes {s.minutes} outside 5..90")
        ts = s.turns
        if not ts or ts[0].role != "user":
            bad(s, "must start with a user turn")
        if ts and (ts[-1].role != "assistant" or ts[-1].calls):
            bad(s, "must end with an assistant turn without tool calls")
        for i in range(1, len(ts)):
            if ts[i].role == "user" and ts[i - 1].role == "user":
                bad(s, f"turns {i - 1} and {i} are both user turns")
        if sum(1 for t in ts if t.role == "user") < 1:
            bad(s, "no user turn")
        for i, t in enumerate(ts):
            if t.role == "user" and (t.calls or not t.text.strip()):
                bad(s, f"user turn {i} must be plain text")
            if t.role == "assistant" and not t.text.strip() and not t.calls:
                bad(s, f"assistant turn {i} is empty")
            for c in t.calls:
                if c.kind not in ("read", "grep", "glob", "ls", "bash", "edit", "write", "todo", "task"):
                    bad(s, f"unknown call kind {c.kind}")
                if c.kind == "edit" and (not c.args["old"] or c.args["old"] == c.args["new"]):
                    bad(s, f"turn {i}: edit with empty or unchanged old text")
                if c.kind in ("read", "grep", "bash") and not c.result.strip() and not (
                        s.agent in ("claude-code", "codex-cli") and i == len(ts) - 1):
                    bad(s, f"turn {i}: {c.kind} call with an empty result")
                if len(c.result) > 6000:
                    bad(s, f"turn {i}: {c.kind} result is {len(c.result)} characters, keep it under 6000")
        if s.agent == "aider":
            users = [t for t in ts if t.role == "user"]
            if len(users) > 3:
                bad(s, "aider sessions: at most 3 user turns")
            for i, t in enumerate(ts):
                kinds = [c.kind for c in t.calls]
                if any(k not in ("edit", "bash") for k in kinds):
                    bad(s, "aider sessions may only use edit and bash calls")
                if "bash" in kinds and "edit" in kinds[kinds.index("bash"):]:
                    bad(s, "aider: edit blocks must come before /run commands within a turn")
                if kinds.count("bash") > 1:
                    bad(s, "aider: at most one /run per turn")
                if "bash" in kinds and i != len(ts) - 2 and i + 1 < len(ts) and ts[i + 1].role == "assistant":
                    pass
        if s.agent in ("cursor-cli", "aider", "amp") and not s.title and s.agent != "aider":
            bad(s, "cursor-cli and amp sessions need a title")
        for text in strings_of(s):
            for ch in BAD_CHARS:
                if ch in text:
                    bad(s, f"contains an em or en dash: {text[:60]!r}")
            for shape in BAD_SHAPES:
                if shape in text:
                    bad(s, f"contains {shape!r}")
            if re.search(r"https?://(?!localhost|127\.0\.0\.1)[a-z0-9.-]+\.(com|org|net|io|dev|ai)\b", text):
                bad(s, f"contains a real-looking URL: {re.findall(r'https?://[^ )]+', text)[:2]}")
    with tempfile.TemporaryDirectory() as tmp:
        home = Path(tmp)
        for s in sessions:
            try:
                tm = m.schedule(s)
                assert tm.end_ms > tm.start_ms
                if s.agent == "aider":
                    r.render_aider_session(s)
                elif s.agent == "opencode":
                    db = r.OpenCodeDb(home)
                    db.add(s)
                    db.close()
                elif s.agent == "goose":
                    db = r.GooseDb(home)
                    db.add(s)
                    db.close()
                else:
                    r.RENDERERS[s.agent](home, s)
            except Exception as e:  # noqa: BLE001
                bad(s, f"render failed: {type(e).__name__}: {e}")
    if not quiet:
        by_agent = {}
        for s in sessions:
            by_agent[s.agent] = by_agent.get(s.agent, 0) + 1
        print(f"{len(sessions)} sessions: {dict(sorted(by_agent.items()))}")
        for p in problems:
            print("PROBLEM", p)
        print("OK" if not problems else f"{len(problems)} problems")
    return problems


if __name__ == "__main__":
    allsess = []
    for name in sys.argv[1:] or ["catalog"]:
        if name == "catalog":
            from dsgen.catalog import all_sessions
            allsess.extend(all_sessions())
        else:
            allsess.extend(importlib.import_module(f"dsgen.{name}").sessions())
    sys.exit(1 if check(allsess) else 0)
