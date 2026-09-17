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

**Fix round 1** (after review): the two NOT-PINNED findings below (#1, #13)
were reviewed and confirmed real and correctly evidenced, but they get
different treatments per the coordinator's decision:

- **#1** was a genuine coverage gap and has been closed: a new core test,
  `a_winner_with_more_paid_sources_than_the_universe_is_refused`, was added
  to `crates/daowow-core/src/claim/tests.rs` and itself probed (broken,
  confirmed red, restored, confirmed green). Row #1 is now **PINNED**.
- **#13** is a deliberate, correct redundancy, not a gap — removing
  `decode_committed` in favor of relying on `ComputedDraw::new`'s internal
  check would make the contract's authentication of holder-supplied input
  depend on another module's implementation detail. The call was kept
  unchanged and a source comment was added explaining the redundancy is
  intentional. Row #13 is now **unpinnable-by-design (redundant with
  `ComputedDraw::new`)**, alongside row #7.

## Results table

| # | Guard | Broken by | Named test | Verdict |
| - | ----- | --------- | ---------- | ------- |
| 1 | `retire_decision` winner count | `crates/daowow-core/src/claim.rs`: `!=` → `<` | `a_winner_with_more_paid_sources_than_the_universe_is_refused` (core unit, added in fix round 1) | PINNED |
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
| 13 | Schedule commitment check | `contracts/entry-shard-type/src/claim.rs`: `decode_committed` → `decode` | `a_forged_schedule_witness_is_refused` (integration) | **unpinnable-by-design (redundant with `ComputedDraw::new`)** |

