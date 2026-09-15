# Security Closure Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the security gates without replacing the confirmed prototype deployment.

**Architecture:** Authenticated per-shard terminal state seals the participating entries before future entropy. Batch records bind entries and native DAO custody; verified draw and actual withdrawal value determine participant liabilities. Settlement remains bounded and permissionless.

**Tech Stack:** Rust, ckb-std, ckb-testtool, pinned offline Cargo dependencies.

**Spec:** User-approved design in this conversation (2026-09-05), with protocol invariants in `AGENT_HANDOFF.md` and `docs/protocol-v0.2.md`.

## Global Constraints

- Testnet-only; no deployment, broadcast, manifest replacement, or wallet operations.
- No operator-selected entitlement roots or privileged custody path.
- Preserve participant principal and explicitly account for every Shannon.
- Entry participation is immutable before selected future entropy is available.
- Fixed participant commitments, no optional entropy reveals.
- Bounded transactions and independently progressing settlement batches.
- Preserve existing uncommitted work; no blanket warning suppression.

## Stage 1 — Deterministic core and review gate

### Task 1: Lint repairs

Files: `crates/daowow-core/Cargo.toml`, `src/encoding.rs`, `src/witness.rs`,
`src/accumulator/imt.rs`, and vendored `src/accumulator/smtc/`.
Do not change accumulator hashing or expose a partially implemented trie mode.

- [x] Reproduce: `cargo clippy --offline --locked -p daowow-core -- -D warnings`.
- [x] Remove unused assignments/constants, use modern numeric constants and
  iterator forms, expose explicit lifetimes and a settlement tuple alias.
- [x] Preserve default and no_std SMT semantics; remove unsupported trie
  branches if the vendored tree implementation cannot support that feature.
- [x] Verify core tests and default/no-default-feature Clippy.

### Task 2: Draw correctness

File: `crates/daowow-core/src/draw.rs` (unit tests in the same file).
Interface: retain `draw_positions(seed, n_tickets, prize_count, prizes)`.

- [x] Add failing boundary assertions: `unbiased_mod(&[255; 32], 3) == None`,
  `unbiased_mod(&[255; 32], 2) == Some(1)`, and short output buffer rejection.
- [x] Reject candidates at or above the finite limit, accept all candidates
  when 2^256 is divisible by N, and validate output buffer length.
- [x] Make retry exhaustion an explicit error and test duplicate retries.
- [x] Run `cargo test --offline --locked -p daowow-core --lib draw::`.

### Task 3: Accumulator soundness

Files: `crates/daowow-core/src/accumulator/mmr.rs` and `smt.rs`.
Interfaces: retain membership and insertion-certificate verification APIs.

- [x] Reproduce MMR proof for position 0 accepted as position 4 at count 5.
- [x] Derive peak slot and height from count/position, require exact proof
  length, and test every position in mixed-peak MMR sizes.
- [x] Reproduce SMT certificate inserting a declared and undeclared key.
- [x] Replay the old absence proof with the new leaf to authenticate the
  exact new root; verify the supplied inclusion proof independently.
- [x] Run `cargo test --offline --locked -p daowow-core --lib accumulator::`.

## Stage 2 — Authenticated lifecycle

Checkpoint: accepted-prefix accounting/membership primitives are implemented
in `crates/daowow-core/src/lifecycle.rs`, with five tests. They are not wired
into contracts or canonical state-cell codecs; none of the on-chain gates
below is marked complete on that basis. Stage 1 independent security review
is blocked by reviewer account quota, after successful lint/format repair.

Execute only after Stage 1 review. Split protocol implementation into a
separate detailed plan grounded in the corrected proof interfaces. Required
acceptance cases, in dependency order:

- [ ] Atomic config and all canonical shards creation; reject missing,
  duplicated and recreated shards.
- [ ] Per-shard aggregation cursor/state consumes actual entries exactly
  once and commits the resulting batch identity and full input capacities.
- [ ] Terminal state irreversibly chooses accepted vs excluded entries;
  excluded entries remain refundable, including failed aggregation.
- [ ] Finalisation consumes all canonical terminal shard states and creates
  a unique universe record; entropy targets derive only after this record
  is committed, not from a keeper-selected header or delayed transaction.
- [ ] Authenticated future canonical headers produce the deterministic
  draw; reject wrong height, stale/forked references and alternate seeds.
- [ ] Native DAO deposit type/data, exact realised phase-two value, batch
  identity and configured term are enforced; reject decoy settlement outputs.
- [ ] Settlement entitlements derive from authenticated entry records and
  the verified draw, with canonical prize rounding and total conservation.
- [ ] Final reserve disposal is explicit; no zero-capacity live funding cell.

## Stage 3 — Integration and release evidence

- [ ] Add adversarial VM tests for cursor replay, lock substitution,
  cross-config refunds, multi-batch routing and forged liability roots.
- [ ] Build all five contracts and any new lifecycle contracts for RV64IMAC.
- [ ] Run core, targeted VM, lint, formatting and independent security review.
- [ ] Exercise node-level capacity, header, maturity and full-round checks.
- [ ] Update protocol, builders and ABI documentation, retaining historical
  manifests. Mark readiness only for gates actually exercised successfully.

No stage is complete merely because its predecessor passes. Stage 2 needs
its own concrete transaction/witness specification; this plan does not claim
the conceptual lifecycle alone is an implementable security proof.
