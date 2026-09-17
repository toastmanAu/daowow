# SDD ledger — plan: docs/superpowers/plans/2026-09-17-beta-rule-enforcement.md

Spec: docs/superpowers/specs/2026-09-17-beta-rule-enforcement-design.md (read)
Branch: feat/beta-rule-enforcement, off main at the gate-1 spec/plan commits.
Baseline: core 148 passing; integration 171 passed / 2 failed (known smoke pair).

## Pre-flight scan

### Cross-task rows (shared file or interface)

| Producer | Consumer | Interface | Finding |
| --- | --- | --- | --- |
| T1 error.rs | T1 contract, T1 tests | `SHARD_ERROR_NOT_OPEN = -39` | ok, -39 verified free (shard range ends at -38) |
| T1 contract | T3 devnet | the append opening check | ok — T3 must set a non-zero entry_start or the check is vacuous; the brief says so |
| T2 encoding.rs | T3 devnet config | `validate` guards | **F1** — devnet uses entry_shard_count 2; guard only bites with a cap, devnet has maximum_tickets 0, so ok |
| T2 encoding.rs | T2 shard.rs fixture | the cap/shard guard | ok — the brief already carries the fixture fix |
| T1, T2, T3 | T4 docs | the record | ok |

### Per-task self-consistency rows

| Task | Finding |
| --- | --- |
| T1 | ok — mirrors the freeze arm's since handling verbatim; the entry_start != 0 skip is stated with its reason |
| T2 | ok — three tests, each pinning one guard, plus the equal-boundary case |
| T3 | **F2** — the brief says "set entry_start to a non-zero epoch" but the devnet round runs on a fresh chain whose epochs start near 0; a large entry_start would require mining to reach it |
| T4 | ok — documentation only |

### Findings and rulings

F1. Devnet config has `entry_shard_count: 2` and `maximum_tickets: 0`. The Task 2
guard only rejects a cap with multiple shards, so the devnet is unaffected.
Verified by reading tests/integration/examples/devnet_round.rs:77,82. No action.

F2. Task 3 requires a non-zero `entry_start` so Task 1's check executes on a real
node, but the devnet mines from genesis and the existing config uses
entry_start 0, entry_end 2, aggregation_deadline 4 — epochs in the low single
digits.
Ruling: a non-zero entry_start need only be non-zero, not large. entry_start 1
with entry_end 2 keeps the existing mining profile while making the check
execute. Task 3's implementer chooses the exact values and reports them; the
constraint is that entry_start > 0 and the aggregation window stays tight.
Cost if wrong: if the devnet cannot reach even epoch 1 before the first append,
the implementer reports it rather than setting entry_start back to 0 — which
would silently make the check vacuous again and prove nothing.

Ruling: work on feat/beta-rule-enforcement rather than main, matching the
pattern the user chose for the previous sub-project. Cost if wrong: none; a
branch is merged the same way.

Task 1: implementer DONE_WITH_CONCERNS — commit e17d780. Core 148/148,
integration 174 passing, mutation round trip confirmed (guard removed -> both
rejection tests RED; restored byte-identically -> GREEN). Binary 229128 ->
229208 (+80). Review dispatched over 20708e0..e17d780.

CORRECTION TO MY OWN EARLIER WORK, and my verification method was the fault.
Earlier today I "fixed" the binary-hash fragility in
security_redemption.rs::redeeming_the_same_source_twice_is_rejected_by_the_claim
by pairing prize amounts AFTER the ticket-id sort instead of before, and
reported it "fixed and proven" on the strength of ONE binary perturbation that
gave 22/22. Task 1's contract change moves the binary again and the test fails
again — now -77 (settlement refuses) rather than the original underflow panic.
The implementer proved it is not their change by perturbing the binary inertly
and reproducing the same failure. I re-ran it myself and confirm it fails on
this branch.

What I got wrong: the property is permutation-independence, and a single
perturbation is a single SAMPLE of that permutation. Passing once says the
permutation happened to be favourable, not that the fixture is independent of
it. Verifying a permutation-dependent property needs many samples, or better,
removing the dependence structurally. My fix removed the `amount` coupling and
left another one.

Ruling: do NOT fix it inside gate 1. It is pre-existing, out of this plan's
scope, and a proper fix is a fixture redesign rather than another one-line
pairing change — the second time a "one line" attempt has moved the failure
rather than removed it. Main is currently green on it only because main's
binary happens to produce a favourable permutation; any contract change flips
it, and gate 1 changes the contract. Record it as a known failure for this
branch, tell the user my earlier claim was wrong, and leave the redesign as its
own piece of work.
Cost if wrong: this branch carries a third known-failing integration test, and
anyone reading a green-except-three suite must be told which three and why.
Task 1: review spec MET, quality approved, no Critical/Important. The reviewer
verified the `entry_start != 0` skip against epoch.rs rather than accepting the
rationale: with deadline 0, absolute_epoch_at_least is trivially Ok for any
validly-flagged since but still rejects the bare `0` every existing append test
uses — so the skip is correct AND the check is unconditional whenever
entry_start > 0, with no evasion route. It also checked something not in the
brief: whether cfg.entry_start could be spoofed. It cannot — cfg resolves via
config_by_commitment keyed off the args commitment, the same trust path the
pre-existing freeze check already uses for cfg.entry_end.

⚠️ resolved by the reviewer itself, and I accept its resolution: the append
fixture is NOT literally a single script group — the shard cell's lock is the
same entry-shard-type binary in public-lock mode, so two groups execute. It read
public_lock() and confirmed that for this single-input well-formed transaction
it always returns 0, so only the TYPE group can produce a nonzero code. The
exact-i8 assertions are therefore stable; only the report's wording ("only one
group runs") was imprecise, not the test.

Task 1: minor (deferred): the new append block duplicates the freeze arm's
load_input_since + absolute_epoch_at_least + return shape almost verbatim. A
shared `check_epoch_since(deadline, code)` helper would remove it. Pre-existing
style — the freeze arm was already inline — so not new debt.
Task 1: minor (deferred): the report says "only one script group runs" where
"only one group can reject" is accurate.

Task 1: complete (commits 20708e0..e17d780, review clean, 0 fix rounds)
