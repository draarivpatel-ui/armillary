use armillary_model::*;
use serde_json::json;
#[test]
fn namespace_and_length_prefixes_prevent_input_ambiguity() {
    assert_ne!(
        stable_id("session", &["a:b", "c"]),
        stable_id("session", &["a", "b:c"])
    );
    assert_ne!(
        stable_id("session", &["ab", "c"]),
        stable_id("session", &["a", "bc"])
    );
    assert_ne!(
        stable_id("session", &["a", "b"]),
        stable_id("message", &["a", "b"])
    );
    assert_eq!(
        stable_session_id("store", "native"),
        "f83056a88ceb08afc743979e805048e5b50ebbc7d1982a46fe31ba709e68181a"
    );
}
#[test]
fn surface_independent_store_and_profile_identity() {
    let cli = StoreIdentity::new("shared-history", "/synthetic/store", "p1");
    let desktop = cli.clone();
    let other = StoreIdentity::new("shared-history", "/synthetic/store", "p2");
    assert!(cli.valid());
    assert_eq!(
        stable_session_id(&cli.id, "1"),
        stable_session_id(&desktop.id, "1")
    );
    assert_ne!(
        stable_session_id(&cli.id, "1"),
        stable_session_id(&other.id, "1")
    );
}
fn observation(
    id: &str,
    semantics: UsageSemantics,
    input: Option<u64>,
    output: Option<u64>,
) -> UsageObservation {
    UsageObservation {
        event_id: id.into(),
        semantics,
        input_tokens: input,
        output_tokens: output,
        at: None,
    }
}
#[test]
fn cumulative_delta_unknown_and_zero_have_distinct_meanings() {
    let c = Usage::from_observations(vec![
        observation("1", UsageSemantics::Cumulative, Some(100), Some(0)),
        observation("2", UsageSemantics::Cumulative, Some(150), None),
    ])
    .unwrap();
    assert_eq!(c.input_tokens, Some(150));
    assert_eq!(c.output_tokens, Some(0));
    let d = Usage::from_observations(vec![
        observation("1", UsageSemantics::Delta, Some(100), None),
        observation("2", UsageSemantics::Delta, Some(150), Some(0)),
    ])
    .unwrap();
    assert_eq!(d.input_tokens, Some(250));
    assert_eq!(d.output_tokens, Some(0));
    let u = Usage::from_observations(vec![observation(
        "1",
        UsageSemantics::Unknown,
        Some(10),
        None,
    )])
    .unwrap();
    assert_eq!(u.input_tokens, None);
    assert_eq!(u.observations[0].input_tokens, Some(10));
    assert_eq!(Usage::default().output_tokens, None);
}
#[test]
fn duplicate_usage_is_deduplicated_and_conflicts_are_rejected() {
    let one = observation("id", UsageSemantics::Delta, Some(5), None);
    let usage = Usage::from_observations(vec![one.clone(), one.clone()]).unwrap();
    assert_eq!(usage.input_tokens, Some(5));
    assert_eq!(usage.observations.len(), 1);
    assert!(Usage::from_observations(vec![
        one,
        observation("id", UsageSemantics::Delta, Some(6), None)
    ])
    .is_err());
}
#[test]
fn mixed_usage_and_numeric_overflow_do_not_invent_totals() {
    let mixed = Usage::from_observations(vec![
        observation("1", UsageSemantics::Delta, Some(5), None),
        observation("2", UsageSemantics::Cumulative, Some(10), None),
    ])
    .unwrap();
    assert_eq!(mixed.semantics, UsageSemantics::Unknown);
    assert_eq!(mixed.input_tokens, None);
    assert!(Usage::from_observations(vec![
        observation("1", UsageSemantics::Delta, Some(MAX_SAFE_INTEGER), None),
        observation("2", UsageSemantics::Delta, Some(1), None)
    ])
    .is_err());
}
#[test]
fn all_ordered_block_kinds_roundtrip_without_loss() {
    let values = vec![
        json!({"type":"text","text":"hello"}),
        json!({"type":"code","code":"fn main() {}","language":"rust"}),
        json!({"type":"tool_call","call_id":"c","native_id":"c","name":"read","input":{"path":"a"},"files":["a"]}),
        json!({"type":"tool_result","call_id":"c","output":{"ok":true},"is_error":false}),
        json!({"type":"edit","path":"a","before":"old","after":"new","diff":"@@"}),
        json!({"type":"checklist","items":[{"text":"Check","checked":true}]}),
        json!({"type":"error","message":"Failure","code":"E"}),
        json!({"type":"attachment","reference":"local-ref:1","mime_type":"image/png","label":"Screenshot"}),
    ];
    for value in values {
        let block: ContentBlock = serde_json::from_value(value.clone()).unwrap();
        assert_eq!(serde_json::to_value(&block).unwrap(), value);
        assert!(!block.search_text().is_empty());
    }
}
#[test]
fn live_unknown_and_explicit_actions_are_representable() {
    let value = Live {
        session_id: "s".into(),
        state: LiveState::Unknown,
        since: None,
        observed_at: 1,
        evidence: vec![],
        confidence: Confidence::Unknown,
        process: None,
        expires_at: None,
    };
    let json = serde_json::to_value(LiveAction::Update { value }).unwrap();
    assert_eq!(json["value"]["state"], "unknown");
    assert_eq!(json["value"]["since"], serde_json::Value::Null);
    assert_eq!(
        serde_json::to_value(LiveAction::Preserve).unwrap()["action"],
        "preserve"
    );
}
#[test]
fn contract_rejects_unknown_fields_instead_of_erasing_them() {
    assert!(serde_json::from_value::<StoreIdentity>(
        json!({"id":"a","namespace":"b","canonical_root":"c","profile_id":"d","invented":true})
    )
    .is_err());
}
#[test]
fn checked_in_schema_matches_the_rust_model() {
    let schema: serde_json::Value =
        serde_json::from_str(include_str!("../generated/contract.schema.json")).unwrap();
    assert_eq!(schema, schema_json());
}
#[test]
fn source_path_fallback_never_fabricates_a_native_id_or_collides_with_one() {
    let store = StoreIdentity::new("history", "fixture://store", "p");
    assert_ne!(
        normalized_session_id(&store.id, None, "session.json"),
        stable_session_id(&store.id, "session.json")
    );
}
#[test]
fn even_unknown_usage_observations_must_fit_the_json_integer_range() {
    assert!(Usage::from_observations(vec![observation(
        "1",
        UsageSemantics::Unknown,
        Some(u64::MAX),
        None
    )])
    .is_err());
}
