# Computed Draw Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Derive global winning positions from the canonical entropy snapshot and authenticate their owners against accepted prefixes.

**Architecture:** A borrowing `ComputedDraw` validates config/schedule/ledger compatibility, builds checked shard-major accepted offsets, hashes the exact approved seed preimage, and computes bounded distinct positions. Winner verification requires one authenticated entry proof per computed prize. Chain provenance remains the contract caller's responsibility.

**Tech Stack:** Rust no_std + alloc, existing hash/draw/MMR/SMT/IMT helpers.

**Spec:** `docs/superpowers/specs/2026-09-10-computed-entitlements-design.md`

## Global Constraints

- Maximum 32 prizes from validated `PrizeSchedule`; no optional reveals or batch-specific draw input.
- Seed `H("DAOWOW_AUTHENTICATED_DRAW_V1" || cfg.commitment() || entropy_record.encode())`.
- Success iff accepted total is positive and reaches minimum tickets.
- Frozen membership alone does not prove acceptance; check nonce and interval against accepted counters.
- Preserve dirty worktree and read-only git metadata; no branch changes or commits.

## Task 1: Pure computed draw and owner proofs

**Files:** Create `crates/daowow-core/src/computed_draw.rs`; export from `lib.rs`. Tests inside the module use real MMR fixtures and actual ledger accept/close operations.

**Interfaces:** `ComputedDraw<'a>::new(&'a RoundConfigV1, &'a EntropyRecord, &PrizeSchedule) -> Result<Self, CoreError>`, `total_tickets() -> u64`, `seed() -> Hash32`, `positions() -> &[(u64,u64)]`, `is_success() -> bool`, `verify_winners(&[WinnerProof<'_>]) -> Result<Vec<Hash32>, CoreError>`. `WinnerProof` borrows an `EntryDataV1` and its proof bytes.

- [x] Write fixture with four shards, two empty; nonempty shards each freeze three entries but accept only one. Draw all four accepted tickets under a four-prize schedule.
- [x] Assert `total_tickets() == 4`, all distinct positions in 0..4, exactly two wins per accepted owner. Replace each owner with an excluded entry and its genuine frozen proof; require rejection.
- [x] Add wrong config/schedule, empty/failed rounds, missing/extra/reordered winner proofs, altered fields/proofs and arithmetic-bound cases. Seed mutation checks bind inclusion/header inputs; schedule alteration cannot bypass config commitment.
- [x] Compile API skeleton and run `cargo test --offline --locked -p daowow-core --lib computed_draw::tests`; observe behavioral failures.
- [x] Implement checked accepted offsets and draw using the existing sampler:

```rust
let seed = ckb_hash256(&[b"DAOWOW_AUTHENTICATED_DRAW_V1", &cfg.commitment(), &record.encode()]);
let mut positions = vec![(0, 0); schedule.weights_for(total)?.len()];
draw_positions(&seed, total, positions.len() as u64, &mut positions)?;
```

  Failed rounds have no positions and accept only an empty winner-proof list.
  For each winner, verify matching round/shard, positive ticket count, correct
  ticket principal, nonce below accepted entries, checked interval within
  accepted tickets, global position containment, then accumulator membership.
- [x] Run focused and full core tests, default/no_std strict Clippy, fmt and whitespace gates.
- [x] Request bounded read-only Rust/security review; fix findings, record scope.

Checkpoint: initial compiling skeleton produced five behavioral test failures;
implemented derivation passed the initial six groups. Extended suite now has
nine computed-draw groups and 83 total core tests passing. Strict default/no_std
Clippy, formatting and whitespace checks pass. Final bounded Rust/security review
approved the module and export with no actionable findings, including the
all-accumulator, overflow and independent-seed-vector additions. Contract and
node validation remain outside this checkpoint.

## Remaining goal

This does not authenticate a chain cell, derive batch liabilities, harden funding creation, change settlement payouts, or validate node maturity/reorg behavior. Those dependent stages remain required by the approved spec.
