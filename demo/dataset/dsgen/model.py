"""Neutral description of an agent session, plus the clock that gives it real timestamps.

A session is a list of turns. A user turn is the engineer's message. An assistant turn is
prose plus zero or more tool calls, each with the result it produced. The per-agent
renderers (render.py) turn the same description into each agent's own on-disk format, so a
session is written once and shows up in whichever agent's layout it belongs to.

Everything here is fictional and deterministic: the only randomness is a generator seeded
from the session key.
"""

import datetime
import json
import random
import uuid
from dataclasses import dataclass, field

UTC = datetime.timezone.utc

# Fixed reference date of the dataset: 2026-10-12T18:00:00Z (a Monday).
REF_EPOCH = 1791828000
DEV_CWD_BASE = "/Users/fictional-dev/projects"

PROJECT_SLUGS = ["skyline-weather", "nexus-gateway", "aurora-docs", "vortex-pipeline", "zenith-cli"]


def project_cwd(slug):
    return f"{DEV_CWD_BASE}/{slug}"


def det_uuid(key):
    """Stable UUID derived from a key: same key, same id, on every machine."""
    return str(uuid.uuid5(uuid.NAMESPACE_URL, "armillary-demo/" + key))


def at(day, hhmm, sec=0):
    """UTC datetime for 'YYYY-MM-DD' and 'HH:MM'. Work hours are US Central, so 14:00Z to 02:00Z."""
    h, m = hhmm.split(":")
    y, mo, d = (int(p) for p in day.split("-"))
    return datetime.datetime(y, mo, d, int(h), int(m), sec, tzinfo=UTC)


# ---------------------------------------------------------------------------
# Tool calls (neutral)
# ---------------------------------------------------------------------------

# Nominal seconds a tool takes, before the session is stretched to its target length.
_NOMINAL_SECS = {
    "read": 1, "grep": 2, "glob": 1, "edit": 1, "write": 1, "todo": 0,
    "bash": 8, "task": 90, "ls": 1,
}


@dataclass
class Call:
    """One tool call and what came back.

    kind: read | grep | glob | ls | bash | edit | write | todo | task
    args: kind specific, see the constructors below.
    result: the text the tool returned (plain; numbering and wrappers are added per agent).
    error: True when the tool failed (non-zero exit, refused edit, ...).
    """
    kind: str
    args: dict
    result: str = ""
    error: bool = False
    secs: float = 0.0

    def nominal(self):
        return self.secs if self.secs else _NOMINAL_SECS.get(self.kind, 2)


def read(path, result, start=1, limit=None):
    a = {"path": path, "start": start}
    if limit:
        a["limit"] = limit
    return Call("read", a, result)


def grep(pattern, path, result, glob=None):
    a = {"pattern": pattern, "path": path}
    if glob:
        a["glob"] = glob
    return Call("grep", a, result)


def glob(pattern, result, path=None):
    return Call("glob", {"pattern": pattern, "path": path}, result)


def ls(path, result):
    return Call("ls", {"path": path}, result)


def bash(cmd, result, error=False, desc=None, secs=0.0):
    return Call("bash", {"command": cmd, "description": desc or ""}, result, error, secs)


def edit(path, old, new, result="", error=False, line=None):
    """A string replacement. `old` and `new` are the exact before and after text."""
    return Call("edit", {"path": path, "old": old, "new": new, "line": line}, result, error)


def write(path, content, result=""):
    return Call("write", {"path": path, "content": content}, result)


def todo(*items):
    """items: (text, status, active_form) with status pending | in_progress | completed.
    active_form may be omitted (text is reused)."""
    norm = []
    for it in items:
        if len(it) == 2:
            norm.append((it[0], it[1], it[0]))
        else:
            norm.append(tuple(it))
    return Call("todo", {"items": norm}, "")


def task(description, prompt, result, secs=0.0):
    return Call("task", {"description": description, "prompt": prompt}, result, False, secs)


# ---------------------------------------------------------------------------
# Turns and sessions
# ---------------------------------------------------------------------------

@dataclass
class Turn:
    role: str                       # "user" or "assistant"
    text: str = ""
    calls: list = field(default_factory=list)
    think: float = 0.0              # extra nominal seconds before this turn (0 = default)


def user(text, think=0.0):
    return Turn("user", text, [], think)


def asst(text="", calls=None, think=0.0):
    return Turn("assistant", text, list(calls or []), think)


