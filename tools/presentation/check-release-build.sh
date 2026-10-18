#!/usr/bin/env bash
# Checks that dev-only presentation material never ships (INT):
#  1. a normal frontend build contains no sample snapshot (and no presentation bridge chunk);
#  2. a presentation build (VITE_ARMILLARY_PRESENTATION=1) does contain them;
#  3. the exporter is a cargo example: `cargo build --release` produces no export-presentation binary;
#  4. the normal build has the export, presentation and capture flags off (tools/check-release-flags.sh).
# Usage: tools/presentation/check-release-build.sh   (leaves app/dist as a NORMAL build)
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT/app"
marker="armillary.presentation.v1"
VITE_ARMILLARY_PRESENTATION=1 npm run build >/tmp/rv-presentation-build.log 2>&1
grep -rqs "$marker" dist/assets || { echo "FAIL: the presentation build has no snapshot"; exit 1; }
echo "ok: presentation build contains the snapshot"
npm run build >/tmp/rv-normal-build.log 2>&1
if grep -rqs "$marker" dist/assets; then echo "FAIL: a normal build contains the sample snapshot"; exit 1; fi
if ls dist/assets | grep -q '^bridge-'; then echo "FAIL: a normal build contains the presentation bridge"; exit 1; fi
echo "ok: normal build contains no snapshot and no bridge"
"$ROOT/tools/check-release-flags.sh" "$ROOT/app/dist"
if grep -q '^\[\[bin\]\]' "$ROOT/app/src-tauri/Cargo.toml" || [ -e "$ROOT/app/src-tauri/src/bin/export-presentation.rs" ]; then
  echo "FAIL: the exporter is a binary target"; exit 1
fi
echo "ok: the exporter is an example (release builds never build or bundle it)"
