use crate::{
    adapter_spec::AdapterDef, boundary::ReadBoundary, engine::AdapterEngine,
    model::NormalizedSession,
};
use std::path::Path;
pub struct GoldenHarness;
impl GoldenHarness {
    pub fn run_test(
        adapter: &AdapterDef,
        fixture_dir: &Path,
    ) -> Result<(), Box<dyn std::error::Error>> {
        let expected_path = fixture_dir.join("expected.json");
        let expected = ReadBoundary::new(&[fixture_dir.to_path_buf()])?.read(&expected_path)?;
        let expected_sessions: Vec<NormalizedSession> = serde_json::from_slice(&expected.bytes)?;
        let actual = AdapterEngine::process_fixture_dir(adapter, fixture_dir)?;
        if actual != expected_sessions {
            return Err(format!(
                "golden mismatch for {}\nEXPECTED {}\nACTUAL {}",
                adapter.id,
                serde_json::to_string_pretty(&expected_sessions)?,
                serde_json::to_string_pretty(&actual)?
            )
            .into());
        }
        Ok(())
    }
}
