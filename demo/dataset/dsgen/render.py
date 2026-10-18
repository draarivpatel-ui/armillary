"""Renderers: one neutral session (model.py) to one agent's on-disk format.

Each renderer writes exactly what that agent's adapter reads (crates/adapters/src/builtins/*.toml
and crates/adapters/src/modules/*.rs). Where a real agent keeps a field the adapter does not read,
the field is still written when it costs nothing (it is how the real file looks), and the gap is
listed in demo/dataset/README.md under "Adapter limits".
"""

import difflib
import hashlib
import json
import os
import sqlite3
from pathlib import Path

from .model import (DEV_CWD_BASE, det_uuid, estimate_usage, iso, project_cwd, schedule,
                    stable_hex)


def dumps(obj):
    return json.dumps(obj, ensure_ascii=False, separators=(",", ":"))


def write_jsonl(path, records):
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        for r in records:
            f.write(dumps(r) + "\n")


def set_mtime(path, ms):
    sec = ms / 1000.0
    os.utime(path, (sec, sec))


def abspath(project, p):
    if p.startswith("/"):
        return p
    return f"{project_cwd(project)}/{p}"


def numbered(text, start=1):
    """cat -n style, as Claude Code's Read tool returns it."""
    lines = text.split("\n")
    if lines and lines[-1] == "":
        lines = lines[:-1]
    return "\n".join(f"{start + i:>6}→{ln}" for i, ln in enumerate(lines))


def unified_hunks(old, new, context=3):
    """Hunks of a change as (header-free) +/-/space lines, grouped per hunk."""
    a = old.split("\n")
    b = new.split("\n")
    out = []
    for group in difflib.SequenceMatcher(None, a, b).get_grouped_opcodes(context):
        lines = []
        for tag, i1, i2, j1, j2 in group:
            if tag == "equal":
                lines += [" " + x for x in a[i1:i2]]
            else:
                lines += ["-" + x for x in a[i1:i2]]
                lines += ["+" + x for x in b[j1:j2]]
        out.append(lines)
    return out


# ---------------------------------------------------------------------------
# Claude Code: ~/.claude/projects/<slug>/<sessionId>.jsonl
# ---------------------------------------------------------------------------

def claude_slug(project):
    return project_cwd(project).replace("/", "-")


def _claude_tool(s, c):
    k, a = c.kind, c.args
    if k == "read":
        inp = {"file_path": abspath(s.project, a["path"])}
        if a.get("start", 1) > 1:
            inp["offset"] = a["start"]
        if a.get("limit"):
            inp["limit"] = a["limit"]
        return "Read", inp
    if k == "grep":
        inp = {"pattern": a["pattern"], "path": abspath(s.project, a["path"]), "output_mode": "content", "-n": True}
        if a.get("glob"):
            inp["glob"] = a["glob"]
        return "Grep", inp
    if k == "glob":
        inp = {"pattern": a["pattern"]}
        if a.get("path"):
            inp["path"] = abspath(s.project, a["path"])
        return "Glob", inp
    if k == "ls":
        return "LS", {"path": abspath(s.project, a["path"])}
    if k == "bash":
        inp = {"command": a["command"]}
        if a.get("description"):
            inp["description"] = a["description"]
        return "Bash", inp
    if k == "edit":
        return "Edit", {"file_path": abspath(s.project, a["path"]), "old_string": a["old"], "new_string": a["new"]}
    if k == "write":
        return "Write", {"file_path": abspath(s.project, a["path"]), "content": a["content"]}
    if k == "todo":
        return "TodoWrite", {"todos": [{"content": t, "status": st, "activeForm": af} for t, st, af in a["items"]]}
    if k == "task":
        return "Task", {"description": a["description"], "prompt": a["prompt"], "subagent_type": "general-purpose"}
    raise ValueError(k)


def _claude_result(s, c):
    k, a = c.kind, c.args
    if k == "read":
        return numbered(c.result, a.get("start", 1))
    if k == "edit":
        if c.result:
            return c.result
        start = a.get("line") or 1
        return (f"The file {abspath(s.project, a['path'])} has been updated. Here's the result of running `cat -n` "
                f"on a snippet of the edited file:\n" + numbered(a["new"], start))
    if k == "write":
        return c.result or f"File created successfully at: {abspath(s.project, a['path'])}"
    if k == "todo":
        return ("Todos have been modified successfully. Ensure that you continue to use the todo list to track "
                "your progress. Please proceed with the current tasks if applicable")
    if k == "bash" and c.error:
        return "Exit code 1\n" + c.result
    return c.result


def claude_assistant_content(s, t, tm, ti):
    content = []
    if t.text:
        content.append({"type": "text", "text": t.text})
    ids = []
    for ci, c in enumerate(t.calls):
        name, inp = _claude_tool(s, c)
        tid = "toolu_" + stable_hex(f"{s.key}/{ti}/{ci}", 22)
        ids.append(tid)
        content.append({"type": "tool_use", "id": tid, "name": name, "input": inp})
    return content, ids


