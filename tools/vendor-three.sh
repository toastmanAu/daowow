#!/usr/bin/env bash
# Vendors Three.js for the draw animation.
#
# One file, copied unmodified out of the published npm tarball, whose sha512
# is checked against the registry integrity pinned below BEFORE anything is
# extracted. No install, no scripts run, nothing bundled.
#
# 0.170.0 is deliberate: it is the last release that ships as a single
# three.module.min.js. Later releases split the build across two files.
set -euo pipefail

VERSION="0.170.0"
INTEGRITY="sha512-FQK+LEpYc0fBD+J8g6oSEyyNzjp+Q7Ks1C568WWaoMRLW+TkNNWmenWeGgJjV105Gd+p/2ql1ZcjYvNiPZBhuQ=="
SOURCE="package/build/three.module.min.js"

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VENDOR="$ROOT/apps/web/vendor"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

cd "$WORK"
npm pack "three@$VERSION" --ignore-scripts --silent >/dev/null
TARBALL="three-$VERSION.tgz"

GOT="sha512-$(openssl dgst -sha512 -binary "$TARBALL" | openssl base64 -A)"
if [ "$GOT" != "$INTEGRITY" ]; then
  echo "refusing: the tarball's integrity is $GOT, not the pinned $INTEGRITY" >&2
  exit 1
fi

tar -xzf "$TARBALL" "$SOURCE"
cp "$SOURCE" "$VENDOR/three.module.min.js"
SHA256="$(sha256sum "$VENDOR/three.module.min.js" | cut -d' ' -f1)"

cat > "$VENDOR/three.lock.json" <<JSON
{
  "artifactSha256": "$SHA256",
  "packages": {
    "three": "$VERSION"
  },
  "tarballIntegrity": "$INTEGRITY",
  "source": "$SOURCE",
  "regenerate": "tools/vendor-three.sh"
}
JSON
echo "vendored three@$VERSION ($(wc -c < "$VENDOR/three.module.min.js") bytes, sha256 $SHA256)"
