# Authoritative shard aggregation ledger

Date: 2026-09-07. Architecture approved in conversation: reuse canonical
shard cells as the aggregation authority. The user approved this written
specification in conversation. It is not an implemented security claim.

## Scope and release boundary

Connect actual entry inputs to the accepted-prefix ledger, authenticated
batch receipts and native DAO deposits. Close the ledger irreversibly and
make excluded entries refundable. Preserve sharding and permissionless
progression. No new standalone ledger contract is required.

The subsequent universe seal, future-header verification, draw and derived
settlement liabilities are separate work. Completing this specification does
not authorize funded rounds. The old settlement root trust boundary remains
a release blocker. No deployment, wallet operation or historical manifest
replacement is part of this work.

## Authority and script modes

Keep the canonical shard type args: config commitment (32 bytes), shard ID
(LE u32). Atomic round creation remains the only origin of each shard.
Every transition consumes exactly one cell and recreates exactly one cell
with this same type. Destruction, replacement and duplicate creation fail.

Use the entry-shard implementation in three disjoint modes:

- 36-byte args: canonical shard type.
- One-byte args `00`: public lock. Every group input must carry a type using
  the same code hash/hash type in a recognized enforcing type mode. Reject
  empty groups, missing types, unknown args and use of `00` as a type.
- 77-byte args: `02 || config_commitment[32] || shard_id[u32] ||
  batch_id[u64] || digest[32]`, the batch receipt type.

Shard creation and every transition require the public lock. This removes
creator-signature dependencies, including for freeze and timeout closure.
Receipt cells use the same public lock; their type forbids spending in this
stage. Their sponsor-funded capacity therefore stays reserved. Receipt
reclamation requires a separately reviewed successor rule, not a bypass.

## State encoding and transitions

OPEN and FROZEN retain the 101-byte EntryShardDataV1 encoding. Add a distinct
207-byte AggregationStateV2 encoding, in this exact order:

| Field | Bytes |
| --- | ---: |
| Version, exactly 2 | 1 |
| Original FROZEN EntryShardDataV1 | 101 |
| Config commitment | 32 |
| Accepted entries, tickets, principal, full capacity: four LE u64s | 32 |
| Number of accepted batches: LE u64 | 8 |
| Batch hash-chain root | 32 |
| Closed flag, exactly 0 or 1 | 1 |

Decoding rejects unknown versions, flags, truncation and trailing bytes.
Configuration, frozen identity/root/counters and accepted counters are
validated before use; counters use checked arithmetic. No caller may
construct trusted state by accepting arbitrary witness bytes.

Transitions:

1. OPEN append and OPEN-to-FROZEN retain existing membership and freeze
   rules. A deadline alone is not claimed to prevent late appends.
2. FROZEN-to-ledger initializes exactly `AggregationState::new`, with zero
   accepted batches and `closed = false`. No entries are consumed here.
3. Open ledger-to-open ledger accepts exactly one nonempty batch.
4. Open ledger-to-closed ledger preserves all counters and commitments.
   Complete acceptance permits closure at entry_end; otherwise closure
   requires aggregation_deadline. Validate absolute epoch `since` on the
   consumed shard input. No entries are consumed in a closure transaction.
5. Closed ledger-to-identical closed ledger is permitted for future
   coordination; any capacity decrease, mutation or reopening fails.

Shard capacity cannot decrease. Sponsors pay any increase needed for the
larger state, receipt capacity and transaction fees. Entry funds cannot pay
these costs. An empty shard can initialize and close normally.

## Atomic aggregation

For the first implementation, an aggregation transaction advances exactly
one canonical shard and contains no other DAOWOW entry configuration or
shard. Different shards remain independently usable in separate transactions.
Refunds and aggregation cannot be mixed in one transaction.

The shard input's raw witness is `02 || count[u32]`, followed by count
records `absolute_input_index[u32] || proof_length[u32] || proof_bytes`.
Count is 1..32; records are in increasing entry nonce order. Duplicate
indices, invalid lengths and trailing bytes fail. Entries and capacities
are loaded from the indexed transaction inputs, never supplied as trusted
witness values. Existing accumulator proof verifiers authenticate each leaf
against the immutable frozen root.

The indexed set must equal the complete set of entry inputs for this
transaction. Validate each entry lock's implementation, participant/config
args, absence of type, round/shard identity, data and capacity. The core
accepted-prefix rule rejects skipped or replayed nonces, wrong position
bases and counter overflow. The resulting output state must exactly equal
the computed state, with accepted batch count incremented by one.

