# Mutation probe record: retirement and memento guards

Task 10 of the `2026-09-16-claim-retirement-memento` plan. Each guard listed
in the task-9 brief's probe table was broken one at a time, the named test
was run to confirm it goes red on the expected assertion, then the file was
restored (`git checkout --`) and re-verified green before moving to the next
guard. Contract-source and `daowow-core` mutations that affect the
`entry-shard-type` RISC-V binary were rebuilt with
`cargo build --target riscv64imac-unknown-none-elf --release -p entry-shard-type`
before running the integration test, and rebuilt again after restoring.

Baseline (confirmed before and after every probe): `cargo test -p daowow-core
--lib` → 147 passed; `tests/integration` `security_retirement` → 16/16;
`claim_retirement` → 3/3.

## Results table

| # | Guard | Broken by | Named test | Verdict |
| - | ----- | --------- | ---------- | ------- |
| 1 | `retire_decision` winner count | `crates/daowow-core/src/claim.rs`: `!=` → `<` | `a_winner_one_source_short_is_refused` (integration) | **NOT PINNED** |
| 2 | `retire_decision` non-winner count | `crates/daowow-core/src/claim.rs`: dropped `paid_count() != 0` | `a_non_winner_carrying_payments_is_refused` (core unit) | PINNED |
| 3 | Viability gate | `crates/daowow-core/src/computed_draw.rs`: dropped the `min_viable_pool` term | `an_unyieldable_schedule_voids_the_round` (core unit) | PINNED |
| 4 | Zero-allocation refusal | `crates/daowow-core/src/entitlements.rs`: `return Err(Conservation)` → `continue` | `a_batch_allocating_zero_to_a_drawn_position_is_refused` (core unit) | PINNED |
| 5 | Memento count for a winner | `contracts/entry-shard-type/src/claim.rs`: dropped `expected_index.is_some() && found != 1` check | `a_winner_retiring_with_no_memento_is_refused` (integration) | PINNED |
| 6 | Memento group-size guard | `contracts/entry-shard-type/src/memento.rs`: dropped `load_cell(1, Group*)` check | `two_mementos_of_one_identity_are_refused` (integration) | **PINNED, but masked** |
| 7 | Claim-side memento duplicate (`found > 1`) | — | — | **UNPINNABLE by design** (per brief; see note below) |
| 8 | Memento lock equality | `contracts/entry-shard-type/src/claim.rs`: dropped the lock comparison | `a_memento_locked_to_a_stranger_is_refused` (integration) | PINNED |
| 9 | Memento data equality | `contracts/entry-shard-type/src/claim.rs`: dropped `data != expected` branch | `a_memento_with_the_wrong_winnings_is_refused` (integration) | PINNED |
| 10 | Memento mint claim-input count | `contracts/entry-shard-type/src/memento.rs`: dropped the `Input` count check | `a_memento_minted_with_no_retiring_claim_is_refused` (integration) | PINNED |
| 11 | Memento mint claim-output count | `contracts/entry-shard-type/src/memento.rs`: dropped the `Output` count check | `a_memento_minted_beside_a_transferring_claim_is_refused` (integration) | PINNED |
| 12 | `MementoData::decode` template | `crates/daowow-core/src/memento.rs`: dropped `data[2..34] != WINNER_TEMPLATE_SHA256` | `a_memento_with_a_substituted_template_is_refused` (integration) | **PINNED, but masked** |
| 13 | Schedule commitment check | `contracts/entry-shard-type/src/claim.rs`: `decode_committed` → `decode` | `a_forged_schedule_witness_is_refused` (integration) | **NOT PINNED** |

12 of 13 rows were probed (row 7 is deliberately excluded per the brief). Of
those 12: **8 cleanly pinned**, **2 pinned-but-masked**, **2 not pinned**.

## Detail on every non-clean result

### #1 — `retire_decision` winner count: NOT PINNED

Breaking `state.paid_count() != universe` into `state.paid_count() < universe`
left the **entire suite green** — not just the named test, but all 16
`security_retirement` tests, all 3 `claim_retirement` tests, and all 147 core
unit tests.

