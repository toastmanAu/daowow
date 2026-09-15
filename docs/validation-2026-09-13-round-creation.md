# Real DAOWOW creation — 2026-09-13

The isolated CKB node now commits a real DAOWOW round-creation transaction
with both configured empty MMR shards. This is the first protocol-history
step, not evidence for complete aggregation, entropy, entitlements or payout
history.

Verification: all nine tests passed with Docker opt-in in 112.439 seconds
(`/tmp/daowow-2026-09-13-node-full.log`, ephemeral): four unit tests and five
live-node tests, including the native DAO maturity and competing-branch reorg
regressions. Default runs pass four unit tests and skip the five live tests.
Strict exporter Clippy, Rust formatting, Python lint/format and whitespace
checks pass. No production contract source changed in this checkpoint.

Implementation:

- The optional DAOWOW node fixture loads all five built contract binaries
  into disposable genesis cells. Fixed paths and archive names, no host
  mounts, no external networking, no wallet keys and exact-ID cleanup remain.
- `tests/integration/examples/devnet_round.rs` uses the Rust protocol
  encoders for configuration, initial shard data and committed prize schedule.
  The round ID is derived from the actual funding input and config output zero.
- `tests/devnet/test_round_creation.py` constructs the RPC transaction around
  those bytes. It verifies rejection with a missing shard (returning its
  capacity to change) or a missing schedule witness, then commits the valid
  transaction and checks all three protocol outputs byte-for-byte.

The first successful creation run committed at block four:
`0x2ad01f7987b1f10a7ac9a8c656ea0e75cfe4e3adf7a35c53fd33a66afe8b837e`.
Block/transaction hashes are observations, not hardcoded expected values.

All six RISC-V binaries (five protocol contracts plus fixture lock) build
offline. Reproduction commands are in [the harness README](../tests/devnet/README.md).
Do not use workspace-wide host `cargo test`: no-main CKB executables collide
with the host test entry point. Use named VM tests or the host exporter target.

Bounded Rust and Python/container reviews approved the exporter, fixture and test. Native DAO
fixture review is also now approved; its earlier usage-limit gap is closed.

Remaining protocol-history work: entry creation, freeze/aggregation, round
seal, scheduled entropy, computed initial funding and payouts on the node,
then orphan/rebuild/refund and payout checks across actual competing branches.
No testnet broadcast or change to funded-round readiness is claimed.
