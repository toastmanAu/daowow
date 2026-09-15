# Claim NFT sub-project 2: ticket-indexed prizes and redemption

Date: 2026-09-16. Status: design for user review. Decisions recorded here were
made by the user on 2026-09-16: prizes are committed per batch as an MMR sorted
by ticket id; winner ownership proofs are dropped from funding creation; up to
32 claims may redeem from one batch in one transaction; a funding cell may be
drained only when its principal cursor is complete and every prize is redeemed.

Inputs: `2026-09-15-prize-only-claim-amendment.md`, the lifecycle design, and
sub-project 1 (`2026-09-16-claim-mint-transfer-design.md`), which shipped the
claim cell whose data is `PrizeRedemptionState`. Retirement and the memento
remain sub-project 3.

## Goal

A batch's prize yield is owed to winning tickets, not to entrant lock hashes.
The holder of a winning ticket's claim cell redeems that batch's prize once,
into their own lock, by one transaction that updates the claim's paid set and
the funding cell together. Principal and excluded-entry refunds keep their
existing participant-keyed paths, untouched by claims.

## Prize domain (pure core)

`InitialEntitlements::derive` splits the batch's realized capacity into two
authenticated domains.

**Principal domain** (unchanged structure): one `PayoutItem` per participant
lock hash, ascending, MMR-committed as `liabilities_root`/`liability_count`.
On a successful round every item's `prize` is zero. On a failed round the
batch yield is distributed pro rata by principal exactly as today, and the
prize domain is empty.

**Prize domain** (new, successful rounds only): for each drawn
`(prize_index, global_position)` from `ComputedDraw::positions()`:

- `ComputedDraw::locate(global_position) -> (shard_id, local_position)` maps
  through the sealed ledgers' accepted-ticket offsets;
- `ticket = ticket_id(commitment, shard_id, local_position)`;
- `amount = schedule.allocate(total_tickets, prize_pool)[prize_index]`;
- amounts of zero create no obligation and are skipped.

Prizes are sorted by ticket id ascending (draw positions are distinct, so
ticket ids are unique). `prize_leaf(ticket, amount) =
H("DAOWOW_PRIZE_LEAF_V1" ‖ ticket ‖ amount_u64_le)` is appended to an MMR;
`prize_root`/`prize_count` are committed in the funding cell.
`Σ principal liabilities + Σ prize amounts == realized_total` or derivation
fails. `InitialEntitlements::prizes()` exposes the sorted list.

Winner ownership proofs are gone: `EntitlementInput` loses `winners`,
`EntitlementWitness` version 2 drops the winners section, and
`ComputedDraw::verify_winners` and `WinnerProof` are removed with their tests.
A drawn position is accepted by construction: the draw universe is exactly the
closed ledgers' accepted tickets.

## Funding cell v3

`SettlementFundingDataV3`, 160 bytes, replaces V2 everywhere (the deployment is
prototype-only with no funded rounds, so no migration):

| Offset | Field |
| --- | --- |
| 0..112 | the eight V2 fields in V2 order |
| 112..120 | `prize_count` u64 LE |
| 120..152 | `prize_root` |
| 152..160 | `prize_paid` u64 LE |

Immutable across transitions: everything except `payout_cursor` and
`prize_paid`. Decode rejects `prize_paid > prize_pool` and
`(prize_count == 0) != (prize_root == 0)`. Capacity at creation still equals
`realized_total`, which now equals principal liabilities plus prize pool.

**Source identity** for a claim's paid set:
`prize_source(commitment, batch_id, digest) = H("DAOWOW_PRIZE_SOURCE_V1" ‖
commitment ‖ batch_id_u64_le ‖ digest)`, computed by both scripts from the
settlement type's 72-byte args. It is a logical batch identity, never an
outpoint, so funding-cell successors do not change it.

## Redemption witness

A new codec in `witness.rs`, placed in the funding input's witness slot:

```
0xFF ‖ u32 n (1..=32) ‖ n × {
  claim_input_index u32, payment_output_index u32,
  prize_index u64, amount u64,
  u32 mmr_len ‖ mmr_proof, u32 absence_len ‖ absence_proof }
```

The leading `0xFF` cannot collide with the payout witness, whose first byte is
a count of at most 128. Both proofs are bounded by the existing 8192-byte
budget. Strict decoding, no trailing bytes.

## Settlement-type: redemption mode

Dispatch on the witness's first byte: `0xFF` is redemption, anything else is
the existing payout path. In both modes the group shape, isolation (one
funding group per transaction) and public-lock checks are unchanged.

Redemption rules, with `before`/`after` the funding data:

1. All immutable fields equal; `after.payout_cursor == before.payout_cursor`;
   `after.prize_paid == before.prize_paid + Σ amounts` and
   `after.prize_paid <= prize_pool`.
