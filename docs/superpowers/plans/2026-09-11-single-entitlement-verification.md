# Single Entitlement Verification Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans task-by-task.

**Goal:** Remove duplicated phase2 proof work without a creation-validation bypass.

**Architecture:** DAO lock requires exactly one output with the configured
settlement type hash/hash_type and exact cfg/batch/digest args and public lock.
It rejects any matching settlement input, forcing the enforcing type's creation
branch. Settlement creation retains complete shared entitlement validation.

**Tech Stack:** Rust no_std, CKB-VM integration tests.

**Spec:** Approved in conversation after the distinct-owner 73.4M-cycle failure;
this supersedes the dual full-verification requirement in the chain-wiring plan.
The owner answered “keep going get the next oeiece” to the proposed split.

## Global Constraints

- Native DAO input type and maturity validation remain unchanged.
- Exact configured script hash, hash_type and all 72 argument bytes must match.
- Reject matching settlement inputs: updates must not substitute for creation.
- Require one matching output with the public settlement lock.
- Settlement creation still computes and checks every entitlement and amount.
- No broadcast, deployment, signing or testnet mutation.

## Task 1: Binding, bypass tests and cost regression

Files: `crates/daowow-contracts-common/src/entitlements.rs`,
`contracts/dao-lock/src/main.rs`, `tests/integration/tests/proto3_dao_lifecycle.rs`.

- [x] Reproduce the existing distinct-owner budget failure with
  `cargo test --offline --locked -p daowow-integration-tests --test proto3_dao_lifecycle phase2_distinct -- --nocapture`.
- [x] Add output identity/removal/duplication mutations and a matching-funding
  input attack; each must fail in the DAO binding guard.
- [x] Add `require_initial_funding_type(cfg, batch_id, digest) -> Option<()>`.
  Scan inputs and reject `funding_type_matches`; scan outputs, reject duplicates
  or wrong public lock, require a match. Treat only IndexOutOfBound as end.
- [x] Replace DAO phase2's full validator call with this guard; keep settlement
  creation's full validator unchanged.
- [x] Run all named VM suites and core tests; build all five RISC-V release
  contracts; run strict core default/no_std and RISC-V Clippy, fmt and diff checks.
- [x] Obtain bounded Rust/security review and record actual cost measurements.

Result: 96 core and 91 named VM tests pass, with all five builds and strict
core/RISC-V Clippy, formatting and whitespace gates passing. Bounded review
approved the guard and delegation, contingent on cfg resolving to the reviewed
settlement implementation. Distinct-owner SMT now costs 32,957,450 cycles.

No commit is attempted in this dirty, read-only-.git workspace. Full history,
maximum sparse proofs and node maturity/reorg remain separate open gates.
