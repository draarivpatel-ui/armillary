#!/usr/bin/env bash
# Runs every test suite in the repo and prints one total, summed with awk.
# Usage: tools/test-all.sh [log-dir]   (default log dir: ./test-logs under the repo root)
# Set ARMILLARY_OFFLINE=1 to run cargo without network access (crates must already be cached).
# Suites: the Rust workspace (crates/*), the Tauri app crate (app/src-tauri, its own
# workspace), and vitest in app, design, ui/orrery, ui/folio and ui/firstrun.
set -u
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
LOG="${1:-$ROOT/test-logs}"
OFFLINE_FLAG=""; [ "${ARMILLARY_OFFLINE:-0}" = 1 ] && OFFLINE_FLAG="--offline"
mkdir -p "$LOG"
status=0
(cd "$ROOT" && cargo test ${OFFLINE_FLAG:+$OFFLINE_FLAG} 2>&1) > "$LOG/cargo-workspace.txt" || status=1
(cd "$ROOT" && cargo test ${OFFLINE_FLAG:+$OFFLINE_FLAG} --manifest-path app/src-tauri/Cargo.toml 2>&1) > "$LOG/cargo-app.txt" || status=1
for p in app design ui/orrery ui/folio ui/firstrun; do
  name="vitest-$(echo "$p" | tr / -)"
  (cd "$ROOT/$p" && npx vitest run 2>&1) > "$LOG/$name.txt" || status=1
done

echo "suite                    passed  failed  ignored"
for f in "$LOG"/cargo-workspace.txt "$LOG"/cargo-app.txt; do
  grep -h "^test result:" "$f" | awk -v n="$(basename "$f" .txt)" '
    { for (i = 1; i <= NF; i++) { if ($i ~ /^passed;?$/) p += $(i-1); if ($i ~ /^failed;?$/) fl += $(i-1); if ($i ~ /^ignored;?$/) ig += $(i-1) } }
    END { printf "%-24s %6d  %6d  %7d\n", n, p, fl, ig }'
done
rm -f "$LOG/vitest-summary.txt"
for f in "$LOG"/vitest-*.txt; do
  # vitest prints e.g. "      Tests  96 passed (96)" or "Tests  2 failed | 94 passed (96)"
  sed 's/\x1b\[[0-9;]*m//g' "$f" | grep -E "^ +Tests +" | tail -1 | awk -v n="$(basename "$f" .txt)" '
    { p = 0; fl = 0; for (i = 1; i <= NF; i++) { if ($i == "passed") p = $(i-1); if ($i == "failed") fl = $(i-1) } }
    END { printf "%-24s %6d  %6d  %7d\n", n, p, fl, 0 }'
done | tee "$LOG/vitest-summary.txt" >/dev/null
cat "$LOG/vitest-summary.txt"
{
  for f in "$LOG"/cargo-workspace.txt "$LOG"/cargo-app.txt; do grep -h "^test result:" "$f"; done | awk '
    { for (i = 1; i <= NF; i++) { if ($i ~ /^passed;?$/) p += $(i-1); if ($i ~ /^failed;?$/) fl += $(i-1) } }
    END { print p, fl }'
  awk '{ p += $2; fl += $3 } END { print p, fl }' "$LOG/vitest-summary.txt"
} | awk '{ p += $1; fl += $2 } END { printf "TOTAL                    %6d  %6d\n", p, fl }'
exit $status
