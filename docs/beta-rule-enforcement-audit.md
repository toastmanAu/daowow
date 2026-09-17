# Public testnet beta: rule-enforcement audit

Date: 2026-09-15. Status: initial source audit; not launch approval.

Scope update: transferable ticket-claim NFTs are now approved direction. See
`testnet-beta-plan.md`. Findings below describe the existing participant-bound
implementation, which must not be presented as supporting transferred claims.

Target: operator-created one- and two-native-DAO-cycle draws at daowow.org,
preserving the existing landing page. A roughly one-week readiness target is
tentative. Public registration notice follows successful rehearsal, not this audit.

## Findings

| Proposed setting | Current source evidence | Beta consequence |
| --- | --- | --- |
| Immutable terms | `contracts/round-type/src/main.rs` requires byte-identical config on update; `RoundConfigV1::commitment` binds its encoded fields | Supported structure; use authenticated config, not UI values |
| Ticket principal | `crates/daowow-core/src/shard.rs::validate_new_entry` checks ticket count times price; append checks principal plus occupied capacity | Price is not the full wallet transaction cost |
| Total ticket cap | `shard.rs::apply_entry_batch` compares only the current shard total against `maximum_tickets` | **Not a round-wide cap across multiple shards.** Must resolve before advertising one |
| Uncapped tickets | `maximum_tickets == 0` skips that cap check | Does not imply unbounded practical proof/keeper throughput |
| Per-lock cap | No corresponding field in `RoundConfigV1`; append checks each entry but does not maintain cumulative per-owner usage | **Not implemented.** A UI quantity limit is not enforcement; a per-lock limit would still not prevent multiple-wallet participation |
| Entry opening | `entry_start` is encoded and ordering-validated, but append does not check time | **Opening is not enforced by the append path** |
| Entry closing | OPEN-to-FROZEN requires an absolute epoch `since` at least `entry_end`; OPEN-to-OPEN dispatches directly to append | **Scheduled freezing is supported, but appends to an unfrozen shard have no closing-time check.** Do not describe a hard expiry as implemented |
| DAO duration | `contracts/dao-lock/src/main.rs` passes `dao_term_periods` to phase-one maturity validation; config rejects zero periods | One/two periods are representable; both beta configurations still need public full-lifecycle evidence |
| Payout weights | `crates/daowow-core/src/schedule.rs` commits 1–32 positive weights; fewer accepted tickets truncate the schedule before normalization | Presets must disclose truncation and rounding, not promise a fixed winner count in an underfilled draw |
| Underfilled draw | `computed_draw.rs` draws only if accepted total is nonzero and at least `minimum_tickets` | Success is based on **accepted** tickets, not merely submitted entries; minimum and cap policies need approval |
| Excluded-entry refund | `lifecycle.rs::close` closes an incomplete accepted prefix at the aggregation deadline; `is_refundable` identifies the excluded suffix | Distinct from cancellation of already deposited principal |
| Failed accepted round | Entitlement logic includes a failed-round path; existing unit tests cover return of yield to depositors | Failure does not mean instant withdrawal from native DAO; UI must distinguish refund from maturity-delayed settlement |

These findings are source-level evidence, not newly reproduced adversarial node
tests. Existing local tests do not prove the missing cross-shard cap, owner cap,
or append-time checks. The deployment manifest remains
`purpose: prototype-code-cells-only`, `fundedRoundsReady: false`.

## Decisions still needed

1. Variable odds with a hard round-wide ticket cap, proceeding underfilled when
   the approved minimum is reached, versus a must-fill policy. The former is
   proposed but not yet approved.
2. Ticket principal, total cap, minimum, optional per-lock limit and exact prize
   preset. The landing page's 100 CKB and 1–100 quantity range are preview values.
3. Closing semantics: an announced target followed by observable on-chain freeze,
   or a hard expiry requiring a separately validated enforcement design. Do not
   assume adding a header or `since` check alone establishes an upper time bound.
4. Entry notice/window lengths, aggregation deadline, sponsor budget and failure
   disclosures. Accepted funds remain subject to native DAO maturity.

## Required engineering follow-up

- Design and test a true round-wide cap across the intended shard topology.
  A single-shard beta is an alternative only with explicit scope approval, not
  an implicit substitute for the requested lottery system.
- Design cumulative per-lock accounting if that beta option is selected.
- Add opening enforcement and settle closing semantics with adversarial cases:
  early append, delayed freeze, append/freeze contention and reorg recovery.
