# Initial Entitlements Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rebuild complete, conserved batch liabilities from verified draw owners and a canonical receipt's committed entries/capacities.

**Architecture:** A pure `InitialEntitlements::derive` validates the receipt replay and accepted range, invokes `ComputedDraw`, consolidates participants, allocates yield and builds the indexed MMR. An input descriptor groups batch evidence. Private result fields expose only derived funding data and liabilities. Contract callers must authenticate receipt/config/entropy provenance and realized native DAO value.

**Tech Stack:** Rust no_std + alloc, existing lifecycle digest, draw, accounting and MMR primitives.

**Spec:** `docs/superpowers/specs/2026-09-10-computed-entitlements-design.md`

## Global Constraints

- 1–32 complete batch entries, full deposited capacity returned; actual realized value must cover the deposit.
- Replay every receipt field and digest from ordered entries/capacities; check batch ID shard/ordinal and nonce range within accepted ledger.
- Each successful batch pays the same verified global winners; all prize dust to first prize.
- Failed rounds consolidate depositor capacities first, floor proportional yield in u128, then give residual Shannons in ascending lock-hash order.
- Sorted unique liability hashes, no zero-total records, derived MMR count/root, cursor zero and exact realized conservation.
- No chain-authentication claim or testnet writes in this pure-core stage.

## Task 1: Batch replay and complete root derivation

**Files:** Create `crates/daowow-core/src/entitlements.rs` and `crates/daowow-core/src/entitlements/tests.rs`; export module from lib.rs. Share only cfg(test) fixtures from computed_draw tests, not production test helpers.

**Interfaces:** `EntitlementInput<'a>` contains batch_id, borrowed BatchCommitment, entries, capacities, realized_total and WinnerProof list. `InitialEntitlements::derive(&RoundConfigV1, &EntropyRecord, &PrizeSchedule, &EntitlementInput) -> Result<Self, CoreError>`, `funding() -> &SettlementFundingDataV2`, `liabilities() -> &[PayoutItem]`.

- [x] Write tests using actual accepted receipts and independent expected amounts. Four-ticket fixed draw `[3,2,1,0]`, weights `[4,3,2,1]`, batch-0 deposit250 and realized350 must derive sorted `(owner10,250,30),(owner12,0,70)`; batch2 routes its principal to owner12 but uses the same winners.
- [x] Write failed-round consolidation/rounding, zero-yield, wrong receipt fields/digest/capacities, omitted/reordered/excluded entries, out-of-range batch IDs, realized underflow, missing/extra winner and MMR membership checks.
- [x] Observe behavioral failures against a compiling API skeleton with `cargo test --offline --locked -p daowow-core --lib entitlements::tests`.
- [x] Replay `DAOWOW_ENTRY_BATCH_V2 || cfgcommit || shard[u32] || count[u32] || (entry.encode || capacity[u64])*`; recompute every receipt field with checked arithmetic and compare the whole receipt.
- [x] Consolidate principal and verified prizes with a BTreeMap keyed by Hash32; failed-round rounding occurs after consolidation. Build MMR via `append_peaks` / `bag_peaks`, counting sorted nonzero liabilities.

```rust
let prize_pool = input.realized_total.checked_sub(receipt.input_capacity)
    .ok_or(CoreError::Conservation)?;
let share = (u128::from(prize_pool) * u128::from(principal)
    / u128::from(receipt.input_capacity)) as u64;
```

- [x] Check sum(principal + prize) == realized_total and derived funding has cursor0, actual principal/prize totals, positive derived count and root.
- [x] Run focused/full core, strict default/no_std Clippy, fmt and whitespace gates; obtain bounded Rust/security review.

## Subsequent mandatory integration

Checkpoint: implementation and eight targeted test groups pass, as do all 91
core tests and default/no_std strict Clippy. Bounded Rust/security review
approved the constructor and all eight groups. Initial skeleton tests failed
behaviorally before implementation. The remaining integration below is not
complete.

Round creation must authenticate schedule availability; shared chain-context code must authenticate config, immutable entropy, receipt and DAO inputs; DAO phase2 and standalone settlement creation must both enforce these computed outputs. Correct sponsor-funded payout accounting and test maximum final tails before real-node maturity/reorg validation. None of these is satisfied by a pure constructor.