def render_claude(home, s, pending_last=False, tail=None):
    """Write one Claude Code session. Returns (path, last_ms, records, session id).

    pending_last: the last assistant turn asked for tools whose results never arrived yet (a live session).
    tail: extra records appended after the last one (for example a permission prompt)."""
    tm = schedule(s)
    usage = estimate_usage(s)
    sid = det_uuid("claude/" + s.key)
    cwd = project_cwd(s.project)
    base = {"isSidechain": False, "userType": "external", "cwd": cwd, "sessionId": sid,
            "version": "2.1.4", "gitBranch": s.branch}
    recs = []
    prev = None
    n = 0

    def add(rec):
        nonlocal prev, n
        n += 1
        rec = {"parentUuid": prev, **base, **rec}
        rec["uuid"] = det_uuid(f"claude/{s.key}/rec/{n}")
        prev = rec["uuid"]
        recs.append(rec)

    for ti, t in enumerate(s.turns):
        if t.role == "user":
            add({"type": "user", "message": {"role": "user", "content": t.text}, "timestamp": iso(tm.turn_ms[ti])})
            continue
        fresh, out_tokens, cache_read = usage[ti]
        content, ids = claude_assistant_content(s, t, tm, ti)
        add({
            "type": "assistant",
            "message": {
                "id": "msg_" + stable_hex(f"{s.key}/msg/{ti}", 24),
                "type": "message", "role": "assistant", "model": s.model,
                "content": content,
                "stop_reason": "tool_use" if t.calls else "end_turn",
                "stop_sequence": None,
                "usage": {"input_tokens": fresh, "cache_creation_input_tokens": 0 if ti > 1 else 5400,
                          "cache_read_input_tokens": cache_read, "output_tokens": out_tokens,
                          "service_tier": "standard"},
            },
            "requestId": "req_" + stable_hex(f"{s.key}/req/{ti}", 24),
            "timestamp": iso(tm.turn_ms[ti]),
        })
        if t.calls and not (pending_last and ti == len(s.turns) - 1):
            results = []
            for c, tid in zip(t.calls, ids):
                r = {"type": "tool_result", "tool_use_id": tid, "content": _claude_result(s, c)}
                if c.error:
                    r["is_error"] = True
                results.append(r)
            add({"type": "user", "message": {"role": "user", "content": results},
                 "timestamp": iso(tm.results_ms[ti])})
    for extra in (tail or []):
        add(extra(sid, cwd, tm) if callable(extra) else extra)
    path = home / ".claude" / "projects" / claude_slug(s.project) / f"{sid}.jsonl"
    write_jsonl(path, recs)
    return path, tm.end_ms, recs, sid


# ---------------------------------------------------------------------------
# Codex CLI: ~/.codex/sessions/YYYY/MM/DD/rollout-<local time>-<id>.jsonl
# ---------------------------------------------------------------------------

def _codex_command(s, c):
    k, a = c.kind, c.args
    if k == "read":
        start = a.get("start", 1)
        end = start + (a.get("limit") or 120) - 1
        return f"sed -n '{start},{end}p' {a['path']}"
    if k == "grep":
        g = f" -g '{a['glob']}'" if a.get("glob") else ""
        return f"rg -n{g} -- \"{a['pattern']}\" {a['path']}"
    if k == "glob":
        return f"rg --files -g '{a['pattern']}'"
    if k == "ls":
        return f"ls -la {a['path']}"
    if k == "bash":
        return a["command"]
    if k == "edit":
        hunks = unified_hunks(a["old"], a["new"], 2)
        body = []
        for h in hunks:
            body.append("@@")
            body += h
        patch = "*** Begin Patch\n*** Update File: " + a["path"] + "\n" + "\n".join(body) + "\n*** End Patch"
        return "apply_patch <<'EOF'\n" + patch + "\nEOF"
    if k == "write":
        lines = ["+" + ln for ln in a["content"].rstrip("\n").split("\n")]
        patch = "*** Begin Patch\n*** Add File: " + a["path"] + "\n" + "\n".join(lines) + "\n*** End Patch"
        return "apply_patch <<'EOF'\n" + patch + "\nEOF"
    raise ValueError(k)


def _codex_stdout(s, c):
    k, a = c.kind, c.args
    if k in ("edit", "write") and not c.result:
        return f"Success. Updated the following files:\n{'M' if k == 'edit' else 'A'} {a['path']}\n"
    return c.result