- Reject contradictory configuration bounds and validate operator presets.
- Rehearse multi-owner/multi-batch rounds for both durations, including partial
  aggregation, failed minimum, refunds and restart/reorg recovery.
- Only then expose the verified settings through operator setup and the public
  wallet flow. No contract, deployment, wallet or Cloudflare state was changed
  by this audit.

## Duration and payout follow-up — 2026-09-15

Further source inspection changes the duration decision from a label choice to
a protocol-semantics decision:

- `crates/daowow-core/src/epoch.rs::absolute_epoch_after_dao_term` requires
  `deposit epoch + 180 * dao_term_periods`, including the deposit's epoch
  fraction, **before phase-one withdrawal preparation**.
- `contracts/dao-lock/src/main.rs` invokes that check on the actual deposit
  header and input `since`. The configured term is not a final-payment deadline.
- `tests/devnet/test_round_creation.py` currently hardcodes a one-period term
  at `term_epoch = deposit_epoch + 180`. It computes final native maturity
  separately from the actual withdrawal inclusion epoch, rounding the elapsed
  interval up to a multiple of 180 epochs. Withdrawal inclusion later than the
  exact term boundary can therefore move final maturity into a later period.
- The epoch unit test checks two-period rejection/acceptance, but that is not
  a two-period full-node lifecycle rehearsal. The current full-history harness
  is not parameterized for both beta durations.

Do not market the existing `dao_term_periods = 1` setting as a guaranteed
one-cycle deposit-to-payout lock. Decide whether the product means a minimum
yield-accrual term followed by native withdrawal maturity (current behavior),
or a target total lock duration (requires a distinct design and validation).
Any calendar estimate must derive from actual chain state and show uncertainty.
The one-week development target is not evidence that a full public maturity
rehearsal can finish within that week; that dependency remains unsatisfied.

Payout inspection confirms that `InitialEntitlements::derive` allocates all
realized growth above full input capacity: to computed winners on success, or
proportionally to consolidated depositor capacities on failure, with deterministic
residual allocation. No configurable keeper deduction is applied by that
function. An admin fee control must not be inferred from the mere presence of
fee/keeper policy hashes in the config. Budget sponsor-funded operations and
audit the complete transaction builders before introducing any fee preset.

### Evidence required for each beta duration

- Approved meaning of duration, minimum/cap policy, prize preset and costs.
- Early phase-one rejection, fraction-boundary cases and actual phase-one
  inclusion; early phase-two rejection and native final maturity.
- Multiple owners and batches, with exact full-capacity principal and all yield
  reconciled through final payouts; no hidden principal-funded fees.
- Below-minimum settlement after maturity and excluded-entry refunds after
  canonical deadline closure; neither described as an unconditional instant exit.
- Persistent keeper restart, transaction conflict handling and reorg recovery.
- Public-testnet transaction/block identifiers for the deployed approved code;
  isolated accelerated runs and host tests remain separate evidence categories.

This follow-up is read-only source analysis plus documentation. It introduces
no new test result or approval and makes no change to the beta's launch gate.

## Gate 1 closure — 2026-09-17

Delivery gate 1 of `docs/testnet-beta-plan.md`
(`docs/superpowers/specs/2026-09-17-beta-rule-enforcement-design.md`,
`docs/superpowers/plans/2026-09-17-beta-rule-enforcement.md`) closes some of
this audit's findings against the beta's approved values. What follows
distinguishes **enforced** (the contract refuses the alternative on chain),
**decided** (the operator/user chose a value or scope; no code path prevents
choosing otherwise in general, only this instance is fixed), and **not
implemented** (out of scope, present nowhere).

