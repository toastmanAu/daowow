# Settlement remaining-liabilities design

Status: user directed continuation with the recommended approach on 2026-09-08.
Resolves the reviewed cursor-skipping
griefing defect, not the separate initial-entitlement authentication gap.

## Rejected after semantic review

The implementation described below was tested, then removed from production
after review identified a compressed-SMT proof representation ambiguity.
`Q` (compressed sibling) can be replaced by `P` (its hash) without changing
membership verification against the original root. Replaying these proofs
with zero produces different roots. Thus membership does not authenticate a
canonical deletion transition. A core regression reproduces this behavior:
`equivalent_membership_encodings_diverge_when_replayed_with_zero`.

There is no production `deleted_root` API and settlement does not implement
this proposal. The cursor-skipping regression is now closed by the approved
[indexed replacement](2026-09-08-indexed-settlement-design.md), an immutable liability commitment
with a count and next-unpaid ordinal, using position-bound membership to
prove contiguous progression. That replacement is implemented and tested.
The sections below preserve the rejected proposal for review history, not
implementation instructions.

## Change

Interpret the funding cell's `liabilities_root` as the current unpaid tree.
For each payout, authenticate the nonzero liability leaf against the current
root and replay that exact proof with zero to derive the root after deletion.
Chain these roots in witness order. All sibling subtrees must remain fixed.
Require the continuation cell's root to equal the final derived root; final
consumption requires that root to be empty and capacity fully paid out.

The existing cursor becomes an informational last-paid key, checked against
the last witness item but never used as a lower bound for subsequent batches.
Within one batch, retain strictly increasing keys to reject duplicates and
keep canonical witness ordering. Across batches, any unpaid key may be paid.
Proofs must reference successive intermediate trees, not the original root.
Reusing a paid leaf fails membership; replacing other liabilities fails the
exact root transition. Reject zero-value deletion targets.

## Preserved rules

Round/batch identity, realised total, principal liability and prize pool remain
immutable. Preserve the canonical public funding lock, ordinary participant
outputs, actual occupied capacity, transaction-wide group isolation and exact
Shannon conservation. No fees may come from settlement funding.

The wire container can remain unchanged, but the meaning of its proofs and
funding root changes incompatibly. Update contract comments, host builders,
tests and security documentation together. Do not redeploy old artifacts or
claim old witnesses remain compatible.

## Tests

First reproduce the existing failure: pay the highest of six keys, recreate
the funding cell, then pay the lowest key with enough remaining capacity.
The second payment currently fails with the ordering error.

Core deletion tests must independently compare with a host tree containing
only the remaining leaves; reject wrong value/key/root, absence proofs for
nonzero claims, trailing/invalid proof instructions and stale proofs after a
deletion. Test deleting the last leaf yields the empty root.

VM tests must cover high-then-low successful payouts; replay of an already
paid leaf; forged continuation roots; stale multi-payout proofs; final
consumption with unpaid leaves despite balanced capacity; and existing lock,
proof, overpayment and occupied-remainder regressions.

## Limits

Creation still requires the future authenticated draw/finalisation path to
establish the initial tree. Underfunded or attacker-chosen initial liabilities
are not made safe by deletion proofs. Reserve allocation and small-remainder
liveness need separate enforcement. This change is not release approval.