def render_codex(home, s, pending_last=False, tail=None):
    tm = schedule(s)
    usage = estimate_usage(s)
    sid = det_uuid("codex/" + s.key)
    cwd = project_cwd(s.project)
    recs = []
    item_n = 0

    def item_id():
        nonlocal item_n
        i = f"item_{item_n}"
        item_n += 1
        return i

    def ev(ms, payload):
        recs.append({"timestamp": iso(ms), "type": "event_msg", "payload": {**payload, "timestamp": iso(ms)}})

    recs.append({"timestamp": iso(tm.start_ms), "type": "session_meta",
                 "payload": {"id": sid, "timestamp": iso(tm.start_ms), "cwd": cwd, "originator": "codex_cli_rs",
                             "cli_version": "0.162.1", "model": s.model, "model_provider": "openai", "source": "cli"}})
    cum_in = cum_out = 0
    for ti, t in enumerate(s.turns):
        if t.role == "user":
            ev(tm.turn_ms[ti], {"type": "item_completed",
                                "item": {"id": item_id(), "type": "user_message", "content": t.text}})
            continue
        if t.text:
            ev(tm.turn_ms[ti], {"type": "item_completed",
                                "item": {"id": item_id(), "type": "agent_message", "text": t.text}})
        last_ms = tm.turn_ms[ti]
        if pending_last and ti == len(s.turns) - 1:
            continue
        for ci, c in enumerate(t.calls):
            end = tm.call_end_ms[ti][ci]
            last_ms = max(last_ms, end)
            if c.kind == "todo":
                items = c.args["items"]
                mark = {"completed": "x", "in_progress": " ", "pending": " "}
                text = "Updated plan\n" + "\n".join(
                    f"- [{mark[st]}] {tx}" + (" (in progress)" if st == "in_progress" else "") for tx, st, _ in items)
                ev(end, {"type": "item_completed", "item": {"id": item_id(), "type": "agent_message", "text": text}})
                continue
            if c.kind == "task":
                continue
            out = _codex_stdout(s, c)
            ev(end, {"type": "item_completed",
                     "item": {"id": item_id(), "type": "command_execution", "command": _codex_command(s, c),
                              "aggregated_output": out, "exit_code": 1 if c.error else 0, "stdout": out,
                              "stderr": "", "status": "failed" if c.error else "completed"}})
        fresh, out_tokens, cache_read = usage[ti]
        cum_in += fresh + cache_read
        cum_out += out_tokens
        ev(last_ms, {"type": "token_count",
                     "info": {"total_token_usage": {"input_tokens": cum_in, "cached_input_tokens": cache_read,
                                                    "output_tokens": cum_out, "total_tokens": cum_in + cum_out}}})
    if s.completed and not pending_last and not tail:
        ev(tm.end_ms, {"type": "session_completed"})
    for extra in (tail or []):
        recs.append(extra(sid, cwd, tm) if callable(extra) else extra)
    stamp = iso(tm.start_ms, False)[:19].replace(":", "-")
    day = stamp[:10].split("-")
    path = home / ".codex" / "sessions" / day[0] / day[1] / day[2] / f"rollout-{stamp}-{sid}.jsonl"
    write_jsonl(path, recs)
    return path, tm.end_ms, recs, sid


# ---------------------------------------------------------------------------
# Gemini CLI: ~/.gemini/tmp/<sha256 of project path>/chats/session-<time>-<id>.jsonl
# ---------------------------------------------------------------------------

def _gemini_tool(s, c):
    k, a = c.kind, c.args
    p = lambda x: abspath(s.project, x)
    if k == "read":
        return "read_file", {"file_path": p(a["path"])}
    if k == "grep":
        d = {"pattern": a["pattern"], "path": p(a["path"])}
        if a.get("glob"):
            d["include"] = a["glob"]
        return "search_file_content", d
    if k == "glob":
        return "glob", {"pattern": a["pattern"]}
    if k == "ls":
        return "list_directory", {"path": p(a["path"])}
    if k == "bash":
        return "run_shell_command", {"command": a["command"], "description": a.get("description") or ""}
    if k == "edit":
        return "replace", {"file_path": p(a["path"]), "old_string": a["old"], "new_string": a["new"],
                           "instruction": "Apply the change described above."}
    if k == "write":
        return "write_file", {"file_path": p(a["path"]), "content": a["content"]}
    if k == "todo":
        return "write_todos", {"todos": [{"description": t, "status": st} for t, st, _ in a["items"]]}
    if k == "task":
        return "delegate_to_agent", {"agent_name": "codebase_investigator", "objective": a["prompt"]}
    raise ValueError(k)


def _tool_input_for_adapter(args):
    """The Qwen TOML still reads `input` and files from `input/path` (open, see RV-ADP); Gemini's was
    fixed to read the real `args` and `result`, so only the Qwen records carry this copy."""
    inp = dict(args)
    for key in ("file_path", "absolute_path"):
        if key in inp and "path" not in inp:
            inp["path"] = inp[key]
    return inp


def _gemini_tool_calls(s, t, tm, ti, with_ids=True):
    calls = []
    for ci, c in enumerate(t.calls):
        name, args = _gemini_tool(s, c)
        calls.append({
            "id": f"{name}-{tm.call_end_ms[ti][ci]}-{stable_hex(f'{s.key}/{ti}/{ci}', 6)}",
            "name": name, "args": args,
            "result": [{"functionResponse": {"id": f"{name}-{ci}", "name": name,
                                             "response": {"output": c.result}}}],
            "status": "error" if c.error else "success",
            "timestamp": iso(tm.call_end_ms[ti][ci]),
            "displayName": name.replace("_", " ").title(),
        })
    return calls


def render_gemini(home, s):
    tm = schedule(s)
    usage = estimate_usage(s)
    sid = det_uuid("gemini/" + s.key)
    cwd = project_cwd(s.project)
    phash = hashlib.sha256(cwd.encode()).hexdigest()
    recs = [{"sessionId": sid, "projectHash": phash, "startTime": iso(tm.start_ms), "lastUpdated": iso(tm.end_ms),
             "kind": "main", "cwd": cwd, "model": s.model}]
    for ti, t in enumerate(s.turns):
        mid = det_uuid(f"gemini/{s.key}/msg/{ti}")
        if t.role == "user":
            recs.append({"id": mid, "timestamp": iso(tm.turn_ms[ti]), "type": "user", "content": t.text})
            continue
        fresh, out_tokens, cache_read = usage[ti]
        rec = {"id": mid, "timestamp": iso(tm.turn_ms[ti]), "type": "gemini", "model": s.model, "content": t.text,
               "tokens": {"input": fresh + cache_read, "output": out_tokens, "cached": cache_read,
                          "thoughts": int(out_tokens * 0.3), "tool": 0,
                          "total": fresh + cache_read + out_tokens}}
        if t.calls:
            rec["toolCalls"] = _gemini_tool_calls(s, t, tm, ti)
        recs.append(rec)
    stamp = iso(tm.start_ms, False)[:16].replace(":", "-")
    path = home / ".gemini" / "tmp" / phash / "chats" / f"session-{stamp}-{sid[:8]}.jsonl"
    write_jsonl(path, recs)
    return path, tm.end_ms, recs, sid


