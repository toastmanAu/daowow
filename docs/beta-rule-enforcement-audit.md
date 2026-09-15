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
