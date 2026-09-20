# Validation — prize schedule v2, 2026-09-20

Plan `docs/superpowers/plans/2026-09-20-prize-schedule-v2.md`, spec
`docs/superpowers/specs/2026-09-19-prize-schedule-v2-design.md`.

## Tasks 1–3: the core change

Core tests 154 → 168. Integration 179, unchanged. Every guard mutation-checked.

**v1 compatibility holds.** `encode()` still emits the v1 wire whenever the
thresholds are the v1 default, so the existing `COMMITMENT` constant passes
untouched and the vectors file diff is **additions only** — no existing value
moved. Disabling that branch reds nine tests including the canary.

**One test was wrong and is recorded rather than quietly fixed.** The
non-decreasing-thresholds guard was not pinned: the test used `[8, 1]`, whose
first element is 8, so the *first-threshold* guard refused it before the
ordering guard ran, and disabling the ordering guard left the suite green.
Rewritten as `[1, 8, 5]` — a valid first element so only the ordering check can
refuse — and it now reds correctly. The same shadowing shape as the `rpcUrl`
and terminal-cursor cases in gate 2a: a test asserting the right conclusion for
the wrong reason.

## Task 4: which contracts actually moved

Predicted: `round-type` and `entry-shard-type`. **Measured: four of five.**

| contract | deployed hash | rebuilt hash | |
|---|---|---|---|
| round-type | `0xdc172248…` | `0x6134e439…` | **moved** |
| entry-shard-type | `0x6afa519d…` | `0x60052a7b…` | **moved** |
| entry-lock | `0x48ce84d8…` | `0x863d2629…` | **moved** |
| dao-lock | `0x0cb1229a…` | `0x0cb1229a…` | same |
| settlement-type | `0x3114256d…` | `0xa6854371…` | **moved** |

`entry-lock` and `settlement-type` were the interesting cases: neither calls
`weights_for`, but both link `daowow-core` and dead-code elimination did not
remove the changed code. Predicting instead of measuring would have left two
contracts running the old binary against a manifest claiming otherwise, and
`verify-deployment.mjs` would have caught it only after the fact.

`dao-lock` is unchanged and keeps its existing out point. It is **not**
redeployed, and must not be reclaimed.

**The freshness guard earned its place here.** The integration suite failed on
the first attempt because `accumulator-bench` had not been rebuilt after
`daowow-core` changed. Without `read_bin`'s staleness check that run would have
passed against a stale binary.

## Task 5: the redeploy, and why the reclaim must come first

| contract | bytes | cell CKB |
|---|---:|---:|
| round-type | 62,392 | 62,453 |
| entry-shard-type | 231,592 | 231,653 |
| entry-lock | 95,392 | 95,453 |
| settlement-type | 155,544 | 155,605 |
| **total** | | **545,164** |

**Liquid capacity is 128,812 CKB. The redeploy needs 545,164.** So the
superseded cells must be reclaimed *before* redeploying, not after.

That is safe, and only because no round exists on testnet: nothing references
the deployed code cells, so consuming them strands nothing. Confirmed by
`tools/audit-wallet-cells.mjs`, which reports 694,458 CKB reclaimable from code
— the five DAOWOW cells plus the older `0xa4d1e1e8` set.

Order:

1. **Reclaim the four superseded cells** (538,308 CKB), and optionally the
   older `0xa4d1e1e8` set (78,649 CKB) still sitting unspent from gate 2a.
   Do **not** reclaim `dao-lock`: it is unchanged, still correct, and
   reclaiming it would force an unnecessary redeploy.
   Liquid becomes 667,120 CKB, or 745,769 with the older set.
2. **Size the new config** with `tools/check-deploy-size.mjs`. At 545,164 CKB
   of capacity the binaries total roughly 545 KB, which is comfortably over
   the 597,000-byte block limit once serialised — **this will need splitting**,
   exactly as the first deployment did.
3. **Deploy, one part at a time**, waiting for each to commit before
   generating the next, per `docs/deploy-dev-testnet.md`.
4. **Regenerate the manifest** from all info files, including the original
   part that still carries `dao-lock`.
5. **Verify**: `tools/verify-deployment.mjs` must report 5/5 and exit 0.

## Not yet done

- Task 5 (redeploy) — needs Phill, since it signs.
- Task 6 (devnet round at the demo schedule, proving two places pay at ten
  tickets) — can run before Task 5, since the devnet deploys its own binaries.
