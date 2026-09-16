# Claim retirement and winner memento: implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the claim lifecycle — a holder with no outstanding prize
obligation retires the claim, recovers its capacity, and a winner receives a
non-financial memento cell recording what they won.

**Architecture:** Retirement is a standalone transaction. The claim's retire
mode authenticates the round from two cell deps (round config, entropy record)
and one witness (the committed prize schedule), derives the draw, and compares
`paid_count` against the obligation universe `Σ accepted_batches`. A separate
success condition in `ComputedDraw::new` voids a round whose schedule cannot
yield a positive prize for every drawn position, so the universe is exactly the
batch count. The memento is args tag 6 on the same binary and delegates every
content check to the claim.

**Tech Stack:** Rust `no_std` on `riscv64imac-unknown-none-elf` for contracts,
`std` host tests in `daowow-core`, `ckb-testtool` for VM suites, Python
`unittest` driving an isolated Docker CKB devnet.

**Spec:** `docs/superpowers/specs/2026-09-16-claim-retirement-memento-design.md`

## Global Constraints

- `daowow-core` must stay `no_std`-clean: verify with
  `cargo check -p daowow-core --no-default-features` after every core task.
- Host tests live behind `#[cfg(all(test, feature = "std"))]` in a `tests.rs`
  beside the module (see `crates/daowow-core/src/claim/tests.rs`).
- Clippy is a gate: `cargo clippy -p daowow-core --lib -- -D warnings`.
- Contracts build one package at a time; the workspace contains `std` crates:
  `cargo build --target riscv64imac-unknown-none-elf --release -p entry-shard-type`.
- Never rebuild a contract binary while the devnet suite is running; each test
  deploys the binaries fresh.
- `ckb-testtool`: never re-verify a transaction after `chain_cell` has advanced
  its input. The script then sees `before == after` and fails for a reason that
  has nothing to do with the test. Return cycles from the helper that ran it
  instead of running it twice. This cost sub-project 2 twenty minutes of
  bisecting a `-31`.
- CKB executes script groups in script-hash order, not input order. When two
  scripts would both reject, the reported code is hash luck. To pin a guard in
  script A, construct the transaction so script B is consistent.
- `VIABILITY_RATIO = 1_000_000`. Pool bar allowance is `cfg.ticket_price / VIABILITY_RATIO`.
- `MEMENTO_TAG = 6`, `MEMENTO_ARGS_SIZE = 45`, `MEMENTO_DATA_SIZE = 54`,
  `MEMENTO_RENDERER_V1 = 1`.
- `WINNER_TEMPLATE_SHA256 = sha256(ticketWinner.png) =
  de98837659f7b6a7abc1125a12ec0dd64dc0cc053d93f48007b1459e6f5cb46d`.
- Commit messages are `<type>: <description>` and end with
  `Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>`.
- Existing fixtures use `ticket_price = 100 * SHANNONS = 10_000_000_000` and
  schedules `[1; 32]` (bar 32) and `[4, 3, 2, 1]` (bar 10) against an allowance
  of 10_000. All pass the viability gate — this was checked before writing this
  plan. A test that needs an unviable round must construct a pathological
  schedule on purpose.

## File structure

| File | Responsibility |
| --- | --- |
| `crates/daowow-core/src/schedule.rs` | add `min_viable_pool` beside `allocate` |
| `crates/daowow-core/src/computed_draw.rs` | add `VIABILITY_RATIO` and the success condition |
| `crates/daowow-core/src/seal.rs` | add `RoundSeal::total_accepted_batches` |
| `crates/daowow-core/src/entitlements.rs` | reject a zero allocation |
| `crates/daowow-core/src/memento.rs` (new) | `MementoArgs`, `MementoData`, capacity, template constant |
| `crates/daowow-core/src/memento/tests.rs` (new) | host tests for the codec |
| `crates/daowow-core/src/claim.rs` | add `RetireDecision` and `retire_decision` |
| `crates/daowow-core/src/error.rs` | codes -98..-103 |
| `contracts/entry-shard-type/src/claim.rs` | retire mode |
| `contracts/entry-shard-type/src/memento.rs` (new) | memento mode |
| `contracts/entry-shard-type/src/main.rs` | dispatch tag 6 |
| `tests/integration/tests/common/mod.rs` | memento harness helpers |
| `tests/integration/tests/claim_retirement.rs` (new) | accepted VM cases |
| `tests/integration/tests/security_retirement.rs` (new) | rejected VM cases |

---

### Task 1: Pool bar (`min_viable_pool`)

**Files:**
- Modify: `crates/daowow-core/src/schedule.rs` (after `allocate`, around line 88)
- Test: `crates/daowow-core/src/schedule.rs` `mod tests`

**Interfaces:**
- Consumes: `PrizeSchedule::weights_for`, `accounting::checked_sum`
- Produces: `PrizeSchedule::min_viable_pool(&self, tickets: u64) -> Result<u64, CoreError>`

- [ ] **Step 1: Write the failing tests**

Add to the `mod tests` block at the bottom of `schedule.rs`:

```rust
    #[test]
    fn min_viable_pool_is_ceil_sum_over_min_weight() {
        // [40,25,20,10,5]: sum 100, min 5 -> 20
        let s = PrizeSchedule::new(&[40, 25, 20, 10, 5]).unwrap();
        assert_eq!(s.min_viable_pool(100), Ok(20));
        // [1,1,1000]: sum 1002, min 1 -> 1002
        let wide = PrizeSchedule::new(&[1, 1, 1000]).unwrap();
        assert_eq!(wide.min_viable_pool(100), Ok(1002));
        // exact division does not round up
        let flat = PrizeSchedule::new(&[2, 2]).unwrap();
        assert_eq!(flat.min_viable_pool(100), Ok(2));
    }

    #[test]
    fn min_viable_pool_follows_the_weights_for_truncation() {
        // fewer tickets than prizes truncates the weight list, so the bar moves
        let s = PrizeSchedule::new(&[1, 1, 1000]).unwrap();
        assert_eq!(s.min_viable_pool(2), Ok(2)); // weights [1,1]: sum 2, min 1
        assert_eq!(s.min_viable_pool(1), Ok(1)); // weights [1]:   sum 1, min 1
        assert_eq!(s.min_viable_pool(0), Err(CoreError::InvalidArgument));
    }

    #[test]
    fn the_bar_is_exactly_the_zero_free_threshold() {
        // At the bar no position is zero; one shannon below it, one is.
        let s = PrizeSchedule::new(&[1, 1, 1000]).unwrap();
        let bar = s.min_viable_pool(100).unwrap();
        let at = crate::accounting::allocate_prizes_complete(&[1, 1, 1000], bar).unwrap();
        assert!(at.iter().all(|a| *a > 0), "{at:?}");
        let below = crate::accounting::allocate_prizes_complete(&[1, 1, 1000], bar - 1).unwrap();
        assert!(below.iter().any(|a| *a == 0), "{below:?}");
    }
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cargo test -p daowow-core --lib schedule::tests -- --nocapture`
Expected: FAIL, `no method named 'min_viable_pool' found`.

- [ ] **Step 3: Write the implementation**

Insert into `impl PrizeSchedule`, directly after `allocate`:

```rust
    /// Smallest batch prize pool for which no drawn position allocates zero.
    ///
    /// `allocate_prizes` gives position `i` exactly `floor(pool * w_i / W)`, so
    /// that value is positive iff `pool * w_i >= W`. The binding position is the
    /// smallest weight, giving `ceil(W / w_min)`. Index zero also receives the
    /// dust, so it is never the binding case.
    pub fn min_viable_pool(&self, tickets: u64) -> Result<u64, CoreError> {
        let weights = self.weights_for(tickets)?;
        let sum = crate::accounting::checked_sum(weights)?;
        // validate_weights rejects zero weights, so min is positive.
        let min = *weights.iter().min().ok_or(CoreError::InvalidArgument)?;
        Ok(sum.div_ceil(min))
    }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cargo test -p daowow-core --lib schedule::tests`
