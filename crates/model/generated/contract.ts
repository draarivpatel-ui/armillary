// Generated from armillary-model by generate-contract. Do not edit.
// Contract: armillary.cf.v1. Times are Unix milliseconds. Unknown values are null.

export type Agent = { "family": string; "id": string; "kind": string; "name": string; "vendor": string; };

export type ChecklistItem = { "checked": boolean; "text": string; };

export type Checkpoint = { "digest": string; "offset": number; "records": number; "revision": number; };

export type Confidence = "unknown" | "low" | "medium" | "high";

export type ConfirmedSourceDeletion = { "evidence": Evidence; "source": SourceProvenance; };

export type ContentBlock = { "text": string; "type": "text"; } | { "code": string; "language"?: string | null; "type": "code"; } | { "call_id": string; "files": Array<string>; "input": unknown; "name": string; "native_id"?: string | null; "type": "tool_call"; } | { "call_id": string; "is_error"?: boolean | null; "output": unknown; "type": "tool_result"; } | { "after"?: string | null; "before"?: string | null; "diff"?: string | null; "path": string; "type": "edit"; } | { "items": Array<ChecklistItem>; "type": "checklist"; } | { "code"?: string | null; "message": string; "type": "error"; } | { "label"?: string | null; "mime_type"?: string | null; "reference": string; "type": "attachment"; };

export type Evidence = { "at"?: number | null; "detail": string; "kind": string; "native_event_id"?: string | null; };

export type ImportBatch = { "diagnostics": Array<ImportDiagnostic>; "live_updates": Array<LiveMutation>; "mode": ImportMode; "read_status": ReadStatus; "sessions": Array<NormalizedSession>; "source": SourceProvenance; };

export type ImportDiagnostic = { "code": string; "message": string; "retryable": boolean; "source_key": string; };

export type ImportMode = { "mode": "snapshot"; } | { "from": Checkpoint; "mode": "append"; };

export type Install = { "agent_id": string; "executable_path"?: string | null; "id": string; "paths": Record<string, string>; "profile_id": string; "store_ids": Array<string>; "version"?: string | null; };

export type Live = { "confidence": Confidence; "evidence": Array<Evidence>; "expires_at"?: number | null; "observed_at": number; "process"?: ProcessIdentity | null; "session_id": string; "since"?: number | null; "state": LiveState; };

export type LiveAction = { "action": "preserve"; } | { "action": "update"; "value": Live; } | { "action": "remove"; "evidence": Evidence; };

export type LiveMutation = { "action": LiveAction; "session_id": string; };

export type LiveState = "unknown" | "working" | "waiting" | "idle" | "done";

export type Message = { "at"?: number | null; "blocks": Array<ContentBlock>; "id": string; "native_id"?: string | null; "role": string; "seq": number; "session_id": string; };

export type NormalizedSession = { "messages": Array<Message>; "session": Session; };

export type ProcessIdentity = { "pid": number; "started_at"?: number | null; };

export type ReadStatus = "complete" | "incomplete" | "failed";

export type Session = { "agent_id": string; "completion"?: Evidence | null; "ended_at"?: number | null; "id": string; "installation_id"?: string | null; "model"?: string | null; "native_id"?: string | null; "native_parent_id"?: string | null; "parent_id"?: string | null; "project_root"?: string | null; "provenance": SourceProvenance; "started_at"?: number | null; "status": string; "title"?: string | null; "turns": number; "usage": Usage; };

export type SourceProvenance = { "adapter_id": string; "adapter_version": string; "checkpoint": Checkpoint; "file_identity": string; "generation": number; "source_id": string; "source_path": string; "store": StoreIdentity; };

export type StoreIdentity = { "canonical_root": string; "id": string; "namespace": string; "profile_id": string; };

export type Usage = { "input_tokens"?: number | null; "observations": Array<UsageObservation>; "output_tokens"?: number | null; "semantics": UsageSemantics; };

export type UsageObservation = { "at"?: number | null; "event_id": string; "input_tokens"?: number | null; "output_tokens"?: number | null; "semantics": UsageSemantics; };

export type UsageSemantics = "unknown" | "cumulative" | "delta";