13 of 13 rows have a recorded verdict. Row 7 was deliberately not probed per
the brief (unpinnable by design). Of the remaining 12 probed rows: **9
cleanly pinned** (including #1 after fix round 1), **2 pinned-but-masked**,
and **1 unpinnable-by-design** (#13, after fix round 1 — kept as deliberate
defense in depth rather than removed).

## Detail on every non-clean result

### #1 — `retire_decision` winner count: PINNED (fixed in round 1)

Originally found NOT PINNED: breaking `state.paid_count() != universe` into
`state.paid_count() < universe` left the **entire suite green** — not just
the named test, but all 16 `security_retirement` tests, all 3
`claim_retirement` tests, and all 147 core unit tests.

Root cause: `a_winner_one_source_short_is_refused` constructs an
**under-paid** winner (`paid_count = universe - 1`). Both `!=` and `<` reject
`universe - 1 < universe`, so this specific mutation is invisible to that
test. The mutation only changes behavior for an **over-paid** winner
(`paid_count > universe`), which no test in the suite — core or integration —
constructed. A `<` guard would let a claim that has been credited with more
sources than the round's universe retire as a fully-discharged winner.

This was confirmed to be a real coverage gap, not a scoping choice: sources
are genuine and distinct only because other modules (SMT absence proofs over
real batches) guarantee it, and the `!=` in `retire_decision` exists
precisely as defence against that guarantee ever failing. **Fix round 1**
closed the gap: added
`a_winner_with_more_paid_sources_than_the_universe_is_refused` to
`crates/daowow-core/src/claim/tests.rs`, which builds a winner with
`paid_count = universe + 1` and asserts `Err(StateTransition)`. Probed
immediately after writing it:

```
$ cargo test -p daowow-core --lib a_winner_with_more_paid_sources_than_the_universe_is_refused
test claim::tests::a_winner_with_more_paid_sources_than_the_universe_is_refused ... ok

# then broke `!=` -> `<` in crates/daowow-core/src/claim.rs:178
$ cargo test -p daowow-core --lib a_winner_with_more_paid_sources_than_the_universe_is_refused
thread '...' panicked at crates/daowow-core/src/claim/tests.rs:274:5:
assertion `left == right` failed
  left: Ok(Winner { prize_index: 0 })
 right: Err(StateTransition)
test result: FAILED. 0 passed; 1 failed

# also re-confirmed the ORIGINAL named test still stays green under this
# mutation (rebuilt entry-shard-type first) — this is expected and is the
# original finding, unchanged:
$ cargo test --test security_retirement a_winner_one_source_short_is_refused
test a_winner_one_source_short_is_refused ... ok

# restored crates/daowow-core/src/claim.rs via `git checkout --`, rebuilt,
# re-ran: green again (148 passed including the new test)
```

Row #1 is now PINNED by the new test, which is the one the brief's original
named test could not be (by construction, since it only exercises the
under-paid direction).

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

### #13 — Schedule commitment check: unpinnable-by-design (kept, documented, not removed)

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
observable difference of any kind at this call site.

**Fix round 1 decision: keep the call, do not remove it.** Dropping
`decode_committed` in favor of relying on `ComputedDraw::new`'s internal
re-check would make the contract's authentication of the one input the
retiring holder directly supplies (the schedule witness) depend on an
implementation detail of another module. If `ComputedDraw::new` is ever
reordered or relaxed during an unrelated refactor of the draw, the contract
would silently start accepting a holder-forged schedule with nothing at the
contract layer asserting otherwise. The schedule check belongs to the
contract's own precondition, not to the draw module's internal ordering.

A source comment was added directly above the `decode_committed` call in
`contracts/entry-shard-type/src/claim.rs` recording that the redundancy is
deliberate and that no test can distinguish this call from a plain `decode`
at this call site. Row #13 is recorded as **unpinnable-by-design**, alongside
row #7 — not a defect, and not something a future test in this suite should
be built to chase.

## Rows #7 and #13 — unpinnable by design

**Row #7 — claim-side memento duplicate (`found > 1`)**: not probed, per the
brief's explicit instruction. Two memento outputs with byte-identical args
are, by construction, the same type script and therefore one script group
with two members — so the memento binary's own group-size guard (row #6)
fires unconditionally on the same transaction shape, and which of the two
independent guards CKB reports depends on script-hash sort order (a function
of the deployed binary's own code hash). The suite's own file-level `NOTE` in
`tests/integration/tests/security_retirement.rs` documents this in detail
and deliberately does not ship a test for `CLAIM_ERROR_RETIRE`'s `found > 1`
branch in isolation.

**Row #13 — schedule commitment check**: probed in the original pass (see
above), confirmed fully redundant with `ComputedDraw::new`'s own re-check.
Unlike row #7, this redundancy is between two DIFFERENT modules
(`daowow-core::schedule` and `daowow-core::computed_draw`) rather than an
artifact of CKB script-hash ordering, and it was a deliberate design decision
in fix round 1 to keep both checks rather than remove either — see the
detailed writeup above and the new source comment in
`contracts/entry-shard-type/src/claim.rs`.

Neither row is a gap. Both are recorded as **unpinnable-by-design /
deliberate defense in depth**.

## Summary

- **Cleanly pinned (9/12 probed rows)**: `retire_decision` winner count (#1,
  fixed in round 1), non-winner count, viability gate, zero-allocation
  refusal, memento count for a winner, memento lock equality, memento data
  equality, mint claim-input count, mint claim-output count.
- **Pinned but masked (2/12)**: memento group-size guard (#6), `MementoData`
  template check (#12) — both flip the named test red, but via
  `MEMENTO_ERROR_MINT` rather than the guard's own error code, because the
  fixture's absence of any claim cell independently trips the mint-count
  check first.
- **Unpinnable by design (2 of 13 rows, #7 and #13)**: claim-side memento
  duplicate check (`found > 1`, a script-hash-order artifact of row #6), and
  the schedule commitment check in `retire()` (fully redundant with
  `ComputedDraw::new`'s own check — kept intentionally as defense against a
  future change to the draw module, documented in-source rather than
  removed).

No coverage is overstated: 9 of 13 rows are cleanly pinned, 2 are pinned via
an assertion that fires for the right test but the wrong internal mechanism,
and 2 are correctly identified as deliberately unpinnable rather than
defects.

Every original-pass mutation was restored via `git checkout --` and verified
byte-identical to `HEAD` (`git diff` empty) before moving to the next guard,
and the `entry-shard-type` RISC-V binary was rebuilt after every restore.
Fix round 1 added one new permanent test
(`a_winner_with_more_paid_sources_than_the_universe_is_refused`) and one
permanent source comment (above the `decode_committed` call in
`contracts/entry-shard-type/src/claim.rs`); both are committed, not
transient probe scaffolding. The working tree is clean at the end of this
task.

## Task 12: full gate and devnet proof

Contracts were built one package at a time (never rebuilt while the devnet
suite was running), then the full gate ran in order: core unit tests,
`no_std` check, clippy, the `tests/integration` suite, the example build, and
finally the isolated-node devnet suite. Actual counts observed on this run,
not numbers predicted ahead of time:

- `cargo build --target riscv64imac-unknown-none-elf --release -p <name>` for
  all eight packages: clean, no rebuild needed for most (already current from
  Task 10; `round-type`, `entry-lock`, `dao-lock`, `settlement-type`,
  `accumulator-bench`, `smoke-alloc` recompiled trivially, `entry-shard-type`
  and `smoke-minimal` were already up to date).
- `cargo test -p daowow-core --lib`: **148 passed, 0 failed**.
- `cargo check -p daowow-core --no-default-features`: clean.
- `cargo clippy -p daowow-core --lib -- -D warnings`: clean, 0 warnings.
- `cd tests/integration && cargo test --no-fail-fast`: **168 passed, 2
  failed** across 20 test binaries. Per-file counts: `accumulator_bakeoff` 1,
  `claim_lifecycle` 6, `claim_redemption` 5, `claim_retirement` 3,
  `host_repro` 1, `proto1_entry_shard` 5, `proto2_membership` 3,
  `proto3_dao_lifecycle` 30, `proto4_settlement` 16, `round_validation` 8,
  `security_claims` 17, `security_config` 2, `security_entitlements` 1,
  `security_freeze` 1, `security_ledger` 8, `security_redemption` 22,
  `security_refunds` 7, `security_retirement` 16, `security_seal` 2,
  `security_shard_lock` 11, `smoke` 3 passed / 2 failed.
  The 2 failures are exactly the pre-existing `smoke` suite failures named in
  the task brief (`template_contract_runs`, `round_type_binary_as_lock`,
  both a missing-fixture-binary / stale-hash class of failure unrelated to
  this branch) — unchanged.
- **Correction to the brief, verified rather than assumed**:
  `security_redemption.rs::redeeming_the_same_source_twice_is_rejected_by_the_claim`
  was listed as a third known failure (a host-side `in_cap - amount`
  underflow in the test's own setup). On this run it **passed**, both inside
  the full 22-test file run and in isolation (`cargo test --test
  security_redemption redeeming_the_same_source_twice_is_rejected_by_the_claim`),
  reproduced three times, deterministically. `git log` shows the file itself
  has not changed since the referenced commit
  (`4461d8b feat: authenticate claim retirement against the sealed round`);
  no fix to this test or its fixture was made in this task. Recorded as
  observed, not silently corrected and not silently accepted: the "known
  failures" list in the brief and in `docs/HANDOFF-2026-09-16.md` should
  read two pre-existing failures (both in `smoke`), not three, as of this
  commit. Nothing here should be read as this task having fixed it — the
  file was not touched.
- `cargo build -p daowow-integration-tests --examples`: clean, includes the
  new retirement/memento fixture fields on `devnet_round`.
- `DAOWOW_RUN_ISOLATED_NODE=1 python3 -m unittest discover -s tests/devnet -v`:
  see "Devnet proof" below.

### `entry-shard-type` binary size and code-cell cost

228,096 bytes, unchanged by this task (grew from 209,360 bytes to 228,096
bytes across sub-project 3's earlier tasks, confirmed via `wc -c` against the
freshly built binary). A CKB code cell's occupied capacity is 1 CKB per byte
of data plus the 8 CKB capacity field and its lock's own cost; holding
lock/overhead constant, the byte growth alone is **+18,736 CKB** to deploy
this binary versus the pre-sub-project-3 baseline (18,736 additional bytes x
1 CKB/byte). This is a one-time deployment cost, not a per-transaction cost;
it does not affect the mint/transfer/redeem/retire cycle costs below.

### Measured cycles (ckb-testtool, not devnet)

The isolated node does not report CKB-VM cycle counts over RPC, so these were
measured the same way the repo's own benchmarking convention does: via
`ckb_testtool::context::Context::verify_tx`'s `Ok(cycles)` return, already
computed by every existing `expect_ok` call in `tests/integration/tests/`.
`expect_ok` (common/mod.rs) normally discards this value, so it was
temporarily instrumented with an `eprintln!` for one measurement pass against
`claim_retirement.rs`, then reverted with `git checkout --` (confirmed clean,
`git diff` empty) before the devnet run started — no contract or host test
file was left changed by this measurement. `MAX_CYCLES` for this suite is
70,000,000.

| Transaction | Cycles |
| --- | --- |
| Non-winner claim retirement (no memento) | 685,539 |
| Winner claim retirement + memento mint | 759,601 |
| Memento transfer | 58,576 |
| Memento burn | 55,441 |

All four are well under the suite's cycle ceiling; the retire paths cost
roughly an order of magnitude more than a bare memento transfer/burn because
they authenticate the sealed round from cell deps (config + entropy record)
and re-derive the computed draw, whereas transfer/burn only check the
memento's own group.

### Devnet proof

Extended `tests/devnet/test_round_creation.py` with a new test method,
`test_sealed_round_retires_to_completion`, calling the existing
`run_history(reorg=False, partial=True, partial_full=True, retire=True)` —
a new `retire` keyword, default `False`, added to `run_history`'s signature
so none of the other seven existing test methods change behavior. The new
`retire=True` path only runs inside the block already gated on `partial and
partial_full` (the only existing branch that reaches a completed redemption
and payout with two live claims), so no other test's code path is touched.

The scenario needed a genuine non-winner claim living alongside a genuine
winner in one sealed round to prove both `retire_decision` branches on a
real node. The existing `partial` fixture already provides this for free:
its excluded entry (shard 0, position 1) is refunded on its own principal
cell but its separately-minted claim NFT (entry_tx output index 5) is never
touched again by any existing step — it is a real, live, never-redeemed
claim once the round is sealed, exactly the non-winner case. The accepted
entry's claim (index 4, later index 1 of `redeem_hash`) is the schedule's
sole winner (a one-weight schedule over a one-ticket accepted universe draws
that ticket unconditionally) and had already redeemed the round's one and
only batch via the pre-existing `redeem` step.

New Rust exporter fields, added to `tests/integration/examples/devnet_round.rs`
inside the existing `settlement` (10-arg) branch — no new invocation, no
new fixture stage, since every value needed was already in scope where the
redemption fixture is built:

- `settlement.retirement.schedule_raw`: the committed prize schedule's raw
  canonical bytes (`schedule.encode()`), exactly as `retire()` expects them
  at the retiring claim's own group-input witness (not wrapped in a
  `WitnessArgs`, unlike the round-creation witness).
- `settlement.retirement.memento`: the winning ticket's fully authenticated
  memento identity, data, and occupied capacity — `type` from
  `MementoArgs{commitment, shard_id: 0, position: 0}`, `data` from
  `MementoData{renderer_version: MEMENTO_RENDERER_V1, prize_index, paid_count,
  paid_total}` using the real `ComputedDraw` rank and the post-redemption
  `PrizeRedemptionState`, and `capacity` from
  `memento_occupied_capacity(lock_size)`.

New `tests/devnet/retirement_history.py` module (mirrors the existing
per-stage modules `refund_history.py`, `reorg_history.py`,
`settlement_reorg.py` rather than growing `run_history` further) drives three
transactions:

1. **Non-winner retirement** — input the excluded entry's claim, output a
   plain cell (no type) at the claim's own full occupied capacity, cell deps
   = protocol deps + the entropy record cell, witness = the raw schedule
   bytes. A negative case (same tx minus the entropy-record cell dep) is
   checked first and must fail `ValidationFailure`.
2. **Winner retirement with memento** — input the redeemed winning claim,
   output the memento cell (its exported type/data/capacity) under the same
   holder lock, same cell deps and witness. A negative case (memento minted
   under a different holder lock) is checked first and must fail
   `ValidationFailure`.
3. **Memento transfer** — input the just-minted memento, output the same
   memento under a different lock, byte-identical data, no authenticating
   witness needed (the memento's own transfer mode only checks data
   equality) — but it does still need `protocol_deps` as a cell dep, for the
   input's own holder LOCK script to be loadable, exactly like every other
   transaction in this file that spends a fixture-locked cell.

### Devnet outcome: real bugs found and fixed, then a clean pass

**First full-gate run** (`unittest discover`, 16 tests across
`test_native_dao.py`, `test_node_harness.py`, `test_round_creation.py`, 1452s):
15 of 16 passed — every pre-existing test unaffected by this task's changes,
first try. The 16th, the new `test_sealed_round_retires_to_completion`, got
through the entire pre-existing round lifecycle (creation, entry, freeze,
aggregation, partial refund, seal, entropy, DAO withdrawal and payout, prize
redemption) and into the new retirement code before failing on the very
first new transaction:

```
RuntimeError: send_transaction: {'code': -1104, 'message':
'PoolRejectedTransactionByMinFeeRate: The min fee rate is 1000 shannons/KW,
requiring a transaction fee of at least 499 shannons, but the fee provided
is only 0', ...}
```

Root cause: the non-winner retirement transaction (and, latently, the
memento transfer transaction) set the output capacity exactly equal to the
input capacity — a real fee of zero. `ckb-testtool`'s mock verifier has no
fee-rate policy and would have accepted this without complaint; the real
node's transaction pool rejects it before any script runs at all, so the
`assertRaisesRegex(RuntimeError, "ValidationFailure")` negative check
(expecting the *script* to reject a missing cell dep) instead saw a
different `RuntimeError` about pool fee policy and failed the test. This is
a devnet-only class of bug: nothing in the entire mutation-probe pass or the
`tests/integration` suite could have caught it, because neither exercises
real fee-rate policy.

Every other value-preserving step in `test_round_creation.py` already
avoids this by deducting a 100,000-shannon fee reserve from a change or
output cell; the fix applies the same convention to the new transactions.
For the memento (minted at its bare minimum occupied capacity, with no
slack), deducting a fee from the *transfer* step would have dropped it
below its own minimum required capacity — a different, system-level
rejection. Fix: mint the memento with a 100,000-shannon buffer above its
bare minimum, and let the transfer consume exactly that buffer as its fee,
landing back at exactly the bare minimum with no capacity double-charge.

**First targeted re-run** (`unittest test_round_creation.RoundCreationTests.test_sealed_round_retires_to_completion`
only, no contract rebuild, 214.5s): both retirement transactions succeeded
end to end (non-winner retired, winner retired with memento minted) and
failed on the memento transfer:

```
RuntimeError: send_transaction: {'code': -302, 'message':
'TransactionFailedToVerify: Verification failed Script(TransactionScriptError
{ source: Inputs[0].Lock, cause: ScriptNotFound: code_hash: ... })', ...}
```

Root cause: the transfer transaction was built with `cell_deps: []`. On
`ckb-testtool`, a deployed cell's code is available to any transaction in
the same `Context` with no cell dep bookkeeping; on a real node, the
input's own holder lock script (the fixture's `smoke-minimal` code) must be
named as a cell dep regardless of whether any type script is involved — a
plain lock-only transfer is not exempt. Every other transaction in this
file that spends a fixture-locked cell already includes `protocol_deps` for
exactly this reason (e.g. the `payout` transaction); the new transfer
transaction had simply been written on the (wrong) assumption that a
content-only transfer needs no deps at all. Fix: `cell_deps: protocol_deps`.

**Second targeted re-run** (same single test, no contract rebuild, 215.0s):
**clean pass.** All three new transactions committed on the isolated node:

- Non-winner claim retirement: `0x3f26a166e15bab0d959da5cb151a8fe875db6636fe4b8238293cc3170d4b5029`,
  recovered capacity `0x4fb888f60` = 21,399,900,000 shannons (213.999 CKB —
  the claim's full 214 CKB occupied capacity minus the 100,000-shannon fee).
- Winner claim retirement with memento mint: `0xe639f2f44803feeb6b4fbb87f50a28b7acd282d48c9c0439931b2e71acdcdfb9`.
- Memento transfer: `0x745d7241ea514812c37215e59830f7ac280059343a37ff67c4d670a487e79300`.

Both negative cases (missing entropy-record cell dep on the non-winner
retirement; memento minted under the wrong holder lock) were confirmed to
reject with `ValidationFailure` before each corresponding positive
transaction was committed.

**Scope of what was and was not re-verified after the fix**: the two
targeted re-runs exercised only `test_sealed_round_retires_to_completion`,
not the full `unittest discover` a third time. The other 15 tests (all of
`test_native_dao.py`, `test_node_harness.py`, and the other 7
`test_round_creation.py` methods) were confirmed passing in the first
full-gate run and were not touched by either fix — both fixes are confined
to the new `retirement_history.py` module and change nothing any other test
exercises. Per the task's own guidance not to burn devnet runs chasing
problems once one clean run of the new scenario is achieved, a third full
discovery run was not performed. No contract binary was rebuilt at any
point across the initial run or either retry.

**Two new traps for `~/.claude/rules/ckb-transactions.feedback.md`**, both
from this devnet session, both invisible to `ckb-testtool`:

- A `ckb-testtool` mock transaction with input capacity exactly equal to
  output capacity (zero real fee) passes the mock verifier fine; a real
  node's transaction pool rejects it with `PoolRejectedTransactionByMinFeeRate`
  before any script runs. Any devnet-bound transaction that intentionally
  preserves capacity across a spend (a retirement, a plain transfer) needs
  an explicit fee deducted from *somewhere* — this codebase's convention is
  a flat 100,000-shannon reserve taken from a change or output cell. When
  the spent output is already at its bare minimum occupied capacity (no
  slack to deduct from without going under), the fee buffer has to be added
  one step earlier, at mint time, and consumed at spend time — not
  invented out of nowhere at the spend itself.
- `ckb-testtool`'s `Context` makes every deployed cell's code available to
  every transaction with no cell-dep bookkeeping at all; a real node
  requires the INPUT'S OWN LOCK script's code cell as an explicit cell dep
  on every spend, independent of whether any type script is present or
  cares. A lock-only, content-only transfer transaction is not exempt from
  this — omitting cell deps because "nothing but the lock runs" produces
  `ScriptNotFound` on `Inputs[0].Lock` on a real node while working
  perfectly in every mock-based unit and integration test.
