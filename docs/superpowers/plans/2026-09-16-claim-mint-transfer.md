# Claim NFT Mint and Transfer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every accepted ticket is minted as one wallet-held claim cell inside its entry append transaction, transferable by its holder, and otherwise immutable and indestructible.

**Architecture:** A pure `daowow_core::claim` module owns the args codec, initial state and the mint/transfer validators. `entry-shard-type` gains a claim mode (45-byte args, tag 5) that delegates minting to the shard transition, and the shard append path enforces exactly one claim per new ticket. Test harness builders add claim outputs through one shared helper.

**Tech Stack:** no_std Rust (daowow-core, ckb-std 1.1.0 contracts), ckb-testtool 1.1.1 integration suite, Python devnet harness driving the `devnet_round` example.

**Spec:** `docs/superpowers/specs/2026-09-16-claim-mint-transfer-design.md`

## Global Constraints

- Claim type args are exactly `[5] ‖ commitment(32) ‖ shard_id(u32 LE) ‖ position(u64 LE)`, 45 bytes.
- Claim data is exactly `PrizeRedemptionState::encode()` (81 bytes) with `ticket == ticket_id(commitment, shard_id, position)`.
- Minting is mandatory: an append with N new tickets must create exactly N claims, each locked to the owning entry's `participant_lock_hash`.
- Every non-append shard transition and the create path must see zero claim outputs for that shard.
- No data change and no burn of a claim is accepted anywhere in this sub-project.
- No RoundConfig, entry-lock, dao-lock or settlement-type change.
- Error codes: `CLAIM_ERROR_ARGS -91`, `CLAIM_ERROR_DATA -92`, `CLAIM_ERROR_GROUP -93`, `CLAIM_ERROR_MINT -94`, `CLAIM_ERROR_TRANSITION -95`, `CLAIM_ERROR_RETIRE -96`, `SHARD_ERROR_CLAIM_CELL -38`.
- Contracts build with `cargo build --target riscv64imac-unknown-none-elf --release -p entry-shard-type` from the repo root before any integration test runs.
- Commit after each task. Commit messages end with `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.

---

## File map

| File | Responsibility |
| --- | --- |
| `crates/daowow-core/src/claim.rs` (new) | `ClaimArgs` codec, `initial_state_bytes`, `MintedClaim`, `validate_mint`, `validate_transfer`, `claim_occupied_capacity` |
| `crates/daowow-core/src/claim/tests.rs` (new) | host unit tests for every rule |
| `crates/daowow-core/src/lib.rs` | `pub mod claim;` |
| `crates/daowow-core/src/error.rs` | claim and shard error codes |
| `contracts/entry-shard-type/src/claim.rs` (new) | claim mode: mint delegation, transfer, rejections |
| `contracts/entry-shard-type/src/main.rs` | dispatch to claim mode; collect claim outputs; enforce mint in append and zero elsewhere |
| `tests/integration/tests/common/mod.rs` | `claim_type_script`, `claim_outputs_for`, `claim_cell_capacity` |
| `tests/integration/tests/proto1_entry_shard.rs`, `proto2_membership.rs`, `security_ledger.rs` | append builders add claim outputs |
| `tests/integration/tests/claim_lifecycle.rs` (new) | accepted cases and cycle measurement |
| `tests/integration/tests/security_claims.rs` (new) | rejected cases |
| `tests/integration/examples/devnet_round.rs`, `tests/devnet/test_round_creation.py` | devnet append emits and spends claim outputs |

---

### Task 1: Core claim args, identity, initial state and transfer rule

**Files:**
- Create: `crates/daowow-core/src/claim.rs`
- Create: `crates/daowow-core/src/claim/tests.rs`
- Modify: `crates/daowow-core/src/lib.rs` (module list, alphabetical after `accumulator`)
- Modify: `crates/daowow-core/src/error.rs` (add codes)

**Interfaces:**
- Consumes: `daowow_core::ticket::ticket_id`, `daowow_core::redemption::PrizeRedemptionState`, `daowow_core::encoding::{read_u32, read_u64, write_u32, write_u64}`, `CoreError`.
- Produces:
  - `pub const CLAIM_TAG: u8 = 5; pub const CLAIM_ARGS_SIZE: usize = 45; pub const CLAIM_DATA_SIZE: usize = 81;`
  - `pub struct ClaimArgs { pub commitment: Hash32, pub shard_id: u32, pub position: u64 }` with `encode(&self) -> [u8; 45]`, `decode(&[u8]) -> Result<Self, CoreError>`, `ticket_id(&self) -> Hash32`.
  - `pub fn initial_state_bytes(args: &ClaimArgs) -> [u8; 81]`
  - `pub fn validate_transfer(args: &ClaimArgs, input: &[u8], output: &[u8]) -> Result<(), CoreError>`
  - `pub fn claim_occupied_capacity(lock_script_size: u64) -> u64` (shannons)

- [x] **Step 1: Add error codes**

In `crates/daowow-core/src/error.rs`, change the `SHARD_ERROR_CONFIG_DEP` line and the reserved comment:

```rust
    pub const SHARD_ERROR_CONFIG_DEP: i8 = -37;
    pub const SHARD_ERROR_CLAIM_CELL: i8 = -38;
```

and after the `accumulator-bench` codes add:

```rust
    // claim mode of entry-shard-type (reserved range -91..)
    pub const CLAIM_ERROR_ARGS: i8 = -91;
    pub const CLAIM_ERROR_DATA: i8 = -92;
    pub const CLAIM_ERROR_GROUP: i8 = -93;
    pub const CLAIM_ERROR_MINT: i8 = -94;
    pub const CLAIM_ERROR_TRANSITION: i8 = -95;
    pub const CLAIM_ERROR_RETIRE: i8 = -96;
```

Update the header comment `//   -91..-128  reserved` to `//   -91..-100  claim mode of entry-shard-type` and `//   -101..-128 reserved`.

- [x] **Step 2: Write the failing tests**

`crates/daowow-core/src/claim/tests.rs`:

```rust
use super::*;
use crate::redemption::PrizeRedemptionState;
use crate::ticket::ticket_id;
use crate::CoreError;

fn args() -> ClaimArgs {
    ClaimArgs {
        commitment: [7; 32],
        shard_id: 3,
        position: 0x0102_0304_0506_0708,
    }
}

#[test]
fn args_round_trip_with_exact_layout() {
    let wire = args().encode();
    assert_eq!(wire.len(), CLAIM_ARGS_SIZE);
    assert_eq!(wire[0], CLAIM_TAG);
    assert_eq!(&wire[1..33], &[7; 32]);
    assert_eq!(&wire[33..37], &3u32.to_le_bytes());
    assert_eq!(&wire[37..45], &0x0102_0304_0506_0708u64.to_le_bytes());
    assert_eq!(ClaimArgs::decode(&wire), Ok(args()));
}

#[test]
fn args_decoder_rejects_wrong_length_or_tag() {
    let wire = args().encode();
    assert_eq!(ClaimArgs::decode(&wire[..44]), Err(CoreError::Encoding));
    let mut long = wire.to_vec();
    long.push(0);
    assert_eq!(ClaimArgs::decode(&long), Err(CoreError::Encoding));
    let mut bad_tag = wire;
    bad_tag[0] = 2;
    assert_eq!(ClaimArgs::decode(&bad_tag), Err(CoreError::Encoding));
    assert_eq!(ClaimArgs::decode(&[]), Err(CoreError::Encoding));
}

#[test]
fn identity_and_initial_state_derive_from_args() {
    let a = args();
    assert_eq!(a.ticket_id(), ticket_id(&[7; 32], 3, 0x0102_0304_0506_0708));
    let bytes = initial_state_bytes(&a);
    assert_eq!(bytes, PrizeRedemptionState::new(a.ticket_id()).encode());
    assert_eq!(bytes.len(), CLAIM_DATA_SIZE);
}

#[test]
fn transfer_requires_identical_decodable_state_with_matching_ticket() {
    let a = args();
    let state = initial_state_bytes(&a);
    assert_eq!(validate_transfer(&a, &state, &state), Ok(()));

    let mut changed = state;
    changed[73] = 1; // paid_total low byte
    assert_eq!(validate_transfer(&a, &state, &changed), Err(CoreError::Encoding));

    let other = initial_state_bytes(&ClaimArgs { position: 9, ..a });
    assert_eq!(validate_transfer(&a, &other, &other), Err(CoreError::Encoding));
    assert_eq!(validate_transfer(&a, &state, &other), Err(CoreError::StateTransition));
    assert_eq!(validate_transfer(&a, &state, &state[..80]), Err(CoreError::Encoding));
}

#[test]
fn occupied_capacity_counts_every_cell_field() {
    // 8 capacity + 53 secp lock + (32 + 1 + 45) type + 81 data = 220 bytes
    assert_eq!(claim_occupied_capacity(53), 220 * 100_000_000);
}
```

