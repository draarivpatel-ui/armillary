//! JSON Schema -> TypeScript, for the subset emitted by the CF model's schemars derives.
use serde_json::Value;
use std::{fs, path::PathBuf};
fn ty(v: &Value) -> String {
    if let Some(r) = v.get("$ref").and_then(Value::as_str) {
        return r.rsplit('/').next().unwrap().to_string();
    }
    for k in ["oneOf", "anyOf"] {
        if let Some(a) = v[k].as_array() {
            return a.iter().map(ty).collect::<Vec<_>>().join(" | ");
        }
    }
    if let Some(a) = v["enum"].as_array() {
        return a
            .iter()
            .map(|x| x.to_string())
            .collect::<Vec<_>>()
            .join(" | ");
    }
    if let Some(a) = v["type"].as_array() {
        return a
            .iter()
            .map(|x| ty(&serde_json::json!({"type":x})))
            .collect::<Vec<_>>()
            .join(" | ");
    }
    match v["type"].as_str() {
        Some("string") => "string".into(),
        Some("integer" | "number") => "number".into(),
        Some("boolean") => "boolean".into(),
        Some("null") => "null".into(),
        Some("array") => format!("Array<{}>", ty(&v["items"])),
        Some("object") => {
            if let Some(p) = v["properties"].as_object() {
                let req = v["required"].as_array();
                format!(
                    "{{ {} }}",
                    p.iter()
                        .map(|(k, val)| {
                            let required =
                                req.is_some_and(|a| a.iter().any(|x| x.as_str() == Some(k)));
                            format!(
                                "{}{}: {};",
                                serde_json::to_string(k).unwrap(),
                                if required { "" } else { "?" },
                                ty(val)
                            )
                        })
                        .collect::<Vec<_>>()
                        .join(" ")
                )
            } else {
                format!(
                    "Record<string, {}>",
                    v.get("additionalProperties")
                        .map(ty)
                        .unwrap_or("unknown".into())
                )
            }
        }
        None if v.as_bool() == Some(false) => "never".into(),
        _ => "unknown".into(),
    }
}
fn main() {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let schema = armillary_model::schema_json();
    let mut out = String::from("// Generated from armillary-model by generate-contract. Do not edit.\n// Contract: armillary.cf.v1. Times are Unix milliseconds. Unknown values are null.\n\n");
    for (name, v) in schema["definitions"].as_object().unwrap() {
        out.push_str(&format!("export type {name} = {};\n\n", ty(v)));
    }
    let schema_text = serde_json::to_string_pretty(&schema).unwrap() + "\n";
    let ts_path = root.join("generated/contract.ts");
    let schema_path = root.join("generated/contract.schema.json");
    if std::env::args().any(|a| a == "--check") {
        assert_eq!(
            fs::read_to_string(ts_path).unwrap(),
            out,
            "TypeScript is stale"
        );
        assert_eq!(
            fs::read_to_string(schema_path).unwrap(),
            schema_text,
            "schema is stale"
        );
    } else {
        fs::create_dir_all(root.join("generated")).unwrap();
        fs::write(ts_path, out).unwrap();
        fs::write(schema_path, schema_text).unwrap();
    }
}
