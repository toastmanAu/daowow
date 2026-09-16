# SDD ledger — plan: docs/superpowers/plans/2026-09-16-claim-retirement-memento.md

Spec: docs/superpowers/specs/2026-09-16-claim-retirement-memento-design.md (read)
Branch: feat/claim-retirement-memento (user chose in-place branch over worktree,
to keep target/ warm for RISC-V contract builds and the 21-minute devnet)
Baseline: cargo test -p daowow-core --lib = 124 passed, 0 failed.

## Pre-flight scan

### Cross-task rows (shared file or interface)

| Producer | Consumer | Interface | Finding |
| --- | --- | --- | --- |
| T1 schedule.rs | T2 computed_draw | `min_viable_pool(tickets) -> Result<u64>` | ok |
| T2 computed_draw | T6 retire_decision, T7 contract | `ComputedDraw::{positions,locate,is_success}` | ok |
| T2 computed_draw.rs tests | T6 computed_draw.rs tests | both extend the same fixture | ok, sequential |
| T3 entitlements.rs | none | zero-allocation refusal | ok, independent |
| T4 seal.rs | T7 contract | `RoundSeal::total_accepted_batches()` | **F3** — T6 Interfaces claims it consumes this; it does not |
| T5 memento.rs | T7, T8, T8 harness | `MementoArgs`, `MementoData`, `memento_occupied_capacity` | ok (capacity consumer added to T8 in review) |
| T6 claim.rs core | T7 contract | `retire_decision`, `RetireDecision` | ok |
| T7 error.rs | T8, T9 | `CLAIM_ERROR_*`, `MEMENTO_ERROR_*` | ok, T7 defines all six |
| T7 contract claim.rs | T8 main.rs dispatch | disjoint files | ok |
| T7 claim_retirement.rs | T8 extends it; T9 new file | both edit common/mod.rs | ok, sequential |
| T10 probe table | T2, T3, T6, T9 test names | 12 named tests | ok, all 12 names verified present |
| T11 | all | devnet + docs | ok |

### Per-task self-consistency rows

| Task | Finding |
| --- | --- |
| T1 | ok — `CoreError` in scope via `use super::*`; `weights_for(0)` really returns InvalidArgument |
| T2 | **F1, F2** — calls `Fixture::build(4, 8)`, which does not exist; gate voids the existing fixture |
| T3 | ok — `allocate_prizes_complete(&[1,1,1000], 3) == [1,0,2]` verified against the real helper |
| T4 | ok |
| T5 | ok — capacity arithmetic `8+53+78+54 = 193` checks out |
| T6 | **F1, F3** — same non-existent fixture constructor; Interfaces block overclaims |
| T7 | ok — `load_witness` fully qualified, `alloc::vec::Vec` import noted, input data loaded before the match |
| T8 | ok |
| T9 | ok — one worked test plus a 15-row variant table, every code exact |
| T10 | ok |
| T11 | ok |

### Findings and rulings

F1. The plan calls `Fixture::build(4, 8)` in T2 and T6. The real API is a free
function `fixture(minimum: u64, accept: bool)`, called as `fixture(1, true)`.
Ruling: correct the plan to the real API before dispatch. Cost if wrong: none,
this is a verified fact.

F2. SEVERE. `computed_draw`'s test fixture sets `ticket_price: 100` (shannons).
The allowance is `ticket_price / 1_000_000 = 0`, while the `[4,3,2,1]` schedule's
bar is 10, so the viability gate voids every core fixture round. Measured
empirically by applying the gate and running the suite, then reverting: exactly
3 tests fail — `computed_draw::tests::draws_only_accepted_prefixes_across_empty_shards`,
`entitlement_witness::tests::decoded_evidence_derives_entitlements_and_rejects_altered_capacity`,
`entitlements::tests::success_round_credits_prizes_to_tickets_and_principal_to_depositors`.
The spec's Ripple section claimed shipped fixtures pass the bar; that was checked
against the integration harness (`ticket_price = 100 * SHANNONS`) and is false for
the core fixture.
Ruling: the gate is right and the fixture is economically incoherent — a
100-shannon ticket cannot fund a cell, let alone a prize. Insert a new task
before the gate that scales the core draw fixture by 10^8 to a 100 CKB ticket,
keeping every ratio identical, and renumber the plan to 12 tasks. Scaling by a
constant must leave all three assertions at exactly old x 10^8; any other value
means rounding behaviour changed and the task stops and reports.
Cost if wrong: fixture churn across three core test modules. Self-announcing —
the same three tests fail loudly if the scaling is wrong.

