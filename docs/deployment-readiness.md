# DAOWOW — deployment readiness & status

Date: 2026-09-05
Scope: honest assessment of how close the smart contracts are to a **CKB
testnet deployment** (Milestone 10), what is blocking it, and the critical
path. Companion docs: [`prototype-report.md`](../prototype-report.md) (what is
built and measured), [`AGENT_HANDOFF.md`](../AGENT_HANDOFF.md) (objectives and
stop conditions), [`docs/milestones.md`](milestones.md) (gates).

**Verdict up front:** the on-chain logic is prototype-solid — five contracts,
all verified on the real CKB-VM with adversarial negative tests, with the
toolchain landmines already solved. But the project is **not
deployment-ready**: there is no deploy tooling, no off-chain transaction
builders (M9), two protocol milestones are unimplemented (M6, M7), one
milestone gate is only half-proven (M4 refunds), and the core has a
position-space inconsistency that must be fixed before formats freeze.
Milestone status: **M0–M3 done, M5 mostly done, M4 half-done; M6, M7, M9, M10
not started.**

---

## 1. What is ready (de-risked)

### Contracts (all build for `riscv64imac`, `data1` hash type)

| Contract | Lines | VM-verified by | Notes |
|---|---|---|---|
| `round-type` | 92 | proto1 | immutable RoundConfig creation/validation |
| `entry-shard-type` | 323 | proto1 | sharded collection + MMR append/freeze, contention behaviour |
| `entry-lock` | 407 | proto2 | aggregation via membership proof **or** deadline-gated refund |
| `dao-lock` | 243 | proto3 | native DAO custody, phase 1 + 2, no lock substitution |
| `settlement-type` | 200 | proto4 | batched direct payouts via SMT liability proofs, ascending lock-hash cursor |
| `accumulator-bench` | 257 | bakeoff | MMR vs SMT vs IMT measurement harness (ADR-0001: MMR selected) |

- On-VM integration suites proto1–proto4 are green (ckb-testtool 1.1.1,
  in-process ckb-vm 0.24.14), including adversarial cases with mirrored error
  codes (`-31/-33/-34/-45/-47/-57/-58/-59/-72/-73/-75`).
- Cycle costs and batching ceilings measured and documented
  (prototype-report §3–§6); occupied-capacity table published (§5).
- Toolchain landmines solved and documented (prototype-report §1): mandatory
  `--no-rosegment`, plain RV64IMAC code shipped as `data1`, vendored `bytes`
  without RISC-V atomics, bump allocator replacing buddy-alloc.
- Deterministic core (`daowow-core`, 40 host unit tests) has cross-language
  conformance: the JS mirror (`apps/web/core.js`) passes all 11 Rust-generated
  vectors, and a full-round JS engine model is browser-verified
  (`apps/web/PROGRESS.md`).

This is the part that usually kills CKB projects late — script/VM/toolchain
compatibility — and it is already done.

## 2. Gap register (what blocks testnet)

Ordered by dependency, not severity alone. "Size" is focused-work estimate for
a minimal testnet-viable version.

### G1 — Deployment tooling: does not exist (blocks M10) · size: small

Nothing in the repo computes code hashes, builds deploy transactions, funds
cells, or manages cell-deps. Needed:

- deploy script/program producing one cell per contract with `hash_type: data1`
  (VM v1), from the existing `--no-rosegment` RISC-V binaries
  (`target/riscv64imac-unknown-none-elf/release/`);
- recorded code hashes / a deployed-scripts manifest that every later tx
  builder consumes as cell-deps;
- a funded testnet account flow (faucet) and capacity accounting for the
  ~100 KB of script cells.

The contracts are plain bin crates, so the content is trivial; the work is
plumbing and reproducibility (a `make deploy` equivalent + manifest).

### G2 — Keeper / transaction builders (M9) — the long pole (blocks M10) · size: large

Every contract interaction currently happens inside the Rust `ckb-testtool`
harness. A live round needs off-chain code (TypeScript + CCC per the handoff)
that:

- builds real transactions: entry, shard retry under contention, freeze,
  batched aggregation with MMR membership proofs, DAO phase 1/2 with header-deps
  and `since`, settlement batches with liability proofs;
- reads chain state (shard heads, deposit cells, funding cells) and drives the
  permissionless transitions unattended for a full round;
- re-uses the measured batch-size policy constants (prototype-report §6).

Handoff rule: **read the CCC agent skills before writing any CCC code.**
This milestone gates M10 completely; a UI is explicitly not required for it.

### G3 — Refund path (M4) implemented but never tested on-VM · size: small

`entry-lock` implements the refund branch (absolute-epoch `since` ≥
`aggregation_deadline`, pays only to the committed participant lock hash, no
DAO outputs allowed — `contracts/entry-lock/src/main.rs:328`), but **zero
integration tests exercise it**. M4's gate — "no Entry can be both refunded
and aggregated" — is only half-proven (the aggregation side is tested; the
refund side and the both-at-once adversarial case are not). Also untested:
refund interacting with the shard state (spent entry vs shard counters) and
refund after freeze being rejected.

### G4 — Core position-space inconsistency (spec delta, found via the UI model) · size: small but must precede G7

`crates/daowow-core/src/shard.rs:65` assigns `position_base` **per shard**
(`running_position_base = shard.ticket_count`) while
`crates/daowow-core/src/accounting.rs::validate_position_tiling` requires entry
ranges to tile the **global** `[0, total_tickets)`. Both cannot hold for
multi-shard rounds. Consistent resolution (already implemented and tested in
the engine model, `apps/web/engine.js draw()`): global position space is the
**shard-major concatenation of the frozen shards** — shard `s` owns
`[prefix_s, prefix_s + count_s)`; an entry's local
`[position_base, position_base + ticket_count)` maps to
`prefix_s + position_base`. Deterministic from public chain data. The core
(and eventually the M7 finalisation cell, which must commit the per-shard
prefix offsets) needs this fix. Deploying with the current spec would make
draws unverifiable for multi-shard rounds.

