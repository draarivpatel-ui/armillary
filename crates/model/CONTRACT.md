# Armillary CF contract v1

Status: frozen for package integration. Namespace: `armillary.cf.v1`.
The Rust source of truth is `armillary-model`. Adapters and archive re-export it;
neither defines a second Session, Message, Usage or Live type.

## Generated application types

`generated/contract.schema.json` is derived from Rust with schemars.
`generated/contract.ts` is generated from that schema by the checked-in converter.
Application packages should import these types rather than maintain local copies.

```sh
cargo run --offline -p armillary-model --bin generate-contract
cargo run --offline -p armillary-model --bin generate-contract -- --check
```

The JSON shape is snake_case. Times are Unix milliseconds, with null or absent
optional fields meaning unknown. Unknown never means zero. Numeric timestamps,
usage and checkpoints must fit the JavaScript safe integer range. Tool arguments
and results retain JSON values; attachment references are never dereferenced.

## Identity: one algorithm, explicit namespaces and inputs

`H(kind, inputs)` is SHA-256 of the following UTF-8 strings, in order:
`armillary.cf.v1`, `kind`, then every input. Prefix EACH string with its byte
length encoded as an unsigned 64-bit big-endian integer. Return the entire digest
as 64 lowercase hexadecimal characters. There are no delimiter joins, truncated
hashes, platform-native byte encodings or hidden adapter-version inputs.

- Agent IDs are stable catalogue slugs, not derived hashes.
- Installation: `H("installation", [agent_id, canonical_installation_locator,
  profile_id])`. Registry integration supplies the locator for binaries, bundles
  or extension installs; unresolved migration uses an explicit legacy locator.
- Store: `H("store", [store_namespace, canonical_store_root, profile_id])`.
- Native session: `H("session", [store_id, native_session_id])`.
- Session without a native ID: `H("session-path", [store_id, relative_source_path])`.
  Its `native_id` remains null; no native identifier is fabricated.
- Native message: `H("message", [session_id, native_message_id])`.
- Message without a native ID: `H("message-path", [session_id, source_key,
  generation_decimal, record_position_decimal])`. `native_id` remains null. An
  explicit missing message-ID pointer never falls back to a session's `id` field.
- Source: `H("source", [store_id, relative_source_path])`.
- Native usage observation: `H("usage", [session_id, native_event_id])`.
- Source-position usage: `H("usage-path", [session_id, source_key,
  generation_decimal, record_position_decimal])`.
- Session-summary usage: `H("usage-summary", [session_id])`.
- Tool call without a native call ID: `H("tool", [source_event_and_block_position])`.
  Tool results require a native correlation ID; guessing a result's call is refused.

Independent Python hash calculation pins this test vector:
`H("session", ["store", "native"]) = f83056a88ceb08afc743979e805048e5b50ebbc7d1982a46fe31ba709e68181a`.

Integration owns store identity. Canonicalize the STORE root once, choose an opaque
profile identity, and use the same format namespace for every CLI, desktop or IDE
surface reading that store. Do not substitute the executable name, importer
installation, scan root or adapter ID for store identity. Reference namespaces are
`claude-history` and `codex-history`. Different profiles or stores produce different
IDs even when both native IDs are `1`. Adapter upgrades do not change IDs.

`Agent` is catalogue metadata. `Install` has a separate installation ID, executable,
version, profile, store IDs and logical paths. The session's installation is optional
provenance, not part of its identity. Native session, message, parent and call IDs
are retained when present. For source-position message fallbacks, rotation cannot
prove event continuity; integration must supply stable native IDs or a dedicated
normalizer instead of rebasing sequence numbers and hoping they match.

## Session and ordered content

`NormalizedSession` contains a `Session` and ordered `messages`. There is no separate
independently numbered tool-call stream. Each Message has its stable ID, native ID,
role, sequence, optional time and ordered `blocks`:

- `text`, `code` with optional language.
- `tool_call` with correlation ID, native ID, name, original JSON input and file paths.
- `tool_result` with the same correlation ID, original JSON output and optional error flag.
- `edit` with path and optional before, after or diff content.
- `checklist` with text and checked state per item.
- `error` with text and optional code.
- `attachment` with a reference, optional MIME type and label.

One source event produces one Message, including tool-only events. JSONL sequences
are one-based source record positions, so metadata and usage events can leave gaps.
JSON and Markdown use record-array order; SQLite preserves query row order within
each native-session group. A call and its inline result are consecutive blocks in
the same event. A later result stays in its own later event. Search hits carry
`message_id`, `seq`, `block_index` and that message's time.

`turns` counts user events containing text or code, excluding tool-only responses.
An ordinary user prompt or file inactivity does not prove completion. Native status,
end-time fields or a declared native completion event supply explicit completion
evidence. Otherwise status and end time remain unknown. Do not equate an assistant
reply, usage event or item completion with the session ending.

## Usage semantics