Expected: PASS, including the three new tests.

- [ ] **Step 5: Check no_std and clippy**

Run: `cargo check -p daowow-core --no-default-features && cargo clippy -p daowow-core --lib -- -D warnings`
Expected: both clean.

- [ ] **Step 6: Commit**

```bash
git add crates/daowow-core/src/schedule.rs
git commit -m "feat: closed-form pool bar for zero-free prize allocation

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: Void an unyieldable draw

**Files:**
- Modify: `crates/daowow-core/src/computed_draw.rs:57` (the `if total != 0 && ...` condition)
- Test: `crates/daowow-core/src/computed_draw.rs` `mod tests`

**Interfaces:**
- Consumes: `PrizeSchedule::min_viable_pool` (Task 1), `RoundConfigV1::ticket_price`
- Produces: `computed_draw::VIABILITY_RATIO: u64`; `ComputedDraw::is_success()` now
  returns false for an unviable schedule

- [ ] **Step 1: Write the failing test**

The fixture in `computed_draw.rs` `mod tests` builds `cfg`, `record` and a
`schedule`. Add this test to that module, using the existing `Fixture`:

```rust
    #[test]
    fn an_unyieldable_schedule_voids_the_round() {
        let f = Fixture::build(4, 8);
        // Sane schedule: bar 10 against allowance ticket_price / 1_000_000.
        let sane = PrizeSchedule::new(&[4, 3, 2, 1]).unwrap();
        assert!(sane.min_viable_pool(f.total_tickets()).unwrap() <= f.cfg.ticket_price / VIABILITY_RATIO);

        // Pathological spread: bar exceeds the allowance, so the round must fail.
        let mut wide_weights = [1u64; 32];
        wide_weights[0] = u64::MAX / 64;
        let wide = PrizeSchedule::new(&wide_weights).unwrap();
        let mut wide_cfg = f.cfg;
        wide_cfg.prize_schedule_hash = wide.commitment();
        let record = f.record_for(&wide_cfg);

        let draw = ComputedDraw::new(&wide_cfg, &record, &wide).unwrap();
        assert!(!draw.is_success(), "unyieldable schedule must not draw");
        assert!(draw.positions().is_empty());
        // The void is not an error: totals still derive.
        assert_eq!(draw.total_tickets(), f.total_tickets());
    }

    #[test]
    fn viability_is_round_level_and_not_per_batch() {
        // Same (cfg, record, schedule) must give the same verdict every call,
        // because settlement and retirement both re-derive it independently.
        let f = Fixture::build(4, 8);
        let a = ComputedDraw::new(&f.cfg, &f.record, &f.schedule).unwrap();
        let b = ComputedDraw::new(&f.cfg, &f.record, &f.schedule).unwrap();
        assert_eq!(a.is_success(), b.is_success());
        assert_eq!(a.positions(), b.positions());
    }
```

If `Fixture` has no `record_for(&cfg)` or `total_tickets()` helper, add them to
the fixture in the same module — `record_for` rebuilds the `EntropyRecord` for a
config whose `prize_schedule_hash` differs, and `total_tickets` returns the sum
of the fixture's accepted ticket counts. Do not change the existing fixture's
default behaviour.

- [ ] **Step 2: Run tests to verify they fail**

Run: `cargo test -p daowow-core --lib computed_draw::tests -- --nocapture`
Expected: FAIL, `cannot find value 'VIABILITY_RATIO'`, and after adding the
constant, `unyieldable schedule must not draw`.

- [ ] **Step 3: Write the implementation**

Add near the top of `computed_draw.rs`, below the imports:

```rust
/// A round draws only if its committed schedule can pay every drawn position a
/// positive amount from the smallest batch the round can produce. The smallest
/// batch is one ticket (`AggregationState::accept` rejects an empty batch and
/// forces `principal == ticket_count * ticket_price`), so the worst-case pool is
/// the DAO yield on `ticket_price`. This ratio is the economic assumption: that
/// a full term yields more than one part per million of principal.
pub const VIABILITY_RATIO: u64 = 1_000_000;
```

Then replace the success condition at line 57:

```rust
        let mut positions = Vec::new();
        // An unviable schedule is a failed round, not an error: the existing
        // failed-round path returns principal and yield to depositors and lets
        // every claim retire as a non-winner. Derived from round-level data
        // only, so every batch and retirement reach the same verdict.
        if total != 0
            && total >= cfg.minimum_tickets
            && schedule.min_viable_pool(total)? <= cfg.ticket_price / VIABILITY_RATIO
        {
            positions = vec![(0, 0); schedule.weights_for(total)?.len()];
            crate::draw::draw_positions(&seed, total, positions.len() as u64, &mut positions)?;
        }
```

- [ ] **Step 4: Run the whole core suite**

Run: `cargo test -p daowow-core --lib`
Expected: PASS. If an existing draw or entitlement test now sees a failed round,
check its schedule against `min_viable_pool` before assuming a regression —
per Global Constraints the shipped fixtures all pass the bar, so a failure means
that test introduced its own schedule.

- [ ] **Step 5: Check no_std and clippy**

Run: `cargo check -p daowow-core --no-default-features && cargo clippy -p daowow-core --lib -- -D warnings`
Expected: both clean.

- [ ] **Step 6: Commit**

```bash
git add crates/daowow-core/src/computed_draw.rs
git commit -m "feat: void a round whose schedule cannot yield every prize

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: Derivation refuses a zero allocation

**Files:**
- Modify: `crates/daowow-core/src/entitlements.rs:79` (`if amount == 0 { continue; }`)
- Test: `crates/daowow-core/src/entitlements/tests.rs`

**Interfaces:**
- Consumes: nothing new
- Produces: `InitialEntitlements::derive` returns `Err(CoreError::Conservation)`
  for a successful batch allocating zero to a drawn position

- [ ] **Step 1: Write the failing test**

Add to `crates/daowow-core/src/entitlements/tests.rs`, following the shape of
the existing `derive` tests in that file (reuse whatever fixture builder they
already use; do not invent a new one):

```rust
    #[test]
    fn a_batch_allocating_zero_to_a_drawn_position_is_refused() {
        // A pool smaller than the number of drawn positions cannot pay them all.
        // This is unreachable through the viability gate and is pinned anyway:
        // it is the invariant the retirement count argument rests on.
        let mut f = DeriveFixture::successful_round();
        f.realized_total = f.receipt.input_capacity + 2; // pool of 2, 32 winners
        assert_eq!(f.derive(), Err(CoreError::Conservation));
    }

    #[test]
    fn pool_size_alone_is_not_the_condition() {
        // weights [1,1,1000] with pool 3 allocates [1,0,2]: the pool exceeds the
        // position count and a position is still zero, so the guard must test
        // the computed allocation, not the pool.
        assert_eq!(
            crate::accounting::allocate_prizes_complete(&[1, 1, 1000], 3),
            Ok(alloc::vec![1, 0, 2])
        );
    }
```

Name the fixture to match whatever `entitlements/tests.rs` already defines. If
no reusable builder exists, extend the nearest existing successful-round test
by cloning its setup into the new test rather than refactoring shipped tests.

- [ ] **Step 2: Run tests to verify they fail**

Run: `cargo test -p daowow-core --lib entitlements::tests -- --nocapture`
Expected: FAIL — `derive` returns `Ok` where `Err(Conservation)` is expected.

- [ ] **Step 3: Write the implementation**

In `entitlements.rs`, replace the skip at line 79:

```rust
                // A zero here can never be discharged: record_verified_prize
                // rejects amount == 0, and the only other evidence the batch
                // owed this ticket nothing is a funding cell the final drain
                // consumes. The viability gate in ComputedDraw makes this
                // unreachable for a round drawn under it; configs predating
                // that gate still exist, so refuse rather than skip.
                if amount == 0 {
                    return Err(CoreError::Conservation);
                }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cargo test -p daowow-core --lib`
Expected: PASS.

- [ ] **Step 5: Regenerate the vectors**

Run: `cargo test -p daowow-core --test gen_vectors`
Then regenerate `apps/web/vectors.js` with the Python snippet in
`apps/web/PROGRESS.md`, and run `node apps/web/test/*.test.js`.
Expected: web checks pass.

- [ ] **Step 6: Commit**

```bash
git add crates/daowow-core/src/entitlements.rs crates/daowow-core/src/entitlements/tests.rs \
        crates/daowow-core/tests/vectors/daowow_core_vectors.json apps/web/vectors.js
git commit -m "feat: refuse a batch that allocates zero to a drawn position

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: Obligation universe on the seal

**Files:**
- Modify: `crates/daowow-core/src/seal.rs` (inside `impl RoundSeal`, beside `ledger`)
- Test: `crates/daowow-core/src/seal.rs` `mod tests` (or `seal/tests.rs` if present)

**Interfaces:**
- Consumes: `AggregationState::accepted_batches`
- Produces: `RoundSeal::total_accepted_batches(&self) -> Result<u64, CoreError>`

- [ ] **Step 1: Write the failing test**

```rust
    #[test]
    fn total_accepted_batches_sums_every_shard() {
        let (cfg, ledgers) = closed_ledgers_with_batches(&[3, 0, 5, 1]);
        let seal = RoundSeal::new(&cfg, &ledgers).unwrap();
        assert_eq!(seal.total_accepted_batches(), Ok(9));
    }

    #[test]
    fn total_accepted_batches_is_zero_for_an_empty_round() {
        let (cfg, ledgers) = closed_ledgers_with_batches(&[0, 0, 0, 0]);
        let seal = RoundSeal::new(&cfg, &ledgers).unwrap();
        assert_eq!(seal.total_accepted_batches(), Ok(0));
    }
```

Write `closed_ledgers_with_batches(counts: &[u64]) -> (RoundConfigV1, Vec<AggregationState>)`
as a test helper in the same module, building one closed `AggregationState` per
entry of `counts` by running `accept` that many times against a frozen shard.
Model it on the existing seal tests' fixture construction.

- [ ] **Step 2: Run tests to verify they fail**

Run: `cargo test -p daowow-core --lib seal -- --nocapture`
Expected: FAIL, `no method named 'total_accepted_batches'`.

- [ ] **Step 3: Write the implementation**

Add inside `impl RoundSeal`, after `ledger`:

```rust
    /// The complete prize-obligation universe for any winning ticket of this
    /// round: every batch of every shard owes every winner a positive amount,
    /// so a winner's discharged-source count equals this when nothing is left.
    /// Only meaningful for a sealed round; `RoundSeal::new` guarantees closure.
    pub fn total_accepted_batches(&self) -> Result<u64, CoreError> {
        let mut total = 0u64;
        for ledger in &self.ledgers {
            total = total
                .checked_add(ledger.accepted_batches())
                .ok_or(CoreError::Overflow)?;
        }
        Ok(total)
    }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cargo test -p daowow-core --lib seal`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add crates/daowow-core/src/seal.rs
git commit -m "feat: sum the sealed round's batch count as the obligation universe

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: Memento codec

**Files:**
- Create: `crates/daowow-core/src/memento.rs`
- Create: `crates/daowow-core/src/memento/tests.rs`
- Modify: `crates/daowow-core/src/lib.rs` (add `pub mod memento;`)

**Interfaces:**
- Consumes: `encoding::{read_u32, read_u64, write_u32, write_u64}`, `hash::Hash32`, `ticket::ticket_id`
- Produces: `MEMENTO_TAG`, `MEMENTO_ARGS_SIZE`, `MEMENTO_DATA_SIZE`,
  `MEMENTO_RENDERER_V1`, `WINNER_TEMPLATE_SHA256`, `MementoArgs {commitment, shard_id, position}`
  with `encode/decode/ticket_id`, `MementoData {renderer_version, prize_index, paid_count, paid_total}`
  with `encode/decode`, and `memento_occupied_capacity(lock_script_size: u64) -> u64`

- [ ] **Step 1: Write the failing tests**

Create `crates/daowow-core/src/memento/tests.rs`:

```rust
use super::*;

fn args() -> MementoArgs {
    MementoArgs { commitment: [7; 32], shard_id: 2, position: 9 }
}

fn data() -> MementoData {
    MementoData { renderer_version: MEMENTO_RENDERER_V1, prize_index: 3, paid_count: 4, paid_total: 4000 }
}

#[test]
fn args_round_trip_and_carry_tag_six() {
    let wire = args().encode();
    assert_eq!(wire.len(), MEMENTO_ARGS_SIZE);
    assert_eq!(wire[0], MEMENTO_TAG);
    assert_eq!(MementoArgs::decode(&wire), Ok(args()));
}

#[test]
fn args_reject_the_claim_tag_and_wrong_lengths() {
    let mut wire = args().encode();
    wire[0] = crate::claim::CLAIM_TAG;
    assert_eq!(MementoArgs::decode(&wire), Err(CoreError::Encoding));
    let good = args().encode();
    assert_eq!(MementoArgs::decode(&good[..44]), Err(CoreError::Encoding));
    let mut long = good.to_vec();
    long.push(0);
    assert_eq!(MementoArgs::decode(&long), Err(CoreError::Encoding));
}

#[test]
fn args_ticket_matches_the_claim_of_the_same_identity() {
    let a = args();
    let c = crate::claim::ClaimArgs { commitment: a.commitment, shard_id: a.shard_id, position: a.position };
    assert_eq!(a.ticket_id(), c.ticket_id());
}

#[test]
fn data_round_trips_and_commits_the_template() {
    let wire = data().encode();
    assert_eq!(wire.len(), MEMENTO_DATA_SIZE);
    assert_eq!(wire[0], 1);
    assert_eq!(&wire[2..34], &WINNER_TEMPLATE_SHA256);
    assert_eq!(MementoData::decode(&wire), Ok(data()));
}

#[test]
fn data_rejects_a_substituted_template_or_renderer() {
    let mut wire = data().encode();
    wire[2] ^= 1;
    assert_eq!(MementoData::decode(&wire), Err(CoreError::Encoding));
    let mut wire = data().encode();
    wire[1] = MEMENTO_RENDERER_V1 + 1;
    assert_eq!(MementoData::decode(&wire), Err(CoreError::Encoding));
    let mut wire = data().encode();
    wire[0] = 2;
    assert_eq!(MementoData::decode(&wire), Err(CoreError::Encoding));
}

#[test]
fn data_rejects_counters_a_winner_cannot_have() {
    // a winner discharged at least one source, each of a positive amount
    let mut zero = data();
    zero.paid_count = 0;
    assert_eq!(MementoData::decode(&zero.encode()), Err(CoreError::Encoding));
    let mut thin = data();
    thin.paid_count = 5;
    thin.paid_total = 4;
    assert_eq!(MementoData::decode(&thin.encode()), Err(CoreError::Encoding));
    let mut ranked = data();
    ranked.prize_index = crate::schedule::MAX_SCHEDULE_PRIZES as u32;
    assert_eq!(MementoData::decode(&ranked.encode()), Err(CoreError::Encoding));
}

