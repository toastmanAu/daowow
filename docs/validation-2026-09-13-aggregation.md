# Full-node history through aggregation — 2026-09-13

The isolated CKB fixture now progresses through actual round/shard creation,
one MMR entry, freezing both shards, initializing the authoritative ledger,
and atomically consuming the entry into a native DAO deposit and receipt.
Later protocol stages and funded-round readiness remain unverified.

The entry has 100 CKB ticket principal and 400 CKB actual deposited capacity.
The DAO output receives all 400 CKB; separate sponsor change pays receipt
capacity and fees. Tests check exact live ledger, DAO and receipt cells.
Missing shards/schedule, a corrupt accumulator root, premature freeze and a
one-Shannon-short DAO deposit reject. The short-deposit mutation returns the
Shannon to change, preserving transaction-wide capacity.

Two issues were exposed and repaired:

1. `config_by_commitment` allocated every dependency's data while searching.
   Putting 564 KiB of code dependencies before the config exhausted the
   512-KiB non-reclaiming heap; entry append failed with script error -1.
   The helper now reads a fixed 358-byte stack buffer, skips non-config-sized
   cells and retains full configuration authentication. The unchanged
   dependency ordering now passes entry and aggregation validation.
2. The exporter used the consensus DAO code reference where the protocol
   config requires the complete DAO type-script hash. Aggregation rejected
   with shard error -28. The exporter now hashes the packed native DAO script
   with type hash mode and empty args. Contract DAO semantics are unchanged.

The successful focused run committed creation at block 4, both frozen shards
at block 24, and aggregation at block 32:
`0xd2d97b52b38ea1b06922b436da2a9a1f5aced36d8f648cf92bf5c700b93c5a18`.
Hashes are observations, not hardcoded test expectations.

Rust review approved the bounded scan and canonical exporter; Python review
approved the history fixture. All five protocol binaries were rebuilt.
These binary changes have **not** been deployed to testnet.

Verification so far: 96 core tests and 93 named security/lifecycle VM tests
pass with the rebuilt binaries. Strict shared-helper/exporter Clippy, Python
lint/format and whitespace checks pass. Reproduction uses the build and
Docker-opt-in commands in [the harness README](../tests/devnet/README.md).

The complete nine-test Docker-opt-in suite passed in 119.654 seconds,
including the native DAO maturity and basic competing-branch reorg regressions
(`/tmp/daowow-2026-09-13-aggregation-node.log`, ephemeral). The history test was
subsequently renamed to describe its expanded coverage; behavior is unchanged.

The broad integration-package run also exposed legacy smoke-test issues:
an external `/tmp/template-contract` prerequisite, an unbuilt `smoke-alloc`,
and an obsolete expectation that `round-type` acts as an always-success lock.
Those smoke tests are not part of the 93 named security/lifecycle VM gate;
no all-package-green claim is made. An initially missing accumulator benchmark
binary was built, and that benchmark test then passed.

Next in the approved order: close ledgers, seal the round, authenticate
scheduled entropy, perform native DAO withdrawals and create/pay computed
entitlements on the same history. After that come DAOWOW-specific reorg and
liveness tests, broader edge cases, operational tooling, and testnet rollout.
