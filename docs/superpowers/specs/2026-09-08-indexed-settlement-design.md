# Indexed settlement progression

User approved the immutable indexed liability tree in conversation.
This replaces the rejected compressed-SMT deletion proposal.

## State and proof rules

Funding uses `SettlementFundingDataV2`, exactly 112 bytes:
round ID at 0..32; LE u64 batch ID, realised total, principal liability and
prize pool at 32, 40, 48 and 56; LE u64 next-unpaid cursor at 64; LE u64
liability count at 72; immutable MMR root at 80..112.

The decoder rejects all other lengths, zero count and cursor greater than
count. Creation requires cursor zero. Updates keep identity, financial
totals, count and root immutable. Every payout proves `liability_leaf` at
the current cursor using the existing position-bound MMR verifier and the
immutable count. Increment the cursor once per verified and paid item with
checked arithmetic. Continuations must store exactly the resulting cursor,
strictly below count. Final consumption requires resulting cursor == count.

Keep strictly increasing participant keys within each batch, preventing
duplicate-output reuse. Canonical initial liability construction must sort
and consolidate participant liabilities; that construction is not yet
authenticated by the current creation path.

Keep the public funding lock, transaction-wide funding group isolation,
ordinary empty-data payout cells, actual occupied-capacity checks and exact
capacity conservation. No tree updates or deletion proofs are used.

## Compatibility and limits

This is a breaking data and witness change. Old 128-byte funding records and
SMT payout proofs are not accepted by the new implementation. Existing args
remain config commitment plus batch ID until ledger batch-digest wiring is
implemented. The confirmed deployment and manifests remain unchanged.

Initial entitlement/root authentication, reserve allocation, on-chain ledger
wiring, future entropy/draw authentication and node-level full-round tests
remain release blockers. Count bounds and ordered membership prevent skipping
an authenticated liability list; they cannot prove the initial list is valid.

## Verification targets

Reject skips at the first or an interior position, replay after progression,
mutated root/count/cursor, bad proofs, early finalisation and underoccupied
remainders. Preserve a valid six-participant round paid in two batches.
Codec tests reject malformed boundaries and legacy records. DAO routing
fixtures must use the new codec. Do not regenerate shared vectors implicitly;
updating generator source does not claim downstream builders are migrated.