- **Total ticket cap — now ENFORCED for the beta, not fixed in general.**
  `shard.rs::apply_entry_batch` still compares only one shard's ticket count
  against `maximum_tickets`; that has not changed. What changed is
  `RoundConfigV1::validate` (`crates/daowow-core/src/encoding.rs`): when
  `maximum_tickets != 0`, it now refuses `entry_shard_count > 1`. Because the
  beta is configured with `entry_shard_count = 1`, the one quantity the shard
  check compares *is* the round-wide total, so the advertised cap is exactly
  right for this configuration. The cap is enforced *because* the beta is
  single-shard and any config that would make the advertised number wrong is
  now unconstructible — not because a round-wide accounting mechanism across
  shards was built. A future multi-shard beta still needs the cross-shard cap
  design this audit's "Required engineering follow-up" calls for; that work
  was not done. The evidence for this closure is host tests (`shard.rs`'s cap
  tests) plus the config guard proven by
  `encoding.rs::the_beta_configuration_validates_and_an_absent_cap_is_not_refused`
  — narrow that claim explicitly: **no on-chain test yet exercises a capped
  single-shard round.** Every integration and devnet round in this repository
  configures multiple shards with `maximum_tickets = 0` (uncapped); none pairs
  a cap with `entry_shard_count = 1`. An on-chain cap test — the 200th ticket
  accepted, the 201st refused, against a single-shard capped config — is
  required before a funded round.
- **The cap bounds SUBMITTED tickets; success and prizes are decided by
  ACCEPTED tickets — a different quantity.** `shard.rs::apply_entry_batch`
  compares the shard's `ticket_count`, which counts every appended entry,
  against `maximum_tickets`. But `computed_draw.rs` gates the draw on
  **accepted** tickets, and `lifecycle.rs::close` excludes an unaggregated
  suffix at the aggregation deadline. The direction is safe (accepted <=
  submitted <= cap), so this is disclosure, not a breach — but a round can
  read "200/200 sold" while fewer than 200 tickets are ever accepted, and
  nobody can top the round back up, because exclusion only happens after the
  freeze and a frozen shard refuses further appends. A UI that shows one
  number for both quantities would advertise something the protocol does not
  mean.
- **Minimum vs. maximum — now ENFORCED.** The same `validate` gained a second
  guard: when `maximum_tickets != 0`, `minimum_tickets > maximum_tickets` is
  refused. A round that could never reach its own success threshold can no
  longer be constructed.
- **Entry opening — now ENFORCED.** The append path
  (`contracts/entry-shard-type/src/main.rs`) now checks the input `since`
  against `cfg.entry_start` via `absolute_epoch_at_least` and refuses an entry
  submitted before the round opens, with new error code
  `SHARD_ERROR_NOT_OPEN = -39`. This applies only when `entry_start != 0`; at
  zero the constraint is vacuous (the round opens at epoch 0, and every valid
  epoch is at or after that), so a beta or test round with `entry_start = 0`
  is unaffected and was never expected to be. Pinned by
  `tests/integration/tests/security_entry_window.rs` and proven by a mutation
  round trip (remove the check, the pinning test goes red; restore it, green).
  This closes the "Entry opening is not enforced by the append path" finding
  above.
- **Entry closing — UNCHANGED, and still not a hard expiry.** OPEN-to-FROZEN
  still requires `since >= entry_end`; OPEN-to-OPEN append still has no
  closing-time check. `since` is a CKB lower bound: a transaction can prove it
  is not earlier than an epoch, never that it is not later. Closing remains an
  announced target followed by an observable on-chain freeze, and an entry can
  still land in the gap between the announced close time and the actual
  freeze transaction. Gate 1 does not add a hard expiry, and none should be
  inferred from the opening check above — opening and closing are not
  symmetric: a lower bound can enforce "not yet" but nothing here can enforce
  "not anymore" without a design of its own (not built).
- **The consequence of the unenforced close that matters most.** The bullet
  above describes the gap in terms of odds — an entry landing after the
  announced close still dilutes the draw. That is the smaller half. A late
  entry landing between the announced close and the actual freeze can push
  the accepted total across `minimum_tickets`, converting what would have
  been a FAILED round — every participant refunded — into a SUCCESSFUL round
  — every participant's principal locked into the native DAO for a full
  term. That is an outcome-class change for everyone already in the round,
  decided after the round's advertised close, by whoever happens to submit
  the entry that crosses the line.
- **The mitigation that makes the above defensible.** The freeze is
  permissionless and cannot happen early. The shard cell sits under the
  public lock (`is_public_lock`/`public_lock` in
  `contracts/entry-shard-type/src/main.rs`), so the OPEN-to-FROZEN
  transaction can be submitted by ANY participant, not only the keeper — and
  the contract's `since >= entry_end` check refuses it for everyone equally
  before `entry_end`. The gap described above is not keeper discretion; it is
  a race that any honest party can win by closing the round themselves at
  exactly `entry_end`. Read on its own, the bullet above could leave a reader
  assuming the keeper decides when the doors shut; it does not — nobody can
  shut them early, and anybody can shut them on time.