# ---------------------------------------------------------------------------
# Qwen Code: ~/.qwen/projects/<slug>/chats/<id>.jsonl
# ---------------------------------------------------------------------------

def render_qwen(home, s):
    tm = schedule(s)
    usage = estimate_usage(s)
    sid = det_uuid("qwen/" + s.key)
    cwd = project_cwd(s.project)
    common = {"sessionId": sid, "cwd": cwd, "version": "0.0.14", "gitBranch": s.branch}
    recs = [{**common, "uuid": det_uuid(f"qwen/{s.key}/sys"), "timestamp": iso(tm.start_ms), "type": "system",
             "model": s.model, "subtype": "init"}]
    for ti, t in enumerate(s.turns):
        uid = det_uuid(f"qwen/{s.key}/rec/{ti}")
        if t.role == "user":
            recs.append({**common, "uuid": uid, "timestamp": iso(tm.turn_ms[ti]), "type": "user",
                         "message": {"role": "user", "content": t.text}})
            continue
        fresh, out_tokens, cache_read = usage[ti]
        rec = {**common, "uuid": uid, "timestamp": iso(tm.turn_ms[ti]), "type": "assistant", "model": s.model,
               "message": {"role": "assistant", "content": t.text},
               "usageMetadata": {"promptTokenCount": fresh + cache_read, "candidatesTokenCount": out_tokens,
                                 "totalTokenCount": fresh + cache_read + out_tokens}}
        if t.calls:
            tcs = []
            for ci, c in enumerate(t.calls):
                name, args = _gemini_tool(s, c)
                tcs.append({"id": f"{name}-{stable_hex(f'{s.key}/{ti}/{ci}', 6)}", "name": name, "args": args,
                            "input": _tool_input_for_adapter(args), "status": "error" if c.error else "success"})
            rec["toolCalls"] = tcs
        recs.append(rec)
    path = home / ".qwen" / "projects" / claude_slug(s.project) / "chats" / f"{sid}.jsonl"
    write_jsonl(path, recs)
    return path, tm.end_ms, recs, sid


# ---------------------------------------------------------------------------
# GitHub Copilot CLI: ~/.copilot/session-state/<id>/events.jsonl
# ---------------------------------------------------------------------------

def _copilot_tool(s, c):
    k, a = c.kind, c.args
    if k == "read":
        return {"toolName": "view", "path": abspath(s.project, a["path"])}
    if k == "grep":
        return {"toolName": "grep", "command": f"rg -n \"{a['pattern']}\" {a['path']}", "path": abspath(s.project, a["path"])}
    if k == "glob":
        return {"toolName": "glob", "command": a["pattern"]}
    if k == "ls":
        return {"toolName": "view", "path": abspath(s.project, a["path"])}
    if k == "bash":
        return {"toolName": "bash", "command": a["command"]}
    if k == "edit":
        return {"toolName": "edit", "path": abspath(s.project, a["path"])}
    if k == "write":
        return {"toolName": "create", "path": abspath(s.project, a["path"])}
    if k == "todo":
        return {"toolName": "update_todo", "command": "; ".join(f"[{st}] {t}" for t, st, _ in a["items"])}
    return {"toolName": "task", "command": a.get("description", "")}


def render_copilot(home, s):
    tm = schedule(s)
    usage = estimate_usage(s)
    sid = det_uuid("copilot/" + s.key)
    cwd = project_cwd(s.project)
    recs = [{"type": "session.start", "id": det_uuid(f"copilot/{s.key}/start"), "timestamp": iso(tm.start_ms),
             "payload": {"sessionId": sid, "cwd": cwd, "model": s.model, "copilotVersion": "0.0.395"}}]
    n = 0

    def add(ms, typ, payload):
        nonlocal n
        n += 1
        recs.append({"type": typ, "id": det_uuid(f"copilot/{s.key}/evt/{n}"), "timestamp": iso(ms), "payload": payload})

    for ti, t in enumerate(s.turns):
        if t.role == "user":
            add(tm.turn_ms[ti], "user.message", {"text": t.text})
            continue
        if t.text:
            add(tm.turn_ms[ti], "assistant.message", {"text": t.text})
        for ci, c in enumerate(t.calls):
            add(tm.call_end_ms[ti][ci], "tool.execution_start", _copilot_tool(s, c))
        fresh, out_tokens, cache_read = usage[ti]
        add(tm.results_ms[ti] if t.calls else tm.turn_ms[ti], "assistant.usage",
            {"inputTokens": fresh + cache_read, "outputTokens": out_tokens})
    path = home / ".copilot" / "session-state" / sid / "events.jsonl"
    write_jsonl(path, recs)
    return path, tm.end_ms, recs, sid