### G5 — Batch accounting (M6) unimplemented (blocks M6, weakens M10) · size: medium

`dao-lock` currently proves only same-round settlement destination. The
BatchCommitmentCell (TX-05) that binds `batch_id → principal sums → funding
cell` is specified but not implemented, so per-batch principal/yield
accounting is enforced by nothing on-chain. M6's gate — "multiple deposits
included at different blocks/epochs settle correctly" — is unproven. A minimal
testnet round could run with a single batch, but shipping the protocol claim
without M6 would be dishonest framing.

### G6 — Entropy/draw (M7) has no on-chain path (blocks M7) · size: medium + open research

Seed derivation + rejection sampling exist in `daowow-core` with vectors, and
the JS engine models the flow, but there is no reveal/finalisation cell
contract, and the randomness threat-model review (open-questions **P0-3**:
last revealer, miner withholding, reorgs, grinding, tx delay) is still open.
The draw can be run off-chain and verified for a demo round, but the protocol
claim "reproducible from public chain data" needs the on-chain finalisation
path.

### G7 — Real participant locks (secp256k1) · size: small-medium integration

All tests use a stand-in always-success lock. Real
`secp256k1_blake2b_sighash_all_all` locks are a **genesis dep on testnet**, so
no deployment is needed — but every participant-facing flow (entry cells,
refund destination, settlement liability leaves = lock-hash-keyed, payout
outputs) changes lock-hash derivation and requires witness signatures in the
keeper. Contract logic should be unaffected (it only ever sees lock hashes);
integration testing is the work.

### G8 — Scale/economics assumptions unverified on a live chain · size: ongoing

- Multi-DAO-cell withdrawal transactions untested (P1-9/10); phase 1/2 scripts
  were tested with 1 cell per tx.
- Header-dep and witness growth at scale (P1-12).
- Economics open questions with real UX impact: minimum viable ticket price
  (P1-14; entry overhead ~0.002% at 100 CKB but 0.2% at 1 CKB), fee policy
  (P1-15), keeper rewards (P1-16).
- 32 shards ≈ 624 CKB locked structural overhead, sponsored by the round
  creator — sponsor/refund flow unexercised.

### G9 — Chain-side compatibility checks (do once before deploy) · size: trivial

Confirm on current testnet: `data1` (VM v1) support post-hardfork, per-cell
script size limit vs current binaries (40–100 KB each — comfortably inside
known limits), and testnet DAO behaviour matches the `dao.c` reference the
tests already use.

## 3. Milestone scorecard

| Milestone | Gate | Status |
|---|---|---|
| M0 Toolchain | clean clone builds + baseline tests | **done** (reproducible, pinned) |
| M1 Core math | Rust + TS match all deterministic vectors | **done** (11/11 via JS mirror; full TS port of every vector family pending SDK) |
| M2 Entry shards | concurrent entries across shards | **done** (proto1) |
| M3 Accumulator | membership proof on CKB-VM, measured | **done** (ADR-0001, MMR) |
| M4 Refunds | no Entry both refunded and aggregated | **half** — refund branch implemented, on-VM tests missing (G3) |
| M5 DAO lifecycle | full lifecycle without privileged key | **done** (proto3; multi-cell scale untested, G8) |
| M6 Batch accounting | multi-batch exact conservation | **not started** (G5) |
| M7 Draw | independent verifier reproduces seed + winners | **partial** — core math + vectors + engine model done; on-chain finalisation + P0-3 review missing (G6, G4) |
| M8 Settlement | parallel shards settle exactly once | **done single-batch** (proto4); cross-batch binding needs M6 |
| M9 Automation | keeper runs a local round unattended | **not started** (G2) |
| M10 Testnet | real round completes, verifier matches chain | **blocked** by G1, G2, G3, G4, G5 |
| M11 Pre-audit freeze | spec/implementation/threat model agree | **open** (Molecule codegen + P0-3 + economics) |

## 4. Critical path to a first testnet round

1. **G3** refund on-VM tests + **G4** position-base core fix — small, and both
   must land before formats freeze (Molecule codegen).
2. **G5** minimal BatchCommitmentCell (can start with single-batch support and
   grow).
3. **G1** deploy script + manifest for the five contracts.
4. **G2** minimal TypeScript/CCC keeper: one round, 20 simulated participants,
   local dev chain first (M9 exit), no UI.
5. **G7** swap stand-in locks for real secp256k1 in the keeper flows.
6. **G9** chain-side checks, then a first round on testnet with the verifier
   bundle published (M10 exit). **G6** (on-chain entropy) can trail the first
   demo round only if the round is honestly labelled as using an
   off-chain-verified draw; the protocol claim requires it.

Realistic shape: the contracts themselves are close to deploy-clean (G3 + G4 +
minimal G5 ≈ days of focused work); the keeper SDK (G2) is the dominant cost,
and per `AGENT_HANDOFF.md` it starts by installing/reading the CCC agent
skills.

## 5. Stop-condition watchlist (from AGENT_HANDOFF.md)

None of the measured results trip a stop condition so far. The ones still
live: cycle/size limits at scale (G8 multi-cell withdrawals), block-derived
randomness vs the threat model (G6/P0-3), and occupied-capacity UX at low
ticket prices (G8/P1-14). If any trips, the handoff requires updating the
protocol design rather than hiding it.
