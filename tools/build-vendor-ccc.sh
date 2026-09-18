#!/usr/bin/env bash
# Regenerates apps/web/vendor/ccc-joyid.min.mjs.
#
# The output is COMMITTED so the served page needs no build step, no CDN and no
# node_modules at serve time. This script is the only thing in the repository
# that touches npm, and it runs with lifecycle scripts disabled.
#
# After running it, `node --test apps/web/test/vendor.test.js` must pass: it
# checks the artifact against the lock file this script writes, and checks that
# the bundled crypto reproduces the Rust hash oracle.
set -euo pipefail

CORE_VERSION="1.21.0"
JOYID_VERSION="1.2.3"

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="$ROOT/apps/web/vendor"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

cd "$WORK"
npm init -y >/dev/null
printf 'ignore-scripts=true\n' > .npmrc
npm install --ignore-scripts --no-audit --no-fund \
  "@ckb-ccc/core@${CORE_VERSION}" "@ckb-ccc/joy-id@${JOYID_VERSION}" esbuild >/dev/null

cat > entry.mjs <<'ENTRY'
export * as ccc from "@ckb-ccc/core";
export * as joyid from "@ckb-ccc/joy-id";
ENTRY

./node_modules/.bin/esbuild entry.mjs --bundle --format=esm \
  --platform=browser --target=es2022 --minify --outfile="$OUT/ccc-joyid.min.mjs"

SHA="$(sha256sum "$OUT/ccc-joyid.min.mjs" | cut -d' ' -f1)"
CORE_RESOLVED="$(node -p "require('$WORK/node_modules/@ckb-ccc/core/package.json').version")"
JOYID_RESOLVED="$(node -p "require('$WORK/node_modules/@ckb-ccc/joy-id/package.json').version")"

cat > "$OUT/ccc-joyid.lock.json" <<LOCK
{
  "artifactSha256": "$SHA",
  "packages": {
    "@ckb-ccc/core": "$CORE_RESOLVED",
    "@ckb-ccc/joy-id": "$JOYID_RESOLVED"
  },
  "builtWith": "esbuild --bundle --format=esm --platform=browser --target=es2022 --minify",
  "regenerate": "tools/build-vendor-ccc.sh"
}
LOCK

echo "wrote $OUT/ccc-joyid.min.mjs"
echo "sha256 $SHA"
echo "core   $CORE_RESOLVED"
echo "joyid  $JOYID_RESOLVED"