# ---------------------------------------------------------------------------
# Cline: ~/.cline/data/sessions/<id>/<id>.json and <id>.messages.json
# ---------------------------------------------------------------------------

def _cline_tool(s, c):
    k, a = c.kind, c.args
    p = lambda x: abspath(s.project, x)
    if k == "read":
        return "read_file", {"path": p(a["path"])}
    if k == "grep":
        return "search_files", {"path": p(a["path"]), "regex": a["pattern"], "file_pattern": a.get("glob") or "*"}
    if k == "glob":
        return "list_files", {"path": p(a.get("path") or "."), "recursive": True}
    if k == "ls":
        return "list_files", {"path": p(a["path"]), "recursive": False}
    if k == "bash":
        return "execute_command", {"command": a["command"], "requires_approval": False}
    if k == "edit":
        diff = f"<<<<<<< SEARCH\n{a['old']}\n=======\n{a['new']}\n>>>>>>> REPLACE"
        return "replace_in_file", {"path": p(a["path"]), "diff": diff}
    if k == "write":
        return "write_to_file", {"path": p(a["path"]), "content": a["content"]}
    if k == "todo":
        return "update_todo_list", {"todos": "\n".join(
            f"- [{'x' if st == 'completed' else ('-' if st == 'in_progress' else ' ')}] {t}" for t, st, _ in a["items"])}
    return "ask_followup_question", {"question": a.get("description", "")}


def _cline_result(s, c):
    k = c.kind
    if k == "edit" and not c.result:
        return f"The content was successfully saved to {abspath(s.project, c.args['path'])}."
    if k == "write" and not c.result:
        return f"The content was successfully saved to {abspath(s.project, c.args['path'])}."
    if k == "todo":
        return "Todo list updated successfully."
    return c.result


def render_cline(home, s):
    tm = schedule(s)
    usage = estimate_usage(s)
    cwd = project_cwd(s.project)
    sid = f"{tm.start_ms}_{stable_hex('cline/' + s.key, 6)}"
    first_prompt = next(t.text for t in s.turns if t.role == "user")
    messages = []
    for ti, t in enumerate(s.turns):
        mid = f"msg_{sid}_{ti + 1:03d}"
        if t.role == "user":
            messages.append({"id": mid, "role": "user", "content": t.text, "ts": tm.turn_ms[ti]})
            continue
        fresh, out_tokens, cache_read = usage[ti]
        content = []
        ids = []
        if t.text:
            content.append({"type": "text", "text": t.text})
        for ci, c in enumerate(t.calls):
            name, inp = _cline_tool(s, c)
            tid = "toolu_" + stable_hex(f"{s.key}/{ti}/{ci}", 20)
            ids.append(tid)
            content.append({"type": "tool_use", "id": tid, "name": name, "input": inp})
        messages.append({"id": mid, "role": "assistant", "content": content, "ts": tm.turn_ms[ti],
                         "metrics": {"inputTokens": fresh + cache_read, "outputTokens": out_tokens,
                                     "cacheReadTokens": cache_read,
                                     "cost": round((fresh + cache_read) * 3e-6 + out_tokens * 15e-6, 4)}})
        if t.calls:
            res = []
            for c, tid in zip(t.calls, ids):
                r = {"type": "tool_result", "tool_use_id": tid, "content": _cline_result(s, c)}
                if c.error:
                    r["is_error"] = True
                res.append(r)
            messages.append({"id": mid + "r", "role": "user", "content": res, "ts": tm.results_ms[ti]})
    manifest = {"version": 1, "session_id": sid, "source": "cli", "pid": 41873 + (tm.start_ms % 900),
                "started_at": iso(tm.start_ms), "ended_at": iso(tm.end_ms), "status": "completed",
                "interactive": True, "provider": "anthropic", "model": s.model, "cwd": cwd,
                "workspace_root": cwd, "prompt": s.title or first_prompt}
    body = {"version": 1, "updated_at": iso(tm.end_ms), "agent": "lead", "sessionId": sid, "messages": messages}
    d = home / ".cline" / "data" / "sessions" / sid
    d.mkdir(parents=True, exist_ok=True)
    (d / f"{sid}.json").write_text(json.dumps(manifest, indent=2, ensure_ascii=False))
    (d / f"{sid}.messages.json").write_text(json.dumps(body, indent=2, ensure_ascii=False))
    return d / f"{sid}.messages.json", tm.end_ms, [d / f"{sid}.json", d / f"{sid}.messages.json"], sid


# ---------------------------------------------------------------------------
# Amp: ~/.local/share/amp/threads/T-<uuid>.json
# ---------------------------------------------------------------------------

def _amp_tool(s, c):
    k, a = c.kind, c.args
    p = lambda x: abspath(s.project, x)
    if k == "read":
        return "Read", {"path": p(a["path"])}
    if k == "grep":
        return "Grep", {"pattern": a["pattern"], "path": p(a["path"])}
    if k == "glob":
        return "glob", {"filePattern": a["pattern"]}
    if k == "ls":
        return "list_directory", {"path": p(a["path"])}
    if k == "bash":
        return "Bash", {"cmd": a["command"]}
    if k == "edit":
        return "edit_file", {"path": p(a["path"]), "old_str": a["old"], "new_str": a["new"]}
    if k == "write":
        return "create_file", {"path": p(a["path"]), "content": a["content"]}
    if k == "todo":
        return "todo_write", {"todos": [{"id": str(i + 1), "content": t, "status": st} for i, (t, st, _) in enumerate(a["items"])]}
    return "Task", {"description": a.get("description", ""), "prompt": a.get("prompt", "")}


