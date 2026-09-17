# Gate 1: beta rule enforcement — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the contracts enforce the beta's immutable rules, so a wallet flow
can be built against rules the protocol keeps rather than rules a document
promises.

**Architecture:** Three small changes. The append path gains an opening check
(`since` is a lower bound, which is exactly the shape this rule needs).
`RoundConfigV1::validate` gains two guards so the beta's decisions cannot be
configured away. The devnet gains a round proving every deposit starts and
finishes inside a bounded window.

**Tech Stack:** Rust `no_std` on `riscv64imac-unknown-none-elf` for contracts,
`std` host tests in `daowow-core`, `ckb-testtool` for VM suites, Python
`unittest` driving an isolated Docker CKB node.

**Spec:** `docs/superpowers/specs/2026-09-17-beta-rule-enforcement-design.md`

## Global Constraints

- `daowow-core` must stay `no_std`-clean: `cargo check -p daowow-core --no-default-features`.
- Clippy gate: `cargo clippy -p daowow-core --lib -- -D warnings`. Note the gate
  is `--lib` only; test-code lints are not enforced by this project.
- `cargo fmt --all` before every commit.
- Contracts build ONE PACKAGE AT A TIME (the workspace contains std crates):
  `cargo build --target riscv64imac-unknown-none-elf --release -p entry-shard-type`
- Never rebuild a contract binary while the devnet suite runs; each test deploys
  the binaries fresh.
- Commit messages are `<type>: <description>` ending with:
  `Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>`
- Beta values from the spec: `ticket_price = 1000 CKB` (100_000_000_000
  shannons), `maximum_tickets = 200`, `minimum_tickets = 50`,
  `entry_shard_count = 1`.
- Baselines to confirm before starting, not to assume: core 148 passing;
  integration 171 passed / 2 failed (two known pre-existing `smoke` failures,
  `template_contract_runs` and `round_type_binary_as_lock` — do not try to fix
  them).

## Two ripples found before writing this plan

Both were measured, not predicted. Handle them as described or the suite breaks.

**1. Every existing append test uses `since = 0`.** Appends are built as
`CellInput::new(shard_op, 0)`. `absolute_epoch_number` requires
`since >> 56 == 0x20` (the absolute-epoch flag), so a plain `0` is
`InvalidArgument`, not epoch zero. An unconditional opening check would fail
every append test in the repository and the devnet with it.

The resolution is not a workaround, it is the rule being vacuous: when
`entry_start == 0` the round opens at epoch 0, every epoch is at or after that,
and there is nothing to check. Task 1 therefore applies the check only when
`cfg.entry_start != 0`. A production config sets a real `entry_start`, so the
check binds where it matters.

**2. `crates/daowow-core/src/shard.rs`'s test fixture sets
`maximum_tickets: 1000` with `entry_shard_count: 4`,** which the Task 2 guard
rejects. Task 2 fixes it by leaving the base fixture uncapped and having the
cap-specific tests set `entry_shard_count = 1` alongside the cap — which is also
the only configuration in which a cap means what those tests assert.

## File structure

| File | Responsibility |
| --- | --- |
| `crates/daowow-core/src/error.rs` | add `SHARD_ERROR_NOT_OPEN` |
| `contracts/entry-shard-type/src/main.rs` | the opening check in the `(OPEN, OPEN)` arm |
| `crates/daowow-core/src/encoding.rs` | the two `validate` guards |
| `crates/daowow-core/src/shard.rs` | fixture fix for the cap guard |
| `tests/integration/tests/security_entry_window.rs` (new) | adversarial opening cases |
| `tests/devnet/` | bounded lock-window evidence |
| `docs/beta-rule-enforcement-audit.md`, `docs/HANDOFF-2026-09-16.md` | record closure |

---

### Task 1: Entry opening enforcement

**Files:**
- Modify: `crates/daowow-core/src/error.rs` (shard code range, after `SHARD_ERROR_CLAIM_CELL: i8 = -38`)
- Modify: `contracts/entry-shard-type/src/main.rs` (the `(SHARD_STATE_OPEN, SHARD_STATE_OPEN)` match arm)
- Create: `tests/integration/tests/security_entry_window.rs`