F3. T6's Interfaces block lists `RoundSeal::total_accepted_batches` as consumed,
but `retire_decision` takes `universe: u64` and never calls it; T7 is the real
consumer. Ruling: correct the block. Cost if wrong: none, cosmetic.

## Execution

Plan amended per rulings F1/F2/F3 and committed as 9d132bb. Twelve tasks.
Brief extraction verified for tasks 1, 2, 3, 12 — boundaries correct, Task 1's
brief does not leak Task 2.

Task 1: dispatched (sonnet; plan text carries the complete code, so this is
transcription plus testing). BASE 9d132bb.
Task 1: implementer DONE — commit f80e559, schedule.rs only (+47). Core suite
124 -> 127 (3 new), no_std clean, clippy clean. Review dispatched (sonnet) over
9d132bb..f80e559.

Ruling: quota pressure (user: will exhaust weekly allowance tonight, resets
overnight). Two adjustments. (1) The ledger is force-added to git at every task
completion despite .superpowers/ being ignored, so the recovery map survives a
fresh session, a context loss, or `git clean -fdx` — `git log` plus this file
reconstructs the whole run. (2) Small independent same-shape tasks are batched
into one dispatch where the plan text carries complete code (Tasks 5+6 are the
candidates: different files, no shared interface, both fully specified).
Contract tasks (9, 10) and the rejection suite (11) are NOT batched — they are
financial-script code and each needs its own review surface.
Cost if wrong: a batched task's review is coarser, so a defect in one half is
likelier to be attributed to the other. Both halves are separately committed,
so a bad batch is revertable per-file.

Task 1 review: spec MET, quality approved, one Important (plan-mandated)
finding — no test distinguishes `div_ceil` from floor division, because every
brief-specified weight set has `min == 1` or divides exactly. A regression to
`sum / min` would pass all three tests.

Ruling: valid and load-bearing — the closed form is the premise of the whole
viability gate, and floor would under-state the bar in the non-exact case,
letting a zero allocation through, which is the exact hole this design closes.
Fix in round 1. Cost if wrong: one extra test.

Ruling: the reviewer's suggested weights `[3, 7]` are WRONG for this purpose and
must not be used. Verified by computing the real allocation: `[3,7]` puts the
minimum at index 0, which absorbs the rounding dust, so at pool 3 it allocates
[1,2] — no zero, no bracket. Use `[7, 3]`: ceil(10/3)=4 vs floor=3, and at pool
3 it allocates [3,0] (position 1 zero) while at pool 4 it allocates [3,1] (all
positive). That distinguishes ceil from floor AND brackets the threshold.
Cost if wrong: none, verified numerically before dispatch.

Finding (new, from checking the above): when the smallest weight sits at index
0, `min_viable_pool` OVER-states the bar, because index 0 receives the dust and
can never be the binding position. The formula is therefore conservative, never
permissive — it may void a round that would in fact have paid every prize, but
it cannot admit one that would not. Safe direction. Document it rather than
complicate the formula.
Task 1: fix round 1/5 (1 addressed, 0 open — ceil-vs-floor test with weights
[7,3] plus the conservatism note on the doc comment; commits f80e559..6223a19).
Implementer ran the disable/re-enable round trip itself: reverting to floor
division made the new test fail left=Ok(3) right=Ok(4), then restored. Scoped
re-review dispatched (haiku).
Task 1: re-review ADDRESSED, no new breakage.

