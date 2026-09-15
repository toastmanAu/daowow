# Isolated excluded-entry refund — 2026-09-14

The full node now validates a real one-entry MMR refund history. It creates the
round and two shards, appends an entry, freezes the shards, initializes the
populated ledger, and deliberately accepts no entries into DAO aggregation.

Closure with the configured deadline `since` rejects while immature. After
epoch four, using the earlier entry-end `since` still rejects at script
validation. Valid deadline closure commits, authorizing the excluded entry's
refund using its membership proof against the frozen shard.

The participant receives the full **400 CKB entry-cell capacity**, not merely
the 100 CKB ticket principal. The fixture funds fees separately and changes
the sponsor output's lock identity so change cannot mask a short refund.

Five refund mutations reject at script validation:

- Missing closed-ledger dependency.
- `since` earlier than the aggregation deadline.
- One-Shannon underpayment, with that Shannon returned to sponsor change.
- Missing entry membership proof.
- Nonempty refund output data.

The valid refund commits and its ordinary output is live with exactly 400 CKB,
the participant lock and empty data. The original entry is no longer live;
the committed transaction's inputs are also checked.

## Verification

The new test first failed because the canonical refund export was absent.
After adding the bounded exporter fields and refund fixture, this command
passed in **4.724 seconds**:

```sh
DAOWOW_RUN_ISOLATED_NODE=1 PYTHONPATH=tests/devnet python3 -m unittest test_round_creation.RoundCreationTests.test_excluded_entry_refund_after_deadline -v
```

Refund transaction:
`0x2ab7d61d04de970b8d9d6905510f4b107102440308c2625a85e7f53660675a33`
at block 48 (`0x30`) of the disposable chain, not public testnet.

Ruff lint/format, exporter build, strict targeted Clippy, Rust formatting and
whitespace checks pass. Default unittest discovery passes four unit tests and
explicitly skips seven Docker tests. Bounded Rust and Python/security reviews
approved the changes. No production contract changes were needed.

The complete opt-in discovery run executed 11 tests in 559.291 seconds:
10 passed, including the refund and entropy-reorg payout histories, but the
canonical history hit a 10-second Docker RPC subprocess timeout during
`generate_block` at final maturity. It did not report a contract rejection.
An unchanged focused rerun of the canonical history passed in 205.827 seconds,
including computed funding and final payout. Every test therefore has a passing
run with these changes, but the single full-suite run was **not green**. The
intermittent transport/mining timeout remains a harness reliability gap; its
underlying cause has not been established. No retries or relaxed assertions
were introduced to mask it.

## Limits and next work

This establishes one excluded-entry refund path, not all failed-round behavior.
Refund reorg recovery, orphaned funding/payout recovery, multiple participants,
partially accepted batches, other accumulators and broader maturity/proof cases
remain open. No precise mempool admission cutoff is claimed. There is no
production keeper or public-testnet deployment in this change.

Implementation: `tests/devnet/refund_history.py`, the refund branch in
`tests/devnet/test_round_creation.py`, and the additive refund fields in
`tests/integration/examples/devnet_round.rs`. See the
[harness instructions](../tests/devnet/README.md).
