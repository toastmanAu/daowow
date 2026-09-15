# Complete isolated partial round — 2026-09-15

Result: the actual two-entry, one-participant MMR history now completes through
final payout after refunding its excluded entry.

The fixture accepts nonce 0 into a 400 CKB DAO deposit and refunds excluded
nonce 1 in full after deadline closure. It then consumes only refund sponsor
change to continue, closes the empty shard, and seals using the populated
ledger already closed for refund authorization. Actual scheduled headers
authenticate entropy for this two-entry frozen history and one-entry accepted
prefix.

After the configured DAO term and native maturity, canonical computed funding
commits and is consumed into a full ordinary participant payout:

- Accepted principal: **400 CKB**.
- Actual DAO yield: **0.70133609 CKB**.
- Separate excluded-entry refund: **400 CKB**, still live and unchanged.

Final assertions verify the refund's exact output and empty data, the accepted
payout amount, and consumption of the DAO deposit, withdrawing cell and funding
cell. The earlier negative checks remain active: invalid aggregation amount,
premature closure/refund, proof substitution, missing authority/proof,
nonordinary refund, incorrect entropy, shortened term/missing receipt, forged
funding root and one-Shannon payout underpayment.

## Verification

The new test first failed after the existing refund history at the explicit
missing-continuation assertion. With the continuation implemented, this command
passed in **210.638 seconds**, exit zero:

```sh
DAOWOW_RUN_ISOLATED_NODE=1 PYTHONPATH=tests/devnet python3 -m unittest test_round_creation.RoundCreationTests.test_partial_round_completes_payout -v
```

Disposable-chain run identifiers:

- Refund: `0x5cab925076c5c09fb2a4dfacd5b4b9ffb2b7b2f29cf35bad4537ad98397c3982`
- Funding: `0xc53de6872e8f0373b813d3519d42c1dfe5249eac87189cbc15067152d3a3ce4c`
- Payout: `0xb5dff15d52db3e0db52dbf7f58c41f582743775d4f4300ca49950db57712060e`
- Payout block: 3640 (`0xe38`).

Ten focused harness, canonical-refund, refund-reorg and short partial-history
regressions also passed in **22.019 seconds**. Bounded Rust and Python/security
reviews approved the changes. Exporter build/strict targeted Clippy, Ruff and
formatting/whitespace checks pass. Default discovery has four passing unit tests
and eleven opt-in skips. The complete 15-test live suite was not run here.

## Scope and remaining work

This is a completed **isolated fixture**, not a public deployment. No production
contract, testnet node, wallet or funds changed. The exporter now accepts a
trailing `partial` flag for initial, entropy and funding output modes; the refund
helper returns the actual successor outpoints needed for continuation.

Coverage remains one owner, two entries, one accepted batch and MMR. Multiple
owners/batches, other accumulators, combined partial-round/reorg scenarios,
maximum resource cases and production keeper persistence remain open. The
previous Docker mining timeout remains a separate reliability issue; this run
did not encounter it. Dummy PoW and the dev-chain cycle limit do not establish
testnet-consensus equivalence.

See [harness instructions](../tests/devnet/README.md) and the prior
[partial-refund checkpoint](validation-2026-09-14-partial.md).