Controller check before accepting: the re-review's prose quoted allocations
[2,1] and [2,0], but the production path `allocate_prizes_complete` gives [3,1]
and [3,0] — the quoted figures are the PRE-dust values from the legacy
`allocate_prizes`. Read the test directly: it calls `allocate_prizes_complete`,
the approved rule, so the verdict stands and the reviewer simply mis-stated the
numbers in prose. Lesson for the rest of this run: a subagent's narrated numbers
are not evidence; check the code when a number looks off by exactly the dust.

Task 1: complete (commits 9d132bb..6223a19, review clean after 1 fix round)

Task 2 (fixture scaling): BLOCKED by the implementer, correctly. It found that
`ticket_price` sits at offset 36 of `RoundConfigV1::encode()`, so it is inside
`commitment()` and therefore inside the draw seed
H("DAOWOW_AUTHENTICATED_DRAW_V1" || commitment || record). Scaling it does not
rescale amounts — it RESHUFFLES which tickets win. Confirmed by reading
encoding.rs:111 and computed_draw.rs:51. Consequences it hit: a golden vector
pinned against an independent Python hashlib computation broke, prize assignment
changed tier, and two further tests failed because the toy fixture's numbers are
rounding-dominated (a true 50/50 split allocating 66/33), so old x 1e8 does not
hold. It committed nothing; working tree reverted clean.

Ruling: SUPERSEDES ruling F2. My F2 was wrong — it assumed ticket_price was a
pure amount. Do not scale the fixture. Instead the viability allowance becomes an
absolute constant, MAX_POOL_BAR = 1_000_000 shannons (0.01 CKB), replacing
`cfg.ticket_price / VIABILITY_RATIO`. Verified before re-dispatch: the core
fixture's [4,3,2,1] has bar 10, the integration harness's [1;32] has bar 32 (8
when truncated), and the pathological test schedule has bar 2.9e17 — so NO
fixture changes at all, and the void test still exercises the gate. Task 2
(scaling) is deleted and the plan is back to 11 tasks, restored from 88ae175
with F1/F3/F4 reapplied rather than renumbered, to avoid renumbering errors.

Why this is safe: the retirement count argument rests on the DERIVATION guard
(reject a zero allocation), not on the draw gate. The gate only makes the
failure graceful instead of stranding a batch. So making the allowance less
adaptive cannot weaken the correctness of retirement.
Cost if wrong: the bound does not adapt to an unusually small ticket price, so a
round priced below the claim-cell floor could strand a batch rather than void
cleanly. Recorded in the spec as a known limit with the config-field fix that
would close it.

Deferred minor: the implementer observed the core fixture's numbers are
rounding-dominated (66/33 for a true 50/50). Not touched, not needed now.
Task 2 (viability gate, re-scoped): implementer DONE — commit 8c170a8,
computed_draw.rs only (+144/-1). Core 128 -> 130, no pre-existing test changed,
no_std + clippy clean, ticket_price untouched. Review dispatched (sonnet) over
aff95e6..8c170a8, told specifically to check the void test is not passing via
the minimum_tickets path or a schedule-commitment mismatch instead of the gate.
Self-reported concerns carried to the reviewer: `record_for` derives acceptance
from the record rather than a stored flag; `fixture_unviable` unused and marked
#[allow(dead_code)] (a later task is specified to call it).

Task 3 (derivation refuses zero): dispatched (sonnet) in parallel — touches
entitlements.rs, disjoint from the file under review. BASE 8c170a8. Told to
report any regenerated-vector change rather than commit it silently.
Task 2: review spec MET, quality approved, no Critical/Important. The reviewer
independently verified the crux rather than trusting the report: it hand-computed
min_viable_pool for the TRUNCATED wide schedule and confirmed the void test
reaches the gate (commitment binding passes because record_for reseals against
wide_cfg, and minimum_tickets is satisfied), so the test is not green via an
unrelated error path. Also grep-confirmed ticket_price is unread in the diff.

Task 2: minor (deferred): note beside #[allow(dead_code)] on `fixture_unviable`
saying which later task consumes it, so it does not read as orphaned.
Task 2: minor (deferred): `record_for` duplicates ~25 lines of fixture()'s shard
construction; extract only if a third caller appears.

