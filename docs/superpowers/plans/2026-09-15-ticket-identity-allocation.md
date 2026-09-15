# Ticket Identity and Capacity Allocation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the pure ticket identity and shared-entry capacity primitives required by transferable claim NFTs.

**Architecture:** Add a focused `ticket` module to the existing no-std core. Ticket IDs depend on immutable configuration and shard-local position; capacity allocation uses immutable ticket order rather than owner or redemption order. These primitives do not mint NFTs or establish chain provenance.

**Tech Stack:** Existing Rust, `daowow-core`, CKB-personalized Blake2b-256; no new dependencies.

**Spec:** `docs/superpowers/specs/2026-09-15-transferable-claim-lifecycle-design.md`

## Global Constraints

- Preserve the landing page's existing design.
- Transfer changes claim ownership, never ticket identity, odds, entry count or draw entropy.
- Amounts derive from authenticated source capacity in contract callers.
- NFT occupied capacity is separate from pooled entry capacity.
- No old encoding changes, contract deployment, wallet signing or network work in this plan.
- Preserve unrelated worktree edits. Commit only task-owned changes if git permissions permit; otherwise report uncommitted changes.

## Scope boundary

This is the first independently testable subproject, not the complete NFT implementation.
Remaining spec requirements need subsequent plans for paid-state proofs and funding
coordination, atomic mint/transfer/redemption contracts, shared-entry refunds, wallet
interoperability/artwork and node lifecycle validation. Passing this plan cannot
satisfy any deployment or beta-readiness gate.

## File responsibilities

- Create `crates/daowow-core/src/ticket.rs`: domain-separated identity and checked allocation.
- Create `crates/daowow-core/src/ticket/tests.rs`: vectors, boundary and conservation tests.
- Modify `crates/daowow-core/src/lib.rs`: export the new module only.
- Update `docs/testnet-beta-plan.md`: evidence and remaining integration work after verification.

### Task 1: Immutable ticket identity

**Interfaces:** Produces `ticket_id(config: &Hash32, shard_id: u32, position: u64) -> Hash32`.
Consumes existing `hash::{Hash32, ckb_hash256}`. Callers must validate the config,
shard bounds and entry position; a hash by itself authenticates none of those.

- [x] Write `ticket/tests.rs` with these tests and wire it through `ticket.rs`:

```rust
use super::*;

#[test]
fn identity_binds_config_shard_and_position() {
    let base = ticket_id(&[1; 32], 2, 3);
    assert_eq!(base, ticket_id(&[1; 32], 2, 3));
    assert_ne!(base, ticket_id(&[2; 32], 2, 3));
    assert_ne!(base, ticket_id(&[1; 32], 3, 3));
    assert_ne!(base, ticket_id(&[1; 32], 2, 4));
}

#[test]
fn identity_has_explicit_domain_and_little_endian_layout() {
    let mut message = b"DAOWOW_TICKET_ID_V1".to_vec();
    message.extend_from_slice(&[1; 32]);
    message.extend_from_slice(&[2, 0, 0, 0]);
    message.extend_from_slice(&[3, 0, 0, 0, 0, 0, 0, 0]);
    assert_eq!(ticket_id(&[1; 32], 2, 3), crate::hash::ckb_hash256_one(&message));
}
```

- [x] Export `pub mod ticket;`, run `cargo test -p daowow-core --lib ticket::tests` and confirm failure is the absent identity function.
- [x] Implement the exact identity preimage:

```rust
use crate::hash::{ckb_hash256, Hash32};

pub fn ticket_id(config: &Hash32, shard_id: u32, position: u64) -> Hash32 {
    ckb_hash256(&[
        b"DAOWOW_TICKET_ID_V1", config,
        &shard_id.to_le_bytes(), &position.to_le_bytes(),
    ])
}

#[cfg(test)]
mod tests;
```

- [x] Run the focused tests. Review that no address, mutable claim state or final cross-shard offset enters the ID.
- [x] Obtain Rust code review and checkpoint task-owned files only. Approved; files preserved uncommitted because `.git` is read-only in this workspace.

### Task 2: Exact per-ticket share of pooled entry capacity

**Interfaces:** Produces `ticket_capacity(price: u64, capacity: u64, count: u64, index: u64) -> Result<u64, CoreError>`.
`index` is zero-based within the immutable original entry; `capacity` is the entry's
full pooled input capacity, excluding the separate NFT cell. Each ticket receives
its fixed principal plus an equal share of overhead; the earliest `remainder`
ticket indices receive one additional Shannon.

- [x] Add tests before implementation:

```rust
#[test]
fn overhead_is_conserved_in_immutable_ticket_order() {
    assert_eq!(ticket_capacity(100, 305, 3, 0), Ok(102));
    assert_eq!(ticket_capacity(100, 305, 3, 1), Ok(102));
    assert_eq!(ticket_capacity(100, 305, 3, 2), Ok(101));
    for count in 1..=32 {
        for overhead in 0..=65 {
            let total = 100 * count + overhead;
            let shares: Vec<_> = (0..count)
                .map(|i| ticket_capacity(100, total, count, i).unwrap())
                .collect();
            assert!(shares.iter().all(|share| *share >= 100));
            assert_eq!(shares.iter().sum::<u64>(), total);
        }
    }
}

#[test]
fn allocation_rejects_invalid_inputs_and_handles_u64_limit() {
    for args in [(0, 100, 1, 0), (1, 100, 0, 0), (1, 100, 1, 1),
                 (100, 299, 3, 0), (u64::MAX, u64::MAX, 2, 0)] {
        assert!(ticket_capacity(args.0, args.1, args.2, args.3).is_err());
    }
    assert_eq!(ticket_capacity(1, u64::MAX, 1, 0), Ok(u64::MAX));
}
```

- [x] Run the focused tests and confirm the new failure is the absent allocation function.
- [x] Implement checked allocation:

```rust
use crate::CoreError;

pub fn ticket_capacity(price: u64, capacity: u64, count: u64, index: u64)
    -> Result<u64, CoreError>
{
    if price == 0 || count == 0 || index >= count {
        return Err(CoreError::InvalidArgument);
    }
    let principal = price.checked_mul(count).ok_or(CoreError::Overflow)?;
    let overhead = capacity.checked_sub(principal).ok_or(CoreError::Conservation)?;
    price.checked_add(overhead / count)
        .and_then(|value| value.checked_add(u64::from(index < overhead % count)))
        .ok_or(CoreError::Overflow)
}
```

- [x] Run `cargo test -p daowow-core --lib`, `cargo check -p daowow-core --no-default-features` and `git diff --check`.
- [x] Obtain Rust code review. Record exact test results and explicitly state that no live NFT/claim functionality exists yet. Checkpoint task-owned files only. Approved; files preserved uncommitted because `.git` is read-only in this workspace.

## Self-review

The two tasks cover stable identity and principal/overhead conservation from the
approved lifecycle. They intentionally do not select an NFT standard, paid-state
proof scheme or failed-round yield rounding rule. Those require the next
contract-design plan, not assumptions hidden in these functions. The maximum
32 used in a test loop is coverage, not a new protocol ticket-count limit.
