# Authenticated Entropy Transition Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans, test-first changes and scoped Rust/security review.

**Goal:** Replace the one-time seal with a uniquely authenticated future-header record, preserving refund snapshots.

**Architecture:** Canonical shard zero spends its version-3 seal once. Load its actual inclusion header with `load_header(0, GroupInput)`; require relative-block `since` of at least 256 with no other flags. Require exactly four header deps: seal inclusion first, then heights +64, +128, +192. Compare inclusion hash to the input-associated header. Compute the expected record from those headers and the original seal; never trust a witness-provided seed. Version-4 records cannot be spent in this bounded stage.

**Tech Stack:** Pinned Rust no_std, CKB-VM and CKB header/relative-since syscalls.

**Spec:** Owner-approved seal and offsets in `docs/superpowers/specs/2026-09-08-draw-authentication-decisions.md`.

## Global Constraints

- No signatures, deployments, broadcasts or alteration of historical artifacts.
- Preserve the entire seal, canonical type/public lock and capacity; forbid entry inputs.
- Node validation must enforce header-dependency validity and relative maturity. VM fixtures do not validate PoW, ancestry, reorgs or actual elapsed blocks.
- This authenticates chain entropy, not winners or initial liability roots.

### Task 1: Record and validate scheduled entropy

**Files:** core `seal.rs`, new shard `entropy.rs`, shard dispatch, entry refund decode, seal/refund VM fixtures.

**Interfaces:** `EntropyRecord::new(seal, inclusion_height, inclusion_hash, [hash;3])`, `encode`, `decode`, `seal`. Wire `04 || seal_bytes || inclusion_height[u64] || inclusion_hash[32] || three_header_hashes[96]`.

- [x] Add codec and VM tests; observe the new transition rejected before contract wiring.
- [x] Implement checked record encoding and schedule validation. Output must equal the computed record byte for byte.
- [x] Route 3→4 through exact canonical authority and header checks; reject 4→anything. Preserve refund snapshot decoding from both states.
- [x] Verify wrong/missing/reordered headers, false anchor, early/absolute/epoch/reserved since, seal mutation, capacity/lock change, repeated entropy transitions and refund preservation. Include 256-shard state-size cases.
- [x] Build all five contracts and run core, full VM and strict lint/format gates; obtain scoped review and document remaining draw/entitlement/node gates.

Verified locally: 69 core tests, 70 VM tests, strict core/contract Clippy and formatting. Behavioral regression confirmed by disabling version-4 dispatch (positive VM test fails -29), then restoring it (passes). Bounded review approved after 256-shard and two-entry-refund tests plus adversarial header/state cases. No node-level maturity/reorg or complete-round claim.