Task 2: complete (commits aff95e6..8c170a8, review clean, 0 fix rounds)

Ruling: do NOT run two implementer subagents concurrently even when their files
are disjoint. Reviews may overlap an implementer because they do not write, but
two implementers would race on the cargo build lock and, worse, on the git index
— concurrent `git add`/`git commit` can interleave and sweep the other's files
into the wrong commit. Reviews overlap; implementers are serial.
Cost if wrong: slower wall-clock than the theoretical maximum under quota
pressure. Accepted deliberately — a cross-contaminated commit would cost far
more to untangle than the parallelism saves.

## STOPPED: weekly quota exhausted 2026-09-16 23:05 ACST (resets 05:30 ACST)

Task 3 (derivation refuses zero): its implementer was terminated by the rate
limit after confirming the baseline (130 passed) and BEFORE writing any code.
It committed nothing and left no edits. Task 3 is NOT started.

### Resume here

Branch feat/claim-retirement-memento, working tree clean, core suite 130 passing.
Completed: Task 1 (commits f80e559, 6223a19), Task 2 (commit 8c170a8).
Next: Task 3, brief already extracted at
.superpowers/sdd/2026-09-16-claim-retirement-memento/task-3-brief.md, BASE 8c170a8.

To resume, re-enter superpowers:subagent-driven-development against
docs/superpowers/plans/2026-09-16-claim-retirement-memento.md. This ledger is the
recovery map; every task with a `complete` line is done.

Carry these into Task 3's dispatch (they are not in the brief):
- The change is entitlements.rs:79, `if amount == 0 { continue; }` inside the
  `if draw.is_success()` branch only; the failed-round branch must not change.
- Keep the guard even though Task 2's MAX_POOL_BAR gate makes it unreachable for
  newly drawn rounds: pre-gate configs exist, and it is the invariant the
  retirement count argument rests on.
- Baseline is 130, not the plan's 124.
- Do not touch computed_draw.rs or schedule.rs.
- `gen_vectors` REWRITES crates/daowow-core/tests/vectors/daowow_core_vectors.json,
  a pinned oracle. Diff it and report what moved; do not commit a silent change.

Standing process rulings for the rest of the run: implementers serial, reviews
may overlap; reviews on the cheapest model that can judge the diff; ledger
force-added and committed after every step; a subagent's narrated NUMBERS are
not evidence (a re-review already mis-quoted an allocation by exactly the dust).

## Resumed 2026-09-17 05:30 ACST

CORRECTION to the stop entry above: it claimed Task 3's killed implementer
"committed nothing and left no edits". The first half is right, the second is
WRONG — it had written the RED step: two tests plus a CoreError import in
entitlements/tests.rs, uncommitted. I wrote that line from the agent's own
last message without checking `git status`, and the very next command's output
contradicted it. Same lesson this run already recorded once: a subagent's
narration is not evidence.

Verified the inherited state before building on it rather than reverting:
`a_batch_allocating_zero_to_a_drawn_position_is_refused` fails Ok(...) vs
Err(Conservation), and the returned value shows prize_count: 1 with a single
2-shannon prize — three of four drawn positions allocated zero and were skipped
by the `continue`. That is the exact defect, so the RED is real and not an
artifact. Kept the work; dispatched Task 3 to do steps 3 onward only.

Ruling: keep a killed agent's uncommitted work only after confirming the failure
it leaves behind is red for the RIGHT reason. Reverting would have been safe but
wasteful; accepting it unverified would have risked building the implementation
on a test that passes for an unrelated reason.
Cost if wrong: if those two tests are subtly wrong, the guard gets built against
them. Mitigated — the task review sees them in the diff, since they are
uncommitted and land in Task 3's commit.

Task 3: implementer DONE_WITH_CONCERNS — commit 50ede8e. 132 passing, no_std +
clippy clean, gen_vectors and apps/web/vectors.js regenerated with ZERO diff
(the guard touches no vector fixture), all 4 web tests pass.