Root cause: `a_winner_one_source_short_is_refused` constructs an
**under-paid** winner (`paid_count = universe - 1`). Both `!=` and `<` reject
`universe - 1 < universe`, so this specific mutation is invisible to that
test. The mutation only changes behavior for an **over-paid** winner
(`paid_count > universe`), which no test in the suite — core or integration —
constructs. A `<` guard would let a claim that has been credited with more
sources than the round's universe retire as a fully-discharged winner.

**What a correct test needs**: a case with `state.paid_count() > universe`
for a winner, asserting `Err(StateTransition)`. This is a real gap, not a
scoping choice — `record_verified_prize` conservatively increments
`paid_count`, and nothing else in the pipeline appears to independently rule
out an over-count reaching `retire_decision`. Flagging for follow-up rather
than fixing here, per the task's instruction not to patch findings from this
verification pass.

### #6 — Memento group-size guard: PINNED, but masked

Breaking `load_cell(1, Source::GroupInput).is_ok() ||
load_cell(1, Source::GroupOutput).is_ok()` in `memento.rs::run` does flip
`two_mementos_of_one_identity_are_refused` from green to red — but via
`MEMENTO_ERROR_MINT` (-103), not the expected `MEMENTO_ERROR_GROUP` (-102):

```
assertion `left == right` failed: unexpected failure: ...
  left: -103
 right: -102
```

Cause: this test's transaction has **no claim cell at all** (only an
always-success funding input), by design, to isolate the memento group from
any competing claim-side group. With the group-size guard removed, `run()`
still reaches the mint branch for group-output index 0, and the mint branch's
own `count_with_args(claim, Input) != 1` check (0 claims present) rejects
independently with `MEMENTO_ERROR_MINT`. So the test **does** detect this
mutation (assert fails → red), but not because the group-size guard's own
mechanism fired — an unrelated, always-present guard (the mint claim count)
happens to reject the same fixture for a different reason.

This means the test does not, on its own, prove the group-size guard is
load-bearing against a duplicate-memento mint that *does* have a genuine
retiring claim present (count == 1) — which is exactly the scenario the
suite's own file-level `NOTE` says is structurally unisolatable (a hash-order
race against the claim's own `found > 1` check, i.e. row #7). So the
group-size guard's unique contribution is only exercised in a scenario this
suite explicitly cannot build. Recording as pinned (the assertion does fire
and does distinguish behavior from baseline) but flagging the masking so it
is not read as full confidence in the specific mechanism.

### #12 — `MementoData::decode` template: PINNED, but masked

Same masking pattern as #6, on the decode side. Breaking
`data[2..34] != WINNER_TEMPLATE_SHA256` inside `MementoData::decode` flips
`a_memento_with_a_substituted_template_is_refused` from green to red, but via
`MEMENTO_ERROR_MINT` (-103), not the expected `MEMENTO_ERROR_DATA` (-101):

```
assertion `left == right` failed: unexpected failure: ...
  left: -103
 right: -101
```

Cause: identical to #6 — this is a memento-only mint with no claim in the
transaction (by design, to isolate the memento group). Originally,
`MementoData::decode` fails on the corrupted template byte and `run()`
returns `MEMENTO_ERROR_DATA` immediately, **before** the mint-count check is
ever reached. With the template check removed, `decode` succeeds, execution
falls through to the mint branch, and `count_with_args(claim, Input) != 1`
(0 claims present) rejects independently with `MEMENTO_ERROR_MINT`.

Broader implication: **every** "memento-only mint" test in this suite
(funding cell as the only input, no claim) will *always* also fail the
mint-count check regardless of what else is wrong with the memento's content,
because minting with zero claims present is itself always rejected. Any test
targeting a check that lives inside `MementoData::decode` is therefore only
provably independent of the mint-count check as long as `decode` itself is
the thing that fails first — which is true at HEAD, but is not verified by
this test once decode's own check is the thing under mutation. Recording as
pinned (test flips red) with the same caveat as #6.

### #13 — Schedule commitment check: NOT PINNED

