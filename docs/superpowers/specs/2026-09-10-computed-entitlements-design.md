# Computed winners, initial entitlements and node validation

Date: 2026-09-10
Status: owner approved this implementation design on 2026-09-10, including
the 32-prize bound, short-ticket schedule truncation and failed-round remainder
ordering. Implementation is in progress; not audited, deployed, or release-ready.
Occurrences of "proposed" below describe the now-approved design choices.

## Approved outcome

Each independently maturing batch returns its depositors' full deposited
capacity and distributes only its actual native DAO yield to the same global
winners. Committed prize weights determine allocations; every rounding Shannon
goes to prize index zero for that batch. Failed rounds return yield
proportionally to depositors. Sponsors pay fees and additional occupied capacity
as contributions, never as claims against participant funds.

Existing closed shard ledgers remain the accepted-prefix authority. Preserve
excluded-entry refunds through shard-zero seal and entropy successors. Keep
the approved seal-relative entropy heights +64/+128/+192 and earliest
finalization +256; no optional reveals.

## Architecture and alternatives

Recommended: compute the global draw from the immutable canonical entropy cell
while creating each batch's settlement funding. Share one pure derivation and
one transaction-authentication implementation. No keeper-supplied root, winner,
or amount is authoritative merely because its witness decodes.

A separate persisted winner cell would avoid repeated derivation but adds a
new unique state transition, occupied capacity, and refund-successor handling.
One global funding cell would serialize independently maturing batches and
conflict with the approved payout policy. Neither is needed for this design.

### Schedule and universe

Proposed canonical schedule encoding: version byte `1`, count `u32` little
endian, followed by that many positive `u64` little-endian weights. Exact length
only; reject trailing bytes, zero weights, empty schedules and sum overflow.
Commitment is `H("DAOWOW_PRIZE_SCHEDULE_V1" || encoding)`, checked against
`RoundConfigV1.prize_schedule_hash`.

Proposed initial on-chain bound: at most 32 prizes, independently of the legacy
pure draw helper's larger limit. Validate the committed schedule when creating
the round config, before any entries can be accepted. This avoids a round
becoming unspendable later because its hidden schedule is invalid or too large.
The matching schedule must be available in a bounded creation witness and
again wherever derivation needs it. No keeper-selected fallback schedule.

For a successful round with fewer accepted tickets than scheduled prizes,
proposed behavior is to use the first `min(ticket_count, schedule_count)`
weights and normalize over those weights. This follows the existing prototype's
truncation behavior without treating the prototype as authenticated authority.
Success requires a nonzero accepted ticket total meeting `minimum_tickets`.
Below that threshold use failed-round entitlements, not an impossible draw.

Compute each shard's global offset by checked summation of **accepted** ticket
counts from the canonical entropy record's closed snapshots in shard-ID order.
Do not use frozen ticket totals, which can include unaggregated entries.

Proposed seed is
`H("DAOWOW_AUTHENTICATED_DRAW_V1" || cfg.commitment() || entropy_record.encode())`.
The exact record commits closed ledgers, fixed entry commitments through their
roots, actual seal inclusion, and the three authenticated header hashes.
No batch ID, batch yield, payout timing, witness ordering, or caller-provided
seed enters this derivation. Reuse the existing unbiased distinct-position
draw algorithm. A participant may own several distinct winning positions.

### Winner ownership

For each computed winning position, require its entry and frozen-accumulator
membership proof. Verify config/round/shard identity, canonical nonce-key or
MMR index as appropriate, `nonce < accepted_entries`, a positive ticket count,
checked local interval bounds inside `accepted_tickets`, and containment of
the computed position after adding the shard offset. Bind every entry field
through the existing canonical entry leaf.

Provide records in prize order, exactly one per computed position. Reusing an
entry for different winning tickets is legal; replacing the computed positions,
providing an excluded entry, omitting a winner, or supplying extra records is
not. The pure API documents that decoded entropy needs canonical-cell
authentication by its caller.

### Batch authentication and initial funding

At DAO phase 2, locate the matching canonical receipt and replay its digest
from the complete ordered batch entries and their actual committed deposit
capacities. Bound the list to 1–32 entries. Recompute all receipt fields,
not just the digest: first nonce, count, ticket count, ticket principal and
full input capacity. Check the batch shard/ordinal and complete nonce range
against the entropy snapshot's accepted batch/entry counts. The receipt type
establishes canonical aggregation provenance; arbitrary copied receipt data
does not.

Derive `realized_total` from the native DAO input/header calculation already
used by the DAO contract. Require `realized_total >= deposited_capacity`.
Principal liability is the sum of full deposited capacities; prize budget is
their difference. Keep exactly one matching settlement funding output for the
batch with capacity exactly equal to realized total, cursor zero and the
derived immutable amounts, MMR root and count.

