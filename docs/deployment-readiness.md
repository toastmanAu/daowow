# DAOWOW — deployment readiness & status

Date: 2026-09-05

2026-09-15 partial-round completion: the two-entry, one-owner history now
continues from excluded refund through seal/entropy, DAO withdrawal, computed
funding and final payout. Accepted principal plus yield pays separately while
the excluded 400 CKB refund remains unchanged. The full partial test and ten
focused regressions pass; bounded reviews approve the test-only changes.
Multiple owners/batches, broader reorg/resource cases and production keeper
tooling remain open. See [partial-round evidence](validation-2026-09-15-partial-full.md).

Partial-acceptance checkpoint, 2026-09-14: two actual same-owner entries now
exercise one accepted DAO deposit plus one excluded full-capacity refund after
deadline closure. Proof substitution rejects; the accepted DAO/receipt remain
unchanged. This is not multi-owner coverage or a complete partially accepted
round payout. See [partial-acceptance evidence](validation-2026-09-14-partial.md).

Refund-reorg checkpoint, 2026-09-14: a real competing branch now orphans a
committed refund, restores the exact entry/sponsor cells, and supports a
replacement full 400 CKB refund. Underpayment and duplicate spending reject.
Nine focused tests pass. Deeper/broader histories and persistent keeper recovery
remain open; testnet is unchanged. See
[refund-reorg evidence](validation-2026-09-14-refund-reorg.md).

Funding/payout-reorg checkpoint, 2026-09-14: two actual competing-branch
reorganizations now roll back committed funding and payout, restore their
inputs, and permit explicit replacement transactions through a full canonical
payout. A distinct-hash duplicate spend rejects. The focused recovery test and
eight harness/refund regressions pass; bounded review approves the test-only
changes. Persistent keeper recovery, refund reorgs and broader histories remain
open. See [settlement-reorg evidence](validation-2026-09-14-settlement-reorg.md).

Refund checkpoint, 2026-09-14: an actual unaggregated entry now returns its full
400 CKB after deadline-gated ledger closure. Missing authority/proof, premature
`since`, underpayment and nonordinary output mutations reject. Bounded reviews
approve this fixture; production contracts and testnet remain unchanged.
The full-suite run had one Docker mining RPC timeout; the unchanged canonical
rerun passed. Harness timeout reliability remains open.
Refund reorg recovery, orphaned funding/payout recovery and broader failed-round
cases remain open. See [refund evidence](validation-2026-09-14-refund.md).

Entropy-reorg checkpoint, 2026-09-14: an actual longer competing branch replaces
the seal inclusion and entropy. The orphaned entropy dependency rejects; the
rebuilt canonical dependency commits, followed by DAOWOW withdrawal, computed
funding and final payout. Ten node/harness tests pass across focused runs.
This is bounded one-entry MMR coverage, not general keeper recovery: failed-round
refunds and orphaned funding/payout recovery remain open, along with broader
round/resource cases and operational rollout gates. No testnet writes occurred.
See [entropy-reorg evidence](validation-2026-09-14-entropy-reorg.md).

Later 2026-09-14 checkpoint: the first complete isolated one-entry MMR round
passes through DAOWOW-locked DAO withdrawal, computed initial funding and final
payout (400 CKB principal plus 0.70133609 CKB yield). All nine node/harness tests
pass across focused runs. This is not readiness for arbitrary funded rounds:
multi-participant/batch and failed-round histories, reorg/liveness, broader
edge cases and operational rollout gates remain. See
[full-round evidence](validation-2026-09-14-full-round.md).

2026-09-14 checkpoint: real isolated history now includes both ledger closures,
the round seal and authenticated scheduled entropy. Missing-shard, early
submission, wrong-header and forged-record rejection checks pass. Exact pool
cutoff/premature-block rejection and subsequent DAOWOW withdrawals, funding,
payouts and reorg/liveness remain open. See
[entropy evidence](validation-2026-09-14-entropy.md).

Later 2026-09-13 checkpoint: actual isolated-node history now reaches entry
append, epoch-gated freeze and atomic aggregation into a full-capacity DAO
deposit plus receipt. A dependency-order heap failure in configuration lookup
was fixed with bounded reads; the fixture's DAO type hash was corrected.
Seal/entropy/withdrawal/entitlement/payout history and later gates remain open.
See [aggregation evidence](validation-2026-09-13-aggregation.md).

2026-09-13 protocol-history checkpoint: an isolated full node commits a real
round and both configured empty MMR shards, with missing-shard and
missing-schedule rejection checks. The Rust exporter and Python/container
changes passed bounded review. Native DAO fixture review is now approved too.
Progression after creation and DAOWOW-specific reorg/liveness remain open;
funded rounds are still not ready. See
[round creation evidence](validation-2026-09-13-round-creation.md).

Real-node update, 2026-09-12: all eight isolated-node harness tests pass,
including a real native DAO deposit, withdrawal preparation, early rejection,
exact fractional-maturity submission and committed compensated payout. The
basic competing-branch reorg also passes. This is not yet DAOWOW transaction
history/reorg validation; broader native maturity cases remain open. See
[native DAO evidence](validation-2026-09-12-native-dao.md).

