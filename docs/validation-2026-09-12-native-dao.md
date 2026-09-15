# Native DAO isolated-node validation — 2026-09-12

Scope: native DAO history using disposable fixture funds, not DAOWOW contract
history or a testnet deployment. The full funded-round readiness gate remains
open.

Verification: all eight tests passed with Docker opt-in in 112.356 seconds
(`/tmp/daowow-native-dao-full.log`, ephemeral). Four are unit tests and four
exercise live isolated nodes. Ruff lint/format and whitespace checks pass.
Without Docker opt-in, four unit tests pass and four live tests are skipped.

Observed native DAO fixture: deposit epoch 0 + 4/10, preparation epoch
0 + 8/10, submission boundary 180 + 4/10, committed payout at block 1808.
Compensation was 7,236,152 Shannons before the 100,000-Shannon payout fee.
The current fixture genesis is
`0xeb24a1b92046119f7437e56f966fff54326cab6599949f57fac5d7f002acb077`.
The same run also passed the existing actual competing-branch reorg test;
that reorg test still contains no DAOWOW transactions.

The harness adds a locally built `smoke-minimal` always-success code cell and
100,000 CKB of fixture capacity to its generated dev genesis. This is not a
production lock and is never used with the owner's wallet or live node.
The fixture ELF SHA-256 for this checkpoint is
`411977164cc01675a75c88a5e528c96cdd3a3362b0c3aa523a9cf49de893e842`.
The spendability regression first failed because the genesis fixture was
absent, then passed after the fixture was added.

The native DAO test:

1. Commits a 10,000 CKB deposit and a withdrawal-preparation transaction.
2. Checks that the withdrawing cell retains the full deposited capacity and
   stores the actual deposit block number.
3. Computes compensation from the two committed headers' accumulated rates,
   with 95 CKB occupied capacity for this exact fixture layout.
4. Checks `Immature` rejection immediately and one block-fraction before the
   180-epoch maturity boundary. The deposit fraction must be nonzero and the
   test explicitly requires the preceding-fraction check to execute.
5. Submits at the exact maturity fraction, then mines through the transaction
   proposal window and checks the committed payout amount, exact spending
   input, and that the withdrawing cell is no longer live.

`passthrough` disables the transaction-pool output-policy validator; native
scripts and consensus validation still run. Acceptance is checked by actual
block commitment, not merely an RPC submission result.

The first maturity run reached the committed payout but failed a final test
assumption: `get_live_cell` returned `unknown` for the consumed cell, not
`dead`. The corrected check accepts either non-live status and additionally
asserts the exact input in the committed spending transaction.

Reproduction: see [the harness README](../tests/devnet/README.md). Default
unit-test runs skip Docker tests; explicit opt-in is required.

Review status: the prior transport/container cleanup changes passed bounded
review. The initially usage-limited review was retried on 2026-09-13 and
approved the genesis fixture and DAO history without blocking findings.
The reviewer ran unit/lint gates and inspected live evidence; it did not
independently rerun the Docker maturity test.

Still required:

- More native DAO cases: differing epoch lengths and withdrawal periods.
- Full DAOWOW history from configuration and shards through aggregation,
  seal, scheduled entropy, initial entitlements and payouts.
- Actual competing-chain orphaned seal/entropy rejection, canonical rebuilding
  and refund/payout liveness using DAOWOW transactions.
- Maximum valid sparse-proof resource cases and new-ABI operational tooling.

No testnet broadcast, live-node mutation, wallet access or deployment occurred.