**Interfaces:**
- Consumes: `daowow_core::epoch::absolute_epoch_at_least(since, deadline) -> Result<(), CoreError>`, already used by the freeze arm
- Produces: `SHARD_ERROR_NOT_OPEN: i8 = -39`

- [ ] **Step 1: Add the error code**

In `crates/daowow-core/src/error.rs`, after `SHARD_ERROR_CLAIM_CELL`:

```rust
    /// An append landed before the round's `entry_start`. Distinct from
    /// SHARD_ERROR_FROZEN, which is the closing side of the same window.
    pub const SHARD_ERROR_NOT_OPEN: i8 = -39;
```

- [ ] **Step 2: Write the failing VM tests**

Two facts you need, both checked before this plan was written:

- The shared harness config sets `entry_start: 0` (`tests/integration/tests/common/mod.rs:111`),
  which makes the new check vacuous by design. Your round MUST use a non-zero
  `entry_start` or these tests prove nothing.
- The existing append builder hardcodes the input `since`:
  `.input(CellInput::new(shard_op.clone(), 0))` at
  `tests/integration/tests/proto1_entry_shard.rs:81`. You need a variant that
  takes the `since` as a parameter. Copy that builder into your new file and
  parameterise it rather than editing the shared one — other suites depend on
  its current shape.

Create `tests/integration/tests/security_entry_window.rs`. Write this test in
full first; the other two are the same transaction with a different `since` and
a different expectation.

```rust
mod common;
use common::*;
use daowow_core::epoch::ABSOLUTE_EPOCH_FLAG;
use daowow_core::error::codes::SHARD_ERROR_NOT_OPEN;

/// An append landing one epoch before the round opens is refused.
///
/// `since` is a lower bound, so "not before `entry_start`" is exactly what it
/// can express. The closing side of the same window cannot be a check at all —
/// it is enforced by the freeze transition, which is why only opening is
/// implemented here.
#[test]
fn an_append_before_entry_start_is_refused() {
    let mut w = World::new(ACC_MMR);
    // entry_start = 100, entry_end = 200, aggregation_deadline = 300
    let (round_op, shard_op, cfg) = open_round_with_entry_start(&mut w, 100, 200, 300);
    let tx = append_with_since(
        &mut w,
        &round_op,
        &shard_op,
        &cfg,
        ABSOLUTE_EPOCH_FLAG | 99,
    );
    expect_code(&mut w.context, &tx, SHARD_ERROR_NOT_OPEN);
}
```

Then the two variants:

| Test | `since` passed | Expected |
| --- | --- | --- |
| `an_append_at_entry_start_is_accepted` | `ABSOLUTE_EPOCH_FLAG \| 100` | `expect_ok` — the boundary is inclusive |
| `a_block_number_since_is_refused` | `100` (no flag) | `SHARD_ERROR_NOT_OPEN` — `absolute_epoch_number` requires `since >> 56 == 0x20`, so a bare block number must not be read as an epoch |

Write `open_round_with_entry_start(world, start, end, deadline)` and
`append_with_since(world, round_op, shard_op, cfg, since)` in this file, adapting
the round/shard/entry construction from `proto1_entry_shard.rs`. `expect_code`
must assert the EXACT `i8`; never a broad match. If your fixture ends up with a
second script group that could also reject, say so in your report rather than
widening the assertion — an exact code is only meaningful when one group can
refuse.

- [ ] **Step 3: Run the tests to verify they fail**

Run: `cd tests/integration && cargo test --test security_entry_window`
Expected: the two rejection tests FAIL because the append currently succeeds;
`an_append_at_entry_start_is_accepted` passes already.

- [ ] **Step 4: Write the implementation**

In `contracts/entry-shard-type/src/main.rs`, replace the append arm:

```rust
        (SHARD_STATE_OPEN, SHARD_STATE_OPEN) => {
            // Opening enforcement. `since` is a lower bound, so "not before
            // entry_start" is exactly the shape it can express — unlike the
            // closing side, which cannot be a check at all and is enforced by
            // the freeze transition instead.
            //
            // When entry_start is 0 the constraint is vacuous: the round opens
            // at epoch 0 and every epoch is at or after that. Skipping the
            // check there keeps every transaction that does not need an epoch
            // `since` from being forced to carry one.
            if cfg.entry_start != 0 {
                let since = match ckb_std::high_level::load_input_since(0, Source::GroupInput) {
                    Ok(s) => s,
                    Err(_) => return err(SHARD_ERROR_NOT_OPEN),
                };
                if daowow_core::epoch::absolute_epoch_at_least(since, cfg.entry_start).is_err() {
                    return err(SHARD_ERROR_NOT_OPEN);
                }
            }
            append(&cfg, &before, &after, &claims)
        }
```

- [ ] **Step 5: Build and verify the tests pass**

Run:
```bash
cargo build --target riscv64imac-unknown-none-elf --release -p entry-shard-type
cd tests/integration && cargo test --test security_entry_window
```
Expected: 3 passed.

- [ ] **Step 6: Verify nothing else broke**

Run: `cd tests/integration && cargo test --no-fail-fast`
Expected: the same counts as your recorded baseline, plus your 3 new tests, with
only the two known `smoke` failures. If an append test elsewhere now fails, the
`entry_start != 0` guard is wrong or missing — investigate rather than adjusting
that test.

- [ ] **Step 7: Prove the guard bites**

Delete the `if cfg.entry_start != 0 { ... }` block entirely, rebuild, and run
`security_entry_window`. Both rejection tests must go RED. Restore it exactly
(`git diff` on the file must be empty against HEAD), rebuild, confirm green.
Put that round-trip output in your report — this project's standing lesson is
that a green suite is not evidence any particular guard works.

- [ ] **Step 8: Commit**

```bash
git add crates/daowow-core/src/error.rs contracts/entry-shard-type/src/main.rs \
        tests/integration/tests/security_entry_window.rs
git commit -m "feat: enforce the round's entry opening on the append path

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: Configuration guards

**Files:**
- Modify: `crates/daowow-core/src/encoding.rs` (inside `RoundConfigV1::validate`, after the `entry_shard_count` rule)
- Modify: `crates/daowow-core/src/shard.rs` (test fixture at ~line 172 and the cap tests at ~line 273)
- Test: `crates/daowow-core/src/encoding.rs` `mod tests`

**Interfaces:**
- Consumes: nothing new
- Produces: two additional `CoreError::InvalidArgument` rejections from `RoundConfigV1::validate`

- [ ] **Step 1: Write the failing tests**

Add to the `mod tests` block in `encoding.rs`, following the file's existing
config-validation test style:

```rust
    #[test]
    fn a_capped_round_must_be_single_shard() {
        // The cap check in shard.rs compares ONE shard's ticket count against
        // maximum_tickets. That is an exact round-wide cap at one shard and a
        // per-shard cap above it, so a multi-shard round would silently accept
        // up to shard_count times the advertised number. Refuse the config
        // rather than let the advertised cap become wrong.
        let mut cfg = sample_config();
        cfg.maximum_tickets = 200;
        cfg.entry_shard_count = 1;
        assert!(cfg.validate().is_ok());
        cfg.entry_shard_count = 2;
        assert_eq!(cfg.validate(), Err(CoreError::InvalidArgument));
    }

    #[test]
    fn an_uncapped_round_may_have_many_shards() {
        // maximum_tickets == 0 is the uncapped path; there is no advertised
        // number to get wrong, so sharding stays available.
        let mut cfg = sample_config();
        cfg.maximum_tickets = 0;
        cfg.entry_shard_count = 4;
        assert!(cfg.validate().is_ok());
    }

    #[test]
    fn a_round_cannot_require_more_tickets_than_it_allows() {
        // A round whose minimum exceeds its cap can never succeed and would
        // strand every entrant's principal until the failed-round path runs.
        let mut cfg = sample_config();
        cfg.entry_shard_count = 1;
        cfg.maximum_tickets = 200;
        cfg.minimum_tickets = 50;
        assert!(cfg.validate().is_ok());
        cfg.minimum_tickets = 201;
        assert_eq!(cfg.validate(), Err(CoreError::InvalidArgument));
        // exactly equal is legal: a must-fill round is a valid configuration
        cfg.minimum_tickets = 200;
        assert!(cfg.validate().is_ok());
    }