Breaking `PrizeSchedule::decode_committed(&witness, &cfg.prize_schedule_hash)`
into plain `PrizeSchedule::decode(&witness)` in
`contracts/entry-shard-type/src/claim.rs::retire` left the **entire suite
green** — all 16 `security_retirement` tests (including the named
`a_forged_schedule_witness_is_refused`, byte-for-byte the same pass, not even
a different error code), all 3 `claim_retirement` tests, and all 147 core
unit tests.

Root cause: `decode_committed` does exactly two things — decode, then check
`schedule.commitment() != expected`. Plain `decode` skips the second check.
But immediately afterward, `retire()` calls
`ComputedDraw::new(&cfg, &record, &schedule)`, and `ComputedDraw::new` itself
re-validates the identical property:

```rust
if schedule.commitment() != cfg.prize_schedule_hash
    || record.seal().ledger(cfg.entry_shard_count).is_some()
{
    return Err(CoreError::StateTransition);
}
```

Both call sites map their error to the same code (`CLAIM_ERROR_UNIVERSE`), so
this is not merely masked by a different guard producing a different visible
code (as in #6/#12) — it is **fully redundant**, byte-for-byte, with no
observable difference of any kind. `decode_committed`'s own commitment check
contributes nothing beyond what `ComputedDraw::new` already enforces on this
code path.

**What a correct test needs**: this specific redundancy cannot be pinned by
any test that also exercises `ComputedDraw::new` on the same schedule value —
which every current caller does. Pinning `decode_committed`'s check would
require either (a) a direct unit test of `PrizeSchedule::decode_committed`
itself (bypassing `retire()`/`ComputedDraw::new` entirely — this exists at
`crates/daowow-core/src/schedule.rs`'s own test module for the pure function,
separately from this contract-level suite), or (b) accepting that at the
contract-integration level this is deliberate defense in depth, not a
distinct enforced property. Recording as not pinned **at the integration
level tested here**; not asserting whether a core-level unit test for
`decode_committed` exists or suffices, since that is out of this task's scope
(the brief pointed at the integration test specifically).

## Row #7 — claim-side memento duplicate (`found > 1`): unpinned by design

Not probed, per the brief's explicit instruction. Two memento outputs with
byte-identical args are, by construction, the same type script and therefore
one script group with two members — so the memento binary's own group-size
guard (row #6) fires unconditionally on the same transaction shape, and which
of the two independent guards CKB reports depends on script-hash sort order
(a function of the deployed binary's own code hash). The suite's own
file-level `NOTE` in `tests/integration/tests/security_retirement.rs`
documents this in detail and deliberately does not ship a test for
`CLAIM_ERROR_RETIRE`'s `found > 1` branch in isolation. Recorded here as
**unpinned by design / deliberate defense in depth**, not a gap.

## Summary

- **Cleanly pinned (8/12 probed rows)**: non-winner count, viability gate,
  zero-allocation refusal, memento count for a winner, memento lock equality,
  memento data equality, mint claim-input count, mint claim-output count.
- **Pinned but masked (2/12)**: memento group-size guard (#6), `MementoData`
  template check (#12) — both flip the named test red, but via
  `MEMENTO_ERROR_MINT` rather than the guard's own error code, because the
  fixture's absence of any claim cell independently trips the mint-count
  check first.
- **Not pinned (2/12)**: `retire_decision` winner-count `!=`-vs-`<` (#1, a
  real coverage gap — no test anywhere exercises an over-paid winner), and
  the schedule commitment check `decode_committed`-vs-`decode` in
  `retire()` (#13, fully redundant with `ComputedDraw::new`'s own check, no
  test can distinguish them at this call site).
- **Unpinnable by design (1/13, not counted above)**: claim-side memento
  duplicate check (`found > 1`), per the brief.

Every mutation was restored via `git checkout --` and verified byte-identical
to `HEAD` (`git diff` empty) before moving to the next guard, and the
`entry-shard-type` RISC-V binary was rebuilt after every restore. The
working tree is clean at the end of this task; no new tests or production
fixes were written, per the task's instruction to record findings rather
than patch them.
