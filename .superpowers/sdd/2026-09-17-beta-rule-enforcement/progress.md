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
Task 2: implementer DONE — commit 1a0794b, encoding.rs (+53) and shard.rs (+3/-1).
148 -> 151, no_std + clippy + fmt clean. Both mutation round trips performed
individually, per guard, with output recorded. Review dispatched over
fba6e3a..1a0794b, told to verify the round-trip evidence is shown rather than
asserted, that the uncapped path still shards freely, that minimum == maximum is
accepted, and that the shard.rs cap tests still genuinely set a cap rather than
having been defanged.

Task 3 (devnet lock window): dispatched (sonnet), BASE 1a0794b. Carries the F2
ruling: entry_start need only be non-zero, not large — the devnet mines from
genesis, so entry_start = 1 keeps the mining profile while making Task 1's check
execute on a real node. Told explicitly that if it cannot reach epoch 1 it must
REPORT that rather than set entry_start back to 0, which would make the check
vacuous again and the run would prove nothing while passing. Also told to assert
the deposit spread and a COMMON maturity boundary, since a round that merely
completes proves neither half of the user's requirement.
Task 2: review spec MET, quality approved, no Critical/Important. The reviewer
traced test independence through sample_config() rather than assuming it: in
`a_capped_round_must_be_single_shard`, minimum_tickets stays at 10 against a cap
of 200 so the min-guard can never fire, and in
`a_round_cannot_require_more_tickets_than_it_allows`, entry_shard_count is pinned
to 1 so the shard-guard can never fire. Neither guard can satisfy the other's
assertion — non-overlapping by construction, which is what makes two
same-variant guards in one commit individually meaningful. It also grepped the
whole of shard.rs to confirm no other fixture pairs a cap with multiple shards,
and confirmed `cap_enforced` still asserts 11 rejected / 10 accepted rather than
having been defanged.

Task 2: minor (deferred): the two guards repeat the `maximum_tickets != 0`
condition rather than nesting one `if`. Trivial.

Task 2: complete (commits fba6e3a..1a0794b, review clean, 0 fix rounds)

Task 3: implementer DONE — commit 5371b49. Devnet 16/16 in one clean run
(1455.7s). entry_start 0 -> 1 (devnet epoch length measured at 10 blocks, so
epoch 1 costs ~10 blocks — comfortably reachable, so Task 1's check now executes
on a real node rather than being vacuous). Deposit epochs [3,3,3,3,3,3], spread
0 inside the [2,4] window. Maturity deltas [360,360,360,360,360] — every batch
at the same D+360 boundary, phase one targeted at D+181, knife edge avoided.

Concern worth the record, raised by the implementer rather than found later: the
fleet-wide property is asserted ACROSS the 8 run_history invocations, not WITHIN
one round. The fixture produces a single DAO deposit per round (one non-empty
shard), so no round with genuinely concurrent multi-batch deposits was
exercised, and a spread of zero over a one-element set is trivially true.
Ruling: accept as evidence for the single-batch case and record the limitation
plainly — do NOT extend the fixture inside gate 1. Multi-batch matters for the
beta (a single-shard round can still accept several batches, since the keeper
aggregates in batches and accepted_batches counts per shard), but rehearsing it
is ALREADY a documented requirement elsewhere: beta-rule-enforcement-audit.md
line 57 ("Rehearse multi-owner/multi-batch rounds for both durations") and line
103 ("Multiple owners and batches"). Adding it here would duplicate a later
gate's evidence at the cost of another 25-minute run.
Cost if wrong: gate 1's devnet evidence proves the window property for
single-batch rounds only, and a multi-batch round could in principle spread its
deposits wider. Bounded by the aggregation window being a config value either
way, and surfaced to the user rather than buried.

Second note from the run: maturity mining now travels ~360 epochs instead of
~180 for five histories, roughly doubling that portion of wall-clock. Total
stayed ~24 min only because devnet epoch length is 10 blocks. A larger epoch
length would make this suite materially slower.
Task 3: review spec MET, quality approved, no Critical/Important. Confirmed both
properties are genuine assertions rather than logged values
(test_round_creation.py:209-210 per-batch window, :275-280 maturity_delta == 360,
plus fleet-wide checks in tearDownClass), that entry_start: 1 is the only devnet
config source so Task 1's check really executed, that phase one targets D+181
strictly inside the interval, and that NOTHING pre-existing was weakened — the
RFC 0023 maturity arithmetic is untouched rather than adjusted to fit an
observed value.

Useful answer to the question I asked about multi-batch reuse: the assertions
GENERALISE without restructuring. Per-batch invariants are asserted individually
at the point of observation and only then appended to a class-level list;
tearDownClass computes spread and set-equality over the union. Any subset's
spread is bounded by the union's, and maturity is exact-set-equality, so a
violation inside a single multi-batch round would still surface. Only the
run_history harness needs to loop per batch — which is the separately tracked
rehearsal work, not a defect here.