```

`sample_config()` is whatever the existing `encoding.rs` tests use to build a
valid `RoundConfigV1` — read the module and reuse it. If there is no such
helper, build the config inline the way the neighbouring tests do.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cargo test -p daowow-core --lib encoding::tests`
Expected: `a_capped_round_must_be_single_shard` and
`a_round_cannot_require_more_tickets_than_it_allows` FAIL — `validate` currently
accepts both.

- [ ] **Step 3: Write the implementation**

In `RoundConfigV1::validate`, immediately after the existing
`entry_shard_count` rule:

```rust
        // A cap is only round-wide at one shard: shard.rs compares a single
        // shard's ticket count against maximum_tickets, so a multi-shard round
        // would accept up to entry_shard_count times the advertised cap.
        // Refuse the configuration rather than let the advertised number be
        // wrong. Uncapped rounds (maximum_tickets == 0) may shard freely.
        if self.maximum_tickets != 0 && self.entry_shard_count > 1 {
            return Err(CoreError::InvalidArgument);
        }
        // A round that cannot reach its own minimum is unsatisfiable.
        if self.maximum_tickets != 0 && self.minimum_tickets > self.maximum_tickets {
            return Err(CoreError::InvalidArgument);
        }
```

- [ ] **Step 4: Fix the shard.rs fixture the guard now rejects**

`crates/daowow-core/src/shard.rs`'s test config sets `maximum_tickets: 1000`
with `entry_shard_count: 4`, which the first guard refuses. Change the base
fixture to `maximum_tickets: 0` (uncapped, valid at 4 shards), and in the
cap-specific tests — the ones that set `c.maximum_tickets = 10` around line 273
— also set `c.entry_shard_count = 1`. That is the only configuration in which
the cap means what those tests assert, so this makes them more correct, not just
compatible.

- [ ] **Step 5: Run the full core suite**

Run: `cargo test -p daowow-core --lib`
Expected: your recorded baseline plus 3, all passing. If a test outside
`encoding` or `shard` fails, another fixture sets a cap with multiple shards —
find and fix it the same way rather than weakening the guard.

- [ ] **Step 6: Prove each guard bites separately**

One at a time, never both: delete the shard guard, confirm
`a_capped_round_must_be_single_shard` goes RED and the other two stay green;
restore. Delete the minimum guard, confirm
`a_round_cannot_require_more_tickets_than_it_allows` goes RED; restore. Record
both round trips. Two guards added together are exactly the case where a single
combined check can pass while neither is individually pinned.

- [ ] **Step 7: Check no_std, clippy and format**

Run: `cargo fmt --all && cargo check -p daowow-core --no-default-features && cargo clippy -p daowow-core --lib -- -D warnings`
Expected: all clean.

- [ ] **Step 8: Commit**

```bash
git add crates/daowow-core/src/encoding.rs crates/daowow-core/src/shard.rs
git commit -m "feat: refuse configs that would make the advertised cap wrong

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: Devnet evidence for the bounded lock window

**Files:**
- Modify: `tests/devnet/` (the round-creation history and its config)
- Modify: `tests/integration/examples/devnet_round.rs` if the config is emitted there

**Interfaces:**
- Consumes: Tasks 1 and 2
- Produces: on-chain evidence that deposits start and finish inside a bounded window

- [ ] **Step 1: Build every contract first**

Run, and do not rebuild anything after this until the devnet finishes:

```bash
for c in round-type entry-shard-type entry-lock dao-lock settlement-type accumulator-bench smoke-alloc smoke-minimal; do
  cargo build --target riscv64imac-unknown-none-elf --release -p $c
