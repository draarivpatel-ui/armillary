#!/usr/bin/env bash
# Real-app frames without the Screen Recording permission (stream SNAP).
#
#   tools/capture-app/run.sh <tour.json> <out-dir> [--video <burst-name>] [--no-build] [--timeout <seconds>] [--consented]
#
# Builds the frontend (with the capture runner) and the app binary (cargo feature `capture`),
# stages the synthetic presentation dataset in a temporary HOME, launches the real binary under
# `env -i` (so no real agent variable or HOME leaks in), lets the tour photograph the app's own
# WKWebView, and waits for it to exit. PNGs and report.json land in <out-dir>.
#
# Privacy: only the temporary HOME is ever visible to the app. ARMILLARY_PROCESS_SCAN=off (no process
# table) and ARMILLARY_DETECT_SCOPE=home (detection and import confined to HOME, no /Applications or PATH)
# are set for the launch and enforced by the app (INT, on main since 7dfd26e). Before that merge, treat any
# Field Guide, Switchboard or first-run frame as private (it can show this Mac's real apps). Keep <out-dir> outside the repo
# (for example /tmp/rv/snap/<name>). Never point HOME at the real home folder.
#
# Tours: app/src/capture/tour.ts is the schema; tools/capture-app/*.json are examples.
#
# --video NAME turns the burst NAME-0001.png, NAME-0002.png ... into <out-dir>/NAME.mp4 at real
#   time (frame durations come from report.json), with ffmpeg.
# --no-build reuses the last capture build (frontend and binary).
# --consented seeds first-run consent and completion in the temp HOME's app data folder (FR's
#   firstrun.json format, mode 0600), so the app starts its background import at launch and the
#   archive views (Almanac, Search, Folio) show the dataset without walking the first run. The import
#   runs in the background: tours should `waitFor` a populated row before snapshotting.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
TOUR="${1:-}"; OUT="${2:-}"
if [ -z "$TOUR" ] || [ -z "$OUT" ]; then sed -n '2,/^set -euo/p' "$0"; exit 64; fi
shift 2
VIDEO=""; BUILD=1; TIMEOUT=300; CONSENTED=0
while [ $# -gt 0 ]; do
  case "$1" in
    --video) VIDEO="$2"; shift 2 ;;
    --no-build) BUILD=0; shift ;;
    --consented) CONSENTED=1; shift ;;
    --timeout) TIMEOUT="$2"; shift 2 ;;
    *) echo "unknown option: $1" >&2; exit 64 ;;
  esac
done