def render_amp(home, s):
    tm = schedule(s)
    usage = estimate_usage(s)
    tid = "T-" + det_uuid("amp/" + s.key)
    messages = []
    ledger = []
    mid = 0
    for ti, t in enumerate(s.turns):
        if t.role == "user":
            messages.append({"role": "user", "messageId": mid, "content": [{"type": "text", "text": t.text}]})
            mid += 1
            continue
        fresh, out_tokens, cache_read = usage[ti]
        content = []
        ids = []
        if t.text:
            content.append({"type": "text", "text": t.text})
        for ci, c in enumerate(t.calls):
            name, inp = _amp_tool(s, c)
            cid = "toolu_" + stable_hex(f"{s.key}/{ti}/{ci}", 20)
            ids.append(cid)
            content.append({"type": "tool_use", "id": cid, "name": name, "input": inp})
        messages.append({"role": "assistant", "messageId": mid, "model": s.model, "content": content,
                         "usage": {"inputTokens": fresh + cache_read, "outputTokens": out_tokens}})
        ledger.append({"model": s.model, "timestamp": iso(tm.turn_ms[ti], False), "toMessageId": mid,
                       "tokens": {"input": fresh + cache_read, "output": out_tokens}})
        mid += 1
        if t.calls:
            res = [{"type": "tool_result", "toolUseID": cid,
                    "run": {"status": "error" if c.error else "done", "result": c.result}}
                   for c, cid in zip(t.calls, ids)]
            messages.append({"role": "user", "messageId": mid, "content": res})
            mid += 1
    thread = {"v": 1, "id": tid, "created": tm.start_ms, "title": s.title,
              "messages": messages, "usageLedger": {"events": ledger}}
    path = home / ".local" / "share" / "amp" / "threads" / f"{tid}.json"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(thread, indent=2, ensure_ascii=False))
    return path, tm.end_ms, None, tid


# ---------------------------------------------------------------------------
# Cursor CLI: ~/.cursor/chats/<md5 of project path>/<id>/{meta.json,store.db}
# ---------------------------------------------------------------------------

def render_cursor(home, s):
    tm = schedule(s)
    sid = det_uuid("cursor/" + s.key)
    cwd = project_cwd(s.project)
    first_prompt = next(t.text for t in s.turns if t.role == "user")
    d = home / ".cursor" / "chats" / hashlib.md5(cwd.encode()).hexdigest() / sid
    d.mkdir(parents=True, exist_ok=True)
    meta = {"agentId": sid, "cwd": cwd, "name": s.title or first_prompt[:60], "createdAt": tm.start_ms,
            "mode": "agent", "lastUsedModel": s.model}
    (d / "meta.json").write_text(json.dumps(meta, indent=2, ensure_ascii=False))
    db = d / "store.db"
    if db.exists():
        db.unlink()
    conn = sqlite3.connect(db)
    conn.execute("CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT)")
    conn.execute("CREATE TABLE blobs (id TEXT PRIMARY KEY, data BLOB)")
    conn.execute("INSERT INTO meta (key, value) VALUES ('0', ?)", (json.dumps(meta),))
    n = 0
    for ti, t in enumerate(s.turns):
        if t.role == "user":
            msg = {"role": "user", "content": t.text}
        else:
            parts = []
            if t.text:
                parts.append({"type": "text", "text": t.text})
            for ci, c in enumerate(t.calls):
                name, inp = _cline_tool(s, c)
                parts.append({"type": "tool-call", "toolName": name, "args": inp,
                              "id": "call_" + stable_hex(f"{s.key}/{ti}/{ci}", 12)})
            msg = {"role": "assistant", "content": parts}
        n += 1
        conn.execute("INSERT INTO blobs (id, data) VALUES (?, ?)", (f"blob_{n:04d}", dumps(msg).encode("utf-8")))
    conn.commit()
    conn.close()
    return db, tm.end_ms, [d / "meta.json", db], sid


# ---------------------------------------------------------------------------
# OpenCode: ~/.local/share/opencode/opencode.db (one shared database)
# ---------------------------------------------------------------------------

