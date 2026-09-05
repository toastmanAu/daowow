# DAOWOW Protocol v0.2 — Consolidated

## 1. Protocol purpose

DAOWOW pools participant CKB into the native Nervos DAO. Participant deposits create positional ticket entitlements. Principal remains attributable to its participant; realised DAO compensation becomes the Round Yield Pool and is distributed to winning positions according to immutable Round rules.

## 2. Round lifecycle

```text
CREATED
  -> OPEN
  -> ENTRY_SHARDS_FROZEN
  -> DAO_AGGREGATING
  -> ENTRY_SET_FINAL
  -> ENTROPY_FINALIZING
  -> DRAW_FINAL
  -> DAO_ACTIVE / DAO_WITHDRAWING
  -> DAO_FINALIZED
  -> SETTLING
  -> COMPLETE
```

Failure path before successful DAO aggregation:

```text
OPEN/CLOSED -> aggregation deadline missed -> REFUNDABLE
```

An Entry successfully consumed into DAO aggregation cannot also be refunded because CKB cells are single-use.

## 3. Round configuration

Immutable after creation:

```text
RoundConfigV1 {
  version
  round_id
  ticket_price_shannons
  minimum_tickets
  maximum_tickets_or_zero
  entry_start
  entry_end
  aggregation_deadline
  dao_term_periods
  entry_shard_count
  prize_schedule_hash
  entropy_scheme_id
  settlement_scheme_id
  fee_policy_hash
  keeper_policy_hash
  flags
}
```

The RoundConfigCell should be immutable during ordinary operation. Round status is derived from live cells and chain history rather than mutating one global Round state cell.

## 4. Ticket model

A ticket is a mathematical position, not necessarily a token.

```text
entry_principal = ticket_price * ticket_count
```

Accepted entries receive contiguous positions in a deterministic ordering. Splitting ownership between multiple entries must not increase aggregate probability relative to the same total number of tickets.

Recommended duplicate rule: one position may win at most once; one participant may win multiple prizes if they own multiple distinct winning positions.

## 5. Entry sharding

Use N fixed mutable EntryShardCells, initially benchmark 32.

Entry transaction:

```text
inputs:
  EntryShard[N]
  participant funding
outputs:
  updated EntryShard[N]
  EntryCell
  participant change
```

EntryShard state conceptually tracks:

```text
EntryShardDataV1 {
  version
  round_id
  shard_id
  sequence
  entry_count
  ticket_count
  principal_total
  accumulator_root
  state // OPEN or FROZEN
}
```

The accumulator must support efficient append/update and later membership proofs. Benchmark SMT, MMR and incremental binary Merkle approaches.

## 6. Entry Cell

```text
EntryDataV1 {
  version
  round_id
  shard_id
  participant_lock_hash
  ticket_count
  principal_shannons
  entry_nonce
  entropy_commitment
}
```

EntryLock permits only:

- valid consumption into the corresponding Round DAO aggregation path; or
- participant refund after an authorised failure condition.

No arbitrary operator output is valid.

## 7. Final accepted Entry universe

Critical invariant: draw entropy must not become knowable until the complete accepted DAO-participating Entry set is immutable.

The protocol cannot rely on an on-chain script globally scanning all historical cells. EntryShard accumulators exist to create a bounded, on-chain commitment to accepted Entry history.

All configured shards are frozen after entry close. DAO aggregation must be deterministically tied to those frozen commitments. If a cap exists, acceptance/exclusion rules must be deterministic.

## 8. DAO aggregation

Preferred atomic transaction:

```text
inputs:
  bounded set of valid EntryCells
  optional sponsor/keeper fee input
outputs:
  native Nervos DAO deposit cell
  BatchCommitmentCell
  change
```

The DAO deposit cell uses:

- native Nervos DAO type script;
- 8 zero bytes of cell data;
- DAOWOWDAOLock as the lock;
- compact lock args binding Round + batch identity.

No intermediary operator wallet is permitted.

## 9. DAO batches

A Round may have many DAO deposit batches. Each batch records or commits to:

```text
BatchDataV1 {
  round_id
  batch_id
  entry_count
  ticket_count
  principal_shannons
  entries_subroot
}
```

Actual deposit inclusion block/epoch is authoritative. Different batches can mature at different moments.

## 10. DAO withdrawal

Follow the native DAO exactly.

Phase one converts deposit cells to withdrawing cells. For a deposit input at index i, the corresponding withdrawing output must be at output index i, preserve capacity, retain native DAO type, and contain the deposit inclusion block number in 8-byte little-endian data.

DAOWOWDAOLock must prevent malicious lock substitution during phase one.

Phase two must satisfy native DAO header-dependency, witness and absolute-epoch `since` requirements. Native DAO compensation rules are authoritative.

## 11. Accounting

Use shannons / unsigned integers only.

```text
gross_withdrawal = sum(realised DAO batch value)
total_principal = sum(accepted principal liabilities)
gross_yield = gross_withdrawal - total_principal - explicit infrastructure adjustments
yield_pool = gross_yield - authorised costs
```

Settlement conservation:

```text
all settlement inputs
=
principal payouts
+ prize payouts
+ authorised keeper/protocol costs
+ tx fees
+ explicit remaining protocol capacity
```

No unexplained residual can be redirected to an operator.

## 12. Randomness

V0.2 candidate design combines participant commitments and predetermined future CKB block entropy.

Entry:

```text
commitment = H(secret || round_id || participant_context)
```

Missing reveal candidate fallback:

```text
H("DAOWOW_MISSING_REVEAL_V1" || commitment)
```

Future block offsets must be fixed before hashes are knowable. Chain entropy uses multiple predetermined block hashes. Final seed domain-separates Round, Entry root, ticket total, participant entropy and chain entropy.

This construction is not production-frozen until adversarially reviewed for last-revealer, withholding, reorg, grinding and transaction-delay attacks.

## 13. Positional draw

Use rejection sampling to avoid modulo bias.

```text
limit = floor(2^256 / N) * N
candidate = H(seed || prize_index || retry_counter)
if candidate >= limit: retry
position = candidate mod N
```

Duplicate already-winning positions retry deterministically.

All encoding, endianness and hash-domain strings must be frozen with test vectors.

## 14. Settlement

Prefer direct batched payouts over claim contracts for V1.

```text
SettlementShardFunding[N]
  -> participant ordinary CKB outputs
  -> remainder SettlementShardFunding[N]
```

Participant output:

```text
capacity = principal_return + prize - explicitly authorised cost
lock = participant committed lock
type = none (preferred where possible)
data = empty
```

Settlement shards allow parallel keepers and remove a single global payout bottleneck.

## 15. Protocol invariants

- principal cannot be prize money;
- no privileged custody path;
- every accepted Entry belongs to one Round and one EntryShard;
- an Entry can be consumed only once;
- Entry cannot both aggregate and refund;
- DAO batch principal equals backing accepted Entry principal;
- ticket positions are unique and exhaustive over `[0, total_tickets)`;
- entropy only begins after accepted Entry universe is immutable;
- draw is reproducible;
- payouts cannot exceed realised settlement funding;
- prize allocations cannot exceed Yield Pool;
- every Shannon is accounted for.