64-liability update, 2026-09-11: all three accumulators pass creation of 64
distinct liabilities and final consumption of the resulting funding cell.
Creation costs 17.3–31.4M cycles; final payout costs about 7.3M. Maximum valid
sparse proofs, pre-phase2 history, and full-node maturity/reorg remain open.
See the [creation-to-drain report](benchmarks/2026-09-11-64-liability-creation.md).

Distinct-owner budget fix, 2026-09-11: the owner-approved verification split
reduces the SMT fixture from **73,445,370 to 32,957,450 cycles**. The DAO lock
requires the exact new settlement type output; that type performs the complete
entitlement verification once. Matching settlement inputs are forbidden so an
update cannot replace creation. See the
[single-verification report](benchmarks/2026-09-11-single-verification.md).

Validation update, 2026-09-11: local gates pass (96 core, 93 targeted VM tests).
Combined 32-entry/32-prize/256-shard creation fixtures now pass for all three
accumulators using bounded detached evidence for large native-DAO witnesses.
These do not cover maximum sparse proofs or distinct-owner memory limits.
Computed winners and initial funding authentication are wired into DAO phase2
and settlement creation; sponsor-aware payouts and the 64-liability tail pass
bounded review and VM tests. **Not ready for funded rounds:** full historical
fixtures, maximum creation memory/witness tests, new-ABI tooling and full-node
maturity/reorg validation remain incomplete. The owner's testnet RPC and old
code cells were verified in an earlier read-only preflight, not rechecked here.
See [current security checkpoint](security-progress.md).

Scope: honest assessment of how close the smart contracts are to a **CKB
testnet deployment** (Milestone 10), what is blocking it, and the critical
path. Companion docs: [`prototype-report.md`](../prototype-report.md) (what is
built and measured), [`AGENT_HANDOFF.md`](../AGENT_HANDOFF.md) (objectives and
stop conditions), [`docs/milestones.md`](milestones.md) (gates).

**Verdict after source inspection:** **not deployment-ready**. The existing
prototype suites pass, but they do not establish the advertised security
properties. A debugging early return bypassed all RoundConfig validation;
this has now been removed and covered by real creation/update VM tests.
Local security changes now bind configuration commitments and repair freeze
and refund epoch checks and refund accounting. Exact DAO withdrawal routing
and initial liability enforcement are repaired locally; complete historical
chain validation, maximum creation resource bounds, deploy tooling and
transaction builders remain release blockers.
See the new **G0** gate below and the executable sequence in
[`testnet-launch-plan.md`](testnet-launch-plan.md).
Milestone status: **M0–M3 done, M5 mostly done, M4 half-done; M6, M7, M9, M10
not started.**

---

## 1. What is ready (de-risked)

### Fresh verification, 2026-09-05

Latest local checkpoint (2026-09-11): all five contracts build; 96 core tests
and 93 targeted VM tests pass. One-time closed-universe sealing and preserved
shard-zero refunds are implemented locally, including 256-shard VM cases;
the scheduled-header entropy successor is now implemented and bounded-reviewed.
Computed winners and initial entitlements are contract-enforced locally;
full-node lifecycle validation remains unfinished.
The 32-participant SMT aggregation fixture now
costs 47.4M cycles (previously 637.6M), within the 70M harness ceiling.
Canonical public shard locks now enforce
permissionless progression and nondecreasing shard capacity. Core ledger codecs, the shard-creation bypass
fix and indexed settlement progression are implemented and bounded-reviewed.
Settlement uses an incompatible 112-byte V2 funding codec and position-bound
MMR proofs; the rejected SMT deletion approach is not in production. Initial
entitlement authentication is now wired and bounded-reviewed. On-chain ledger, atomic receipt/DAO
wiring and terminal refund authorization are implemented locally. Round-wide
sealing and draw authentication are implemented; maximum creation resource
validation, operational batch sizing and node validation remain open;
see `docs/security-progress.md`.

Historical local security pass (2026-09-06): all five contracts build; **55 core
tests and 35 targeted VM tests pass** (proto1–proto4, round_validation,
security_config, security_freeze, security_refunds). Strict core and RISC-V
contract Clippy passes; integration-test harness warnings remain.
The JavaScript mirror passes five new security checks, eleven vector checks,
and its demonstration engine test. The new accepted-prefix ledger remains
core-only; on-chain lifecycle and independent security review are still open.
These local binaries are **not** the confirmed testnet deployment below.
See [security-progress.md](security-progress.md) for ABI changes and open gates.

- Installed the repository's pinned Rust 1.98.1 toolchain and RISC-V target;
  all five protocol contracts build from the locked dependencies.
- Existing proto1–proto4 suites: **16 tests pass** after rebuilding contracts.
- New `round_validation` suite: **3 tests pass**, covering valid creation
  with sponsor change, rejected zero ticket price, and immutable updates.
  The zero-price test failed before the fix because the VM accepted the tx.
