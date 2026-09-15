# Prize Redemption State Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans inline. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Track each ticket's paid prize sources without allowing a duplicate payment to reset or overwrite history.

**Architecture:** A pure core state carries ticket ID, append-only sparse-tree root, paid-source count and paid-prize total. Reuse `smt::inserted_root` with one bounded absence proof per positive, fully discharged source obligation. This is accounting only: contracts must authenticate obligations, pay funds and enforce successor continuity.

**Tech Stack:** Existing no-std Rust core and vendored SMT; no dependencies added.

**Spec:** `docs/superpowers/specs/2026-09-15-prize-only-claim-amendment.md` takes precedence over the earlier all-rights lifecycle draft.

## Global constraints

- No principal or refund claim kind. No ownership field or transfer-induced reset.
- NFT occupied capacity and sovereign deposit capacity are outside this state.
- No completion flag, burn authorization or memento issuance inferred from count/total.
- Canonical source identity must be stable across funding-cell successor outpoints;
  the future contract adapter derives it from authenticated round/batch identity.
- Zero-value sources require no payment marker. This module never decides that
  an absent, unknown or immature source has zero value.
- Preserve all existing contracts, encodings, artwork and landing-page files.
- Keep changes in the user-selected workspace; `.git` is read-only.

## Files and interfaces

- Create `crates/daowow-core/src/redemption.rs` and `redemption/tests.rs`.
- Export `pub mod redemption;` in `crates/daowow-core/src/lib.rs`.
- `prize_obligation_key(ticket: &Hash32, source: &Hash32) -> Hash32` hashes
  `DAOWOW_PRIZE_OBLIGATION_V1 || ticket || source || 0x01`. The fixed kind is
  prize only. Amount and owner are deliberately absent from the key.
- `prize_payment_leaf(ticket: &Hash32, source: &Hash32, amount: u64) -> Hash32`
  hashes `DAOWOW_PRIZE_PAYMENT_V1 || obligation_key || amount_u64_le`.
- `PrizeRedemptionState` has private ticket/root/count/total fields and read-only
  getters. `new(ticket)` creates empty accounting, not mint authorization.
- `record_verified_prize(&self, source: &Hash32, amount: u64, absence: &[u8])`
  returns `Result<Self, CoreError>`. Reject zero, checked-total/count overflow
  and failed absence proof; insert exactly the payment leaf into the old root.
  A source's amount is its complete verified obligation, not a chosen installment.
  Incremental redemption means separate canonical sources, not repeatedly paying
  the same source. The caller authenticates amounts and performs actual payment.
- `encode() -> [u8; 81]`, `decode(&[u8]) -> Result<Self, CoreError>`: version byte
  1, ticket bytes 1..33, root 33..65, count LE 65..73, total LE 73..81. Reject
  non-exact length/version, inconsistent empty state, zero root with positive
  count and total below count. Decoding does not authenticate chain provenance
  or prove the counters match the tree; valid mint/transition history does.

### Task 1: Tests first

- [x] Create tests using real `SmtHost` proofs and observe failure from the missing API.

```rust
let state = PrizeRedemptionState::new([1; 32]);
let source = [2; 32];
let key = prize_obligation_key(&state.ticket(), &source);
let mut tree = SmtHost::new();
let proof = tree.absence_proof(&[key]).unwrap();
let next = state.record_verified_prize(&source, 7, &proof).unwrap();
tree.insert(&key, &prize_payment_leaf(&state.ticket(), &source, 7)).unwrap();
assert_eq!(next.paid_root(), tree.root());
assert_eq!(next.paid_total(), 7);
assert!(next.record_verified_prize(&source, 8, &proof).is_err());
```

Also test field/domain binding; ordered versus reversed source redemption;
fresh duplicate proofs; stale root proofs; corruption and oversize rejection;
maximum total overflow with unchanged input; exact codec and malformed states;
and continued payment after encoding/decoding an existing paid state.

Run `cargo test -p daowow-core --lib redemption::tests` and confirm missing API,
not unrelated fixture failures.

### Task 2: Implement and verify

- [x] Implement hashing and strict fixed-width codec with private state fields.
- [x] Implement checked, nonmutating transition:

```rust
let count = self.paid_count.checked_add(1).ok_or(CoreError::Overflow)?;
let total = self.paid_total.checked_add(amount).ok_or(CoreError::Overflow)?;
let root = smt::inserted_root(
    &self.paid_root,
    &prize_obligation_key(&self.ticket, source),
    &prize_payment_leaf(&self.ticket, source, amount),
    absence,
)?;
```

Reject `amount == 0` before this sequence; return new state without mutating self.
Do not accept an arbitrary caller-provided new root.

- [x] Run focused tests, `cargo test -p daowow-core --lib`,
  `cargo check -p daowow-core --no-default-features`, strict core library Clippy,
  targeted rustfmt and `git diff --check`.
- [x] Obtain read-only Rust review, resolve findings and record actual scope/results.

## Results (2026-09-15, Codex session hit usage cap after first green run; completed in Claude Code)

- `cargo test -p daowow-core --lib`: 109 passed, 0 failed (9 in `redemption::tests`,
  1 new `accumulator::proof_len_tests`).
- `cargo check -p daowow-core --no-default-features`: clean (no_std confirmed).
- `cargo clippy -p daowow-core --lib -- -D warnings` (std and no-std): clean. Clippy on
  `--all-targets` has 6 pre-existing errors in `imt.rs`, `smt.rs`, `computed_draw.rs`
  and `entitlements/tests.rs`; none in the redemption files, left untouched.
- rustfmt and `git diff --check`: clean. `cargo check --workspace`: clean.
- Read-only Rust review: APPROVE, no CRITICAL/HIGH. One MEDIUM resolved: the
  `MAX_PROOF_BYTES` bound in `smt::inserted_root` was not pinned by any test (empty
  and oversize proofs were rejected by the vendored decoder on a different path).
  Fixed by asserting the exact `MembershipProof` variant for an empty proof and a
  valid proof padded past the bound, plus a boundary unit test on `check_proof_len`.
  Mutation probe: replacing the length check with a no-op turns
  `stale_corrupt_and_unbounded_proofs_cannot_replace_paid_history` red. Two LOW
  notes (getter docs, decode readability) applied.
- Mutation probes on the module's own guards: amount==0, the three decode
  consistency checks and the version byte each fail exactly one named test when
  removed. The `paid_count` overflow guard is defence-in-depth only: decode enforces
  total >= count, so a saturated count implies a saturated total and the total guard
  fires first. `saturated_decoded_counters_cannot_accept_another_payment` exercises
  that path.
- Scope unchanged from the coverage boundary above: no contract wiring, source
  provenance, NFT authorization, funding-state coordination, retirement proof or
  memento issuance exists yet. Nothing committed; the whole DAOWOW working tree is
  still uncommitted from the Codex sessions.

## Coverage boundary and follow-on

This implements the paid-obligation set primitive of the approved model. It does
not claim to implement source provenance, live NFT authorization, atomic funding
updates, separate depositor payout, completion proofs, souvenir minting or wallet
rendering. Those remain required for the full objective. The existing 8192-byte
proof budget is inherited, not evidence that a maximum multi-claim transaction
fits VM limits; resource benchmarking belongs to contract integration.