- **Per-lock cap — remains NOT IMPLEMENTED, by decision, not oversight.**
  There is still no cumulative per-owner accounting field or check. This
  audit's original finding — a per-lock limit does not prevent multi-wallet
  participation, so a UI-only quantity limit is not enforcement — stands
  unchanged, and gate 1 did not attempt a fix. It was decided out of scope for
  this beta: the field would sit inside `RoundConfigV1`, whose encoded fields
  feed `cfg.commitment()`, and `cfg.commitment()` seeds the draw, so widening
  the config format for a control that a second wallet defeats anyway was not
  judged worth the change to a value that feeds the draw seed.
- **Devnet evidence — single-batch only; multi-batch rehearsal remains open.**
  `tests/devnet/test_round_creation.py` now proves 16/16 on a real isolated
  node with `entry_start = 1` (a real, non-vacuous opening check exercised on
  chain) and six DAO deposits landing at the same epoch (spread 0 inside a
  `[2,4]` window), all maturing at the same `D+360` boundary with phase one
  targeted at `D+181`. This is one DAO deposit per round in the fixture — a
  one-element set — so it demonstrates the *timing window* mechanism, not
  concurrent multi-owner/multi-batch aggregation. This audit's "Required
  engineering follow-up" (rehearse multi-owner/multi-batch rounds) and the
  "Evidence required for each beta duration" list (multiple owners and
  batches) are unchanged by this work and remain open; do not read the
  16/16 result as covering them.
- **A new obligation for gate 2's wallet flow.** With `entry_start != 0` (the
  beta's actual value), every append transaction must set an absolute-epoch
  `since` on the shard input — the canonical value is `ABSOLUTE_EPOCH_FLAG |
  entry_start` — or the append is refused with `SHARD_ERROR_NOT_OPEN = -39`.
  A wallet that omits `since` fails every single entry once the beta's real
  `entry_start` goes live, not only in an adversarial case. Separately, at
  `entry_shard_count = 1` every entry in the beta serialises through one live
  shard cell: 200 tickets means 200 sequential spends of that one cell, and
  an entrant whose transaction loses the race for the current shard cell must
  detect the conflict and retry. Both are direct, mechanical consequences of
  gate 1's own decisions, and the wallet flow gate 2 builds must be designed
  for them from the start rather than discovered under load.
- **What remains uncovered.** This audit's own follow-up list above asks for
  adversarial cases covering early append, delayed freeze, append/freeze
  contention and reorg recovery. This branch's evidence — the mutation round
  trip and the devnet run — covers early-append only; append/freeze
  contention, delayed freeze and reorg recovery are untested.

### The beta's approved values

`ticket_price = 1000 CKB`, `maximum_tickets = 200`, `minimum_tickets = 50`,
`entry_shard_count = 1`. An entrant's wallet cost is roughly 1,220 CKB per
ticket, not 1,000: each accepted entry mints a claim cell
(`claim_occupied_capacity`, `crates/daowow-core/src/claim.rs`) of about 220 CKB
under a standard secp256k1 lock, on top of the 1,000 CKB ticket principal. That
220 CKB is not spent — it is returned to the holder at retirement
(sub-project 3), but it must be present in the entrant's wallet at entry time
and the UI must not describe it as part of the ticket price.

`minimum_tickets = 50` exceeds `MAX_SCHEDULE_PRIZES = 32`
(`crates/daowow-core/src/schedule.rs`). `computed_draw.rs` only draws once the
accepted total is at least `minimum_tickets`, so a successful round always has
at least 50 accepted tickets — more than the schedule's 32-weight ceiling —
and `weights_for`'s truncation path (documented in this audit's Findings table
as a required disclosure) is therefore never reached in a round that actually
succeeds. This does not remove the disclosure requirement in general: it means
that for *this* beta's configuration, a preset may promise a fixed winner
count without qualifying it, because underfilling below 32 accepted tickets
is definitionally a failed (below-minimum) round, not a successful one with a
truncated schedule. Lowering `minimum_tickets` below 33 in any future
configuration reopens the truncation case and reinstates the disclosure
requirement from the Findings table above.

No other finding in this audit is closed by gate 1. The deployment manifest
remains `purpose: prototype-code-cells-only`, `fundedRoundsReady: false`; this
closure is documentation plus the three code changes cited above, not a launch
approval.