#[test]
fn occupied_capacity_matches_the_spec_arithmetic() {
    // 8 capacity + 53 secp lock + (32 + 1 + 45) type + 54 data = 193 CKB
    assert_eq!(memento_occupied_capacity(53), 193 * 100_000_000);
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cargo test -p daowow-core --lib memento -- --nocapture`
Expected: FAIL, `unresolved module` / `file not found for module memento`.

- [ ] **Step 3: Write the implementation**

Create `crates/daowow-core/src/memento.rs`:

```rust
//! Winner memento: a non-financial keepsake cell, args tag 6 of the shard
//! binary. It carries no prize rights and authorizes nothing. Every field is
//! validated by the retiring claim's script (contracts/entry-shard-type);
//! this module is codec and arithmetic only.

use crate::encoding::{read_u32, read_u64, write_u32, write_u64};
use crate::hash::Hash32;
use crate::ticket::ticket_id;
use crate::CoreError;

/// First args byte; distinct from 5 (claim) and every earlier shard mode.
pub const MEMENTO_TAG: u8 = 6;
/// `[tag] || commitment(32) || shard_id(u32 LE) || position(u64 LE)`.
pub const MEMENTO_ARGS_SIZE: usize = 45;
/// `MementoData::encode()` length.
pub const MEMENTO_DATA_SIZE: usize = 54;
/// The only renderer this layout describes.
pub const MEMENTO_RENDERER_V1: u8 = 1;
const SHANNONS_PER_CKB: u64 = 100_000_000;

/// `sha256(ticketWinner.png)`, the redeemed-winner template committed by the
/// prize-only claim amendment. Stored in full so a memento is verifiable
/// against the artwork with no off-chain registry.
pub const WINNER_TEMPLATE_SHA256: Hash32 = [
    0xde, 0x98, 0x83, 0x76, 0x59, 0xf7, 0xb6, 0xa7, 0xab, 0xc1, 0x12, 0x5a, 0x12, 0xec, 0x0d, 0xd6,
    0x4d, 0xc0, 0xcc, 0x05, 0x3d, 0x93, 0xf4, 0x80, 0x07, 0xb1, 0x45, 0x9e, 0x6f, 0x5c, 0xb4, 0x6d,
];

/// Identity, mirroring `ClaimArgs` under a different tag so the two are
/// distinct type scripts and therefore distinct cell types and script groups.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct MementoArgs {
    pub commitment: Hash32,
    pub shard_id: u32,
    pub position: u64,
}

impl MementoArgs {
    pub fn encode(&self) -> [u8; MEMENTO_ARGS_SIZE] {
        let mut out = [0u8; MEMENTO_ARGS_SIZE];
        out[0] = MEMENTO_TAG;
        out[1..33].copy_from_slice(&self.commitment);
        write_u32(&mut out, 33, self.shard_id);
        write_u64(&mut out, 37, self.position);
        out
    }

    pub fn decode(data: &[u8]) -> Result<Self, CoreError> {
        if data.len() != MEMENTO_ARGS_SIZE || data[0] != MEMENTO_TAG {
            return Err(CoreError::Encoding);
        }
        let mut commitment = [0u8; 32];
        commitment.copy_from_slice(&data[1..33]);
        Ok(Self {
            commitment,
            shard_id: read_u32(data, 33),
            position: read_u64(data, 37),
        })
    }

    /// The same ticket the claim of this identity names.
    pub fn ticket_id(&self) -> Hash32 {
        ticket_id(&self.commitment, self.shard_id, self.position)
    }
}

/// Commemorative payload. Decoding proves nothing about provenance: only the
/// retiring claim's script authenticates these values against the draw.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct MementoData {
    pub renderer_version: u8,
    pub prize_index: u32,
    pub paid_count: u64,
    pub paid_total: u64,
}

impl MementoData {
    pub fn encode(&self) -> [u8; MEMENTO_DATA_SIZE] {
        let mut out = [0u8; MEMENTO_DATA_SIZE];
        out[0] = 1;
        out[1] = self.renderer_version;
        out[2..34].copy_from_slice(&WINNER_TEMPLATE_SHA256);
        write_u32(&mut out, 34, self.prize_index);
        write_u64(&mut out, 38, self.paid_count);
        write_u64(&mut out, 46, self.paid_total);
        out
    }

    /// Strict structural decoding. The template and renderer are protocol
    /// constants, so a substituted value is a malformed memento, not a variant.
    pub fn decode(data: &[u8]) -> Result<Self, CoreError> {
        if data.len() != MEMENTO_DATA_SIZE
            || data[0] != 1
            || data[1] != MEMENTO_RENDERER_V1
            || data[2..34] != WINNER_TEMPLATE_SHA256
        {
            return Err(CoreError::Encoding);
        }
        let out = Self {
            renderer_version: data[1],
            prize_index: read_u32(data, 34),
            paid_count: read_u64(data, 38),
            paid_total: read_u64(data, 46),
        };
        // A memento exists only for a winner, who discharged at least one
        // source, each of a positive amount, at a rank the schedule can hold.
        if out.paid_count == 0
            || out.paid_total < out.paid_count
            || out.prize_index as usize >= crate::schedule::MAX_SCHEDULE_PRIZES
        {
            return Err(CoreError::Encoding);
        }
        Ok(out)
    }
}

/// Occupied capacity in shannons: capacity field, holder lock, memento type, data.
pub fn memento_occupied_capacity(lock_script_size: u64) -> u64 {
    (8 + lock_script_size + (32 + 1 + MEMENTO_ARGS_SIZE as u64) + MEMENTO_DATA_SIZE as u64)
        * SHANNONS_PER_CKB
}

#[cfg(all(test, feature = "std"))]
mod tests;
```

Add `pub mod memento;` to `crates/daowow-core/src/lib.rs` beside `pub mod claim;`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cargo test -p daowow-core --lib memento`
Expected: PASS, all seven tests.

- [ ] **Step 5: Check no_std and clippy**

Run: `cargo check -p daowow-core --no-default-features && cargo clippy -p daowow-core --lib -- -D warnings`
Expected: both clean.

- [ ] **Step 6: Commit**