Note on the second `validate_transfer` case: a changed `paid_total` with `paid_count == 0` fails decode, so it is an `Encoding` error, not `StateTransition`. The third case (`state` to `other`) decodes on both sides but the output ticket does not match the args, which is also `Encoding`. To exercise `StateTransition` the plan relies on the fourth case being a decodable, ticket-matching but different state; since the only such state is a paid one, build it explicitly:

```rust
#[test]
fn transfer_rejects_any_paid_state_change() {
    use crate::accumulator::smt::host::SmtHost;
    use crate::redemption::{prize_obligation_key, prize_payment_leaf};
    let a = args();
    let initial = PrizeRedemptionState::new(a.ticket_id());
    let mut tree = SmtHost::new();
    let key = prize_obligation_key(&initial.ticket(), &[9; 32]);
    let proof = tree.absence_proof(&[key]).unwrap();
    let paid = initial.record_verified_prize(&[9; 32], 5, &proof).unwrap();
    tree.insert(&key, &prize_payment_leaf(&initial.ticket(), &[9; 32], 5)).unwrap();
    assert_eq!(
        validate_transfer(&a, &initial.encode(), &paid.encode()),
        Err(CoreError::StateTransition)
    );
    // a paid claim transfers unchanged
    assert_eq!(validate_transfer(&a, &paid.encode(), &paid.encode()), Ok(()));
}
```

Replace the fourth assertion in `transfer_requires_identical_decodable_state_with_matching_ticket` (the `state` to `other` case) with `Err(CoreError::Encoding)`.

- [x] **Step 3: Run tests to verify they fail**

Run: `cargo test -p daowow-core --lib claim::tests`
Expected: compile error, `unresolved import` / `cannot find` for `claim` module.

- [x] **Step 4: Implement**

`crates/daowow-core/src/claim.rs`:

```rust
//! Claim cell primitives: args identity, initial state and pure transition
//! rules. Chain provenance, lock authorization and shard delegation are the
//! contract's job (contracts/entry-shard-type/src/claim.rs).

use crate::encoding::{read_u32, read_u64, write_u32, write_u64, EntryDataV1};
use crate::hash::Hash32;
use crate::redemption::PrizeRedemptionState;
use crate::ticket::ticket_id;
use crate::CoreError;

/// First args byte; distinct from 0 (public lock), 2 (receipt), 3 (seal), 4 (entropy).
pub const CLAIM_TAG: u8 = 5;
/// `[tag] || commitment(32) || shard_id(u32 LE) || position(u64 LE)`.
pub const CLAIM_ARGS_SIZE: usize = 45;
/// `PrizeRedemptionState::encode()` length.
pub const CLAIM_DATA_SIZE: usize = 81;
const SHANNONS_PER_CKB: u64 = 100_000_000;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ClaimArgs {
    pub commitment: Hash32,
    pub shard_id: u32,
    pub position: u64,
}

impl ClaimArgs {
    pub fn encode(&self) -> [u8; CLAIM_ARGS_SIZE] {
        let mut out = [0u8; CLAIM_ARGS_SIZE];
        out[0] = CLAIM_TAG;
        out[1..33].copy_from_slice(&self.commitment);
        write_u32(&mut out, 33, self.shard_id);
        write_u64(&mut out, 37, self.position);
        out
    }

    pub fn decode(data: &[u8]) -> Result<Self, CoreError> {
        if data.len() != CLAIM_ARGS_SIZE || data[0] != CLAIM_TAG {
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

    pub fn ticket_id(&self) -> Hash32 {
        ticket_id(&self.commitment, self.shard_id, self.position)
    }
}

/// The only data a freshly minted claim may carry.
pub fn initial_state_bytes(args: &ClaimArgs) -> [u8; CLAIM_DATA_SIZE] {
    PrizeRedemptionState::new(args.ticket_id()).encode()
}

/// Transfer keeps data byte-identical. Both sides must decode with the ticket
/// the args name; any decodable difference is the (not yet defined) redemption
/// shape and is a state-transition error.
pub fn validate_transfer(args: &ClaimArgs, input: &[u8], output: &[u8]) -> Result<(), CoreError> {
    let ticket = args.ticket_id();
    for side in [input, output] {
        let state = PrizeRedemptionState::decode(side)?;
        if state.ticket() != ticket {
            return Err(CoreError::Encoding);
        }
    }
    if input != output {
        return Err(CoreError::StateTransition);
    }
    Ok(())
}

/// Occupied capacity in shannons: capacity field, holder lock, claim type, data.
pub fn claim_occupied_capacity(lock_script_size: u64) -> u64 {
    (8 + lock_script_size + (32 + 1 + CLAIM_ARGS_SIZE as u64) + CLAIM_DATA_SIZE as u64)
        * SHANNONS_PER_CKB
}

// `MintedClaim` and `validate_mint` are added in Task 2.
#[allow(unused_imports)]
use EntryDataV1 as _;

#[cfg(all(test, feature = "std"))]
mod tests;
```

Add `pub mod claim;` to `crates/daowow-core/src/lib.rs` between `accumulator` and `computed_draw`.

- [x] **Step 5: Run tests to verify they pass**

Run: `cargo test -p daowow-core --lib claim::tests`
Expected: 6 passed.

- [x] **Step 6: Run the crate checks**

Run: `cargo test -p daowow-core --lib && cargo check -p daowow-core --no-default-features && cargo clippy -p daowow-core --lib -- -D warnings && rustfmt --check --edition 2021 crates/daowow-core/src/claim.rs crates/daowow-core/src/claim/tests.rs`
Expected: all green (the placeholder `use EntryDataV1 as _;` keeps clippy quiet until Task 2 removes it).

- [x] **Step 7: Commit**

```bash
git add crates/daowow-core/src/claim.rs crates/daowow-core/src/claim/tests.rs crates/daowow-core/src/lib.rs crates/daowow-core/src/error.rs
git commit -m "feat(core): claim args identity, initial state and transfer rule"
```

---

### Task 2: Core mint validator

**Files:**
- Modify: `crates/daowow-core/src/claim.rs`
- Modify: `crates/daowow-core/src/claim/tests.rs`

**Interfaces:**
- Consumes: Task 1 items; `EntryDataV1 { participant_lock_hash, ticket_count, position_base, .. }`.
- Produces:
  - `pub struct MintedClaim { pub position: u64, pub lock_hash: Hash32, pub data: [u8; 81] }`
  - `pub fn validate_mint(before_tickets: u64, after_tickets: u64, commitment: &Hash32, shard_id: u32, entries: &[EntryDataV1], claims: &[MintedClaim]) -> Result<(), CoreError>`
  - Error mapping: count mismatch or `after < before` → `InvalidArgument`; position out of range, duplicate, no owning entry, wrong lock → `StateTransition`; wrong data → `Encoding`.

- [x] **Step 1: Write the failing tests**

Append to `crates/daowow-core/src/claim/tests.rs`:

```rust
fn entry(lock: u8, base: u64, tickets: u64) -> crate::encoding::EntryDataV1 {
    crate::encoding::EntryDataV1 {
        round_id: [1; 32],
        shard_id: 3,
        participant_lock_hash: [lock; 32],
        ticket_count: tickets,
        principal: tickets * 100,
        position_base: base,
        entry_nonce: base,
        entropy_commitment: [0; 32],
    }
}

fn claim(position: u64, lock: u8) -> MintedClaim {
    let a = ClaimArgs { commitment: [7; 32], shard_id: 3, position };
    MintedClaim { position, lock_hash: [lock; 32], data: initial_state_bytes(&a) }
}

/// Two entries: A owns positions 10..13 (3 tickets), B owns 13..15 (2 tickets).
fn fixture() -> (Vec<crate::encoding::EntryDataV1>, Vec<MintedClaim>) {
    let entries = vec![entry(0xA, 10, 3), entry(0xB, 13, 2)];
    let claims = vec![claim(10, 0xA), claim(11, 0xA), claim(12, 0xA), claim(13, 0xB), claim(14, 0xB)];
    (entries, claims)
}

fn check(claims: &[MintedClaim]) -> Result<(), CoreError> {
    let (entries, _) = fixture();
    validate_mint(10, 15, &[7; 32], 3, &entries, claims)
}

#[test]
fn mint_accepts_exactly_one_claim_per_new_ticket_in_any_order() {
    let (_, mut claims) = fixture();
    assert_eq!(check(&claims), Ok(()));
    claims.reverse();
    assert_eq!(check(&claims), Ok(()));
    let (entries, _) = fixture();
    assert_eq!(validate_mint(10, 10, &[7; 32], 3, &[], &[]), Ok(()));
    let _ = entries;
}

#[test]
fn mint_rejects_wrong_claim_count() {
    let (_, mut claims) = fixture();
    let extra = claims.pop().unwrap();
    assert_eq!(check(&claims), Err(CoreError::InvalidArgument));
    claims.push(extra);
    claims.push(claim(14, 0xB));
    assert_eq!(check(&claims), Err(CoreError::InvalidArgument));
    let (entries, claims) = fixture();
    assert_eq!(validate_mint(15, 10, &[7; 32], 3, &entries, &claims), Err(CoreError::InvalidArgument));
}

#[test]
fn mint_rejects_positions_outside_the_new_range_and_duplicates() {
    let (_, mut claims) = fixture();
    claims[4] = claim(9, 0xA); // remint of an earlier ticket
    assert_eq!(check(&claims), Err(CoreError::StateTransition));
    claims[4] = claim(15, 0xB); // beyond after_tickets
    assert_eq!(check(&claims), Err(CoreError::StateTransition));
    claims[4] = claim(13, 0xB); // duplicate of claims[3]
    assert_eq!(check(&claims), Err(CoreError::StateTransition));
}

#[test]
fn mint_rejects_claim_not_locked_to_the_owning_entrant() {
    let (_, mut claims) = fixture();
    claims[3] = claim(13, 0xA); // B's ticket minted to A
    assert_eq!(check(&claims), Err(CoreError::StateTransition));
    claims[3] = claim(13, 0xC); // stranger
    assert_eq!(check(&claims), Err(CoreError::StateTransition));
}

#[test]
fn mint_rejects_position_with_no_owning_entry() {
    // entries cover 10..15 but the second entry is missing; count still 5
    let entries = vec![entry(0xA, 10, 3)];
    let (_, claims) = fixture();
    assert_eq!(
        validate_mint(10, 15, &[7; 32], 3, &entries, &claims),
        Err(CoreError::StateTransition)
    );
}

#[test]
fn mint_rejects_nonzero_or_misidentified_data() {
    let (_, mut claims) = fixture();
    claims[0].data[73] = 1; // paid_total
    assert_eq!(check(&claims), Err(CoreError::Encoding));
    let (_, mut claims) = fixture();
    let wrong = ClaimArgs { commitment: [8; 32], shard_id: 3, position: 10 };
    claims[0].data = initial_state_bytes(&wrong);
    assert_eq!(check(&claims), Err(CoreError::Encoding));
    let (_, mut claims) = fixture();
    let wrong = ClaimArgs { commitment: [7; 32], shard_id: 4, position: 10 };
    claims[0].data = initial_state_bytes(&wrong);
    assert_eq!(check(&claims), Err(CoreError::Encoding));
}
```

- [x] **Step 2: Run tests to verify they fail**

Run: `cargo test -p daowow-core --lib claim::tests`
Expected: compile error, `cannot find struct MintedClaim` / `cannot find function validate_mint`.

- [x] **Step 3: Implement**

In `crates/daowow-core/src/claim.rs` replace the two placeholder lines (`// MintedClaim and validate_mint...` and `use EntryDataV1 as _;`) with:

```rust
/// One claim output as observed by the shard script.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct MintedClaim {
    pub position: u64,
    pub lock_hash: Hash32,
    pub data: [u8; CLAIM_DATA_SIZE],
}

/// Exactly one claim per new ticket `[before_tickets, after_tickets)`, each
/// locked to the entrant that owns the position and carrying the initial
/// state for its identity. `entries` are the append's witness entries, already
/// validated contiguous by `shard::apply_entry_batch`.
pub fn validate_mint(
    before_tickets: u64,
    after_tickets: u64,
    commitment: &Hash32,
    shard_id: u32,
    entries: &[EntryDataV1],
    claims: &[MintedClaim],
) -> Result<(), CoreError> {
    let new = after_tickets
        .checked_sub(before_tickets)
        .ok_or(CoreError::InvalidArgument)?;
    if claims.len() as u64 != new {
        return Err(CoreError::InvalidArgument);
    }
    // bounded by the transaction's own output count (claims.len() == new)
    let mut seen = alloc::vec![false; claims.len()];
    for c in claims {
        if c.position < before_tickets || c.position >= after_tickets {
            return Err(CoreError::StateTransition);
        }
        let idx = (c.position - before_tickets) as usize;
        if seen[idx] {
            return Err(CoreError::StateTransition);
        }
        seen[idx] = true;
        let owner = entries
            .iter()
            .find(|e| {
                c.position >= e.position_base
                    && e.position_base
                        .checked_add(e.ticket_count)
                        .is_some_and(|end| c.position < end)
            })
            .ok_or(CoreError::StateTransition)?;
        if c.lock_hash != owner.participant_lock_hash {
            return Err(CoreError::StateTransition);
        }
        let args = ClaimArgs {
            commitment: *commitment,
            shard_id,
            position: c.position,
        };
        if c.data != initial_state_bytes(&args) {
            return Err(CoreError::Encoding);
        }
    }
    Ok(())
}
```

- [x] **Step 4: Run tests to verify they pass**

Run: `cargo test -p daowow-core --lib claim::tests`
Expected: 12 passed.

- [x] **Step 5: Mutation probes**

For each guard below, temporarily break it, run `cargo test -p daowow-core --lib claim::tests`, confirm the named test fails, restore, and confirm green. Record the outcome in the Results section of this plan.

| Guard | Mutation | Must fail |
| --- | --- | --- |
| count check | `!= new` → `!= new + 1000` and skip the bitmap (or return Ok early) | `mint_rejects_wrong_claim_count` |
| range check | drop the `c.position < before_tickets \|\| ... >= after_tickets` return | `mint_rejects_positions_outside_the_new_range_and_duplicates` |
| duplicate check | drop the `if seen[idx]` return | same test (duplicate case) |
| lock check | drop the `lock_hash != owner` return | `mint_rejects_claim_not_locked_to_the_owning_entrant` |
| data check | drop the `c.data != initial_state_bytes` return | `mint_rejects_nonzero_or_misidentified_data` |
| owner lookup | replace `.ok_or(StateTransition)?` with `unwrap_or(&entries[0])` | `mint_rejects_position_with_no_owning_entry` |

- [x] **Step 6: Crate checks and commit**

Run: `cargo test -p daowow-core --lib && cargo check -p daowow-core --no-default-features && cargo clippy -p daowow-core --lib -- -D warnings && rustfmt --check --edition 2021 crates/daowow-core/src/claim.rs crates/daowow-core/src/claim/tests.rs`

```bash
git add crates/daowow-core/src/claim.rs crates/daowow-core/src/claim/tests.rs
git commit -m "feat(core): claim mint validator"
```

---

### Task 3: Contract claim mode and shard mint enforcement

**Files:**
- Create: `contracts/entry-shard-type/src/claim.rs`
- Modify: `contracts/entry-shard-type/src/main.rs` (`mod` list at lines 17-19; dispatch at lines 65-76; claim collection after the `entry_shard_count` check at line 134; creation path; state-machine match at lines 208-230; `append` signature and body after the `claimed` check at ~line 393)

**Interfaces:**
- Consumes: `daowow_core::claim::{ClaimArgs, MintedClaim, initial_state_bytes, validate_mint, validate_transfer, CLAIM_ARGS_SIZE, CLAIM_TAG, CLAIM_DATA_SIZE}`, `daowow_core::error::codes::*`, `daowow_core::encoding::SHARD_DATA_SIZE`.
- Produces: contract behaviour only. `claim::run(&Script) -> Result<i8, i8>` mirrors `seal::create`.

- [x] **Step 1: Write the claim mode**

`contracts/entry-shard-type/src/claim.rs`:

```rust
//! Claim mode of the shard binary: args `[5] || commitment || shard_id || position`.
//!
//! Mint delegates counting to the OPEN shard transition of the same identity,
//! which must be present as input and output. Transfer keeps data identical.
//! Any data change (redemption) or burn (retirement) is rejected until the
//! sub-projects that authenticate them exist.

use ckb_std::ckb_constants::Source;
use ckb_std::ckb_types::packed::Script;
use ckb_std::ckb_types::prelude::*;
use ckb_std::high_level::{load_cell, load_cell_data};
use daowow_core::claim::{initial_state_bytes, validate_transfer, ClaimArgs};
use daowow_core::encoding::SHARD_DATA_SIZE;
use daowow_core::error::codes::*;
use daowow_core::CoreError;

fn err(e: i8) -> Result<i8, i8> {
    ckb_std::debug!("claim error {}", e);
    Err(e)
}

/// Data length without allocating the whole cell data.
fn data_len(index: usize, source: Source) -> Option<usize> {
    let mut probe = [0u8; 1];
    match ckb_std::syscalls::load_cell_data(&mut probe, 0, index, source) {
        Ok(size) | Err(ckb_std::error::SysError::LengthNotEnough(size)) => Some(size),
        Err(_) => None,
    }
}

/// True when `source` holds an OPEN/FROZEN shard cell of this binary whose
/// args are exactly `commitment || shard_id`.
fn shard_present(script: &Script, args: &ClaimArgs, source: Source) -> bool {
    let mut expect = [0u8; 36];
    expect[..32].copy_from_slice(&args.commitment);
    expect[32..].copy_from_slice(&args.shard_id.to_le_bytes());
    let mut i = 0;
    while let Ok(cell) = load_cell(i, source) {
        if let Some(t) = cell.type_().to_opt() {
            if t.code_hash() == script.code_hash()
                && t.hash_type() == script.hash_type()
                && t.args().raw_data().as_ref() == expect
                && data_len(i, source) == Some(SHARD_DATA_SIZE)
            {
                return true;
            }
        }
        i += 1;
    }
    false
}

pub fn run(script: &Script) -> Result<i8, i8> {
    let args = match ClaimArgs::decode(script.args().raw_data().as_ref()) {
        Ok(a) => a,
        Err(_) => return err(CLAIM_ERROR_ARGS),
    };
    if load_cell(1, Source::GroupInput).is_ok() || load_cell(1, Source::GroupOutput).is_ok() {
        return err(CLAIM_ERROR_GROUP);
    }
    let has_input = load_cell(0, Source::GroupInput).is_ok();
    let output = load_cell_data(0, Source::GroupOutput).ok();
    match (has_input, output) {
        (false, Some(data)) => {
            if !shard_present(script, &args, Source::Input)
                || !shard_present(script, &args, Source::Output)
            {
                return err(CLAIM_ERROR_MINT);
            }
            if data.as_ref() != initial_state_bytes(&args) {
                return err(CLAIM_ERROR_DATA);
            }
            Ok(0)
        }
        (true, Some(data)) => {
            let input = match load_cell_data(0, Source::GroupInput) {
                Ok(d) => d,
                Err(_) => return err(CLAIM_ERROR_DATA),
            };
            match validate_transfer(&args, &input, &data) {
                Ok(()) => Ok(0),
                Err(CoreError::StateTransition) => err(CLAIM_ERROR_TRANSITION),
                Err(_) => err(CLAIM_ERROR_DATA),
            }
        }
        (true, None) => err(CLAIM_ERROR_RETIRE),
        (false, None) => err(CLAIM_ERROR_GROUP),
    }
}
```

- [x] **Step 2: Wire the dispatch**

In `contracts/entry-shard-type/src/main.rs`:

Add `mod claim;` to the module list (alphabetical: `claim`, `entropy`, `ledger`, `seal`).

Immediately after the public-lock check in `main` (after `return public_lock(&script);` block, before the 77-byte receipt check) add:

```rust
    {
        let args = script.args().raw_data();
        if args.len() == daowow_core::claim::CLAIM_ARGS_SIZE
            && args[0] == daowow_core::claim::CLAIM_TAG
        {
            return claim::run(&script).unwrap_or_else(err);
        }
    }
```

- [x] **Step 3: Collect claim outputs in the shard path**

Add this function near `large_state_version`:

```rust
/// Every output that is a claim of this binary for `commitment || shard_id`.
/// Malformed claim data for this shard is an error here so a later branch
/// cannot silently ignore it.
fn collect_claims(
    script: &ckb_std::ckb_types::packed::Script,
    commitment: &[u8; 32],
    shard_id: u32,
) -> Result<alloc::vec::Vec<daowow_core::claim::MintedClaim>, i8> {
    use daowow_core::claim::{CLAIM_ARGS_SIZE, CLAIM_DATA_SIZE, CLAIM_TAG};
    let mut out = alloc::vec::Vec::new();
    let mut i = 0usize;
    while let Ok(cell) = load_cell(i, Source::Output) {
        if let Some(t) = cell.type_().to_opt() {
            let args = t.args().raw_data();
            if t.code_hash() == script.code_hash()
                && t.hash_type() == script.hash_type()
                && args.len() == CLAIM_ARGS_SIZE
                && args[0] == CLAIM_TAG
                && args[1..33] == commitment[..]
                && args[33..37] == shard_id.to_le_bytes()
            {
                let position = u64::from_le_bytes(args[37..45].try_into().unwrap());
                let lock_hash = ckb_std::high_level::load_cell_lock_hash(i, Source::Output)
                    .map_err(|_| SHARD_ERROR_CLAIM_CELL)?;
                let data = load_cell_data(i, Source::Output).map_err(|_| SHARD_ERROR_CLAIM_CELL)?;
                if data.len() != CLAIM_DATA_SIZE {
                    return Err(SHARD_ERROR_CLAIM_CELL);
                }
                let mut fixed = [0u8; CLAIM_DATA_SIZE];
                fixed.copy_from_slice(&data);
                out.push(daowow_core::claim::MintedClaim {
                    position,
                    lock_hash,
                    data: fixed,
                });
            }
        }
        i += 1;
    }
    Ok(out)
}
```

In `main`, directly after the `if cfg.entry_shard_count <= after.shard_id { ... }` check, add:

```rust
    let claims = match collect_claims(&script, &commitment, after.shard_id) {
        Ok(c) => c,
        Err(e) => return err(e),
    };
```

In the `if is_creation {` block, as its first statement:

```rust
        if !claims.is_empty() {
            return err(SHARD_ERROR_CLAIM_CELL);
        }
```

Change the state-machine match:

```rust
    match (before.state, after.state) {
        (SHARD_STATE_OPEN, SHARD_STATE_OPEN) => append(&cfg, &before, &after, &claims),
        (SHARD_STATE_OPEN, SHARD_STATE_FROZEN) => {
            if !claims.is_empty() {
                return err(SHARD_ERROR_CLAIM_CELL);
            }
            // ... existing since / validate_freeze body unchanged ...
        }
        (SHARD_STATE_FROZEN, SHARD_STATE_FROZEN) => {
            if !claims.is_empty() {
                return err(SHARD_ERROR_CLAIM_CELL);
            }
            // ... existing validate_frozen_noop body unchanged ...
        }
        _ => err(SHARD_ERROR_STATE),
    }
```

Change `fn append(cfg, before, after)` to `fn append(cfg, before, after, claims: &[daowow_core::claim::MintedClaim])` and, right after the block ending `if claimed.iter().any(|c| !c) { return err(SHARD_ERROR_ENTRY_CELL); }`, add:

```rust
    // one claim NFT per new ticket, locked to its entrant, carrying fresh state
    if daowow_core::claim::validate_mint(
        before.ticket_count,
        after.ticket_count,
        &cfg.commitment(),
        after.shard_id,
        &wit.entries,
        claims,
    )
    .is_err()
    {
        return err(SHARD_ERROR_CLAIM_CELL);
    }
```

- [x] **Step 4: Build the contract**

Run: `cargo build --target riscv64imac-unknown-none-elf --release -p entry-shard-type`
Expected: success, no warnings from the new code.

- [x] **Step 5: Confirm the rule bites**

Run: `cd tests/integration && cargo test --test proto1_entry_shard 2>&1 | tail -20`
Expected: append tests now FAIL with captured debug showing shard error `-38` (no claim outputs yet). This is the expected red; Task 4 turns it green. If they still pass, the enforcement is not wired.

- [x] **Step 6: Commit**

```bash
git add contracts/entry-shard-type/src/claim.rs contracts/entry-shard-type/src/main.rs
git commit -m "feat(contract): claim mode and mandatory mint in shard append"
```

---

### Task 4: Harness helper and existing append builders

**Files:**
- Modify: `tests/integration/tests/common/mod.rs` (add three functions after `entry_cell_capacity`)
- Modify: `tests/integration/tests/proto1_entry_shard.rs:31-115` (`build_entry_tx`)
- Modify: `tests/integration/tests/proto2_membership.rs:35-110` (`build_round`)
- Modify: `tests/integration/tests/security_ledger.rs:47-90` (fixture append loop)
- Check: every other file that calls `smt_append_witness` or builds an OPEN→OPEN shard transaction (`grep -rn "smt_append_witness\|encode_shard_append_witness" tests/integration/tests`); `accumulator_bakeoff.rs` drives the bench contract, not the shard, and should need no change — confirm by running it.

**Interfaces:**
- Produces in `common/mod.rs`:
  - `impl World { pub fn claim_type_script(&mut self, shard_id: u32, position: u64) -> Script }`
  - `pub fn claim_cell_capacity(lock: &Script) -> u64`
  - `pub fn claim_outputs_for(world: &mut World, entries: &[EntryDataV1], lock_for: &dyn Fn(&Hash32) -> Script) -> Vec<(CellOutput, Bytes)>`

- [x] **Step 1: Add the helpers**

In `tests/integration/tests/common/mod.rs`, inside `impl World` after `entry_lock_script`:

```rust
    /// Claim NFT type script for one ticket of this round.
    pub fn claim_type_script(&mut self, shard_id: u32, position: u64) -> Script {
        let r = self.deps.entry_shard_type;
        let args = daowow_core::claim::ClaimArgs {
            commitment: self.config_hash,
            shard_id,
            position,
        }
        .encode();
        self.script_for(&r, Bytes::from(args.to_vec()))
    }
```

After `entry_cell_capacity`:

```rust
/// Minimum capacity of a claim cell under `lock` (shannons).
pub fn claim_cell_capacity(lock: &Script) -> u64 {
    daowow_core::claim::claim_occupied_capacity(lock.as_slice().len() as u64)
}

/// One claim output per ticket of `entries`, locked by `lock_for(participant_lock_hash)`.
/// The lock returned must hash to that participant hash (the test's own lock).
pub fn claim_outputs_for(
    world: &mut World,
    entries: &[EntryDataV1],
    lock_for: &dyn Fn(&Hash32) -> Script,
) -> Vec<(CellOutput, Bytes)> {
    let mut out = Vec::new();
    for e in entries {
        let lock = lock_for(&e.participant_lock_hash);
        for i in 0..e.ticket_count {
            let position = e.position_base + i;
            let type_script = world.claim_type_script(e.shard_id, position);
            let args = daowow_core::claim::ClaimArgs {
                commitment: world.config_hash,
                shard_id: e.shard_id,
                position,
            };
            let cell = CellOutputBuilder::default()
                .capacity(pack_u64(claim_cell_capacity(&lock)))
                .lock(lock.clone())
                .type_(Some(type_script).pack())
                .build();
            out.push((
                cell,
                Bytes::from(daowow_core::claim::initial_state_bytes(&args).to_vec()),
            ));
        }
    }
    out
}
```

`World.config_hash` is the config commitment: `create_round` sets it from `cfg.commitment()` (`common/mod.rs:306`), so `claim_type_script` must be called after `create_round`, which every fixture already does.

- [x] **Step 2: Update `proto1_entry_shard::build_entry_tx`**

The participant lock in this builder is the `always_success` script captured as `participant_lock` (currently `let (_, participant_lock) = world.always_success();` at ~line 78). After the loop that pushes entry outputs and before the spurious-entry loop, add:

```rust
    let lock = participant_lock.clone();
    for (cell, data) in claim_outputs_for(world, entries, &|_| lock.clone()) {
        builder = builder.output(cell).output_data(data);
    }
```

The `participant_hash` argument of `build_entry_tx` must be `World::participant_hash(&participant_lock)` for the mint lock check to pass; verify the callers (search `build_entry_tx(` in the file) and, where a caller passes a hash that is not that lock's hash for a *rejection* test, leave it: the transaction is expected to fail anyway. For adversarial tests that expect a specific shard error other than `-38`, confirm they still fail for their original reason by reading the captured debug output; if one now fails at the claim check first, move its mutation after the claims are consistent (e.g. mint claims to the same lock the entry names).

Also raise the funding input if needed: each claim cell needs ~220 CKB, so an entry of `t` tickets adds `t * 220 CKB`. `world.funding_cell(100_000 * SHANNONS)` covers up to ~450 claims; leave as is unless a test exceeds it.

- [x] **Step 3: Update `proto2_membership::build_round`**

The participant lock is `lock` (from `let (_, lock) = world.always_success();` at line 41) and its hash is `ph`. Split the chained `TransactionBuilder` at line 82 into a `let mut builder = ...` ending after `.output_data(Bytes::from(e.encode().to_vec()))`, then insert before the `.witness(witness)` chain:

```rust
        let claim_lock = lock.clone();
        for (cell, data) in claim_outputs_for(&mut world, &[e.clone()], &|_| claim_lock.clone()) {
            builder = builder.output(cell).output_data(data);
        }
        let tx = builder
            .witness(witness)
            .witness(pack_pbytes(WitnessArgs::new_builder().build().as_bytes().as_ref()))
            .witness(pack_pbytes(WitnessArgs::new_builder().build().as_bytes().as_ref()))
            .build();
```

- [x] **Step 4: Update `security_ledger` fixture**

In the loop building each entry transaction (`security_ledger.rs:47-90`), the participant lock is `participant_lock` (always_success with one-byte args). Replace the `let tx = TransactionBuilder::default()...build();` with a builder variable and add claim outputs before `.witness(...)`:

```rust
        let mut builder = TransactionBuilder::default()
            .cell_dep(w.round_config_dep(&round))
            .input(CellInput::new(shard.clone(), 0))
            .input(CellInput::new(funding, 0))
            .output(cell.clone())
            .output_data(Bytes::from(frozen.encode().to_vec()))
            .output(entry_cell.clone())
            .output_data(Bytes::from(e.encode().to_vec()));
        for (claim_cell, claim_data) in
            claim_outputs_for(&mut w, &[e], &|_| participant_lock.clone())
        {
            builder = builder.output(claim_cell).output_data(claim_data);
        }
        let tx = builder
            .witness(smt_append_witness(
                &[e],
                &[(absence.as_slice(), inclusion.as_slice())],
            ))
            .build();
```

The funding cell there is `1000 * SHANNONS`; one ticket per entry adds 220 CKB, so raise it to `2000 * SHANNONS`.

Repeat the same edit in every other `security_*.rs` fixture that builds an append (grep as listed above); they were copied from this one.

- [x] **Step 5: Run the whole integration suite**

Run: `cargo build --target riscv64imac-unknown-none-elf --release && cd tests/integration && cargo test 2>&1 | grep -E "^test result|FAILED|panicked" `
Expected: every suite green. Any remaining `-38` in captured debug means a builder still lacks claim outputs.

- [x] **Step 6: Commit**

```bash
git add tests/integration/tests
git commit -m "test: mint claim outputs in every append builder"
```

---

### Task 5: Accepted lifecycle suite and cycle measurement

**Files:**
- Create: `tests/integration/tests/claim_lifecycle.rs`

**Interfaces:**
- Consumes: `common::*`, Task 4 helpers.

- [x] **Step 1: Write the fixture and accepted tests**

```rust
mod common;

use ckb_testtool::ckb_types::{bytes::Bytes, core::TransactionBuilder, packed::*, prelude::*};
use common::*;
use daowow_core::accumulator::smt::host::SmtHost;
use daowow_core::encoding::{EntryDataV1, EntryShardDataV1, RoundConfigV1, ACC_SMT};

struct Fixture {
    w: World,
    cfg: RoundConfigV1,
    round: OutPoint,
    shard: OutPoint,
    shard_data: EntryShardDataV1,
    host: SmtHost,
    lock: Script,
    /// (claim out point, position) for every minted claim
    claims: Vec<(OutPoint, u64)>,
}

fn fixture() -> Fixture {
    let mut w = World::new(ACC_SMT);
    let cfg = default_config([5; 32], ACC_SMT);
    let round = w.create_round(&cfg);
    let (shard, shard_data) = w.create_shard(&cfg, 0, 1);
    let (_, lock) = w.always_success();
    Fixture { w, cfg, round, shard, shard_data, host: SmtHost::new(), lock, claims: Vec::new() }
}

/// Append `ticket_counts` entries for the fixture lock, minting one claim per ticket.
fn append(f: &mut Fixture, ticket_counts: &[u64]) -> (TransactionView, Vec<EntryDataV1>) {
    let participant = World::participant_hash(&f.lock);
    let commitments: Vec<[u8; 32]> = (0..ticket_counts.len()).map(|i| [i as u8 + 1; 32]).collect();
    let entries = make_entry_batch(&f.cfg, &f.shard_data, &participant, ticket_counts, &commitments);
    let mut certs = Vec::new();
    for e in &entries {
        let absence = f.host.absence_proof(&[smt_key(e)]).unwrap();
        f.host.insert(&smt_key(e), &smt_leaf(e)).unwrap();
        let inclusion = f.host.inclusion_proof(&[smt_key(e)]).unwrap();
        certs.push((absence, inclusion));
    }
    let cert_refs: Vec<(&[u8], &[u8])> = certs.iter().map(|(a, b)| (a.as_slice(), b.as_slice())).collect();
    let mut after = daowow_core::shard::apply_entry_batch(Some(&f.shard_data), &f.cfg, &entries).unwrap();
    after.accumulator_root = f.host.root();
    let (shard_in, _) = f.w.cell(&f.shard);
    let (funding, _) = f.w.funding_cell(100_000 * SHANNONS);
    let entry_lock = f.w.entry_lock_script(&participant);
    let mut b = TransactionBuilder::default()
        .cell_dep(f.w.round_config_dep(&f.round))
        .input(CellInput::new(f.shard.clone(), 0))
        .input(CellInput::new(funding, 0))
        .output(shard_in.clone())
        .output_data(Bytes::from(after.encode().to_vec()));
    for e in &entries {
        b = b
            .output(CellOutputBuilder::default().capacity(pack_u64(entry_cell_capacity(e))).lock(entry_lock.clone()).build())
            .output_data(Bytes::from(e.encode().to_vec()));
    }
    let lock = f.lock.clone();
    let claim_cells = claim_outputs_for(&mut f.w, &entries, &|_| lock.clone());
    let first_claim_index = 1 + entries.len();
    for (cell, data) in &claim_cells {
        b = b.output(cell.clone()).output_data(data.clone());
    }
    let tx = b.witness(smt_append_witness(&entries, &cert_refs)).build();
    expect_ok(&mut f.w.context, &tx);
    chain_cell(&mut f.w, &f.shard, &tx, 0);
    f.shard_data = after;
    // register every claim output as a live cell for later transfers
    let mut idx = first_claim_index;
    for e in &entries {
        for k in 0..e.ticket_count {
            let (cell, data) = &claim_cells[idx - first_claim_index];
            let op = f.w.context.create_cell(cell.clone(), data.clone());
            chain_cell(&mut f.w, &op, &tx, idx);
            f.claims.push((op, e.position_base + k));
            idx += 1;
        }
    }
    (tx, entries)
}
```

