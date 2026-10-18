#!/usr/bin/env bash
# Checks that a built frontend (app/dist by default) is a release build (V-REG-7): none of the
# build flags VITE_ARMILLARY_EXPORT, VITE_ARMILLARY_PRESENTATION or VITE_ARMILLARY_CAPTURE was on.
#   tools/check-release-flags.sh [<dist-dir>]
# - Export (Folio Markdown/HTML buttons, switched off for 0.1.0): a release bundle still looks the
#   flag up at run time; a build with the flag set has it folded in, so the name is gone.
# - Presentation: no sample snapshot marker and no bridge chunk.
# - Capture: none of the capture runner's commands.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DIST="${1:-$ROOT/app/dist}"
ASSETS="$DIST/assets"
[ -d "$ASSETS" ] || { echo "FAIL: no built assets in $ASSETS" >&2; exit 1; }
fail=0
if ! grep -rqs "VITE_ARMILLARY_EXPORT" "$ASSETS"; then
  echo "FAIL: the Folio export controls were built in (VITE_ARMILLARY_EXPORT was set)" >&2; fail=1
fi
if grep -rqs "armillary.presentation.v1" "$ASSETS" || ls "$ASSETS" | grep -q '^bridge-'; then
  echo "FAIL: the presentation snapshot or bridge was built in (VITE_ARMILLARY_PRESENTATION was set)" >&2; fail=1
fi
if grep -rqs "capture_config" "$ASSETS"; then
  echo "FAIL: the capture runner was built in (VITE_ARMILLARY_CAPTURE was set)" >&2; fail=1
fi
[ "$fail" = 0 ] && echo "ok: release build flags are off in $DIST"
exit "$fail"