TOUR="$(cd "$(dirname "$TOUR")" && pwd)/$(basename "$TOUR")"
mkdir -p "$OUT"; OUT="$(cd "$OUT" && pwd)"
case "$OUT" in "$ROOT"|"$ROOT"/*) echo "refusing: out-dir is inside the repo ($OUT)" >&2; exit 65 ;; esac
case "$OUT" in "$HOME"|"$HOME"/Desktop|"$HOME"/Desktop/*) echo "refusing: out-dir $OUT" >&2; exit 65 ;; esac

if ! command -v cargo >/dev/null 2>&1; then
  echo "FAIL: cargo not found on PATH (install Rust from https://rustup.rs)" >&2; exit 1
fi
OFFLINE_FLAG=""; [ "${ARMILLARY_OFFLINE:-0}" = 1 ] && OFFLINE_FLAG="--offline"
# ARMILLARY_PROFILE=release builds and runs the release binary instead of the debug one.
PROFILE_DIR=debug; PROFILE_FLAG=""
[ "${ARMILLARY_PROFILE:-}" = release ] && { PROFILE_DIR=release; PROFILE_FLAG="--release"; }
# ARMILLARY_CAPTURE_BIN points at another capture binary (for example a release build copied out of target/).
BIN="${ARMILLARY_CAPTURE_BIN:-$ROOT/app/src-tauri/target/$PROFILE_DIR/orrery-app}"

if [ "$BUILD" = 1 ]; then
  echo "== building the frontend (capture runner included)"
  (cd "$ROOT/app" && VITE_ARMILLARY_CAPTURE=1 npm run build >"$OUT/build-frontend.log" 2>&1) \
    || { tail -30 "$OUT/build-frontend.log"; exit 1; }
  # The frontend is embedded at compile time; make sure cargo notices a new dist.
  touch "$ROOT/app/src-tauri/src/main.rs"
  echo "== building the app binary (--features tauri/custom-protocol,capture)"
  (cd "$ROOT" && cargo build ${OFFLINE_FLAG:+$OFFLINE_FLAG} $PROFILE_FLAG --manifest-path app/src-tauri/Cargo.toml \
      --features tauri/custom-protocol,capture >"$OUT/build-app.log" 2>&1) \
    || { tail -40 "$OUT/build-app.log"; exit 1; }
fi
[ -x "$BIN" ] || { echo "no binary at $BIN" >&2; exit 1; }

WORK="$(mktemp -d /tmp/rv-capture-run.XXXXXX)"
mkdir -p "$WORK/tmp"
echo "== staging the presentation dataset in $WORK/home"
python3 -I "$ROOT/demo/dataset/generate.py" "$WORK/home" >"$OUT/dataset.log" 2>&1
if [ "$CONSENTED" = 1 ]; then
  # The dataset's reference time (2026-10-12T18:00:00Z), not the wall clock, so runs stay comparable.
  DATA_DIR="$WORK/home/Library/Application Support/com.armillary.app"
  mkdir -p "$DATA_DIR"
  ( umask 077; printf '{"version":1,"consentedAt":1791828000000,"completedAt":1791828000000,"declinedAt":null}' \
      >"$DATA_DIR/firstrun.json" )
  echo "== seeded first-run consent in $DATA_DIR/firstrun.json"
fi

rm -f "$OUT"/report.json
echo "== launching (env -i, HOME=$WORK/home)"
env -i HOME="$WORK/home" PATH=/usr/bin:/bin TMPDIR="$WORK/tmp" \
  ARMILLARY_PROCESS_SCAN=off ARMILLARY_DETECT_SCOPE=home ${ARMILLARY_CAPTURE_DEBUG:+ARMILLARY_CAPTURE_DEBUG=1} ${ARMILLARY_FPS_LOG:+ARMILLARY_FPS_LOG="$ARMILLARY_FPS_LOG"} ${ARMILLARY_TRACE_IPC:+ARMILLARY_TRACE_IPC=1} \
  ARMILLARY_CAPTURE_DIR="$OUT" ARMILLARY_CAPTURE_TOUR="$TOUR" \
  "$BIN" >"$OUT/app.log" 2>&1 &
PID=$!
( sleep "$TIMEOUT"; kill "$PID" 2>/dev/null && echo "watchdog: killed the app after ${TIMEOUT}s" >>"$OUT/app.log" ) &
WATCHDOG=$!
set +e
wait "$PID"; STATUS=$?
set -e
kill "$WATCHDOG" 2>/dev/null || true
echo "== app exited with status $STATUS"
[ -f "$OUT/report.json" ] && sed -n '1,12p' "$OUT/report.json"

if [ -n "$VIDEO" ]; then
  FFMPEG=/opt/homebrew/bin/ffmpeg; [ -x "$FFMPEG" ] || FFMPEG="$HOME/.local/bin/ffmpeg"
  python3 -I - "$OUT" "$VIDEO" >"$OUT/$VIDEO.concat.txt" <<'PY'
import json, sys
out, name = sys.argv[1], sys.argv[2]
frames = [f for f in json.load(open(f"{out}/report.json"))["frames"] if f["name"].startswith(name + "-")]
frames.sort(key=lambda f: f["name"])
for i, f in enumerate(frames):
    nxt = frames[i + 1]["at"] if i + 1 < len(frames) else f["at"] + max(f["ms"], 1)
    print(f"file '{out}/{f['name']}.png'")
    print(f"duration {max(nxt - f['at'], 1) / 1000:.4f}")
if frames:
    print(f"file '{out}/{frames[-1]['name']}.png'")
PY
  "$FFMPEG" -y -loglevel error -f concat -safe 0 -i "$OUT/$VIDEO.concat.txt" -vf "format=yuv420p,scale=trunc(iw/2)*2:trunc(ih/2)*2" \
    -c:v libx264 -crf 18 "$OUT/$VIDEO.mp4" && echo "== wrote $OUT/$VIDEO.mp4"
fi

echo "== temporary HOME removed"; rm -rf "$WORK"
exit "$STATUS"