Every UsageObservation states `cumulative`, `delta` or `unknown` and has an event ID.
Repeated identical event IDs are deduplicated. Conflicting repeats are rejected.
Cumulative totals take the latest known value per metric. Delta observations sum
with overflow checking. Explicit zero is retained. Unobserved metrics remain null.
Unknown semantics and mixed cumulative/delta streams retain the observations but
leave totals unknown rather than invent an aggregation. Append imports merge usage
by event ID before recomputing totals.

Session-level mapped token fields are cumulative summaries. Do not also configure
them alongside delta usage without a dedicated reconciliation policy: mixed
semantics intentionally produce unknown totals.

## Source provenance and import batches

Each physical source file has SourceProvenance: store, logical source ID, adapter ID
and version, store-relative source path, file identity, generation and checkpoint.
On POSIX, file identity is device plus inode. Paths use '/' separators. Reference
fixtures use portable `fixture://` store identities and explicit synthetic file
identities, never a developer's HOME or checkout inode.

Integration assigns persistent, monotonic generation and checkpoint revision values.
A generation represents an observed file incarnation, not a wall-clock timestamp.
A revision orders importer attempts within it. Do not use mtime as the ordering
counter. Text checkpoint extent is byte length; SQLite extent is logical query row
count because WAL checkpointing can shrink WAL bytes without removing history.
`records` records parsed native records and `digest` fingerprints the captured data.

An ImportBatch is either:

- `mode: {mode: "snapshot"}` with the fully read and parsed source content.
- `mode: {mode: "append", from: <accepted Checkpoint>}` with an exact base checkpoint
  and strictly advancing new message sequences. Repeated identical native events
  are harmless; changed accepted events require a complete snapshot.

ReadStatus must be `complete` before data can change. An `incomplete` or `failed`
batch records diagnostics only. It never advances the accepted checkpoint or changes
messages, search, metadata or live state. Reader APIs return errors instead of a
successful prefix, including malformed JSONL, invalid UTF-8, interrupted I/O,
permission failures, unsupported content and resource limits.

Older generations/revisions are rejected. Conflicting data at the same revision,
changed file identity or decreasing extent without a new generation are refused.
Replay does not apply live mutations. A complete snapshot replaces content only for
its own source and sessions explicitly included. Missing sessions or missing files
on a scan do not delete archive history. A new generation retains earlier events;
rebased or conflicting event sequences are rejected rather than silently rewritten.
Append and rotation preserve earlier known optional metadata and completion evidence.

Source checkpoint, session metadata, message rows, every FTS block row and batch live
actions change in ONE SQLite transaction. A write failure rolls them all back.
Source diagnostics survive a rejected import; they are read with `diagnostics(key)`.
The archive's public ingestion API is `import_batch`, not the removed v1
`SessionImport` / `import_session` reconstruction API.

## Confirmed deletion and live actions

`confirm_source_deleted` requires `ConfirmedSourceDeletion`, the exact latest accepted
SourceProvenance and `confirmed_source_deletion` evidence. A failed enumeration or
one missing-path observation is insufficient. The caller must confirm deletion
through its scoped watcher/stat policy. The operation removes that source's messages
and FTS rows atomically; a session is removed only if no source still owns it. A
source tombstone rejects older queued imports. Reappearance needs a new generation.
Logical deletion is immediate; SQLite free-page remnants require compaction and the
application's private retention policy. Source data is never modified.

Live state includes `unknown`, `working`, `waiting`, `idle`, `done`, observed time,
optional state start, evidence, confidence, process identity including start time,
and optional expiry. A non-unknown state needs evidence and confidence. Integration
must use a reliable native waiting signal before presenting "needs you" and expire
stale observations without inferring completion.

Every LiveMutation has `session_id` and an `action` object:

- `{action: "preserve"}` leaves the row unchanged.
- `{action: "update", value: <Live>}` explicitly replaces it. Stale observations fail.
- `{action: "remove", evidence: <Evidence>}` removes it. Evidence time must be at
  least as new as an existing observation.

Batch omission preserves live state. Completion callers must explicitly remove or
update it. Live observers can use `live_update` separately from source imports.

## Declarative adapter language

All TOML structs deny unknown keys. Unknown formats, grouping modes, transforms,
timestamp formats and unsupported combinations fail at load time. Every builtin
still parses, including detection-only entries with no history sources.

Source formats are `jsonl`, `json`, `sqlite`, `markdown`. `paths` selects that source's
platform-specific files; `fixture_paths` selects its synthetic files. Neither uses a
global extension scan. JSON fixture discovery always excludes `expected.json`.
Production uses `source_batches` or `read_manifest` with source-specific expanded
paths, an Environment and explicit approved roots. Missing variables and directory
read errors are surfaced; integration must report them and avoid accepting a partial
manifest. Production must never call the synthetic fixture API on a real store.

