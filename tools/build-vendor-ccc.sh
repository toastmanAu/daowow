#!/usr/bin/env bash
# Regenerates apps/web/vendor/ccc.min.mjs: the whole of CCC, every wallet
# signer it ships included, so the app offers what upstream supports.
#
# The output is COMMITTED so the served page needs no build step, no CDN and no
# node_modules at serve time. This script is the only thing in the repository
# that touches npm, and it runs with lifecycle scripts disabled.
#
# After running it, `node --test apps/web/test/vendor.test.js` must pass: it
# checks the artifact against the lock file this script writes, and checks that
# the bundled crypto reproduces the Rust hash oracle.
set -euo pipefail

CCC_VERSION="1.3.6"

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="$ROOT/apps/web/vendor"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

cd "$WORK"
npm init -y >/dev/null
printf 'ignore-scripts=true\n' > .npmrc
npm install --ignore-scripts --no-audit --no-fund \
  "@ckb-ccc/ccc@${CCC_VERSION}" esbuild >/dev/null

cat > entry.mjs <<'ENTRY'
export { ccc } from "@ckb-ccc/ccc";
ENTRY

./node_modules/.bin/esbuild entry.mjs --bundle --format=esm \
  --platform=browser --target=es2022 --minify --outfile="$OUT/ccc.min.mjs"

SHA="$(sha256sum "$OUT/ccc.min.mjs" | cut -d' ' -f1)"
PACKAGES="$(node -e "
const fs=require('fs'),d='$WORK/node_modules/@ckb-ccc';
const o={};for(const n of fs.readdirSync(d).sort())o['@ckb-ccc/'+n]=require(d+'/'+n+'/package.json').version;
process.stdout.write(JSON.stringify(o,null,4).replace(/\n/g,'\n  '))")"

cat > "$OUT/ccc.lock.json" <<LOCK
{
  "artifactSha256": "$SHA",
  "packages": $PACKAGES,
  "builtWith": "esbuild --bundle --format=esm --platform=browser --target=es2022 --minify",
  "regenerate": "tools/build-vendor-ccc.sh"
}
LOCK

echo "wrote $OUT/ccc.min.mjs"
echo "sha256 $SHA"
echo "packages $PACKAGES"
