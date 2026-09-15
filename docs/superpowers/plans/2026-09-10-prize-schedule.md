# Committed Prize Schedule Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement the bounded, canonical prize schedule required by the approved computed-entitlement design.

**Architecture:** A pure no_std-compatible validated schedule owns its weights. Exact decoding and domain-separated commitment checks precede ticket-count truncation and complete allocation. This sub-plan supplies the schedule primitive; it does not claim contract authentication or completion of the wider goal.

**Tech Stack:** Rust 1.98.1, alloc, existing CKB-personalized Blake2b helper, offline pinned Cargo dependencies.

**Spec:** `docs/superpowers/specs/2026-09-10-computed-entitlements-design.md`

## Global Constraints

- At most 32 positive u64 weights; reject an empty schedule and sum overflow.
- Wire: version 1, u32 LE count, u64 LE weights; exact length only.
- Hash: `H("DAOWOW_PRIZE_SCHEDULE_V1" || encoding)`.
- Use the first min(ticket_count, schedule_count) weights; reject zero tickets.
- First prize receives every rounding Shannon; sponsor/DAO policy is not implemented here.
- Preserve the existing dirty worktree and read-only git metadata; no commits or branch changes.

## Task 1: Validated schedule and allocation

**Files:** Create `crates/daowow-core/src/schedule.rs`; export it from `crates/daowow-core/src/lib.rs`. Tests live inside the new module.

**Interfaces:** `PrizeSchedule::new(&[u64]) -> Result<Self, CoreError>`, `encode() -> Vec<u8>`, `decode(&[u8]) -> Result<Self, CoreError>`, `commitment() -> Hash32`, `decode_committed(&[u8], &Hash32) -> Result<Self, CoreError>`, `weights_for(u64) -> Result<&[u64], CoreError>`, `allocate(u64, u64) -> Result<Vec<u64>, CoreError>` (accepted tickets, batch yield).

- [x] Write real tests with hand-checked wire bytes and independently calculated commitment; malformed version/count/length, zero/overflow weights, 32/33 bounds, mismatched commitments and allocation truncation.

```rust
assert_eq!(PrizeSchedule::new(&[40,25,20,10,5]).unwrap().allocate(2, 100), Ok(vec![62,38]));
assert!(PrizeSchedule::new(&[1; 33]).is_err());
assert!(PrizeSchedule::new(&[u64::MAX, 1]).is_err());
```

- [x] Run `cargo test --offline --locked -p daowow-core --lib schedule::tests`; establish behavioral failures with a compiling unimplemented API skeleton.
- [x] Implement exact bounds before allocation/decoding; use checked weight summation and existing `allocate_prizes_complete` for first-prize dust.

```rust
let count = usize::try_from(ticket_count.min(self.weights.len() as u64))
    .map_err(|_| CoreError::Overflow)?;
if count == 0 { return Err(CoreError::InvalidArgument); }
crate::accounting::allocate_prizes_complete(&self.weights[..count], batch_yield)
```

- [x] Re-run focused tests and all core library tests, default/no_std strict Clippy and formatting.
- [x] Obtain read-only Rust review using requesting-code-review; fix important findings before consumers use this API.
- [x] Record tested scope and remaining contract/draw/node work; leave changes uncommitted under workspace constraints.

Checkpoint: five schedule test groups failed against the compiling skeleton and
passed after implementation; full core suite 74 passed. Default/no_std strict
Clippy, formatting and whitespace gates passed. Initial bounded review found
only a redundant bounded allocation and missing API documentation; both are
addressed, and follow-up review approved the bounded primitive with no remaining
findings. No VM or node validation claim.

## Wider goal dependency order (not satisfied by this sub-plan)

Next: accepted-prefix universe and deterministic winner ownership; then authenticated batch replay and consolidated successful/failed entitlements; then schedule validation at round creation plus DAO/settlement enforcement and corrected sponsored payouts. After VM limits and security review, execute isolated full-node maturity and real-reorg assertions from the approved spec. Each dependent change needs its own failing tests and review checkpoint.