It rewrote a pre-existing test, `zero_yield_omits_zero_total_winner_only_records`
-> `a_success_round_with_zero_realized_yield_is_refused`, because the guard is
unconditional on amount == 0 and so also refuses a batch whose realized yield
equals its deposited capacity (prize_pool == 0, every position zero). It flagged
this rather than absorbing it.

Ruling: ACCEPT the rewrite. Checked the old test's body first — it asserted
derive() returns Ok with prize_count == 0 and an empty prize list for a zero-yield
successful round. That is unsound under this sub-project: the retirement universe
is the seal's Σ accepted_batches, which counts a zero-yield batch like any other,
while a winner has no positive prize to record against it, so paid_count could
never reach the universe and EVERY winner of that round would be unretirable.
Refusing is correct.
Cost if wrong: unlike an unyieldable schedule, this has NO graceful void — a
batch's yield is unknown at draw time, so the batch is refused at derivation and
its principal is stranded. Accepted because Nervos DAO's accumulated rate rises
every epoch, making zero yield unreachable for an enforced term; a zero-yield
batch would mean the deposit never matured. Now recorded in the spec, which
previously claimed unqualified that no capacity is stranded.

Task 3: minor (deferred): derive() now returns CoreError::Conservation for both a
malformed batch and a genuine zero-yield round; a caller wanting to distinguish
them has no way to. Diagnosability, not correctness.
Task 3: review spec MET, quality approved, one Important (plan-mandated).
Reviewer mutation-reasoned both tests: reverting the guard to `continue` turns
BOTH red, and they cover genuinely different shapes — partial zero (RED output
showed prize_count: 1 of 4 drawn) and all-zero. Neither is vacuous. Vector
oracles confirmed untouched.

Finding: the code comment I specified in the brief claims the guard is
"unreachable for a round drawn under the viability gate". False, and this same
diff disproves it — MAX_POOL_BAR gates the schedule's weight spread at draw
time and says nothing about realized yield, so a gate-passing round still trips
the guard when prize_pool == 0.
Ruling: fix it. A comment asserting a branch is dead code for current configs is
how a guard gets deleted, and it also contradicts the spec I corrected an hour
ago. Fix round 1 dispatched (comment only, no logic). Corrected the wording at
source in the plan too, so it cannot propagate to a later task's brief.
Cost if wrong: none, comment-only.
Task 3: fix round 1/5 (1 addressed, 0 open — comment rewritten to distinguish
the structural case the draw gate removes from the zero-yield case it does not;
commits 50ede8e..71ff552, comment-only). Scoped re-review dispatched (haiku),
told to judge ACCURACY not merely change, and to flag an overcorrection that
implies the draw gate does nothing.

NOTE for the record: the task-*-report.md files are NOT in git. `.superpowers/sdd/.gitignore`
contains `*`, so only progress.md survives because I force-add it. Verified with
`git check-ignore -v`. The reports are on disk only — a `git clean -fdx` would
destroy them. The ledger is the durable record; reports are convenience.

Task 4 (obligation universe on the seal): dispatched (sonnet), BASE 71ff552,
confined to seal.rs. Told not to weaken the test if building a multi-batch
ledger is hard — a fixture where every shard has 0 or 1 batch would not catch a
summation that ignores per-shard counts.
Task 3: re-review ADDRESSED, no new breakage. The re-reviewer did NOT quote the
comment as instructed, so I read it myself. All three required points are in
fact present and accurate — my first read used a truncating sed range and
appeared to show point 3 missing, which it is not.

Task 3: minor (deferred): the comment says "The seal's accepted-batch count
retires this batch regardless" where "counts this batch" is meant — a batch is
not retired, a claim is. Meaning survives from the rest of the sentence; not
worth a fix round.

Task 3: complete (commits de78023..71ff552, review clean after 1 fix round)
Task 4: implementer DONE — commit 9112849, seal.rs only (+113). 132 -> 134,
no_std + clippy + fmt clean. It built the multi-batch fixture (3,0,5,1) rather
than the easy one, so the asserted total of 9 cannot be produced by counting
non-empty shards. Review dispatched (sonnet).