class OpenCodeDb:
    def __init__(self, home):
        d = home / ".local" / "share" / "opencode"
        d.mkdir(parents=True, exist_ok=True)
        self.path = d / "opencode.db"
        if self.path.exists():
            self.path.unlink()
        self.conn = sqlite3.connect(self.path)
        self.conn.execute("""CREATE TABLE session (id TEXT PRIMARY KEY, project_id TEXT, parent_id TEXT, title TEXT,
            directory TEXT, time_created INTEGER, time_updated INTEGER, model TEXT, tokens_input INTEGER,
            tokens_output INTEGER)""")
        self.conn.execute("""CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT NOT NULL,
            time_created INTEGER NOT NULL, data TEXT NOT NULL)""")
        self.conn.execute("""CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT NOT NULL,
            session_id TEXT NOT NULL, time_created INTEGER NOT NULL, data TEXT NOT NULL)""")
        self.last_ms = 0

    def add(self, s):
        tm = schedule(s)
        usage = estimate_usage(s)
        sid = "ses_" + stable_hex("opencode/" + s.key, 22)
        tin = tout = 0
        for ti, t in enumerate(s.turns):
            if t.role == "assistant":
                f, o, c = usage[ti]
                tin += f + c
                tout += o
        self.conn.execute("INSERT INTO session VALUES (?,?,?,?,?,?,?,?,?,?)",
                          (sid, "prj_" + stable_hex("opencode/prj/" + s.project, 12), None,
                           s.title or next(t.text for t in s.turns if t.role == "user")[:70],
                           project_cwd(s.project), tm.start_ms, tm.end_ms, s.model, tin, tout))
        for ti, t in enumerate(s.turns):
            mid = f"msg_{stable_hex(f'opencode/{s.key}/{ti}', 20)}"
            ms = tm.turn_ms[ti]
            self.conn.execute("INSERT INTO message VALUES (?,?,?,?)",
                              (mid, sid, ms, dumps({"role": t.role, "time": {"created": ms}})))
            parts = []
            if t.text:
                parts.append((ms, {"type": "text", "text": t.text}))
            for ci, c in enumerate(t.calls):
                name, inp = _opencode_tool(s, c)
                cid = "call_" + stable_hex(f"{s.key}/{ti}/{ci}", 16)
                end = tm.call_end_ms[ti][ci]
                parts.append((end - 1, {"type": "tool", "call": {"id": cid, "name": name, "input": inp}}))
                res = {"type": "tool_result", "tool_call_id": cid, "content": _opencode_result(s, c)}
                if c.error:
                    res["is_error"] = True
                parts.append((end, res))
            for pi, (pms, pdata) in enumerate(parts):
                self.conn.execute("INSERT INTO part VALUES (?,?,?,?,?)",
                                  (f"prt_{stable_hex(f'opencode/{s.key}/{ti}/{pi}', 20)}", mid, sid, pms, dumps(pdata)))
        self.last_ms = max(self.last_ms, tm.end_ms)
        return sid, tm.end_ms

    def close(self):
        self.conn.commit()
        self.conn.close()
        return self.path


def _opencode_tool(s, c):
    k, a = c.kind, c.args
    p = lambda x: abspath(s.project, x)
    if k == "read":
        return "read", {"filePath": p(a["path"])}
    if k == "grep":
        return "grep", {"pattern": a["pattern"], "path": p(a["path"])}
    if k == "glob":
        return "glob", {"pattern": a["pattern"]}
    if k == "ls":
        return "list", {"path": p(a["path"])}
    if k == "bash":
        return "bash", {"command": a["command"], "description": a.get("description") or ""}
    if k == "edit":
        return "edit", {"filePath": p(a["path"]), "oldString": a["old"], "newString": a["new"]}
    if k == "write":
        return "write", {"filePath": p(a["path"]), "content": a["content"]}
    if k == "todo":
        return "todowrite", {"todos": [{"id": str(i + 1), "content": t, "status": st, "priority": "medium"}
                                       for i, (t, st, _) in enumerate(a["items"])]}
    return "task", {"description": a.get("description", ""), "prompt": a.get("prompt", "")}


def _opencode_result(s, c):
    if c.kind in ("edit", "write") and not c.result:
        return "Edit applied successfully."
    if c.kind == "todo":
        return json.dumps([{"content": t, "status": st} for t, st, _ in c.args["items"]])
    return c.result


# ---------------------------------------------------------------------------
# Goose: ~/.local/share/goose/sessions/sessions.sqlite
# ---------------------------------------------------------------------------

class GooseDb:
    def __init__(self, home):
        d = home / ".local" / "share" / "goose" / "sessions"
        d.mkdir(parents=True, exist_ok=True)
        self.path = d / "sessions.sqlite"
        if self.path.exists():
            self.path.unlink()
        self.conn = sqlite3.connect(self.path)
        self.conn.execute("""CREATE TABLE sessions (id TEXT PRIMARY KEY, thread_id TEXT, execution_name TEXT,
            working_dir TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
            accumulated_input_tokens INTEGER NOT NULL DEFAULT 0, accumulated_output_tokens INTEGER NOT NULL DEFAULT 0,
            accumulated_total_cost_usd REAL, provider_name TEXT NOT NULL, model_config_json TEXT NOT NULL,
            recipe_run_id TEXT, name TEXT, user_set_name TEXT, description TEXT, scheduler_job_id TEXT,
            archived_at TEXT, session_type TEXT DEFAULT 'user', parent_session_id TEXT, session_source TEXT,
            recipe_text_inputs_json TEXT, session_summary TEXT, summary_is_draft INTEGER)""")
        self.conn.execute("""CREATE TABLE messages (message_id TEXT PRIMARY KEY, session_id TEXT NOT NULL
            REFERENCES sessions(id), id INTEGER NOT NULL, role TEXT NOT NULL, content_json TEXT NOT NULL,
            tool_calls_json TEXT, created_at TEXT NOT NULL)""")

    def add(self, s):
        tm = schedule(s)
        usage = estimate_usage(s)
        sid = "20" + iso(tm.start_ms, False)[2:10].replace("-", "") + "_" + str(1 + int(stable_hex("goose/" + s.key, 4), 16) % 90)
        tin = sum(usage[i][0] + usage[i][2] for i in usage)
        tout = sum(usage[i][1] for i in usage)
        provider = "google" if (s.model or "").startswith("gemini") else "anthropic"
        self.conn.execute(
            """INSERT INTO sessions (id, working_dir, created_at, updated_at, accumulated_input_tokens,
               accumulated_output_tokens, provider_name, model_config_json, name, session_type)
               VALUES (?,?,?,?,?,?,?,?,?, 'user')""",
            (sid, project_cwd(s.project), iso(tm.start_ms, False), iso(tm.end_ms, False), tin, tout, provider,
             json.dumps({"model_name": s.model, "model": s.model}),
             s.title or next(t.text for t in s.turns if t.role == "user")[:70]))
        mn = 0
        for ti, t in enumerate(s.turns):
            mn += 1
            content = [{"type": "text", "text": t.text}] if t.text else []
            tcs = None
            if t.calls:
                tcs = []
                for ci, c in enumerate(t.calls):
                    name, inp = _goose_tool(s, c)
                    tcs.append({"id": "call_" + stable_hex(f"{s.key}/{ti}/{ci}", 16), "name": name, "args": inp})
            self.conn.execute(
                "INSERT INTO messages (message_id, session_id, id, role, content_json, tool_calls_json, created_at) "
                "VALUES (?,?,?,?,?,?,?)",
                (f"msg_{sid}_{mn}", sid, mn, t.role, json.dumps(content), json.dumps(tcs) if tcs else None,
                 iso(tm.turn_ms[ti], False)))
        return sid, tm.end_ms

    def close(self):
        self.conn.commit()
        self.conn.close()
        return self.path


