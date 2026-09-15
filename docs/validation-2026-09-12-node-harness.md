# Isolated node execution — 2026-09-12

Later same-day checkpoint: eight tests now pass, including a native DAO
maturity fixture. See [native DAO evidence](validation-2026-09-12-native-dao.md).
The six-test results and genesis below describe the earlier harness checkpoint.

Status: real-node harness and basic competing-branch reorg implemented.
DAOWOW full-round maturity/reorg validation is still incomplete.

Latest run: all six tests pass with Docker opt-in, including isolation and
cleanup assertions, two lifecycle-failure regressions, two transport checks,
mining and the competing-branch reorg. Log:
`/tmp/daowow-node-cleanup-live.log` (ephemeral). Ruff checks and formatting pass.
The reorg in this latest run replaced
`0x546c14e6138bfea0b53316835b5c01e4afc9c8a700591e7152edf0cbc84d6ebd`
and selected tip
`0x4f10c341787b0e0064b22ce44be882edbc64549583465fe6b3cf3e366745d9eb`.

Review identified a launch-timeout cleanup gap and cleanup-error masking.
The harness now persists a CID file before launch completes, validates the
exact ID before cleanup, accepts an exact already-removed-container response,
and preserves original failures when cleanup also fails. Both cleanup
regressions failed before these fixes and now pass.

`tests/devnet/node_harness.py` creates pinned, disposable, network-isolated
CKB nodes with no host mounts or published ports. `test_node_harness.py`
checks HTTP transport, mining and canonical reorganization. Reproduction and
isolation details are in `tests/devnet/README.md`.

Observed successful run (`/tmp/daowow-node-reorg-third.log`, ephemeral):

- Four tests passed: two transport checks, one mining check, one two-node reorg.
- Dev-chain genesis after target block-limit configuration:
  `0xea0593c5efdd2c5f8f66667aa41568390c790744ab9874f8f2e1ce869c3f26c1`.
- Replaced height-one block:
  `0x5e087ca8fdcaae5fa650a7a0ebaa70444fc874150659b3ab38261a9adcbdd26f`.
- Canonical three-block tip after submitting the competing branch:
  `0xa5a2ac05c31f74417e9aeca8587bb6f80a976191d0fcee8734ed013e2cff4107`.

Block hashes vary with generated timestamps. The test asserts the relationships
between observed hashes rather than pinning incidental block hashes.

Implementation findings:

- CKB init writes the spec before finishing configuration: the harness uses an
  explicit completion marker before reading generated configuration.
- This Docker setup cannot copy tmpfs files with `docker cp`; config updates
  use a small archive streamed through exec into the same tmpfs.
- `generate_block` accepts no parameters on this image. Distinct branch messages
  are set at init, using the required 0x-prefixed hexadecimal encoding.

Remaining authoritative evidence required:

1. Real native DAO deposits and withdrawals with rejection before maturity and
   acceptance at the valid boundary, including epoch fractions.
2. Full DAOWOW transaction history through shard creation, aggregation, seal,
   scheduled entropy, computed entitlements and payouts.
3. Orphaned seal/entropy dependency rejection, canonical rebuilding, and refund
   and payout liveness across a real competing-chain reorg.
4. Maximum valid sparse-proof combinations, separate from malformed-payload and
   64-liability VM cases already covered.

No historical testnet deployment, live node, wallet or signing material changed.