Correction: my Task 4 dispatch told the implementer seal.rs already had a
`mod tests` block to model its fixture on. It did not — I asserted that without
checking (the seal tests I had seen were in tests/integration/security_seal.rs).
The implementer built one from lifecycle.rs/computed_draw.rs patterns and said
so. Told the reviewer not to penalise the divergence, since the brief's premise
was mine and false.

Task 5 (memento codec): dispatched (sonnet), BASE 9112849, new files
memento.rs + memento/tests.rs plus one line in lib.rs. Told to verify the 193
CKB capacity arithmetic independently and STOP rather than adjust the test if it
disagrees, and not to "correct" the committed sha256 template constant.
Task 4: review spec MET, quality approved, one Minor. The reviewer verified the
fixture rather than trusting it: traced that `accept` is called once per entry
so shards genuinely accumulate 3 and 5 batches (sum 9, which an occupancy-count
bug would report as 3), checked the decode guard's zero-ness invariant holds at
both ends, and checked `close()`'s deadline selection accepts the empty shard.

Task 4: minor (deferred): the doc comment on total_accepted_batches asserts
"every batch of every shard owes every winner a positive amount" as if it were a
property of the seal. It is not — it holds only because entitlements.rs refuses
a zero allocation (Task 3). The comment states a CROSS-MODULE invariant as
intrinsic.
Ruling: defer rather than spend a fix round, but carry the substance forward —
Tasks 6 and 7 build the retirement count argument directly on this function, so
their dispatches will state explicitly that the premise lives in entitlements.rs.
Flagged for the final whole-branch review to decide if it must be fixed before
merge. Cost if wrong: if someone later relaxes the entitlements guard, this
comment still claims the property holds. Real but slow-acting, and the final
review sees it.

Task 4: complete (commits 71ff552..9112849, review clean, 0 fix rounds)
Task 5: implementer DONE — commit a70db65, memento.rs + memento/tests.rs + one
line of lib.rs (+226). 134 -> 141 (7 new), no_std + clippy clean. It ran both
independent checks I required: capacity arithmetic 8+53+78+54 = 193 CKB derived
from the module's own constants, and WINNER_TEMPLATE_SHA256 verified with
sha256sum against the real repo-root ticketWinner.png. Only deviation: rustfmt
alphabetised the `mod` declarations in lib.rs, so `pub mod memento;` sits between
lifecycle and redemption rather than beside claim — cosmetic, gate-required.
Review dispatched (sonnet), told to check each of the six decode rejections is
both enforced AND pinned, and to reason about which could be deleted with the
suite still green.

Task 6 (pure retire decision): dispatched (sonnet), BASE a70db65. This is the
heart of the sub-project — both error directions are financial faults (retire
too early and an owed prize is unclaimable forever; refuse wrongly and the claim
plus its capacity are stranded), and the dispatch says so. Carried the Task 4
deferred minor forward as context: the "every batch owes every winner a positive
amount" premise is enforced in entitlements.rs, not here and not in seal.rs, so
any comment must attribute it there. Also told it to DERIVE the winning and
non-winning identities from the real draw rather than hardcoding a position —
a non-winner test that accidentally picks a winning position asserts nothing.
Task 5: review spec MET, quality approved, no Critical/Important. The reviewer
checked each of the six decode rejections is BOTH enforced and independently
pinned, and confirmed each test mutates exactly one field with the rest valid —
so deleting any single condition turns its named test red. No coverage gap.
It also verified ticket_id parity by reading BOTH call sites rather than
assuming: MementoArgs::ticket_id and ClaimArgs::ticket_id call the same free
function with the same argument order. That parity is what the on-chain
cross-check in Task 8 depends on; if they diverged, the memento would
commemorate a different ticket than the claim it is issued beside.

Task 5: minor (deferred): memento.rs groups the structural and semantic decode
checks into two `if` blocks rather than one per condition; a maintainer adding a
field must re-read the block to see which invariants exist. Stylistic.

Task 5: complete (commits 9112849..a70db65, review clean, 0 fix rounds)
