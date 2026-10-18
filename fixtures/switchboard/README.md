# Switchboard fixtures (synthetic)

Everything under this folder is invented test data. No file here was copied from a real
machine, and the Switchboard scanner tests read only these paths. The scanner never opens a
real `~/.claude`, `~/.codex`, `~/.gemini`, `~/.cursor` or any other agent folder.

Structure:

- `home/` stands in for a user home directory (`ScanContext::home_root`).
- `project/webapp/` stands in for one project root (`ScanContext::project_roots`).
- `expected/snapshot.json` is the golden normalized output for the whole tree.

Every secret shaped value uses a fake prefix (`ghp_FAKE`, `sk_live_FAKE`, `AIzaFAKE`, ...) and
is masked in the output. Files named `SENTINEL_*` (`home/.claude/.credentials.json`,
`home/.codex/auth.json`, `home/.gemini/oauth_creds.json`, `home/.copilot/config.json`,
`home/.cline/data/settings/providers.json`, `home/.cursor/state.vscdb`, `project/webapp/.env`,
`project/webapp/deploy.key`) exist only to prove the scanner refuses to open credential files;
their contents are asserted absent from every result.
