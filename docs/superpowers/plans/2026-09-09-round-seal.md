# Round Seal Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans, with test-first changes and scoped Rust/security review.

**Goal:** Authenticate a complete closed-shard universe once, preserving refund authority.

**Architecture:** Canonical shard zero transitions from closed 207-byte ledger to a seal containing every closed ledger in shard-ID order. Other ledgers are authenticated dependencies. Seal bytes are `03 || count[u32] || ledger[207] * count`; count equals the committed config shard count. Shard zero's original snapshot is preserved for excluded-entry refunds. This bounded stage rejects spending a seal; the later authenticated draw transition must explicitly replace that restriction.

**Tech Stack:** Pinned Rust no_std, CKB scripts and CKB-VM tests.

**Spec:** Approved one-time seal/refund-preservation architecture and entropy offsets in the conversation; `docs/superpowers/specs/2026-09-08-draw-authentication-decisions.md`.

## Global Constraints

- Seal source is exactly one canonical shard-zero input, not a copied cell dependency.
- All snapshots are closed, canonical, unique, config-bound and ordered; output bytes exactly match them.
- No entry inputs, no capacity decrease, canonical public locks, sponsor-funded growth.
- No broadcasts, deployment artifact replacement or claims of completed draw authentication.

### Task 1: Seal and preserve refunds

**Files:** new `crates/daowow-core/src/seal.rs`, new `contracts/entry-shard-type/src/seal.rs`, shard dispatch, entry refund decoder, new `tests/integration/tests/security_seal.rs`.

- [x] Add a VM fixture executing frozen→ledger→closed for every shard, then closed shard-zero→seal. Observe rejection before implementation.
- [x] Add `RoundSeal::new`, `decode`, `encode`, `ledger`, and `entropy_heights`; enforce exact bounded wire shape and checked +64/+128/+192/+256 arithmetic.
- [x] Wire canonical seal creation and prohibit seal spending. Refund decoding extracts shard zero's authenticated snapshot.
- [x] Test successful creation, omitted/reordered/open snapshots, early/replayed seal, forged output, missing authority, and refund preservation. Run scoped and full suites, Clippy, formatting and bounded review.
- [x] Record the exact boundary: seal creation implemented, future-header/draw/initial-root authentication still separate.

Bounded review approved this stage: no critical/high finding; eight seal/refund tests pass, including 256-shard seal and two-entry refunds. Full verification: 69 core and 69 VM tests, release build, strict Clippy and formatting pass. Larger refund batches and header/draw/entitlement successors are not covered by this approval.