Mappings use RFC 6901 pointers, including empty pointer for the current value.
Supported session keys: `id`, `project_root`, `title`, `timestamp` OR `started_at`,
`ended_at`, `model`, `status`, `parent_id`, `tokens_in`, `tokens_out`,
`timestamp_format`, metadata filter pointer/value and completion filter pointer/value.
Metadata filters select session records; completion filters apply to all source events.
A missing native ID stays null and uses the separate source-path fallback namespace.

`records.type_pointer` controls `match_type` filters for messages, tools and usage.
`records.array_pointer` selects a JSON/Markdown record array; it is rejected for
JSONL and SQLite. SQLite's SELECT projects JSON-pointer-addressable column names,
groups rows by mapped native session ID and preserves query order. JSON blobs,
cross-table joins beyond the SQL query and other multi-file grouping require a
custom module, never ignored declarative keys.

Message mappings support native ID, role, item type and role map, primary/fallback
text pointers, timestamp pointer/format and text transform. `string` requires scalar
text; `content_array` and `string_or_content` preserve scalar text and supported
ordered native content; `json` retains serialized JSON as text. Supported time formats
are `auto`, `iso8601`, `unix_seconds`, `unix_milliseconds`. Explicit seconds use checked
multiplication, including `i64::MIN`; invalid mapped timestamps fail the batch.

Tool mappings support event match type, a content-array pointer and type filter, or
an item-type pointer plus allowed call types; mapped name, input, inline result and
file paths; call ID; result filter/type list, correlation ID and output. Claude
`tool_use` / `tool_result` and the reference Codex inline command result retain order
and correlation. Canonical code/edit/checklist/error/attachment blocks are accepted
without reconstruction from summaries. Unsupported content blocks fail the source
with a diagnostic rather than disappear from a supposedly complete snapshot.

Usage mappings support event match type, filter pointer/value, input/output pointers,
native event-ID pointer and explicit semantics. Version every history adapter before
claiming compatibility with an actual release. The reference version is `1.0.0`;
unversioned existing adapters are labelled `0.1.0-unverified` in provenance.

## Filesystem and executable boundary

Every reader takes a ReadBoundary with explicitly approved roots. The boundary
canonicalizes paths, checks credential components before opening content, verifies
containment and uses directory handles plus `openat(O_NOFOLLOW)` for each POSIX
component. Symlink escapes and credential targets such as `../auth.json` are refused.
Only regular files are accepted. Limits are 64 MiB per source file and 250,000 native
records/query rows. Before/after metadata detects ordinary source mutation.

SQLite copies DB, WAL and SHM through that same boundary into a private temp directory.
Repeated source capture must match; changing sources retry finitely and then fail.
Only the temp database is opened by SQLite, read-only with query-only enforcement.
SELECT/WITH are permitted; write and ATTACH queries are refused. `file:` URI paths
encode reserved bytes, including '?', '#', '%' and spaces. No immutable open of an
active source, unescaped URI or source-writing fallback remains. Archive DB, WAL and
SHM permissions are tested as private on this Mac.

POSIX source reads are implemented. Windows source reads and version probes currently
fail closed until a native handle/reparse-point boundary is implemented and tested.
Windows declarative path expansion and passive detection mocks still run. Do not
advertise unverified platform history coverage.

Discovery is passive by default, including unknown versions. The optional
`probe_trusted_version` requires an exact canonical executable allowlist, explicit
arguments, a timeout at most five seconds and an output cap at most 64 KiB. It has
bounded nonblocking output, kills the process group on timeout/overflow and reaps the
child. It is never invoked from discovery. Product code makes no network calls.

## Handoff obligations

- Adapter builders must adopt this model, version their specs, supply explicit paths,
  update all full goldens, declare usage semantics and preserve native IDs/results.
  Only Claude and Codex full goldens were regenerated by CF. Other package fixtures
  retain labelled legacy text/count smoke checks until their owners regenerate them.
- Registry/import integration must register catalogue agents, establish shared store
  and profile identities, approve roots per source, persist counters/checkpoints,
  translate discovery failures into source diagnostics and confirm deletions explicitly.
- Tauri must depend on the shared crate despite its separate workspace, pass ImportBatch
  directly, expose diagnostics and message/search pagination, and consume generated TS.
- Folio/Search must render block order and native hit anchors, correlate call IDs, keep
  structured edits/checklists/errors/attachments and display unknown metrics honestly.
  Source text and FTS snippets remain untrusted; renderers must escape them and constrain
  links/attachments before marking highlighting. Do not inject raw snippet HTML.
- Orrery/live builders must handle unknown state, evidence/confidence/expiry, explicit
  preserve/update/remove and process start identity. Almanac must retain unknown times,
  project identity and usage semantics rather than substituting zero.

Schema v1 migrates atomically to v2. It retains session/message content and native
session IDs in a distinct `legacy-unresolved` store, labels old live state unknown,
retains raw usage observations with unknown semantics and records unresolved identity
and lifecycle diagnostics. Reimport is required to establish actual store/profile
identity; do not auto-merge legacy rows by a guessed profile. Synthetic fixtures and
passing tests establish parser behavior, not real-release compatibility or rendered
application integration.
