# Presentation snapshot

`snapshot.json` is what the web build of the app shows in the demo recordings and screenshots. A bridge in
the frontend answers the app's Tauri commands from it. It holds real outputs of the production Rust
code (detection, import, search, config scan, live detector) over the synthetic presentation dataset,
never the user's real HOME.

## Regenerate

```sh
python3 -I demo/dataset/generate.py <demo-home> [--now 2026-10-12T18:00:00Z]
cargo run --manifest-path app/src-tauri/Cargo.toml --example export-presentation -- \
  <demo-home> <out-dir> [--queries demo/presentation/queries.json] [--generator demo/dataset/generate.py]
```

`<out-dir>/snapshot.json` is written. The exporter refuses the real HOME (or any folder that
contains it) and a folder that does not exist, before it scans anything.

## What is inside

Top-level keys: `format` (`armillary.presentation.v1`), `reference_time` (Unix ms), `home` (the
canonical demo HOME, so ids are explainable), `import` (`summary` and the ordered `import:progress`
`events`), `agents_list`, `config_list`, `sessions`, `messages` (session id to messages),
`message_totals`, `search` (`limit` and `entries`), `live`, `firstrun`, and `launchpad` when
`demo/presentation/launchpad.cast` exists.

- `import.events[].t` is a pacing hint in ms, computed from each event's JSON alone (`phase` and
  `agentId`), so it does not depend on the importer's Rust payload type. A terminal event has a
  non-empty `agentId` and phase `adapter`, `finished` or `error`. With k terminal events counted so
  far, a terminal event is 400 * k, the run-level `finished` (empty `agentId`) is 400 * the final k,
  and every other event (run-level `started`, per-agent `started` and `progress`) is 400 * the
  terminal events counted before it. Run `started` is therefore 0 and times never go backwards.
  It is never measured.
- `firstrun` is the real first run replayed over the same demo HOME: `status` is
  `{"consented": true, "completed": true}` (view tours skip the first run; the first-run tour forces it with
  `?firstrun=1`), `plan` is the consent plaque's plan (`plan_core`), and `events` is every event
  `scan_core` emits, in order, as `{event, payload, t}` with the exact payload the Tauri command
  emits. The scan imports into its own in-memory archive, so the main archive is untouched, and
  `liveSessions` in the `firstrun:done` payload counts the non-done sessions of `live.initial`.
  Folders are shown with the home as `~`; the absolute demo HOME path never appears in it.
  `t` follows a fixed rule: `firstrun:catalogue` is 0, the i-th `firstrun:agent` is 120 * i, the
  j-th `firstrun:import` is 200 * j after the last agent event, and `firstrun:done` is 600 after the
  event before it. It is never measured.
- `search.entries` holds one entry per typing prefix of each query in `queries.json` (trimmed,
  duplicates dropped), in typing order: `{query, limit, page}` or `{query, limit, error}`.
- `live.process_table` is `dataset` (from `<home>/processes.json`) or `absent`. `live.initial` is a
  scan at the reference time. When the process table and the generator's `--append-live` exist, each
  working claude-code or codex-cli live session adds a step (`<key> asks for permission`, 41 s apart),
  after which the exporter restores the session file and manifest bytes and mtimes.
- The reference time is `demo-manifest.json` `now`, else 2026-10-12T18:00:00Z.

## Determinism rule

The same demo HOME directory exported twice gives byte-identical files. The exporter never reads the
clock for anything that reaches the snapshot, and object keys are written in sorted order. The ids
depend on the HOME path, so regenerate and export from the same path when comparing snapshots.

## Testing the exporter

`app/src-tauri/tests/presentation_export.rs` runs the built example binary. An unfiltered
`cargo test --manifest-path app/src-tauri/Cargo.toml` (and tools/test-all.sh) builds examples
first; when running that test file alone, add `--examples` so the example is rebuilt:
`cargo test --manifest-path app/src-tauri/Cargo.toml --examples --test presentation_export`.
