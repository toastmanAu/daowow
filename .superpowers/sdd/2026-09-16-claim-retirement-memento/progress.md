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