Batch ID is `(shard_id << 56) | prior_accepted_batch_count`. Require shard ID
below 256 and prior batch count below 2^56; reject overflow. This preserves
the existing u64 batch ID field without collisions between shards.
The digest remains the existing core commitment to config, shard, ordered
full EntryDataV1 records and each actual full input capacity.

The same transaction must create exactly one matching batch receipt and
exactly one matching native DAO deposit:

- Receipt data: version byte 2, then digest[32], first_nonce[u64],
  entry_count[u64], ticket_count[u64], principal[u64], input_capacity[u64].
  Total 73 bytes. Fields equal the computed BatchCommitment.
- DAO lock args: the existing 72-byte round/batch/config prefix, followed
  by digest[32], for exactly 104 bytes.
- DAO type hash equals the configured full native DAO script hash; data is
  exactly eight zero bytes; capacity equals the sum of entry input capacities.

No second output with the same DAO lock is allowed. No sponsor top-up is
silently included in the deposit. Receipt creation independently requires
the canonical shard input/output and validates the same computed batch;
copying config data or supplying a shard dependency is insufficient.
Prefer a shared validation helper so both type modes enforce identical rules.

Every entry lock's aggregation path requires the consumed canonical shard
and inclusion of that exact input index in its validated aggregation
witness. A frozen dependency and plausible DAO output are no longer enough.

## Refunds and terminal state

After aggregation_deadline, an entry refund requires an authenticated closed
ledger dependency for its own config/shard. Verify membership in the frozen
root and require entry_nonce >= accepted_entries. Keep full-capacity return,
ordinary empty-data participant outputs and cross-config repayment accounting.
All inputs in a participant lock group must independently satisfy these rules.

Anyone can freeze a remaining OPEN shard, initialize its ledger and close it
after the deadline, including if no keeper aggregated anything. No privileged
signature may be needed. A refund cannot itself remove an entry that the
ledger could later accept: acceptance after closure is forbidden.

Closed ledgers remain live in this stage. The later universe-seal design must
preserve their availability for refunds or provide an authenticated successor
proof before permitting their destruction. A seal implementation cannot
silently strand excluded entries by consuming the only refund authority.

## Downstream compatibility

DAO phase one preserves all 104 args, native DAO type, capacity and configured
term. It additionally authenticates the receipt dependency and requires the
deposit input's creating transaction hash to equal the receipt's creating
transaction hash. This distinguishes the actual atomic deposit from a copied
lock script on an independently created cell.

DAO phase two propagates the digest into settlement args:
`config_commitment[32] || batch_id[u64] || digest[32]` (72 bytes).
The settlement public lock recognizes this enforcing type mode. Existing
exact realised-capacity routing and payout conservation remain mandatory.
Do not retain a legacy 72-byte DAO or 40-byte settlement fallback in newly
built contracts. Existing deployed binaries and their manifests are untouched.

Digest propagation is identity binding, not entitlement authentication.
Standalone settlement creation and its liability root still require the
subsequent verified draw/finalisation work. Neither a batch receipt nor a
passing payout membership proof is proof of the whole accepted universe.

## Verification and implementation boundaries

Core codec and transition tests cover exact round trips, invalid encodings,
batch ID limits, counters, closure and immutable frozen metadata. VM tests
must execute shard, entry and receipt scripts together, not substitute an
always-success script for any authority under test.

Required VM cases: consecutive batches by different participants; fake shard
dependency; skipped/replayed entries; duplicate or omitted input indices;
extra entry inputs; wrong config/shard; forged membership; wrong digest,
batch ID or receipt; copied deposit provenance; diverted capacity; wrong DAO
type/data; early close; empty shard; no-keeper timeout/refund; accepted-entry
refund; closed-state reopening; public-lock/type confusion; shard capacity
drain; and same-participant cross-config shared repayment.

Update `lifecycle.rs`, `witness.rs`, shared contract helpers, entry-shard-type,
entry-lock, DAO-lock, settlement-type and the integration builders together.
Keep lifecycle contract logic in a separate source module from append logic.
Round-creation fixtures adopt the canonical public shard lock. Legacy positive
aggregation/refund fixtures must be rebuilt around real ledger transitions.

Run existing security suites, all contract builds, strict Clippy, formatting,
and cycle/size measurements for the maximum batch. Verify occupied capacities
and the real native DAO lifecycle on a node before claiming deployability.
Independent semantic review of the existing repairs remains a prerequisite
to on-chain implementation under the security-closure plan; the earlier
quota-limited review did not satisfy it. No review approval is inferred from
unit tests or lint. Excessive proof/receipt costs trigger redesign, not a
claim that bounded entry count alone proves transaction feasibility.
