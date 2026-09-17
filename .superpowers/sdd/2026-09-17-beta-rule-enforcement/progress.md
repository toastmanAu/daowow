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
