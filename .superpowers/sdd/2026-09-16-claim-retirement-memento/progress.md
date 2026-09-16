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