2. Config is loaded by commitment from a cell dep (as creation does); the
   script must match `cfg.settlement_type`.
3. For each item, in order: `prize_index` strictly increasing; the input at
   `claim_input_index` has type `cfg.entry_shard_type` with 45-byte args, tag
   5, and `args[1..33] == commitment`; `ticket` is that args' ticket id;
   `mmr::verify_membership(prize_root, prize_count, prize_index,
   prize_leaf(ticket, amount), mmr_proof)` succeeds; an output with a
   byte-identical type script exists (the claim's successor); the output at
   `payment_output_index` has a lock byte-identical to the claim input's lock,
   no type, empty data, and capacity at least `amount` and at least its own
   occupied capacity. Claim input indexes and payment output indexes are each
   distinct within the transaction.
4. Conservation: `in_capacity == Σ amounts + new_funding_capacity`. Sponsor
   excess on payment outputs is not counted, as for payouts.
5. Final (no funding output) is allowed only when `payout_cursor ==
   liability_count` and the resulting `prize_paid == prize_pool`; the same
   completeness rule is added to the payout path's final case.

The settlement script does not verify the claim's paid-set transition; that
is the claim script's job. It does verify amount, membership, payee and
successor presence, so a claim-only or funding-only update cannot pay.

## Claim script: redemption mode

In the existing `(input, output)` branch, byte-identical data is a transfer.
Differing data now enters redemption instead of failing:

1. Both sides decode with the args' ticket; input and output locks are
   byte-identical (redemption never transfers).
2. Exactly one input carries a settlement type with 72-byte args whose
   `args[..32] == commitment`; its data decodes as V3 and supplies `round_id`
   so the config can be loaded by commitment from a cell dep. That input's
   type must match `cfg.settlement_type`, and this script must match
   `cfg.entry_shard_type`.
3. The witness at that input's index decodes as a redemption witness and has
   exactly one item whose `claim_input_index` is this claim's own input index
   (found by scanning inputs for this script's exact type).
4. `expected = input_state.record_verified_prize(prize_source(settlement
   args), item.amount, item.absence_proof)`; output data must equal
   `expected.encode()`.

Any failure is `CLAIM_ERROR_REDEEM -97`; a lock change during redemption is
`CLAIM_ERROR_TRANSITION`. Together the two scripts guarantee: the amount is
the committed prize for this ticket in this batch, it is paid to the claim's
current lock, and the claim records this source exactly once.

## Ripple

- `entitlements.rs`, `entitlement_witness.rs` (version 2), `computed_draw.rs`
  (`locate`, remove winners), `encoding.rs` (V3), `leaf.rs` (`prize_leaf`),
  `witness.rs` (redemption codec), `error.rs` (`CLAIM_ERROR_REDEEM -97`,
  `SETTLE_ERROR_REDEEM -77`), `gen_vectors.rs` and `tests/vectors/*.json`
  plus `apps/web/vectors.js` regeneration.
- `contracts-common/entitlements.rs` (no winners), `settlement-type`,
  `entry-shard-type/claim.rs`.
- Tests: `proto3_dao_lifecycle` fixtures (drop winner proofs, V3 decode),
  `proto4_settlement`, `security_entitlements`, the devnet example and Python
  harness (payout becomes principal-only and non-final; a redemption by the
  minted claim pays the prize and drains the cell).
- `apps/web/engine.js` still simulates prize payment to participants; it is a
  local model, recorded as a follow-up rather than changed here.

## Verification

Host: derive on success and failure with conservation and ordering asserted;
`locate` against multi-shard offsets; V3 codec including the two consistency
rejections; redemption witness codec bounds; prize leaf and source vectors
reproduced independently in Python; mutation probes on every new guard.

VM: a redemption fixture built on the phase-two history with claim cells
seeded for the batch's winning tickets. Accepted: one claim redeems its prize;
two claims of one holder redeem in one transaction; a claim transferred to a
new holder redeems into the new lock; principal payouts proceed unchanged,
then redemptions, then a final drain to zero. Rejected: redeeming the same
source twice; payment to any lock other than the claim's; wrong amount; wrong
prize index; forged membership proof; stale or corrupt absence proof; claim
successor missing; claim data updated without the funding input; funding
`prize_paid` advanced without a matching claim; two items sharing a payment
output; lock change inside a redemption; final drain with prizes unpaid;
final payout drain with prizes unpaid. Cycles measured for the 32-claim
redemption shape.

Devnet: the full-round history commits principal payout, claim redemption and
final drain on the isolated node.

## Out of scope

Retirement, memento issuance, non-winner claim recovery, unclaimed-prize
expiry, artwork, wallet display, the web entry quote and the local UI model.