```rust
/// Transfer `claims` (out points) to `to`, one successor each, byte-identical data.
fn transfer_tx(f: &mut Fixture, claims: &[OutPoint], to: &Script) -> TransactionView {
    let (funding, _) = f.w.funding_cell(1_000 * SHANNONS);
    let mut b = TransactionBuilder::default().input(CellInput::new(funding, 0));
    for op in claims {
        let (cell, data) = f.w.cell(op);
        b = b
            .input(CellInput::new(op.clone(), 0))
            .output(cell.as_builder().lock(to.clone()).build())
            .output_data(data);
    }
    b.build()
}

#[test]
fn append_mints_one_claim_per_ticket_across_entries() {
    let mut f = fixture();
    let (_, entries) = append(&mut f, &[3, 2]);
    assert_eq!(f.claims.len(), 5);
    assert_eq!(entries[1].position_base, 3);
    let positions: Vec<u64> = f.claims.iter().map(|(_, p)| *p).collect();
    assert_eq!(positions, vec![0, 1, 2, 3, 4]);
}

#[test]
fn consecutive_appends_mint_disjoint_positions() {
    let mut f = fixture();
    append(&mut f, &[2]);
    append(&mut f, &[1, 1]);
    let positions: Vec<u64> = f.claims.iter().map(|(_, p)| *p).collect();
    assert_eq!(positions, vec![0, 1, 2, 3]);
}

#[test]
fn holder_transfers_one_claim() {
    let mut f = fixture();
    append(&mut f, &[2]);
    let (_, recipient) = f.w.always_success();
    let recipient = recipient.as_builder().args(pack_pbytes(b"bob")).build();
    let op = f.claims[0].0.clone();
    let tx = transfer_tx(&mut f, &[op], &recipient);
    let cycles = expect_ok(&mut f.w.context, &tx);
    println!("claim transfer cycles: {cycles}");
}

#[test]
fn holder_transfers_two_claims_in_one_transaction() {
    let mut f = fixture();
    append(&mut f, &[2]);
    let (_, recipient) = f.w.always_success();
    let recipient = recipient.as_builder().args(pack_pbytes(b"carol")).build();
    let ops: Vec<OutPoint> = f.claims.iter().map(|(op, _)| op.clone()).collect();
    let tx = transfer_tx(&mut f, &ops, &recipient);
    expect_ok(&mut f.w.context, &tx);
}

#[test]
fn transfer_to_own_lock_is_allowed() {
    let mut f = fixture();
    append(&mut f, &[1]);
    let me = f.lock.clone();
    let op = f.claims[0].0.clone();
    let tx = transfer_tx(&mut f, &[op], &me);
    expect_ok(&mut f.w.context, &tx);
}

#[test]
fn max_batch_append_with_claims_fits_cycle_budget() {
    let mut f = fixture();
    let counts = vec![4u64; daowow_core::lifecycle::MAX_BATCH_ENTRIES];
    let (tx, _) = append(&mut f, &counts);
    let cycles = expect_ok(&mut f.w.context, &tx);
    println!(
        "append {} entries / {} claims: {} cycles; claim cell {} shannons",
        counts.len(),
        f.claims.len(),
        cycles,
        claim_cell_capacity(&f.lock)
    );
    assert!(cycles < MAX_CYCLES);
}
```

Note: `expect_ok` in `append` already runs the tx, so the last test's second `expect_ok` re-verifies the same tx to capture cycles; that is fine with testtool.

- [x] **Step 2: Run**

Run: `cd tests/integration && cargo test --test claim_lifecycle -- --nocapture 2>&1 | grep -E "cycles|test result|FAILED"`
Expected: 6 passed; record the printed cycle counts and claim cell capacity in Results.

- [x] **Step 3: Commit**

```bash
git add tests/integration/tests/claim_lifecycle.rs
git commit -m "test: claim mint and transfer lifecycle on CKB-VM"
```

---

### Task 6: Rejected cases suite

**Files:**
- Create: `tests/integration/tests/security_claims.rs`

**Interfaces:**
- Consumes: `common::*`; copy the `Fixture`, `fixture()`, `append()` and `transfer_tx()` helpers from Task 5 into this file (integration test files cannot import each other; duplication is the existing convention).

Add a variant of `append` that returns the built transaction **without** running it, so each test can mutate it:

```rust
fn build_append(f: &mut Fixture, ticket_counts: &[u64]) -> (TransactionBuilder, Vec<EntryDataV1>, EntryShardDataV1, Vec<(CellOutput, Bytes)>, Bytes)
```

returning the builder before claim outputs and the witness are attached, the entries, the post-state, the claim cells and the witness bytes, so a test can add altered claim outputs then `.witness(w).build()`.

- [x] **Step 1: Write the rejected tests**

Each test builds the happy-path append from `build_append`, applies one mutation, and calls `expect_fail`. Names describe the attack:

```rust
#[test]
fn append_without_a_claim_per_ticket_is_rejected() {
    let mut f = fixture();
    let (b, _, _, mut claims, w) = build_append(&mut f, &[2]);
    claims.pop();
    let mut b = b;
    for (c, d) in claims { b = b.output(c).output_data(d); }
    expect_fail(&mut f.w.context, &b.witness(w).build());
}

#[test]
fn append_with_an_extra_claim_is_rejected() {
    let mut f = fixture();
    let (mut b, _, _, claims, w) = build_append(&mut f, &[2]);
    for (c, d) in &claims { b = b.output(c.clone()).output_data(d.clone()); }
    let (c, d) = claims[1].clone();
    let extra = f.w.claim_type_script(0, 2);
    let c = c.as_builder().type_(Some(extra).pack()).build();
    let args = daowow_core::claim::ClaimArgs { commitment: f.w.config_hash, shard_id: 0, position: 2 };
    let _ = d;
    b = b.output(c).output_data(Bytes::from(daowow_core::claim::initial_state_bytes(&args).to_vec()));
    expect_fail(&mut f.w.context, &b.witness(w).build());
}

#[test]
fn duplicate_position_is_rejected() {
    // two claims both at position 0 instead of 0 and 1 (count still matches)
    let mut f = fixture();
    let (mut b, _, _, claims, w) = build_append(&mut f, &[2]);
    let (c0, d0) = claims[0].clone();
    b = b.output(c0.clone()).output_data(d0.clone()).output(c0).output_data(d0);
    expect_fail(&mut f.w.context, &b.witness(w).build());
}

#[test]
fn remint_of_an_earlier_position_is_rejected() {
    let mut f = fixture();
    append(&mut f, &[1]); // position 0 exists
    let (mut b, _, _, _, w) = build_append(&mut f, &[1]); // new ticket is position 1
    let lock = f.lock.clone();
    let stale = f.w.claim_type_script(0, 0);
    let args = daowow_core::claim::ClaimArgs { commitment: f.w.config_hash, shard_id: 0, position: 0 };
    let cell = CellOutputBuilder::default().capacity(pack_u64(claim_cell_capacity(&lock))).lock(lock).type_(Some(stale).pack()).build();
    b = b.output(cell).output_data(Bytes::from(daowow_core::claim::initial_state_bytes(&args).to_vec()));
    expect_fail(&mut f.w.context, &b.witness(w).build());
}

#[test]
fn claim_beyond_the_new_range_is_rejected() {
    let mut f = fixture();
    let (mut b, _, _, _, w) = build_append(&mut f, &[1]);
    let lock = f.lock.clone();
    let future = f.w.claim_type_script(0, 1);
    let args = daowow_core::claim::ClaimArgs { commitment: f.w.config_hash, shard_id: 0, position: 1 };
    let cell = CellOutputBuilder::default().capacity(pack_u64(claim_cell_capacity(&lock))).lock(lock).type_(Some(future).pack()).build();
    b = b.output(cell).output_data(Bytes::from(daowow_core::claim::initial_state_bytes(&args).to_vec()));
    expect_fail(&mut f.w.context, &b.witness(w).build());
}

#[test]
fn claim_locked_to_a_stranger_is_rejected() {
    let mut f = fixture();
    let (mut b, _, _, claims, w) = build_append(&mut f, &[1]);
    let (_, stranger) = f.w.always_success();
    let stranger = stranger.as_builder().args(pack_pbytes(b"mallory")).build();
    let (c, d) = claims[0].clone();
    b = b.output(c.as_builder().lock(stranger).build()).output_data(d);
    expect_fail(&mut f.w.context, &b.witness(w).build());
}

#[test]
fn claim_with_nonzero_paid_state_is_rejected() {
    let mut f = fixture();
    let (mut b, _, _, claims, w) = build_append(&mut f, &[1]);
    let (c, d) = claims[0].clone();
    let mut d = d.to_vec();
    d[73] = 1;
    b = b.output(c).output_data(Bytes::from(d));
    expect_fail(&mut f.w.context, &b.witness(w).build());
}

#[test]
fn claim_whose_data_ticket_mismatches_args_is_rejected() {
    let mut f = fixture();
    let (mut b, _, _, claims, w) = build_append(&mut f, &[1]);
    let (c, _) = claims[0].clone();
    let other = daowow_core::claim::ClaimArgs { commitment: f.w.config_hash, shard_id: 0, position: 7 };
    b = b.output(c).output_data(Bytes::from(daowow_core::claim::initial_state_bytes(&other).to_vec()));
    expect_fail(&mut f.w.context, &b.witness(w).build());
}

#[test]
fn claim_for_another_shard_in_the_same_transaction_is_rejected() {
    // the shard-1 claim's own script finds no shard-1 transition -> CLAIM_ERROR_MINT
    let mut f = fixture();
    let (mut b, _, _, claims, w) = build_append(&mut f, &[1]);
    for (c, d) in &claims { b = b.output(c.clone()).output_data(d.clone()); }
    let lock = f.lock.clone();
    let foreign = f.w.claim_type_script(1, 0);
    let args = daowow_core::claim::ClaimArgs { commitment: f.w.config_hash, shard_id: 1, position: 0 };
    let cell = CellOutputBuilder::default().capacity(pack_u64(claim_cell_capacity(&lock))).lock(lock).type_(Some(foreign).pack()).build();
    b = b.output(cell).output_data(Bytes::from(daowow_core::claim::initial_state_bytes(&args).to_vec()));
    expect_fail(&mut f.w.context, &b.witness(w).build());
}

#[test]
fn claim_minted_in_a_freeze_transaction_is_rejected() {
    let mut f = fixture();
    append(&mut f, &[1]);
    let (cell, _) = f.w.cell(&f.shard);
    let mut frozen = f.shard_data;
    frozen.state = daowow_core::encoding::SHARD_STATE_FROZEN;
    let lock = f.lock.clone();
    let t = f.w.claim_type_script(0, 1); // a position that was never minted
    let args = daowow_core::claim::ClaimArgs { commitment: f.w.config_hash, shard_id: 0, position: 1 };
    let claim = CellOutputBuilder::default().capacity(pack_u64(claim_cell_capacity(&lock))).lock(lock).type_(Some(t).pack()).build();
    let tx = TransactionBuilder::default()
        .cell_dep(f.w.round_config_dep(&f.round))
        .input(CellInput::new(f.shard.clone(), 0x2000_0000_0000_0064))
        .output(cell)
        .output_data(Bytes::from(frozen.encode().to_vec()))
        .output(claim)
        .output_data(Bytes::from(daowow_core::claim::initial_state_bytes(&args).to_vec()))
        .build();
    expect_fail(&mut f.w.context, &tx);
}

#[test]
fn claim_minted_with_no_shard_transition_is_rejected() {
    let mut f = fixture();
    let (funding, _) = f.w.funding_cell(1_000 * SHANNONS);
    let lock = f.lock.clone();
    let t = f.w.claim_type_script(0, 0);
    let args = daowow_core::claim::ClaimArgs { commitment: f.w.config_hash, shard_id: 0, position: 0 };
    let claim = CellOutputBuilder::default().capacity(pack_u64(claim_cell_capacity(&lock))).lock(lock).type_(Some(t).pack()).build();
    let tx = TransactionBuilder::default()
        .input(CellInput::new(funding, 0))
        .output(claim)
        .output_data(Bytes::from(daowow_core::claim::initial_state_bytes(&args).to_vec()))
        .build();
    expect_fail(&mut f.w.context, &tx);
}

#[test]
fn claim_minted_beside_a_shard_cell_dep_only_is_rejected() {
    // shard as cell dep, not input+output: claim script must not accept
    let mut f = fixture();
    let (funding, _) = f.w.funding_cell(1_000 * SHANNONS);
    let lock = f.lock.clone();
    let t = f.w.claim_type_script(0, 0);
    let args = daowow_core::claim::ClaimArgs { commitment: f.w.config_hash, shard_id: 0, position: 0 };
    let claim = CellOutputBuilder::default().capacity(pack_u64(claim_cell_capacity(&lock))).lock(lock).type_(Some(t).pack()).build();
    let tx = TransactionBuilder::default()
        .cell_dep(CellDepBuilder::default().out_point(f.shard.clone()).dep_type(pack_byte(DepType::Code as u8)).build())
        .input(CellInput::new(funding, 0))
        .output(claim)
        .output_data(Bytes::from(daowow_core::claim::initial_state_bytes(&args).to_vec()))
        .build();
    expect_fail(&mut f.w.context, &tx);
}

#[test]
fn claim_minted_beside_a_ledger_shaped_cell_is_rejected() {
    // 36-byte shard args but 207-byte data: not an OPEN shard, so the claim
    // script's data-length check refuses to treat it as the delegating shard
    let mut f = fixture();
    let (shard_cell, _) = f.w.cell(&f.shard);
    let fake_data = Bytes::from(vec![2u8; daowow_core::lifecycle::AGGREGATION_STATE_SIZE]);
    let fake = f.w.context.create_cell(shard_cell.clone(), fake_data.clone());
    let (funding, _) = f.w.funding_cell(1_000 * SHANNONS);
    let lock = f.lock.clone();
    let t = f.w.claim_type_script(0, 0);
    let args = daowow_core::claim::ClaimArgs { commitment: f.w.config_hash, shard_id: 0, position: 0 };
    let claim = CellOutputBuilder::default().capacity(pack_u64(claim_cell_capacity(&lock))).lock(lock).type_(Some(t).pack()).build();
    let tx = TransactionBuilder::default()
        .cell_dep(f.w.round_config_dep(&f.round))
        .input(CellInput::new(fake, 0))
        .input(CellInput::new(funding, 0))
        .output(shard_cell)
        .output_data(fake_data.pack())
        .output(claim)
        .output_data(Bytes::from(daowow_core::claim::initial_state_bytes(&args).to_vec()).pack())
        .build();
    expect_fail(&mut f.w.context, &tx);
}

#[test]
fn transfer_with_altered_data_is_rejected() {
    let mut f = fixture();
    append(&mut f, &[1]);
    let (_, to) = f.w.always_success();
    let op = f.claims[0].0.clone();
    let tx = transfer_tx(&mut f, &[op], &to);
    let mut data = tx.outputs_data().get(0).unwrap().raw_data().to_vec();
    data[65] = 1; // paid_count
    let tx = tx.as_advanced_builder().set_outputs_data(vec![Bytes::from(data).pack()]).build();
    expect_fail(&mut f.w.context, &tx);
}

#[test]
fn transfer_with_two_successors_is_rejected() {
    let mut f = fixture();
    append(&mut f, &[1]);
    let (_, to) = f.w.always_success();
    let op = f.claims[0].0.clone();
    let (cell, data) = f.w.cell(&op);
    let tx = transfer_tx(&mut f, &[op], &to)
        .as_advanced_builder()
        .output(cell.as_builder().lock(to).build())
        .output_data(data.pack())
        .build();
    expect_fail(&mut f.w.context, &tx);
}

#[test]
fn burning_a_claim_is_rejected() {
    let mut f = fixture();
    append(&mut f, &[1]);
    let (funding, plain) = f.w.funding_cell(1_000 * SHANNONS);
    let op = f.claims[0].0.clone();
    let (cell, _) = f.w.cell(&op);
    let tx = TransactionBuilder::default()
        .input(CellInput::new(op, 0))
        .input(CellInput::new(funding, 0))
        .output(CellOutputBuilder::default().capacity(cell.capacity()).lock(plain).build())
        .output_data(Bytes::new().pack())
        .build();
    expect_fail(&mut f.w.context, &tx);
}
```

Where `transfer_tx` sets the output data with `.output_data(data)`, the Bytes is a `ckb_types::bytes::Bytes`; use `.pack()` as the harness's other builders do if the compiler asks for `packed::Bytes`.

- [x] **Step 2: Run**

Run: `cd tests/integration && cargo test --test security_claims 2>&1 | grep -E "^test |test result"`
Expected: 16 passed. For each, read the captured debug (set `RUST_LOG` is not needed; `expect_fail` returns the error) and confirm the failing script is the intended one: shard `-38` for count/range/duplicate/lock/data/freeze cases, claim `-94` for the foreign-shard, no-shard and dep-only cases, `-95` for altered data, `-93` for two successors, `-96` for burn. Add `assert!(format!("{err:?}").contains("...")))` only if the harness exposes the code in the error string; otherwise record the observed codes in Results.

- [x] **Step 3: Commit**

```bash
git add tests/integration/tests/security_claims.rs
git commit -m "test: adversarial claim mint and transfer cases"
```

---

### Task 7: Devnet example and Python harness