Settlement creation must independently require the corresponding actual native
DAO withdrawal input with the configured enforcing DAO lock, matching batch
identity/digest and a valid phase-2 shape. Its input lock executes in the same
transaction. Share the initial-entitlement validation path rather than maintain
two divergent formulas. Reject standalone forged funding creation, missing
native DAO inputs, wrong scripts, duplicate output groups and cross-batch reuse.
Dependency loading must handle or explicitly reject dep groups without confusing
raw outpoint indices and expanded dependency indices.

### Complete liabilities

Start with one full-capacity principal contribution per batch entry. Add each
winner's batch prize allocation, including winners whose entries are in other
batches. Consolidate by participant lock hash with checked arithmetic; sort
strictly by that hash. Omit zero-total winner-only records. Build the existing
indexed MMR from `liability_leaf(hash, principal, prize)` and derive its count.
Require the sum of principal plus prize over the complete list to equal actual
realized total. At most 64 records precede consolidation under the proposed
32-entry/32-prize bounds.

For a failed round, consolidate capacities by participant first. Proposed
proportional rule: floor each participant's `yield * capacity / total_capacity`
using `u128`, then distribute remaining Shannons one each in ascending participant
lock-hash order. The remainder is smaller than the participant count. This is
deterministic, conserves yield, and does not depend on how one participant splits
their entries within the batch. No winner proofs are required in this branch.

### Settlement and sponsor contributions

For each authenticated liability, base owed is `principal + prize`, without
adding occupied capacity a second time. Require an ordinary, empty-data,
participant-locked output with capacity at least base owed and at least its
occupied capacity. Any excess is a sponsor contribution. Funding decreases by
base owed only; transaction-level capacity conservation forces excess and fees
to come from other inputs. Keep the existing one-funding-group-per-transaction
restriction to prevent one output discharging multiple funding groups.

No additions to funding capacity and no sponsor repayment liabilities are
introduced. Partial funding must still meet occupied capacity. If the next
partial remainder would be too small, pay the entire remaining tail atomically.
The bounded maximum tail must pass VM and node limits before this design is
considered live. Do not resolve a tail-cost failure by confiscating a remainder,
charging fees to funding, or silently dropping liability records.

## Implementation sequence

1. Pure schedule codec/commitment, accepted-universe offsets, seed, position and
   owner verification; failing tests before implementation.
2. Pure batch replay and successful/failed consolidated entitlement construction;
   root/count and exact conservation tests.
3. Round schedule validation, shared chain-context authentication, DAO phase-2
   and settlement creation wiring; adversarial VM tests at each boundary.
4. Correct payout accounting and sponsor contribution checks; partial/final-tail
   tests, duplicate claims, replay and cross-group attacks.
5. Measure maximum supported schedule, batch and final-tail fixtures across
   supported accumulators. Keep the optimized aggregation checkpoint protected.
6. Bounded Rust/security review, then isolated node harness and validation.

## Verification and completion gates

Pure tests must include fixed vectors; mutations of config, entropy, schedule,
batch capacity and winner ownership; excluded-prefix proofs; sparse/empty shards;
zero yield; multi-win participants; cross-batch winners; insufficient-ticket
rounds; rounding conservation and arithmetic boundaries. Changing only batch
identity/yield must not change the global winning positions.

VM tests must establish both creation boundaries reject forged roots/counts,
omitted or reordered entries, wrong receipts, creator-controlled substitutes,
duplicate identities and incorrect realized amounts. Exercise positive and
negative full-capacity payouts, sponsor gifts and atomic-tail liveness. Re-run
the existing core and targeted VM suites, release builds, no_std/default Clippy,
formatting and whitespace checks. Mock headers are not node evidence.

Use the digest-pinned cached CKB image recorded in
`../../validation-2026-09-10-devnet-preflight.md`. Keep all devnet traffic isolated
from the LAN testnet node; no public peering or publicly exposed debug RPC.
Record modified spec/genesis, target cycle/size limits, binary hashes and all
transaction fixtures. Devnet defaults alone are not target-limit validation.

Run real entry → aggregation → DAO deposit → withdrawal preparation → mature
withdrawal → initial entitlements → complete payout, plus excluded-entry refunds
and failed-round payouts. Assert rejection immediately before native DAO maturity
and entropy finalization boundaries, acceptance at valid boundaries, including
fractional epoch cases. Record actual headers/outpoints, capacities and fees.

Create competing branches with controlled mining and trigger real canonical
reorganization. Cover a removed seal inclusion, removed entropy headers, and
removed settlement/payout transactions. Assert orphaned dependencies fail on
the new branch, old transactions cannot authorize claims there, and keepers
rebuild from canonical state without skipping or duplicating canonical payouts.
Check refund liveness both before and after rebuilding. Report observations
separately from testnet PoW/randomness assurances.

Full completion requires implementation, bounded review, measured limits and
these real-node assertions. Environment preflight, VM-only tests, old code-cell
liveness or successful RPC connectivity do not satisfy that requirement. No
testnet deployment or wallet spending is authorized by this spec review alone.