⚠️ resolved by me, as required before completing: the reviewer could not verify
from the diff that contracts were built before the devnet ran — the stale-binary
trap, where a green run tests the OLD binary and proves nothing about the new
check. Checked decisively: rebuilding entry-shard-type from current source
yields a byte-identical binary (662b2b9b5822ad62), so the run used source
carrying Tasks 1 and 2. Not a gap.

Task 3: minor (deferred): the report does not confirm `cargo fmt --all` was run;
the Rust change is a small json! addition that looks formatted.
Task 3: minor (deferred): window_width is reassigned identically on every
invocation rather than set once. Cosmetic.

Task 3: complete (commits 1a0794b..5371b49, review clean, 0 fix rounds)
Task 4: review spec MET, quality approved, ZERO findings. The reviewer verified
every claim against source rather than the report: the entry_start != 0 condition
is stated rather than implying unconditional enforcement; both config guards are
correctly shown as gated on maximum_tickets != 0 so an uncapped multi-shard round
is not implied to be refused; closing is worded as an announced target plus an
observable freeze with no "closes at X" language; the devnet evidence is
explicitly scoped to one deposit per round over a one-element set; and the
handoff lost exactly the one stale bullet, with every other open item
byte-identical including all three known-failing tests. It also recomputed
claim_occupied_capacity independently — 8 + 53 + 78 + 81 = 220 CKB exactly.

Task 4: complete (commits d43d45d..d306cc1, review clean, 0 fix rounds)

All four tasks complete, zero fix rounds across the whole plan. Final
whole-branch review dispatched on opus.

CORRECTION, filed against my own "third known failure" claim above (the Task 1
CORRECTION entry recording `security_redemption::redeeming_the_same_source_twice_is_rejected_by_the_claim`
failing with -77 at binary 229,208). That observation was made against the
Task-1-only binary. It does not describe this branch. Re-verified directly
against the current branch tip: binary 229,384
(`target/riscv64imac-unknown-none-elf/release/entry-shard-type`,
sha256 662b2b9b5822ad62...), the test passes, 22/22 in the file and in
isolation. A later change (Task 2's `shard.rs` edit, or Task 3, moved the
binary again from 229,208 to 229,384) shifted the sort permutation this
fixture depends on back to favourable.

The underlying property this test's fixture depends on — permutation
independence — is still not actually fixed; see the corresponding correction
in `docs/HANDOFF-2026-09-16.md`. This entry is only about what this branch's
test suite currently reports: this branch carries the TWO known `smoke`
failures, and no third. Do not read the Task 1 CORRECTION entry above as
describing this branch's current state; it describes a binary this branch no
longer has.

Final whole-branch review (opus): APPROVE WITH CONDITIONS, no Critical. It
proved the cap guard is STRONGER than the docs claimed — validate() is not a
creation-time gate but sits on the hot path of every ticket (round-type creation,
config_by_commitment, and apply_entry_batch on every append), so a violating
config cannot be resolved at all and fails closed with SHARD_ERROR_CONFIG_DEP,
even on a round created before the guard existed.

Its sharpest finding: the guard prevents a WRONG cap, not an ABSENT one.
maximum_tickets = 0 validates and enforces nothing, and the beta's numbers
existed only in prose.

Fix wave commit 449f418, all five conditions applied; scoped re-review confirms
all ADDRESSED with no new breakage. Core 148 -> 152. contracts/ diff is +7/-0,
comments only, corroborated by a byte-identical rebuild at 229,384.

Ruling: DECLINE two review minors and record why at the code sites rather than
in a doc only — (i) no shared check_epoch_since(deadline, code) helper, because
the two arms return different error codes and a parameterised helper in a
consensus path is a worse trade than eight duplicated lines; (ii) do not collapse
the two `maximum_tickets != 0` conditions into one nested if, because keeping
them independent is what makes each individually mutation-testable and nesting
reintroduces exactly the guard-masking this project's own discipline warns about.
Cost if wrong: eight duplicated lines and one repeated condition persist.

Ruling: my ledger entry recording security_redemption as a third known failure on
this branch was WRONG and is corrected rather than deleted. I observed it failing
against the Task-1-only binary (229,208); Task 2 moved the binary to 229,384 and
the permutation flipped back to passing. Verified 22/22 myself before accepting
the reviewer's correction. The wrong entry stays in the ledger beneath its
correction so the record shows what was believed and when.
Cost if wrong: none — verified twice, by the reviewer and by me.

Gate 1: COMPLETE. Four tasks, zero fix rounds during tasks, one final fix wave.
