#!/usr/bin/env bash
# Unsigned release build of the macOS app.
#
#   tools/build-release.sh [<out-dir>]
#
# Builds the frontend, the release binary and the .app bundle, then copies the bundle to <out-dir>
# (default ./build in the repository root). Set ARMILLARY_OFFLINE=1 to build without network access
# (the Rust crates must then already be in your local cargo cache); by default cargo may download them.
# The presentation exporter is a cargo example and the sample snapshot is only in
# VITE_ARMILLARY_PRESENTATION=1 builds, so neither can ship (checked below and by
# tools/presentation/check-release-build.sh). No signing, no notarization, no DMG, nothing uploaded.
#
# Why not `npx tauri build --bundles app`: the pinned CLI (2.2.2) adds the cargo feature tauri/native-tls,
# which needs the hyper-tls crate. That crate was not in the offline cargo cache this script was written
# against, so the three steps the CLI would run are done by hand: npm run build, cargo build --release (feature tauri/custom-protocol,
# the same one the CLI passes), then `tauri bundle --bundles app`.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="${1:-$ROOT/build}"
if ! command -v cargo >/dev/null 2>&1; then
  echo "FAIL: cargo not found on PATH (install Rust from https://rustup.rs)" >&2; exit 1
fi
OFFLINE_FLAG=""
if [ "${ARMILLARY_OFFLINE:-0}" = 1 ]; then export CARGO_NET_OFFLINE=true; OFFLINE_FLAG="--offline"; fi
# V-REG-7: a release never carries the dev-only build flags, whatever the calling shell has set.
unset VITE_ARMILLARY_EXPORT VITE_ARMILLARY_PRESENTATION VITE_ARMILLARY_CAPTURE
cd "$ROOT/app"
# Vite also reads .env files: refuse one that sets a flag instead of shipping it.
if grep -qs "VITE_ARMILLARY_" .env .env.local .env.production .env.production.local; then
  echo "FAIL: an app/.env file sets a VITE_ARMILLARY_ build flag" >&2; exit 1
fi
echo "== frontend"; npm run build
"$ROOT/tools/check-release-flags.sh" "$ROOT/app/dist"
touch src-tauri/src/main.rs   # the frontend is embedded at compile time
# A release binary must not carry the build machine's folder names (panic messages embed source paths
# from the cargo registry and the repository). The last matching prefix wins, so the repository comes last.
REMAP="--remap-path-prefix=$HOME=~ --remap-path-prefix=$ROOT=armillary"
echo "== release binary"; ( cd "$ROOT" && RUSTFLAGS="${RUSTFLAGS:+$RUSTFLAGS }$REMAP" cargo build ${OFFLINE_FLAG:+$OFFLINE_FLAG} --release --manifest-path app/src-tauri/Cargo.toml --features tauri/custom-protocol )
if strings -a "$ROOT/app/src-tauri/target/release/orrery-app" | grep -q "$HOME"; then
  echo "FAIL: the release binary still contains $HOME paths" >&2; exit 1
fi
echo "== bundle"; npx tauri bundle --bundles app
APP="$ROOT/app/src-tauri/target/release/bundle/macos/Armillary.app"
mkdir -p "$OUT"; rm -rf "$OUT/Armillary.app"; cp -R "$APP" "$OUT/Armillary.app"
# The presentation exporter is a cargo example (never built by `cargo build --release`, never bundled);
# fail loudly if a dev-only binary ever reappears in the bundle instead of deleting it quietly.
if [ -e "$OUT/Armillary.app/Contents/MacOS/export-presentation" ]; then
  echo "FAIL: the dev-only export-presentation binary is inside the bundle" >&2; exit 1
fi
echo "== $OUT/Armillary.app"; du -sh "$OUT/Armillary.app"; ls -l "$OUT/Armillary.app/Contents/MacOS"