done
cargo build -p daowow-integration-tests --examples
```

- [ ] **Step 2: Set a non-zero entry_start and a tight aggregation window**

The devnet config currently uses `entry_start: 0`, which makes Task 1's check
vacuous, and `entry_end: 2`, `aggregation_deadline: 4`. Set `entry_start` to a
non-zero epoch so the opening check actually executes on a real node, and keep
`aggregation_deadline - entry_end` small so every deposit lands in a bounded
window. Record the exact values you chose and why in your report.

- [ ] **Step 3: Assert the deposit window in the test**

The spec's requirement is that every lock starts within a bounded span. Assert
it rather than assume it: collect each batch's DAO deposit header epoch and
assert the spread between the earliest and latest is within the configured
`[entry_end, aggregation_deadline]` window. A test that merely runs a round
proves the round works, not that the window holds.

- [ ] **Step 4: Prepare phase one inside `(D+180, D+360)` and assert maturity**

The spec's resolution for the lock-finish knife edge. `dao-lock` requires
`since >= deposit_epoch + 180 * dao_term_periods` before phase one, and RFC 0023
then sets maturity at the next 180-epoch boundary — so phase one at `D+180`
matures at `D+180` but at `D+181` matures at `D+360`. Targeting strictly inside
the interval makes maturity `D+360` for every deposit, deterministically, with a
roughly 29-day keeper window instead of minutes.

Assert that every batch matures at the same boundary. That is the property the
requirement asks for; the round completing is not.

- [ ] **Step 5: Run the devnet suite**

Run: `DAOWOW_RUN_ISOLATED_NODE=1 python3 -m unittest discover -s tests/devnet -v`
Expected: all pass, roughly 25 minutes. If the run fails for an environmental
reason, report it rather than burning further runs — one clean run is the proof.

- [ ] **Step 6: Commit**

```bash
git add tests/devnet tests/integration/examples/devnet_round.rs
git commit -m "test: prove deposits start and finish inside a bounded window

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: Close the audit and update the handoff

**Files:**
- Modify: `docs/beta-rule-enforcement-audit.md`
- Modify: `docs/HANDOFF-2026-09-16.md`

**Interfaces:**
- Consumes: Tasks 1 to 3
- Produces: the record

- [ ] **Step 1: Record closure in the audit**

Add a dated section to `docs/beta-rule-enforcement-audit.md` stating which
findings are now closed and how. Be exact about the difference between enforced
and decided: the round-wide cap is enforced *because* the beta is single-shard
and the config guard now makes any other choice unconstructible; the per-lock
cap is out of scope, not implemented; closing remains an announced target with
an observable freeze and is NOT a hard expiry; entry opening is now enforced.
Do not describe the beta as having a hard expiry or a per-lock cap.

- [ ] **Step 2: Record the beta's values**

State the approved configuration in the audit: `ticket_price = 1000 CKB`,
`maximum_tickets = 200`, `minimum_tickets = 50`, `entry_shard_count = 1`, and
that an entrant pays roughly 1,220 CKB per ticket because each mints a claim
cell of about 220 CKB, returned at retirement. Note that `minimum_tickets = 50`
exceeding `MAX_SCHEDULE_PRIZES = 32` means the prize schedule never truncates in
a successful round, so a preset may promise a fixed winner count — and that
lowering the minimum below 33 would reintroduce the audit's truncation
disclosure requirement.

- [ ] **Step 3: Update the handoff**

In `docs/HANDOFF-2026-09-16.md`, record gate 1 as complete with links to the
spec and this plan, list the new error code `SHARD_ERROR_NOT_OPEN -39` beside
the existing codes, and note the two new `validate` rules. Remove the
beta-rule-enforcement items from the open list. Leave every other open item
intact, including the three the final review recorded for before a funded round.

- [ ] **Step 4: Commit**

```bash
git add docs/beta-rule-enforcement-audit.md docs/HANDOFF-2026-09-16.md
git commit -m "docs: close the beta rule-enforcement audit for gate 1

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```
