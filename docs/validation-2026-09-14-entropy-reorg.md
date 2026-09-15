# Isolated entropy reorg and continued payout — 2026-09-14

Result: the one-entry MMR full history passes after a real competing branch
replaces the seal inclusion and authenticated entropy. This is a bounded
validation checkpoint, not readiness for arbitrary funded rounds.

## What the test proves

Two isolated full nodes share the actual history through the block before the
seal. A distinct branch includes the same seal transaction at height 46 instead
of 43, derives entropy from its actual scheduled headers, and commits a different
entropy transaction. Relaying the longer branch into the original node changes
its canonical tip and the hash at the original seal height.

The orphaned entropy output is no longer live. An ordinary sponsor transaction
referencing that cell as a dependency rejects; changing only that dependency to
the rebuilt canonical entropy permits commitment. The fixture then continues
DAOWOW-locked DAO withdrawal, native maturity, computed initial funding and
complete participant payout using canonical evidence.

- Old entropy: `0xd91f686eab4dcc51161a2da4c556c050c9446655ac37e1f3039b4b6a48f73275`
- Canonical entropy: `0x711557165c2feff11c00af44ae5ee604fda8b21b3531d7fb62825483b99fef3a`
- Funding: `0xacc3a571d94da4c73aa3227698f2c6c0291b7ab595bfb9a326964496740a9e37`
- Payout: `0xd3dd9969bb15b86f87c0e7385752438cdc5c612512a0e29437e0f461fdc48402`
- Payout block: 3640 (`0xe38`). Principal: 400 CKB; yield: 0.70133609 CKB.

These hashes identify this disposable run, not public testnet transactions.

## Verification

With `DAOWOW_RUN_ISOLATED_NODE=1 PYTHONPATH=tests/devnet`, the following focused
`python3 -m unittest ... -v` runs all exited zero:

| Test selection | Count | Duration |
| --- | ---: | ---: |
| `test_round_creation.RoundCreationTests.test_orphaned_entropy_rebuild_and_payout` | 1 | 232.646 s |
| `test_round_creation.RoundCreationTests.test_creation_entry_freeze_and_aggregation_history` | 1 | 205.905 s |
| `test_node_harness test_native_dao` | 8 | 108.055 s |

The new test first failed at its explicit missing-reorg assertion, then passed
with the branch-replacement implementation. Bounded Python/security review
approved the changes. No production contract or Rust exporter changed in this
checkpoint. The harness retains its pinned image, no external networking,
no host mounts, no published ports and exact-container cleanup.

## Remaining limits

- The orphan probe establishes dependency resolution, not direct rejection of
  a stale DAOWOW settlement witness. Actual funding afterward uses rebuilt data.
- Rebuilding is fixture code, not restart-safe production keeper tooling.
- No refund history or orphaned funding/payout transaction recovery is covered.
- One participant, one batch and MMR only; broader rounds, accumulators,
  maturity boundaries and maximum proof/resource cases remain open.
- Dummy PoW and the fixture's block-cycle limit are not testnet equivalence.
- No testnet node, wallet, deployment or funds were touched.

Implementation: `tests/devnet/reorg_history.py` and
`tests/devnet/test_round_creation.py`. See the
[harness instructions](../tests/devnet/README.md) and the prior
[canonical full-round report](validation-2026-09-14-full-round.md).