@dataclass
class Sess:
    key: str                # unique, stable; drives ids and the random generator
    agent: str              # claude-code, codex-cli, gemini-cli, cursor-cli, opencode, goose, aider,
                            # qwen-code, github-copilot-cli, cline, amp
    project: str            # slug from PROJECT_SLUGS (aider and amp sessions carry no project in the store)
    start: datetime.datetime
    minutes: float          # target length of the session from first to last message
    turns: list
    title: str = None       # agents that store titles use it; others derive one from the first prompt
    model: str = None
    hero: bool = False
    branch: str = "main"
    completed: bool = True  # codex only: write a session_completed event


# ---------------------------------------------------------------------------
# Clock
# ---------------------------------------------------------------------------

@dataclass
class Timing:
    """Absolute times (epoch ms) for every turn and call of a session."""
    turn_ms: list = field(default_factory=list)       # when each turn is written
    call_start_ms: list = field(default_factory=list)  # per turn: list per call
    call_end_ms: list = field(default_factory=list)    # per turn: list per call
    results_ms: list = field(default_factory=list)     # per turn: when the tool results come back
    start_ms: int = 0
    end_ms: int = 0


def schedule(s):
    """Spread the session's turns over its target length with natural gaps.

    Nominal durations: an engineer reads and types for ~25 to 70 s between turns, the model
    answers in a few seconds, tools take their own time. All of it is scaled so the session
    ends `minutes` after it starts, with seeded jitter so no two gaps are identical.
    """
    rng = random.Random(s.key)
    items = []  # (kind, turn_index, call_index, nominal_seconds)
    for ti, t in enumerate(s.turns):
        if t.role == "user":
            base = 0.0 if ti == 0 else (t.think or rng.uniform(25, 70))
            items.append(("user", ti, -1, base))
        else:
            items.append(("asst", ti, -1, t.think or rng.uniform(4, 11)))
            for ci, c in enumerate(t.calls):
                items.append(("call", ti, ci, c.nominal() * rng.uniform(0.8, 1.3)))
            if t.calls:
                items.append(("results", ti, -1, rng.uniform(0.6, 1.5)))
    total = sum(i[3] for i in items) or 1.0
    scale = max(0.2, s.minutes * 60.0 / total)
    start_ms = int(s.start.timestamp()) * 1000 + rng.randint(0, 899)
    tm = Timing(start_ms=start_ms)
    tm.turn_ms = [0] * len(s.turns)
    tm.call_start_ms = [[] for _ in s.turns]
    tm.call_end_ms = [[] for _ in s.turns]
    tm.results_ms = [0] * len(s.turns)
    cursor = float(start_ms)
    last = start_ms - 1000
    for kind, ti, ci, nominal in items:
        cursor += nominal * scale * 1000.0
        # strictly increasing, at least 1 s apart on the second-granular formats
        now = max(int(cursor), last + 1000)
        cursor = float(now)
        if kind in ("user", "asst"):
            tm.turn_ms[ti] = now
        elif kind == "call":
            # the call began where the previous event ended and ends now
            tm.call_start_ms[ti].append(last)
            tm.call_end_ms[ti].append(now)
        else:
            tm.results_ms[ti] = now
        last = now
    tm.end_ms = last
    return tm


# ---------------------------------------------------------------------------
# Token estimates (deterministic, grow with the conversation like a real context window)
# ---------------------------------------------------------------------------

def estimate_usage(s):
    """Per assistant turn: (fresh input tokens, output tokens, cache read tokens)."""
    rng = random.Random(s.key + "/tokens")
    context_chars = 6200  # system prompt and tool definitions
    out = {}
    for ti, t in enumerate(s.turns):
        if t.role == "user":
            context_chars += len(t.text)
            continue
        call_chars = sum(len(json.dumps(c.args)) for c in t.calls)
        out_tokens = max(38, int((len(t.text) + call_chars) / 3.4 * rng.uniform(0.9, 1.15)))
        fresh = int(context_chars / 3.5 * rng.uniform(0.18, 0.26))
        cache_read = int(context_chars / 3.5 * rng.uniform(0.7, 0.8))
        out[ti] = (fresh + 120, out_tokens, cache_read)
        context_chars += len(t.text) + call_chars + sum(len(c.result) for c in t.calls)
    return out


def iso(ms, with_ms=True):
    d = datetime.datetime.fromtimestamp(ms / 1000.0, UTC)
    if with_ms:
        return d.strftime("%Y-%m-%dT%H:%M:%S.") + f"{ms % 1000:03d}Z"
    return d.strftime("%Y-%m-%dT%H:%M:%SZ")


def stable_hex(key, n=8):
    return uuid.uuid5(uuid.NAMESPACE_URL, "armillary-demo/hex/" + key).hex[:n]