```bash
git add crates/daowow-core/src/memento.rs crates/daowow-core/src/memento/tests.rs crates/daowow-core/src/lib.rs
git commit -m "feat: winner memento identity and payload codec

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: Pure retire decision

**Files:**
- Modify: `crates/daowow-core/src/claim.rs` (after `validate_transfer`)
- Test: `crates/daowow-core/src/claim/tests.rs`

**Interfaces:**
- Consumes: `ComputedDraw::{positions, locate}` (Task 2), `RoundSeal::total_accepted_batches` (Task 4)
- Produces: `RetireDecision { NonWinner, Winner { prize_index: u32 } }` and
  `retire_decision(args: &ClaimArgs, state: &PrizeRedemptionState, draw: &ComputedDraw<'_>, universe: u64) -> Result<RetireDecision, CoreError>`

- [ ] **Step 1: Write the failing tests**

Add to `crates/daowow-core/src/claim/tests.rs`. Build the draw with the
`computed_draw::tests::Fixture` already used elsewhere in the crate:

```rust
    use crate::computed_draw::{tests::Fixture, ComputedDraw};

    #[test]
    fn a_non_winner_retires_with_nothing_paid() {
        let f = Fixture::build(4, 8);
        let draw = ComputedDraw::new(&f.cfg, &f.record, &f.schedule).unwrap();
        let args = f.non_winning_claim_args(&draw);
        let state = PrizeRedemptionState::new(args.ticket_id());
        assert_eq!(retire_decision(&args, &state, &draw, 7), Ok(RetireDecision::NonWinner));
    }

    #[test]
    fn a_winner_retires_only_when_every_batch_is_discharged() {
        let f = Fixture::build(4, 8);
        let draw = ComputedDraw::new(&f.cfg, &f.record, &f.schedule).unwrap();
        let (args, prize_index) = f.winning_claim_args(&draw);
        let state = f.state_with_paid_count(&args, 3);
        assert_eq!(
            retire_decision(&args, &state, &draw, 3),
            Ok(RetireDecision::Winner { prize_index })
        );
        // one source short is refused
        assert_eq!(
            retire_decision(&args, &state, &draw, 4),
            Err(CoreError::StateTransition)
        );
    }

    #[test]
    fn a_non_winner_carrying_payments_is_refused() {
        // Only a drawn ticket can ever have redeemed; anything else is forged.
        let f = Fixture::build(4, 8);
        let draw = ComputedDraw::new(&f.cfg, &f.record, &f.schedule).unwrap();
        let args = f.non_winning_claim_args(&draw);
        let state = f.state_with_paid_count(&args, 1);
        assert_eq!(retire_decision(&args, &state, &draw, 3), Err(CoreError::StateTransition));
    }

    #[test]
    fn state_belonging_to_another_ticket_is_refused() {
        let f = Fixture::build(4, 8);
        let draw = ComputedDraw::new(&f.cfg, &f.record, &f.schedule).unwrap();
        let args = f.non_winning_claim_args(&draw);
        let state = PrizeRedemptionState::new([0xAB; 32]);
        assert_eq!(retire_decision(&args, &state, &draw, 3), Err(CoreError::Encoding));
    }

    #[test]
    fn every_claim_of_a_voided_round_is_a_non_winner() {
        let f = Fixture::build_unviable(4, 8);
        let draw = ComputedDraw::new(&f.cfg, &f.record, &f.schedule).unwrap();
        assert!(!draw.is_success());
        let args = f.any_claim_args();
        let state = PrizeRedemptionState::new(args.ticket_id());
        assert_eq!(retire_decision(&args, &state, &draw, 9), Ok(RetireDecision::NonWinner));
    }
```

Add the fixture helpers `non_winning_claim_args`, `winning_claim_args`,
`state_with_paid_count`, `any_claim_args` and `build_unviable` to
`computed_draw::tests::Fixture`, making it `pub(crate)` where needed.
`state_with_paid_count` builds a state by calling `record_verified_prize`
`n` times with distinct synthetic sources and an SMT absence proof from the
host accumulator, mirroring how `redemption/tests.rs` constructs paid states.

- [ ] **Step 2: Run tests to verify they fail**

Run: `cargo test -p daowow-core --lib claim::tests -- --nocapture`
Expected: FAIL, `cannot find function 'retire_decision'`.

- [ ] **Step 3: Write the implementation**

Add to `crates/daowow-core/src/claim.rs`, after `validate_transfer`:

```rust
/// Outcome of the retirement test for one claim.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RetireDecision {
    /// Never drawn; owes and is owed nothing.
    NonWinner,
    /// Drawn at this rank, with every prize obligation discharged.
    Winner { prize_index: u32 },
}

/// May this claim be consumed without a successor?
///
/// `universe` must be `RoundSeal::total_accepted_batches` of the same sealed
/// round the draw derives from; the caller authenticates both from canonical
/// cells. A count comparison is sufficient because every recorded source was
/// verified against a real funding cell of this commitment and inserted under
/// an absence proof, so sources are genuine and distinct, and because no batch
/// may allocate a winner zero.
pub fn retire_decision(
    args: &ClaimArgs,
    state: &PrizeRedemptionState,
    draw: &crate::computed_draw::ComputedDraw<'_>,
    universe: u64,
) -> Result<RetireDecision, CoreError> {
    if state.ticket() != args.ticket_id() {
        return Err(CoreError::Encoding);
    }
    for (prize_index, global_position) in draw.positions() {
        let (shard_id, position) = draw.locate(*global_position)?;
        if shard_id != args.shard_id || position != args.position {
            continue;
        }
        if *prize_index >= crate::schedule::MAX_SCHEDULE_PRIZES as u64 {
            return Err(CoreError::InvalidArgument);
        }
        if state.paid_count() != universe {
            return Err(CoreError::StateTransition);
        }
        return Ok(RetireDecision::Winner {
            prize_index: *prize_index as u32,
        });
    }
    // Not drawn: only a drawn ticket can ever have redeemed.
    if state.paid_count() != 0 {
        return Err(CoreError::StateTransition);
    }
    Ok(RetireDecision::NonWinner)
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cargo test -p daowow-core --lib`
Expected: PASS.

- [ ] **Step 5: Check no_std and clippy**

Run: `cargo check -p daowow-core --no-default-features && cargo clippy -p daowow-core --lib -- -D warnings`
Expected: both clean.

- [ ] **Step 6: Commit**

```bash
git add crates/daowow-core/src/claim.rs crates/daowow-core/src/claim/tests.rs crates/daowow-core/src/computed_draw.rs
git commit -m "feat: pure retirement decision over the draw and obligation universe

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 7: Claim retire mode (contract)

**Files:**
- Modify: `crates/daowow-core/src/error.rs:99` (append codes)
- Modify: `contracts/entry-shard-type/src/claim.rs:86` (`(true, None) => err(CLAIM_ERROR_RETIRE)`)

**Interfaces:**
- Consumes: `retire_decision`, `RetireDecision` (Task 6); `MementoArgs`,
  `MementoData`, `MEMENTO_RENDERER_V1` (Task 5); `RoundSeal::total_accepted_batches` (Task 4);
  `daowow_contracts_common::config_by_commitment`
- Produces: the retire transition; no new public Rust API

- [ ] **Step 1: Add the error codes**

Append to the claim block in `crates/daowow-core/src/error.rs`:

```rust
    pub const CLAIM_ERROR_UNIVERSE: i8 = -98;
    pub const CLAIM_ERROR_INCOMPLETE: i8 = -99;
    // memento mode of entry-shard-type (reserved range -100..)
    pub const MEMENTO_ERROR_ARGS: i8 = -100;
    pub const MEMENTO_ERROR_DATA: i8 = -101;
    pub const MEMENTO_ERROR_GROUP: i8 = -102;
    pub const MEMENTO_ERROR_MINT: i8 = -103;
```

`CLAIM_ERROR_RETIRE -96` keeps its name and now means the memento obligation is
wrong: missing for a winner, present for a non-winner, or duplicated.

- [ ] **Step 2: Write the failing VM test**

Create `tests/integration/tests/claim_retirement.rs` with one accepted case, so
the mode has a red test before implementation. Use `seed_claim`,
`claim_type_script` and the seal/entropy construction in
`proto3_dao_lifecycle.rs:510` as models:

```rust
mod common;
use common::*;

#[test]
fn a_non_winner_retires_once_the_round_is_sealed() {
    let mut w = World::new();
    let round = sealed_round_with_entropy(&mut w, 4, 8);
    let lock = w.always_success_lock();
    let (claim_op, args) = seed_claim(&mut w, &lock, round.non_winning_shard, round.non_winning_position);

    let tx = TransactionBuilder::default()
        .input(CellInput::new_builder().previous_output(claim_op).build())
        .output(
            CellOutputBuilder::default()
                .capacity(pack_u64(claim_cell_capacity(&lock)))
                .lock(lock.clone())
                .build(),
        )
        .output_data(Bytes::new().pack())
        .cell_dep(round.config_dep.clone())
        .cell_dep(round.entropy_dep.clone())
        .witness(schedule_witness(&round.schedule))
        .build();
    let tx = w.complete(tx);
    expect_ok(&mut w.context, &tx);
    let _ = args;
}
```

Add `sealed_round_with_entropy`, `schedule_witness` and the `SealedRound`
struct (fields: `config_dep`, `entropy_dep`, `schedule`, `non_winning_shard`,
`non_winning_position`, `winning_shard`, `winning_position`, `prize_index`,
`universe`) to `tests/integration/tests/common/mod.rs`. Build the entropy
record cell as a real `entry-shard-type` cell with args
`config_hash || 0u32` carrying `EntropyRecord::encode()`, then wrap it in a
`CellDep`.

- [ ] **Step 3: Run the test to verify it fails**

Run: `cd tests/integration && cargo test --test claim_retirement -- --nocapture`
Expected: FAIL with script error `-96` (`CLAIM_ERROR_RETIRE`), the current
unconditional refusal.

- [ ] **Step 4: Write the implementation**

`entropy_record_dep` returns an owned `Vec<u8>`, so add `use alloc::vec::Vec;`
to the top of `claim.rs` — the contract crate already sets up `daowow_alloc`, so
`alloc` is available but is not imported in this file yet.

In `contracts/entry-shard-type/src/claim.rs`, change the match arm at line 86
from `(true, None) => err(CLAIM_ERROR_RETIRE)` to
`(true, None) => retire(script, &args, &input_data)`, loading the input data
first, and add:

```rust
/// Locate the canonical entropy record of this round among the cell deps: a
/// cell of this binary with args `commitment || 0u32` whose data is a version-4
/// record. Returns its bytes and the round id the seal's first frozen snapshot
/// carries at bytes 7..39 (the seal puts it at 6..38; the record's tag shifts
/// it by one).
fn entropy_record_dep(script: &Script, args: &ClaimArgs) -> Result<(Vec<u8>, [u8; 32]), i8> {
    let mut expect = [0u8; 36];
    expect[..32].copy_from_slice(&args.commitment);
    let mut i = 0usize;
    while let Ok(cell) = load_cell(i, Source::CellDep) {
        if let Some(t) = cell.type_().to_opt() {
            if t.code_hash() == script.code_hash()
                && t.hash_type() == script.hash_type()
                && t.args().raw_data().as_ref() == expect
            {
                if let Ok(data) = load_cell_data(i, Source::CellDep) {
                    if data.first() == Some(&4) && data.len() > 39 {
                        let round: [u8; 32] = data[7..39].try_into().map_err(|_| CLAIM_ERROR_UNIVERSE)?;
                        return Ok((data, round));
                    }
                }
            }
        }
        i += 1;
    }
    Err(CLAIM_ERROR_UNIVERSE)
}

/// Consume the claim with no successor. Authenticates the sealed round from
/// cell deps, derives the draw, and requires the paid-source count to equal the
/// obligation universe for a winner or zero for a non-winner. A winner must
/// issue exactly one memento of this identity; a non-winner none.
fn retire(script: &Script, args: &ClaimArgs, input: &[u8]) -> Result<i8, i8> {
    let state = PrizeRedemptionState::decode(input).map_err(|_| CLAIM_ERROR_DATA)?;
    let (record_bytes, round_id) = entropy_record_dep(script, args)?;
    let cfg = daowow_contracts_common::config_by_commitment(&args.commitment, &round_id, Source::CellDep)
        .ok_or(CLAIM_ERROR_UNIVERSE)?;
    let record = daowow_core::seal::EntropyRecord::decode(&record_bytes, &cfg)
        .map_err(|_| CLAIM_ERROR_UNIVERSE)?;
    let witness = ckb_std::high_level::load_witness(0, Source::GroupInput)
        .map_err(|_| CLAIM_ERROR_UNIVERSE)?;
    let schedule = daowow_core::schedule::PrizeSchedule::decode_committed(&witness, &cfg.prize_schedule_hash)
        .map_err(|_| CLAIM_ERROR_UNIVERSE)?;
    let draw = daowow_core::computed_draw::ComputedDraw::new(&cfg, &record, &schedule)
        .map_err(|_| CLAIM_ERROR_UNIVERSE)?;
    let universe = record.seal().total_accepted_batches().map_err(|_| CLAIM_ERROR_UNIVERSE)?;
    let decision = match daowow_core::claim::retire_decision(args, &state, &draw, universe) {
        Ok(d) => d,
        Err(daowow_core::CoreError::StateTransition) => return err(CLAIM_ERROR_INCOMPLETE),
        Err(_) => return err(CLAIM_ERROR_DATA),
    };
    let expected_index = match decision {
        daowow_core::claim::RetireDecision::NonWinner => None,
        daowow_core::claim::RetireDecision::Winner { prize_index } => Some(prize_index),
    };
    check_memento_outputs(script, args, &state, expected_index)
}

/// Exactly one memento output of this identity for a winner, none otherwise.
/// The memento script only asserts that it stands beside a retiring claim; all
/// of its content is authenticated here, where the draw is already in hand.
fn check_memento_outputs(
    script: &Script,
    args: &ClaimArgs,
    state: &PrizeRedemptionState,
    expected_index: Option<u32>,
) -> Result<i8, i8> {
    let expect_args = daowow_core::memento::MementoArgs {
        commitment: args.commitment,
        shard_id: args.shard_id,
        position: args.position,
    }
    .encode();
    let in_lock = load_cell(0, Source::GroupInput).map_err(|_| CLAIM_ERROR_DATA)?.lock();
    let mut found = 0usize;
    let mut i = 0usize;
    while let Ok(cell) = load_cell(i, Source::Output) {
        if let Some(t) = cell.type_().to_opt() {
            if t.code_hash() == script.code_hash()
                && t.hash_type() == script.hash_type()
                && t.args().raw_data().as_ref() == expect_args
            {
                found += 1;
                if found > 1 {
                    return err(CLAIM_ERROR_RETIRE);
                }
                let Some(prize_index) = expected_index else {
                    return err(CLAIM_ERROR_RETIRE);
                };
                if cell.lock().as_slice() != in_lock.as_slice() {
                    return err(CLAIM_ERROR_RETIRE);
                }
                let expected = daowow_core::memento::MementoData {
                    renderer_version: daowow_core::memento::MEMENTO_RENDERER_V1,
                    prize_index,
                    paid_count: state.paid_count(),
                    paid_total: state.paid_total(),
                }
                .encode();
                let data = load_cell_data(i, Source::Output).map_err(|_| CLAIM_ERROR_RETIRE)?;
                if data.as_ref() != expected {
                    return err(CLAIM_ERROR_RETIRE);
                }
            }
        }
        i += 1;
    }
    if expected_index.is_some() && found != 1 {
        return err(CLAIM_ERROR_RETIRE);
    }
    Ok(0)
}
```

- [ ] **Step 5: Build the contract and run the test**

Run:
```bash
cargo build --target riscv64imac-unknown-none-elf --release -p entry-shard-type
cd tests/integration && cargo test --test claim_retirement
```
Expected: PASS.

- [ ] **Step 6: Record the binary size**

Run: `ls -l target/riscv64imac-unknown-none-elf/release/entry-shard-type`
Note the size against the 209,360-byte baseline; the growth is a deployment
cost item for the results document in Task 11.

- [ ] **Step 7: Commit**

```bash
git add crates/daowow-core/src/error.rs contracts/entry-shard-type/src/claim.rs \
        tests/integration/tests/claim_retirement.rs tests/integration/tests/common/mod.rs
git commit -m "feat: authenticate claim retirement against the sealed round

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 8: Memento mode (contract)

**Files:**
- Create: `contracts/entry-shard-type/src/memento.rs`
- Modify: `contracts/entry-shard-type/src/main.rs:72-80` (dispatch) and the `mod` list

**Interfaces:**
- Consumes: `MementoArgs`, `MementoData` (Task 5), `ClaimArgs` (shipped)
- Produces: the tag-6 script mode

- [ ] **Step 1: Write the failing VM tests**

Add to `tests/integration/tests/claim_retirement.rs`:

```rust
#[test]
fn a_winner_retires_and_receives_one_memento() {
    let mut w = World::new();
    let round = sealed_round_with_entropy(&mut w, 4, 8);
    let lock = w.always_success_lock();
    let (claim_op, args) = seed_paid_claim(&mut w, &lock, &round);
    let tx = retire_with_memento(&mut w, &round, &lock, claim_op, &args);
    expect_ok(&mut w.context, &tx);
}

#[test]
fn a_memento_transfers_and_burns() {
    let mut w = World::new();
    let round = sealed_round_with_entropy(&mut w, 4, 8);
    let lock = w.always_success_lock();
    let memento_op = seed_memento(&mut w, &lock, &round);
    expect_ok(&mut w.context, &transfer_memento(&mut w, &lock, memento_op.clone()));
    expect_ok(&mut w.context, &burn_memento(&mut w, memento_op));
}
```

Add `memento_cell_capacity`, `seed_paid_claim`, `retire_with_memento`,
`seed_memento`, `transfer_memento` and `burn_memento` to `common/mod.rs`.
`memento_cell_capacity` mirrors the shipped `claim_cell_capacity`:

```rust
/// Minimum capacity of a memento cell under `lock` (shannons).
pub fn memento_cell_capacity(lock: &Script) -> u64 {
    let lock_size = 32 + 1 + lock.args().raw_data().len() as u64;
    daowow_core::memento::memento_occupied_capacity(lock_size)
}
```
 `seed_paid_claim`
creates a claim for `round.winning_shard/position` whose state has
`paid_count == round.universe`, built by repeated `record_verified_prize`
against the host SMT with the round's real `prize_source` values.

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd tests/integration && cargo test --test claim_retirement`
Expected: FAIL — the memento output's type script currently falls through the
dispatch to the shard-transition branch and errors.

- [ ] **Step 3: Write the implementation**

Create `contracts/entry-shard-type/src/memento.rs`:

```rust
//! Memento mode of the shard binary: args `[6] || commitment || shard_id ||
//! position`. Non-financial and authorizes nothing.
//!
//! Mint delegates every content check to the retiring claim of the same
//! identity, which has already loaded the sealed round to decide whether it may
//! retire. This mode asserts only the one fact the claim cannot assert on its
//! own behalf: that a claim of this exact ticket is being consumed here.
//! Transfer keeps data identical. Burn is free; there is nothing to discharge.

use ckb_std::ckb_constants::Source;
use ckb_std::ckb_types::packed::Script;
use ckb_std::ckb_types::prelude::*;
use ckb_std::high_level::{load_cell, load_cell_data};
use daowow_core::claim::ClaimArgs;
use daowow_core::error::codes::*;
use daowow_core::memento::{MementoArgs, MementoData};

fn err(e: i8) -> Result<i8, i8> {
    ckb_std::debug!("memento error {}", e);
    Err(e)
}

/// Count cells of `source` whose type script is this binary carrying `args`.
fn count_with_args(script: &Script, args: &[u8], source: Source) -> usize {
    let mut found = 0;
    let mut i = 0usize;
    while let Ok(cell) = load_cell(i, source) {
        if let Some(t) = cell.type_().to_opt() {
            if t.code_hash() == script.code_hash()
                && t.hash_type() == script.hash_type()
                && t.args().raw_data().as_ref() == args
            {
                found += 1;
            }
        }
        i += 1;
    }
    found
}

pub fn run(script: &Script) -> Result<i8, i8> {
    let args = match MementoArgs::decode(script.args().raw_data().as_ref()) {
        Ok(a) => a,
        Err(_) => return err(MEMENTO_ERROR_ARGS),
    };
    if load_cell(1, Source::GroupInput).is_ok() || load_cell(1, Source::GroupOutput).is_ok() {
        return err(MEMENTO_ERROR_GROUP);
    }
    let has_input = load_cell(0, Source::GroupInput).is_ok();
    let output = load_cell_data(0, Source::GroupOutput).ok();
    match (has_input, output) {
        (false, Some(data)) => {
            if MementoData::decode(&data).is_err() {
                return err(MEMENTO_ERROR_DATA);
            }
            let claim = ClaimArgs {
                commitment: args.commitment,
                shard_id: args.shard_id,
                position: args.position,
            }
            .encode();
            // Exactly one claim of this ticket goes in and none comes out:
            // it is retiring, and its script validates everything about us.
            if count_with_args(script, &claim, Source::Input) != 1
                || count_with_args(script, &claim, Source::Output) != 0
            {
                return err(MEMENTO_ERROR_MINT);
            }
            Ok(0)
        }
        (true, Some(data)) => {
            let input = match load_cell_data(0, Source::GroupInput) {
                Ok(d) => d,
                Err(_) => return err(MEMENTO_ERROR_DATA),
            };
            if input != data || MementoData::decode(&data).is_err() {
                return err(MEMENTO_ERROR_DATA);
            }
            Ok(0)
        }
        // Burn: non-financial, so the holder may always recover the capacity.
        (true, None) => Ok(0),
        (false, None) => err(MEMENTO_ERROR_GROUP),
    }
}
```

In `main.rs`, add `mod memento;` beside `mod claim;` and extend the tag branch:

```rust
    {
        let args = script.args().raw_data();
        if args.len() == daowow_core::claim::CLAIM_ARGS_SIZE
            && args[0] == daowow_core::claim::CLAIM_TAG
        {
            return claim::run(&script).unwrap_or_else(err);
        }
        if args.len() == daowow_core::memento::MEMENTO_ARGS_SIZE
            && args[0] == daowow_core::memento::MEMENTO_TAG
        {
            return memento::run(&script).unwrap_or_else(err);
        }
    }
```

- [ ] **Step 4: Build and run the tests**

Run:
```bash
cargo build --target riscv64imac-unknown-none-elf --release -p entry-shard-type
cd tests/integration && cargo test --test claim_retirement
```
Expected: PASS, all four accepted cases.

- [ ] **Step 5: Commit**

```bash
git add contracts/entry-shard-type/src/memento.rs contracts/entry-shard-type/src/main.rs \
        tests/integration/tests/claim_retirement.rs tests/integration/tests/common/mod.rs
git commit -m "feat: winner memento mode on the shard binary

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 9: Rejection suite

**Files:**
- Create: `tests/integration/tests/security_retirement.rs`

**Interfaces:**
- Consumes: every helper from Tasks 7 and 8
- Produces: nothing; a gate

- [ ] **Step 1: Write the first rejection test in full**

This is the shape every other case in this task follows. Write it completely
before the variants, and assert an **exact** error code — never a broad match.
A regex or an or-of-codes assertion passes for the wrong reason: sub-project 2
shipped a test whose `/CKBFS/i` matcher was satisfied by the function's own
name in a `TypeError`.

```rust
mod common;
use common::*;
use daowow_core::error::codes::*;

#[test]
fn a_winner_one_source_short_is_refused() {
    let mut w = World::new();
    let round = sealed_round_with_entropy(&mut w, 4, 8);
    let lock = w.always_success_lock();

    // Every batch discharged but one: the claim still owes a source.
    let (claim_op, args) = seed_claim_with_paid_count(&mut w, &lock, &round, round.universe - 1);

    let tx = TransactionBuilder::default()
        .input(CellInput::new_builder().previous_output(claim_op).build())
        .output(
            CellOutputBuilder::default()
                .capacity(pack_u64(claim_cell_capacity(&lock)))
                .lock(lock.clone())
                .build(),
        )
        .output_data(Bytes::new().pack())
        .cell_dep(round.config_dep.clone())
        .cell_dep(round.entropy_dep.clone())
        .witness(schedule_witness(&round.schedule))
        .build();
    let tx = w.complete(tx);
    expect_err(&mut w.context, &tx, CLAIM_ERROR_INCOMPLETE);
    let _ = args;
}
```

Add `seed_claim_with_paid_count(world, lock, round, count)` to `common/mod.rs`:
it builds a claim for `round.winning_shard/position` whose state is the result
of `count` successive `record_verified_prize` calls against the round's real
`prize_source` values, each with an SMT absence proof from the host
accumulator, mirroring how `redemption/tests.rs` constructs paid states.

- [ ] **Step 2: Write the remaining cases as variants of it**

Each row changes exactly one thing about the transaction above. Where the claim
and the memento would both refuse, keep the other side consistent so the
reported code identifies the guard under test.

| Test name | Change from the worked example | Exact expected code |
| --- | --- | --- |
| `retiring_before_the_entropy_record_exists_is_refused` | omit `round.entropy_dep` | `CLAIM_ERROR_UNIVERSE` |
| `a_winner_retiring_with_no_memento_is_refused` | `paid_count = round.universe`, no memento output | `CLAIM_ERROR_RETIRE` |
| `a_non_winner_issuing_a_memento_is_refused` | non-winning position, plus one **well-formed** memento output for that identity so only the claim's count check can refuse | `CLAIM_ERROR_RETIRE` |
| `two_mementos_for_one_retiring_claim_are_refused` | winner, two identical memento outputs | `CLAIM_ERROR_RETIRE` |
| `a_memento_minted_with_no_retiring_claim_is_refused` | memento output, no claim input at all | `MEMENTO_ERROR_MINT` |
| `a_memento_minted_beside_a_transferring_claim_is_refused` | claim input **and** an identical claim output, plus a memento output | `MEMENTO_ERROR_MINT` |
| `a_memento_for_a_different_ticket_is_refused` | memento args name another position than the retiring claim | `MEMENTO_ERROR_MINT` |
| `a_memento_with_the_wrong_winnings_is_refused` | winner, memento `paid_total` off by one | `CLAIM_ERROR_RETIRE` |
| `a_memento_with_the_wrong_rank_is_refused` | winner, memento `prize_index` off by one | `CLAIM_ERROR_RETIRE` |
| `a_memento_with_a_substituted_template_is_refused` | flip one byte of `template_hash` in the memento data | `MEMENTO_ERROR_DATA` |
| `a_memento_locked_to_a_stranger_is_refused` | winner, memento under a second lock | `CLAIM_ERROR_RETIRE` |
| `a_memento_cannot_carry_claim_data` | tag-6 cell holding the 81-byte `PrizeRedemptionState` | `MEMENTO_ERROR_DATA` |
| `a_claim_cannot_carry_memento_data` | tag-5 cell holding the 54-byte `MementoData` | `CLAIM_ERROR_DATA` |
| `a_forged_schedule_witness_is_refused` | a valid `PrizeSchedule` whose commitment is not `cfg.prize_schedule_hash` | `CLAIM_ERROR_UNIVERSE` |
| `an_entropy_record_of_another_round_is_refused` | a sealed record built under a different config commitment | `CLAIM_ERROR_UNIVERSE` |

- [ ] **Step 3: Run the suite**

Run: `cd tests/integration && cargo test --test security_retirement`
Expected: all PASS.

- [ ] **Step 4: Commit**

```bash
git add tests/integration/tests/security_retirement.rs tests/integration/tests/common/mod.rs
git commit -m "test: adversarial retirement and memento cases

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 10: Mutation probes

**Files:**
- No production changes; a verification pass with a written record

**Interfaces:**
- Consumes: the suites from Tasks 9 and 8
- Produces: the evidence table for Task 11

- [ ] **Step 1: Probe each guard individually**

For every guard below, break it, run the named test, confirm it goes **red**,
then restore and confirm green. One guard at a time — sub-project 2 found four
redundant guards that could each be deleted with the whole suite still green,
because they only went red together.

| Guard | Break it by | Test that must go red |
| --- | --- | --- |
| `retire_decision` winner count | `!=` becomes `<` | `a_winner_one_source_short_is_refused` |
| `retire_decision` non-winner count | drop the `paid_count() != 0` check | `a_non_winner_carrying_payments_is_refused` |
| viability gate | drop the `min_viable_pool` term | `an_unyieldable_schedule_voids_the_round` |
| zero-allocation refusal | restore `continue` | `a_batch_allocating_zero_to_a_drawn_position_is_refused` |
| memento count for a winner | allow `found != 1` | `a_winner_retiring_with_no_memento_is_refused` |
| memento duplicate check | drop the `found > 1` branch | `two_mementos_for_one_retiring_claim_are_refused` |
| memento lock equality | drop the lock comparison | `a_memento_locked_to_a_stranger_is_refused` |
| memento data equality | drop the `data != expected` branch | `a_memento_with_the_wrong_winnings_is_refused` |
| memento mint claim-input count | accept any count | `a_memento_minted_with_no_retiring_claim_is_refused` |
| memento mint claim-output count | drop the output check | `a_memento_minted_beside_a_transferring_claim_is_refused` |
| `MementoData::decode` template | drop the template comparison | `a_memento_with_a_substituted_template_is_refused` |
| schedule commitment check | use `decode` instead of `decode_committed` | `a_forged_schedule_witness_is_refused` |

- [ ] **Step 2: Sanity-check each probe hit its target**

A sloppy mutation fails in the safe-looking direction. After each break, confirm
from the test output that the failure is the expected assertion and not a
compile error or an unrelated test, before recording the result.

- [ ] **Step 3: Record the outcome**

Write the table with pass/fail per guard into
`docs/results/2026-09-16-retirement-memento-results.md`, naming any guard that
could **not** be pinned and saying plainly that it is defence in depth. The
non-winner memento pair is expected to be unpinnable on one side — the spec
says so, and the record must agree rather than claim coverage it lacks.

- [ ] **Step 4: Commit**

```bash
git add docs/results/2026-09-16-retirement-memento-results.md
git commit -m "docs: mutation probe record for retirement and memento guards

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 11: Devnet proof and handoff

**Files:**
- Modify: `tests/devnet/` (extend the existing claim lifecycle test)
- Modify: `docs/results/2026-09-16-retirement-memento-results.md`
- Modify: `docs/HANDOFF-2026-09-16.md`

**Interfaces:**
- Consumes: everything above
- Produces: the shipped record

- [ ] **Step 1: Extend the devnet run**

Carry a sealed round through prize redemption to retirement on the isolated
node: a non-winner retires after the seal; a winner redeems every batch, then
retires and receives a memento; the memento transfers once. Follow the existing
devnet test's deploy-and-drive structure.

- [ ] **Step 2: Run the full gate**

Run, in order, never rebuilding a contract while the devnet suite runs:

```bash
for c in round-type entry-shard-type entry-lock dao-lock settlement-type accumulator-bench smoke-alloc smoke-minimal; do
  cargo build --target riscv64imac-unknown-none-elf --release -p $c
done
cargo test -p daowow-core --lib
cargo check -p daowow-core --no-default-features
cargo clippy -p daowow-core --lib -- -D warnings
cd tests/integration && cargo test --no-fail-fast   # smoke has 2 known failures
cd ../.. && cargo build -p daowow-integration-tests --examples
DAOWOW_RUN_ISOLATED_NODE=1 python3 -m unittest discover -s tests/devnet -v
```

Expected: core suite green, integration green except the two pre-existing smoke
failures, devnet green. Record the actual counts — do not assert a number this
plan predicts.

- [ ] **Step 3: Write the results**

Record in `docs/results/2026-09-16-retirement-memento-results.md`: test counts
per suite, the `entry-shard-type` binary size against the 209,360-byte baseline
and its code-cell capacity cost, measured retirement cycles, and any trap worth
adding to `~/.claude/rules/ckb-transactions.feedback.md`.

- [ ] **Step 4: Update the handoff**

In `docs/HANDOFF-2026-09-16.md`, move sub-project 3 to done with links to this
spec and plan, describe the retire and memento modes beside the existing mode
list, add the new error codes, and note the viability gate under the prize
domain. Remove sub-project 3 from "next" and leave the other open items intact.

- [ ] **Step 5: Commit**

```bash
git add tests/devnet docs/results/2026-09-16-retirement-memento-results.md docs/HANDOFF-2026-09-16.md
git commit -m "docs: retirement and memento results, devnet proof and handoff

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```