**Files:**
- Modify: `tests/integration/examples/devnet_round.rs` (append JSON at ~line 286)
- Modify: `tests/devnet/test_round_creation.py:173-200` (entry transaction outputs)

**Interfaces:**
- Produces: `exported["append"]["claims"]`: a list of `{"type": <script json>, "lock": <script json>, "data": <hex>, "capacity": <hex shannons>}`, one per ticket of every entry in the append (including the excluded entry when `partial`).

- [x] **Step 1: Emit claims from the example**

After `let mut entry_args = ...` in the example, add:

```rust
    let claims: Vec<serde_json::Value> = entries
        .iter()
        .flat_map(|e| (0..e.ticket_count).map(move |i| (e.shard_id, e.position_base + i)))
        .map(|(shard_id, position)| {
            let args = daowow_core::claim::ClaimArgs {
                commitment: cfg.commitment(),
                shard_id,
                position,
            };
            let capacity = daowow_core::claim::claim_occupied_capacity(participant.as_slice().len() as u64);
            json!({
                "type": script(cfg.entry_shard_type, &args.encode()),
                "lock": script_json(&participant),
                "data": hex(&daowow_core::claim::initial_state_bytes(&args)),
                "capacity": format!("0x{:x}", capacity),
            })
        })
        .collect();
```

and add `"claims": claims` to the `"append"` object. The example's `script(reference, args)` (line 27) emits `{"code_hash", "hash_type": "data1", "args"}`; add the matching helper for a packed script (the participant lock is `smoke-minimal` with hash type 2 = data1):

```rust
fn script_json(s: &Script) -> Value {
    json!({
        "code_hash": hex(s.code_hash().as_slice()),
        "hash_type": "data1",
        "args": hex(s.args().raw_data().as_ref()),
    })
}
```

- [x] **Step 2: Spend them in Python**

In `test_round_creation.py`, after `entry_tx` is built and after the `if partial:` block, add:

```python
            for claim in append["claims"]:
                entry_tx["outputs"].insert(
                    len(entry_tx["outputs"]) - 1,
                    {"capacity": claim["capacity"], "lock": claim["lock"], "type": claim["type"]},
                )
                entry_tx["outputs_data"].insert(len(entry_tx["outputs_data"]) - 1, claim["data"])
                change["capacity"] = hex(int(change["capacity"], 16) - int(claim["capacity"], 16))
```

so the change output stays last and pays for the claims. The `corrupt` copy is taken after this block, so it inherits the claims.

- [x] **Step 3: Build and, if a devnet node is available, run**

Run: `cargo build -p daowow-integration-tests --examples` and `python3 -m pytest tests/devnet/test_round_creation.py -x -q` only if `tests/devnet/README.md` prerequisites (local node) are met. If the node is not running, record "devnet harness updated, not executed" in Results rather than claiming a pass.

- [x] **Step 4: Commit**

```bash
git add tests/integration/examples/devnet_round.rs tests/devnet/test_round_creation.py
git commit -m "test(devnet): mint claim cells in the devnet append"
```

---

### Task 8: Review and results

**Files:**
- Modify: this plan (Results section), `docs/testnet-beta-plan.md` (one line under "Transferable claim protocol" noting mint/transfer are implemented and redemption/retirement are not)

- [x] **Step 1: Full verification**

Run from the repo root:

```bash
cargo test -p daowow-core --lib
cargo check -p daowow-core --no-default-features
cargo clippy -p daowow-core --lib -- -D warnings
cargo build --target riscv64imac-unknown-none-elf --release
cd tests/integration && cargo test 2>&1 | grep -E "^test result|FAILED"
```

- [x] **Step 2: Read-only Rust review**

Dispatch the `rust-reviewer` agent on `crates/daowow-core/src/claim.rs`, `contracts/entry-shard-type/src/claim.rs`, the `main.rs` diff and both new test suites, with the spec attached. Ask specifically: can any transaction create a claim for a position outside an append of its shard; can a claim's data change or the cell disappear; can a non-entrant receive a minted claim; does any test assert less than its name claims. Resolve CRITICAL/HIGH, apply MEDIUM where cheap, record the rest.

- [x] **Step 3: Record results**

Append a `## Results` section here with: test counts per suite, cycle numbers from Task 5, claim cell capacity, mutation-probe outcomes from Task 2, observed error codes from Task 6, the review verdict, and an explicit statement that redemption, retirement, memento, artwork and the web quote are not implemented.

- [x] **Step 4: Commit**

```bash
git add docs/superpowers/plans/2026-09-16-claim-mint-transfer.md docs/testnet-beta-plan.md
git commit -m "docs: claim mint/transfer results and beta plan status"
```

---

## Results (2026-09-16, executed inline on branch `feat/claim-mint-transfer`)

**Suites**

| Suite | Result |
| --- | --- |
| `cargo test -p daowow-core --lib` | 121 passed (13 new in `claim::tests`) |
| `cargo check -p daowow-core --no-default-features`, `cargo clippy -p daowow-core --lib -- -D warnings`, rustfmt | clean |
| `tests/integration` `claim_lifecycle` | 6 passed |
| `tests/integration` `security_claims` | 17 passed |
| every other integration suite | green; `smoke` has 2 pre-existing failures (missing external binary path, `round_type_binary_as_lock`) that fail identically on `main` |
| `tests/devnet` isolated Docker node (`DAOWOW_RUN_ISOLATED_NODE=1`) | 15 passed in 1258s: the append with claim cells committed on a real node and the full round history (freeze, aggregation, DAO maturity, settlement, refunds, reorg recovery) completed with claims present |

**Measurements** (ckb-testtool, always-success lock)

| Shape | Cycles |
| --- | --- |
| one claim transfer (claim script only) | 64,494 |
| append 8 entries / 32 claims | 15,170,656 |
| append 32 entries / 32 claims | 52,607,539 |
| append 32 entries / 64 claims | 55,645,290 |
| append 32 entries / 128 claims | 61,720,556 (budget 70,000,000) |

About 95K cycles per claim (claim script plus the shard's output scan) on a ~50M base that the 32-entry append already cost before claims. Claim cell occupied capacity: 200 CKB with an argless lock, 214 CKB with the devnet 14-byte-args lock, 220 CKB with a secp256k1 lock (the spec figure).

**Mutation probes** (each guard removed, named test goes red, restored)

- core `validate_mint`: count, range, duplicate, lock, data and owner-lookup guards each pinned by one test. The owner-lookup test initially passed under mutation because its orphan claims used a different lock, so the lock guard shadowed it; the fixture now uses the owning lock so only the lookup can reject.
- contract `shard_present` data-length gate (`== SHARD_DATA_SIZE`): weakened to any length, `claim_minted_beside_a_valid_ledger_initialization_is_rejected` fails (the transaction is accepted and mints a claim). This test replaced the plan's ledger-shaped-garbage variant after review showed the garbage made the shard's own ledger mode fail first, leaving the gate unpinned.

**Observed error codes** in `security_claims`: shard `-38` for missing/extra/duplicate/remint/out-of-range/stranger-lock claims and for a claim in a freeze tx; claim `-94` for no shard transition, cell-dep-only shard, other-shard claim and valid ledger init; `-95` for a decodable paid-state change on transfer; `-93` for two successors; `-96` for burn. Two tests (nonzero paid state, ticket/args mismatch) accept `-38` or `-92` because the shard rule and the claim script independently enforce the same data rule; the altered-data transfer accepts `-92` or `-95` because a flipped `paid_count` is undecodable.

**Review** (read-only rust-reviewer): no CRITICAL. HIGH test-coverage gap on the data-length gate, resolved as above. MEDIUM: `collect_claims` and the append's entry-matching loop each load every output once, and `collect_claims` runs on freeze/no-op transitions too; with the shard cell permissionlessly spendable an attacker can pad outputs to make their own transaction exceed the cycle limit. Because a failed transaction does not consume the shard cell, this cannot block the shard for others, and the measured per-output cost is small next to the SMT work; recorded as a follow-up (single-pass scan, or restrict the claim scan to the append path) rather than fixed here. Items 1, 2, 3 and 6 (forgery, mutation/burn, non-entrant mint, panics) found no defect.

**Caveat on the devnet run**: a contract rebuild for the data-length mutation probe overlapped the devnet run for about one minute. Any devnet test that deployed binaries in that window ran a claim script with a weakened rejection gate that no devnet test exercises, so no outcome could differ; the restored binary (`entry-shard-type` mtime 01:50:11) is what the branch ships.

**Not implemented** (unchanged from the spec's out-of-scope list): redemption, ticket-indexed prize funding, retirement, memento, artwork rendering, wallet display and the web entry quote. A claim's data cannot change and the cell cannot be consumed without a successor.

**Follow-ups**: single-pass output scan in `entry-shard-type` (review MEDIUM); the web entry quote should use `claim_occupied_capacity(33 + lock_args_len)`; sub-project 2 (ticket-indexed prizes and redemption) is next.