def _goose_tool(s, c):
    k, a = c.kind, c.args
    p = lambda x: abspath(s.project, x)
    if k == "read":
        return "developer__text_editor", {"command": "view", "path": p(a["path"])}
    if k == "grep":
        return "developer__shell", {"command": f"rg -n \"{a['pattern']}\" {a['path']}"}
    if k == "glob":
        return "developer__shell", {"command": f"rg --files -g '{a['pattern']}'"}
    if k == "ls":
        return "developer__shell", {"command": f"ls -la {a['path']}"}
    if k == "bash":
        return "developer__shell", {"command": a["command"]}
    if k == "edit":
        return "developer__text_editor", {"command": "str_replace", "path": p(a["path"]),
                                          "old_str": a["old"], "new_str": a["new"]}
    if k == "write":
        return "developer__text_editor", {"command": "write", "path": p(a["path"]), "file_text": a["content"]}
    if k == "todo":
        return "todo__todo_write", {"content": "\n".join(f"- [{'x' if st == 'completed' else ' '}] {t}" for t, st, _ in a["items"])}
    return "subagent__delegate", {"instructions": a.get("prompt", "")}


# ---------------------------------------------------------------------------
# Aider: ~/.aider/.aider.chat.history.md (every session in one append-only file)
# ---------------------------------------------------------------------------

def _tokens_k(n):
    """aider's utils.format_tokens: exact below 1000, one decimal below 10k, whole thousands above."""
    if n < 1000:
        return str(n)
    if n < 10000:
        return f"{n / 1000:.1f}k"
    return f"{round(n / 1000)}k"


def render_aider_session(s):
    """Markdown for one aider session in the real .aider.chat.history.md shape (aider's io.py and
    utils.split_chat_history_markdown): "#### " lines are the user, "> " lines are tool output,
    everything else is the reply. A SEARCH/REPLACE block is the file path on its own line, the fence,
    then the block. /run output never reaches the file (commands.cmd_run), only the command does."""
    tm = schedule(s)
    usage = estimate_usage(s)
    started = iso(tm.start_ms, False).replace("T", " ").replace("Z", "")
    out = [f"# aider chat started at {started}", ""]
    if s.model:
        out += ["> Aider v0.86.2  ", f"> Main model: {s.model} with diff edit format  ", ""]
    for ti, t in enumerate(s.turns):
        if t.role == "user":
            for ln in t.text.split("\n"):
                out.append(f"#### {ln}  ")
            out.append("")
            continue
        f, o, c = usage[ti]
        if t.text:
            out.append(t.text)
            out.append("")
        for call in t.calls:
            if call.kind == "edit":
                a = call.args
                out.append(a["path"])
                out.append("```" + _fence_lang(a["path"]))
                out.append("<<<<<<< SEARCH")
                out.append(a["old"])
                out.append("=======")
                out.append(a["new"])
                out.append(">>>>>>> REPLACE")
                out.append("```")
                out.append("")
        out.append(f"> Tokens: {_tokens_k(f + c)} sent, {_tokens_k(o)} received.  ")
        out.append("")
        for call in t.calls:
            if call.kind == "bash":
                n = len(call.result.strip().splitlines()) if call.result else 0
                out.append(f"#### /run {call.args['command']}  ")
                out.append("")
                out.append(f"> Added {n} {'line' if n == 1 else 'lines'} of output to the chat.  ")
                out.append("")
    return "\n".join(out), tm.end_ms


def _fence_lang(path):
    ext = path.rsplit(".", 1)[-1] if "." in path else ""
    return {"py": "python", "rs": "rust"}.get(ext, "")


RENDERERS = {
    "claude-code": render_claude,
    "codex-cli": render_codex,
    "gemini-cli": render_gemini,
    "qwen-code": render_qwen,
    "github-copilot-cli": render_copilot,
    "cline": render_cline,
    "amp": render_amp,
    "cursor-cli": render_cursor,
}
