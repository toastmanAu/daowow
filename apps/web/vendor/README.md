# Vendored CCC + JoyID bundle

`ccc-joyid.min.mjs` is the **only third-party code in this repository**. It is
a single browser ES module containing `@ckb-ccc/core` and `@ckb-ccc/joy-id`,
built by `tools/build-vendor-ccc.sh`.

Size: 458K minified, 154K gzipped.

## Why it is committed

`apps/web` has no build step at serve time, no CDN, no remote fonts and no
`node_modules`. Committing the artifact keeps all of that while still giving
the client a real CKB library, rather than hand-rolling molecule encoding,
witness layout and fee sizing — the area `~/.claude/rules/ckb-transactions.feedback.md`
records dozens of silent, expensive bugs in.

The alternative, adopting npm at serve time, would have ended the
zero-dependency property and widened the supply-chain surface permanently.
See `docs/superpowers/specs/2026-09-18-dapp-foundation-design.md` decision D1.

## Regenerating

```sh
./tools/build-vendor-ccc.sh
node --test apps/web/test/vendor.test.js
```

The script installs with `--ignore-scripts`, bundles with esbuild, and writes
`ccc-joyid.lock.json` recording the resolved package versions and the
artifact's sha256. The build is reproducible: rebuilding produces a
byte-identical artifact and therefore the same hash.

## What the tests enforce

`apps/web/test/vendor.test.js` checks two independent properties, and each was
confirmed to fail on its own by a mutation round trip:

1. **Provenance.** The artifact's sha256 matches `ccc-joyid.lock.json`, so a
   silent swap of the bundle fails the suite.
2. **Agreement.** The bundled `hashCkb` reproduces the Rust-generated
   `domain_hash` vector. If the vendored crypto did not hash the way the
   contracts hash, everything built on it would be wrong.

## Known advisory, present in the shipped artifact

`elliptic` (GHSA-848j-6mx2-7j84, **low**) reaches the bundle via
`@joyid/ckb`. All 21 advisories in the install tree chain from that one
package; none are moderate, high or critical.

This is **runtime surface, not build-time only**: `elliptic` is bundled into
the artifact, not merely present in `node_modules` during the build. Recorded
here because an earlier framing of this decision claimed otherwise.
