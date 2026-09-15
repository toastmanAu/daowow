# Transferable ticket claims: lifecycle design

> Ownership amendment: read `2026-09-15-prize-only-claim-amendment.md` first.
> This document preserves the earlier all-rights draft for traceability. Its
> principal/refund transfer and optional-souvenir provisions are superseded:
> only prize rights transfer; depositor principal remains independent; final
> winning redemption must issue a non-redeemable memento.

Date: 2026-09-15. Incremental redemption is approved product direction.
Status: lifecycle approved by the user; not an implemented contract or
approval of an NFT standard, encoding, deployment or financial parameters.

## Scope and existing mismatch

Replace original-participant payout authority with the current holder of one
unique NFT per ticket. Preserve fixed ticket identity, canonical entry/shard
aggregation, authenticated entropy, deterministic winners and full-capacity
conservation. Preserve the landing page's existing design.

The existing `EntryDataV1` combines multiple positional tickets under one
participant lock hash. `InitialEntitlements::derive` consolidates per-batch
payments by participant hash. The new model must instead authenticate obligations
by immutable ticket identity and authorize their discharge using the live NFT.
Old contracts and tests remain useful baselines, not evidence of this feature.

## Claim lifecycle

1. **Mint:** entry issuance atomically creates one unique claim per ticket under
   the entrant's wallet lock. Identity binds the config commitment, shard and
   shard-local ticket position. Minting without the matching canonical append,
   duplicates within a transaction, and reminting a consumed identity fail.
2. **Transfer:** the holder spends the claim cell and recreates exactly one
   successor under a recipient lock. Identity, artwork commitment and all paid
   state remain unchanged. Transfers may occur before/after freezing, draw or
   funding and do not alter ticket eligibility or randomness.
3. **Redeem a portion:** the holder spends the NFT together with authenticated
   funding/refund state. The transaction pays the verified amount to the input
   holder's lock, updates both obligation accounting and NFT paid state, and
   recreates the NFT under that same lock while obligations remain.
4. **Transfer after partial redemption:** the recipient receives remaining rights
   only. Already-paid amounts cannot reset or become claimable again. The UI
   shows redeemed and unpaid amounts separately, plus amounts not yet known.
5. **Retire:** consume the financial NFT only with proof that no present or
   future protocol obligation remains. An optional souvenir is a different,
   non-financial identity and cannot authenticate another withdrawal.

For the first implementation, transfer and redemption are distinct transaction
modes. A redemption does not also transfer its successor or redirect its payment
to an arbitrary witness-specified lock. A separate ordinary transfer remains
available. This simplifies authorization and makes the receiver of each payment
unambiguous.

## Financial obligations and completeness

An obligation is identified by ticket, canonical source and obligation kind,
not the holder's mutable address. Sources include the accepted entry's native
DAO batch, other batches contributing winning yield, or the excluded entry's
refund funding. Each obligation is discharged at most once.

A winning ticket may be owed growth from several DAO batches. Paying its own
principal or one prize installment is not proof of completion. The canonical
closed ledgers and authenticated outcome define the complete source universe;
an absent or not-yet-mature funding cell is not evidence of zero liability.

The detailed contract design must authenticate paid-state transitions and the
complete source universe with bounded proofs. Neither burning on first payout
nor gathering every source into an unbounded transaction is permitted. A holder
must not need another ticket holder's signature to redeem its own due portion.

Excluded entries need a corresponding bounded refund allocation path: tickets
from one original entry may have different holders. Consuming that shared entry
must create or pay all liabilities exactly, never refund its whole capacity to
one ticket holder. An excluded claim has no accepted-ticket prize rights.

Allocate shared entry overhead and failed-round yield deterministically by
immutable ticket identity. All portions must sum to actual source capacity;
rounding cannot change with address transfers, redemption order or transaction
grouping. NFT cell capacity is separate from pooled source capacity and is
returned or retained explicitly, never double-counted as principal.

## Authentication and safety invariants

- The live claim cell is the authority; a screenshot, metadata document or old
  ownership proof cannot authorize redemption.
- Claim identity and immutable metadata survive every permitted transition.
- All consumed claims have one valid successor or a proven terminal discharge.
  There is no arbitrary burn path that bypasses obligation accounting.
- The current input holder's wallet lock authorizes transfer/redemption.
- A payment is bound to the same ticket/source obligation whose paid state
  changes. Updates to only the NFT or only the funding side fail.
- Amounts and eligibility derive from authenticated chain state. The owner
  cannot choose a prize amount, source universe, winner position or principal.
- Transfer and redemption spending the same live NFT conflict; only the
  canonical transaction determines ownership and outstanding rights.
- Recover state after a reorg from canonical outpoints, not local irreversible
  claimed flags. An orphaned payment cannot remain marked paid.

## Wallet and artwork behavior

The default DAOWOW template renders deterministic procedural variations from
the immutable ticket identity and a committed template version. Appearance is
decorative and independent of draw randomness. No remote mutable image is an
ownership proof. Present entry acceptance, maturity, winning status and remaining
claim value as separately verified live data.

Use distinct states for submitted, confirmed, accepted, excluded/refundable,
awaiting maturity, claimable, partially redeemed, transferred and redeemed.
Confirmation does not imply aggregation acceptance. Display unknown future
yield as unknown, not as zero or a guaranteed estimate.

NFT interoperability and ordinary wallet display require explicit integration
testing after choosing an implementation. This design does not assume that any
existing NFT standard permits the required paid-state and retirement rules.

## Verification gates

Pure-model tests must prove conservation, deterministic allocation and legal
state transitions for many tickets, owners and sources. VM tests must reject
forged mints, stale owners, identity substitution, state reset, duplicate claims,
incorrect funding updates and premature retirement. Full-node histories must
exercise transfer before/after draw, partial redemption then transfer, separate
holders refunding a shared entry, conflicting spends and reorg recovery.

Measure proof size, occupied capacity and cycles at supported limits. Verify
bounded progress without requiring a global all-ticket transaction. Rehearse
both native DAO durations with real maturity evidence before public readiness.

## Next design boundary

After lifecycle review, specify the concrete claim codec and uniqueness rule,
paid-state proof structure, ticket-indexed funding transitions and refund
allocation format. Then write a tests-first implementation plan. The remaining
beta cap, minimum, payout and entry-window decisions remain separate; this
approval does not supply values for them or alter the launch gate.
