# Ledger Cost Tuning Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans for this bounded implementation unit.

**Goal:** Execute the 32-distinct-participant SMT batch within the existing 70-million-cycle harness budget without weakening atomic validation.

**Architecture:** Entry locks require the exact canonical, open ledger input. Its enforcing shard type validates all actual entry inputs and their indexed proofs, complete successor state, deposit capacity and receipt. The receipt type independently retains full validation. Initialization, closure and closed no-op prohibit entry inputs, so those transitions cannot serve as aggregation authority.

**Tech Stack:** Rust no_std, CKB-VM, pinned offline Cargo workspace.

**Spec:** Approved implementation order in the conversation and `docs/superpowers/specs/2026-09-07-shard-aggregation-ledger-design.md` (validation placement refined by the user-approved cost tuning).

## Global Constraints

- Preserve canonical config/shard identity checks, exact full-capacity DAO routing and receipt enforcement.
- No deployment, signing, new dependencies or changes to historical artifacts.
- Existing dirty workspace remains in place; no branch/index operations.

### Task 1: Bound whole-batch validation cost

**Files:** `contracts/entry-lock/src/main.rs`, `tests/integration/tests/security_ledger.rs`.

**Interfaces:** Existing `canonical_ledger(commitment, cfg, shard_id, Source::Input)` returns an authenticated `Option<AggregationState>`. No new public ABI.

- [x] Replace the maximum-batch measurement ceiling with `verify_tx(&tx, MAX_CYCLES)` and observe `ExceededMaximumCycles` before changing production code.
- [x] In `aggregate`, require all entries share a shard, and use `canonical_ledger(cfg.commitment(), cfg, entries[0].shard_id, Source::Input).is_some_and(|state| !state.is_closed())`. Remove the unused absolute-index argument from this function and call only; refund still requires its indices.
- [x] Add a regression that removes the ledger input and independently substitutes its type with an always-success script. Both must reject an otherwise valid aggregation.
- [x] Build release RISC-V contracts; run `security_ledger`, `security_refunds`, `proto2_membership` and then all documented VM suites. Require maximum-batch cycles below 70 million.
- [x] Request scoped Rust/security review of the delegation invariant and adversarial coverage; address findings before claiming the optimization complete.
- [x] Update cycle report with fresh results. This unit does not authenticate draw/entitlement roots or prove full-node feasibility.
