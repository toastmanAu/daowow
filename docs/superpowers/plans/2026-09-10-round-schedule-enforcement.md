# Round Schedule Enforcement Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prevent creation of canonical rounds/shards whose committed prize schedule is invalid or unavailable.

**Architecture:** A shared bounded witness loader reads WitnessArgs.output_type at the absolute config output index and validates the canonical PrizeSchedule commitment. Both round-type creation and each initial shard creation invoke it, including the permitted untyped-config path. Existing immutable config updates do not require a new schedule witness.

**Tech Stack:** Rust, ckb-std syscalls/Molecule WitnessArgs, RISC-V VM integration tests.

**Spec:** `docs/superpowers/specs/2026-09-10-computed-entitlements-design.md`

## Global Constraints

- 1–32 valid positive weights, exact schedule encoding and config hash match.
- WitnessArgs preserves the lock field for funding signatures; schedule is not raw lock witness data.
- Config output index identifies the transaction witness slot, including extra witnesses beyond input count.
- Bound the full creation witness to 4096 bytes before allocation; reject missing, oversized or malformed witness/table/output_type.
- Independent shard checks prevent bypass through an untyped anchored config.
- Preserve dirty worktree; no live deployment, signing or node mutation.

## Task 1: Enforce committed schedule during creation

**Files:** `crates/daowow-contracts-common/src/lib.rs`, `contracts/round-type/src/main.rs`, `contracts/entry-shard-type/src/main.rs`; tests in `tests/integration/tests/round_validation.rs`, `security_shard_lock.rs`, and fixture helpers `common/mod.rs`.

- [x] Add valid creation fixtures with schedule commitment and WitnessArgs.output_type; keep a 65-byte lock field to demonstrate nonconflicting serialization.
- [x] Add missing, wrong commitment, committed malformed/zero/33-weight schedules for typed and untyped config creation. Run against existing contracts and observe acceptance where rejection is required.
- [x] Implement `creation_schedule(cfg, config_output_index) -> Option<PrizeSchedule>` with a 4096-byte syscall buffer and verified WitnessArgs decoding; call at both creation boundaries after unique config anchor checks.

```rust
let length = ckb_std::syscalls::load_witness(&mut buffer, 0, index, Source::Input).ok()?;
let witness = WitnessArgs::from_slice(&buffer[..length]).ok()?;
let schedule = witness.output_type().to_opt()?;
PrizeSchedule::decode_committed(&schedule.raw_data(), &cfg.prize_schedule_hash).ok()
```

- [x] Build all five RISC-V contracts with pinned offline dependencies; run targeted round/shard tests and complete existing VM gate set. Test nonzero config index and extra-witness placement, max valid schedule and oversized witness rejection.
- [x] Run full core/default/no_std and contract Clippy, fmt/whitespace gates, bounded Rust/security review. Record observed creation cycles as fixture evidence, not a maximum funded-round cost guarantee.

## Remaining goal

Checkpoint: both creation boundaries implemented and reviewed. Missing-schedule
VM regression failed against old binaries before enforcement. Eight round tests
and eleven shard-lock tests pass; full named VM suite totals72 passing. The
security_ledger actual-creation fixture also needed a schedule commitment and
witness; updated without weakening the gate. All five RISC-V release builds and
strict contract Clippy pass. Cycle evidence is recorded in
`docs/benchmarks/2026-09-10-round-schedule.md`.

Initial-entitlement derivation still needs canonical chain-context wiring in DAO phase2 and settlement creation, corrected sponsor accounting, maximum-tail VM checks and full-node maturity/reorg assertions. This gate alone does not authorize a funded launch.