- Core host tests: **41 pass** on the pinned Rust 1.98.1 toolchain. This is
  not a claim of full workspace validation or a completed local-node round.
- These are script-harness results, not local-node or testnet results. In
  particular, `World::create_round` inserts mock cells without executing
  their creation scripts. Passing the older creation-named test did not
  prove RoundConfig validation.

The tables below describe prototype coverage; G0 takes precedence over any
earlier milestone labelled done.

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

### G0 — Security boundary repairs (blocks every funded round)

Source inspection found gaps beyond the original register. The table below
records the original findings and exit criteria, not a claim that every row
remains untouched. The current partial fixes and remaining verification gaps
are tracked in [security-progress.md](security-progress.md). No finding is
claimed to be a reproduced live-chain exploit.

| Finding | Evidence | Required exit test |
|---|---|---|
| Round validation bypass — **fixed** | `contracts/round-type/src/main.rs` contained unconditional debugging returns before validation | `round_validation`: zero-price creation rejected; valid creation with change and immutable updates checked |
| Config dependency is not authenticated | `entry-lock::find_round_config_in_deps`, `entry-shard-type::config_for`, `dao-lock::config_for` accept config-shaped data with matching round ID and any type script with eight-byte args | Substituted config with attacker-controlled script references rejected; round identity unique and bound to the authenticated config |
| Freeze has no deadline check | `entry-shard-type::main` checks only `validate_freeze` counters/state; no input `since` check | Early freeze rejected; boundary epoch accepted; malformed/relative timestamps rejected |
| Refund accounting reuses payouts | `entry-lock::refund` independently compares each entry principal to the same matching output | Multiple entries for one participant require their summed repayment; no redirected occupied capacity or typed output masquerading as an ordinary refund |
| Refund deadline compares packed bits | `entry-lock::refund` compares the low 56 bits directly to an epoch number | Epoch fractions decoded and validated; pre-deadline fractions cannot bypass the deadline |
| DAO phase-two funding is not bound | `dao-lock::phase_two` requires only that at least one same-round settlement output exists | Small decoy settlement plus diverted remainder rejected; batch identity, exact funding and authenticated liabilities bound together |
| Settlement creation trusts supplied liabilities | `settlement-type::main` creation checks encoding and zero cursor, without deriving/authenticating the root | Attacker-selected payout root rejected even when its membership proofs are internally valid |
| Capacity helper uses bytes as shannons | `tests/integration/tests/common/mod.rs::entry_cell_capacity` adds structural byte count directly to principal | Occupied capacity computed in shannons using actual serialized cells, exercised with real locks and node validation |

The freeze/refund/aggregation interaction also needs a specified terminal
state: simply prohibiting refund after freeze can strand entries when
aggregation fails. Define the accepted, aggregated and excluded ticket
universe before entropy becomes available. A keeper convention cannot
substitute for on-chain enforcement.

**Stop-condition consequence:** the previous non-custodial/principal-preserving
claim is not established. Update the protocol's identity, finalisation and
funding rules before freezing formats or funding a demo. A single batch does
not waive these requirements.

### G1 — Prototype code deployed and verified (M10 round still open)

The five stripped code cells were deployed using `ckb-cli 2.0.0` in transaction
`0x12c1ec3a523bff74caaefa329ce8b115854be61cc3b50521dd7d9efd0d4b8006`,
committed at testnet block **22,314,903**. Verification at
2026-09-05 04:47:27 UTC found 9 confirmations and all five code cells live.
Their on-chain data hashes, binary SHA-256 checksums, capacities and wallet
locks matched the tested artifacts. Ordinary wallet change was also verified.

Code capacity: **180,777 CKB**; fee: **0.00362744 CKB**;
change: **119,222.99637256 CKB**. The owner can spend code cells to recover
capacity, which would invalidate their use as live script dependencies.

[`deployments/testnet-manifest.json`](../deployments/testnet-manifest.json)
records confirmed code hashes and `data1`/`code` cell dependencies. The
deployment configuration, signing workflow and migration receipt are in
[`deployments/`](../deployments/README.md). Future builders must consume the
confirmed manifest and check dependency liveness. Security repairs require
new artifacts and potentially replacement deployments; **G0 remains required
before any funded round. M10 is not complete.**

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

1. **G0** authenticate configuration and liabilities, enforce deadline and
   funding boundaries, and define failed aggregation/refund finalisation.
   Then **G3** refund on-VM tests + **G4** position-base core fix — both
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

Do not retain the original “days to deploy-clean” estimate: G0 changes the
security and format work required. Size the remaining implementation after
the identity, finalisation and liability binding rules have executable
adversarial tests. CCC work starts by installing/reading its agent skills.

## 5. Stop-condition watchlist (from AGENT_HANDOFF.md)

None of the measured results trip a stop condition so far. The ones still
live: cycle/size limits at scale (G8 multi-cell withdrawals), block-derived
randomness vs the threat model (G6/P0-3), and occupied-capacity UX at low
ticket prices (G8/P1-14). If any trips, the handoff requires updating the
protocol design rather than hiding it.
