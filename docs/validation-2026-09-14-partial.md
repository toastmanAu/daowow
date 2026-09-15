# Isolated partial-acceptance history — 2026-09-14

The full-node fixture now appends two actual MMR entries for the same participant,
each with one 100 CKB ticket and 400 CKB full cell capacity. It freezes the
two-entry shard, initializes its ledger, and accepts only nonce 0 into a
400 CKB native DAO deposit plus authenticated receipt. Nonce 1 stays live.

The partially accepted ledger cannot close at the entry-end `since`; it closes
at the aggregation deadline. Its excluded entry then returns its entire
400 CKB to the participant. The accepted entry is already consumed, and its
DAO deposit and receipt remain live with unchanged capacity, scripts and data
after the refund.

The refund rejects when supplied nonce 0's proof instead of nonce 1's proof.
This is a membership-proof substitution check, not direct script-level proof
that a still-live accepted entry cannot refund: the accepted input has already
been consumed by real aggregation. The existing missing-authority/proof,
early-`since`, underpayment and nonordinary-output checks also execute.

## Verification

The test first failed because the two-entry fixture was absent. After adding
the exporter's explicit `partial` mode and the Python history branch, the
focused live test passed in **5.542 seconds**, exit zero:

```sh
DAOWOW_RUN_ISOLATED_NODE=1 PYTHONPATH=tests/devnet python3 -m unittest test_round_creation.RoundCreationTests.test_partial_acceptance_refunds_only_excluded_entry -v
```

- Aggregation: `0x9d876a9d851b5648fa1f953bc88a80e3affcd9d3dc8dae251a7062e050db2388`
- Excluded refund: `0x5cab925076c5c09fb2a4dfacd5b4b9ffb2b7b2f29cf35bad4537ad98397c3982`

These are disposable-chain identifiers, not public-testnet transactions.
Bounded Rust and Python/security reviews approved the fixture. Exporter build,
strict targeted Clippy, formatting and whitespace checks pass. No production
contract or testnet changes were needed.

The combined selection `test_node_harness`, canonical refund, refund-reorg and
partial-acceptance tests passed **10 tests in 23.271 seconds**. Default discovery
passes four unit tests and skips ten explicitly opt-in live tests.

## Limits

This covers two entries from one owner and one accepted batch, through excluded
refund only. It does not yet cover the accepted entry's eventual payout in this
partial round, multiple owners/batches, other accumulators, or combined partial
history/reorg recovery. Production keeper persistence and the earlier Docker
RPC timeout reliability issue remain open. The complete live suite was not
rerun in this checkpoint.

See [harness instructions](../tests/devnet/README.md).
