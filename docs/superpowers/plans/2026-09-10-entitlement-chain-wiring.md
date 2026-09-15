# Entitlement Chain Wiring Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make native DAO phase2 and settlement creation enforce the derived initial funding state.

Current execution note: the owner-approved plan
`2026-09-11-single-entitlement-verification.md` supersedes duplicate full
verification below. DAO binds mandatory settlement creation; that type alone
executes full entitlement derivation. Its bounded review and 91-test VM gate
are complete. Earlier red-budget/proposal notes are historical checkpoints.

**Architecture:** A bounded canonical entitlement payload occupies WitnessArgs.output_type on the absolute DAO input witness. Native DAO retains WitnessArgs.input_type for its deposit header index. Shared contract validation authenticates config, exact batch receipt, canonical immutable entropy and native DAO realization, then invokes InitialEntitlements and compares the funding output byte-for-byte. Both DAO lock and settlement type execute the shared validation, preventing standalone forged creation.

**Tech Stack:** Rust no_std, ckb-std, Molecule WitnessArgs, existing CKB-VM integration harness.

**Spec:** `docs/superpowers/specs/2026-09-10-computed-entitlements-design.md`

## Global Constraints

- One actual DAO withdrawing input per batch lock group, exact configured DAO type/lock and 104-byte identity args.
- Receipt type77 args must bind cfg, shard, batch ID and digest; public canonical receipt lock, exact receipt data, input capacity equal committed deposited capacity.
- Entropy must be the unique canonical shard-zero type36 with cfg commitment, public lock and exact version4 decoding. A witness-supplied entropy record is insufficient.
- Entitlement payload cap160 KiB, per-proof cap8192 bytes, 1–32 batch entries and 0–32 winner records. Encoders and decoders enforce exact lengths/counts before allocations.
- Native header selection stays in WitnessArgs.input_type, independent of entitlement output_type. Preserve native DAO maturity/type validation and exact realized funding routing.
- The payload carries no claimed liability root/count, claimed realized amount, receipt, entropy or caller-selected winning position.
- Keep funded-round readiness blocked until maximum-witness/heap/tail VM cases and node validation pass.

## Task 1: Entitlement witness codec

**Files:** New `crates/daowow-core/src/entitlement_witness.rs`; export from lib.rs. Unit tests in that module.

**Wire:** `01 || schedule_len[u32] || canonical_schedule || batch_count[u32] || (entry[132] || deposited_capacity[u64])* || winner_count[u32] || (entry[132] || proof_len[u32] || proof)*`. Integers LE, exact trailing boundary. Empty winner list is legal for failed rounds only, checked by derivation; decoder alone does not decide success.

**Interfaces:** `EntitlementWitness::decode(&[u8]) -> Result<Self,CoreError>` with owned schedule/entries/capacities and borrowed proof slices; `encode(&PrizeSchedule, &[EntryDataV1], &[u64], &[(EntryDataV1,&[u8])]) -> Result<Vec<u8>,CoreError>`. Accessors provide schedule, batch entries/capacities and temporary WinnerProof views. Schedule commitment is checked later against authenticated config, not supplied in the payload.

- [x] Add hand-checked wire roundtrip, all truncations/trailing/version failures, zero/oversized batch/winner counts, capacity arity, maximum proof and whole payload bounds. Verify borrowed proof data matches exact original bytes.
- [x] Observe behavioral failures against compiling skeleton, implement checked cursor reads, bounded allocations and symmetric encoding, then run focused/full core and default/no_std Clippy.
- [x] Obtain bounded Rust/security review before contract consumers depend on the codec.

Task1 checkpoint: three initial groups failed against the compiling skeleton
before implementation; five groups now pass, including a real consuming
decode-to-entitlement test. All96 core tests pass, both core Clippy modes and
formatting/whitespace pass. Bounded Rust/security review approved the codec;
this does not establish VM memory feasibility or Task2 completion.

## Task 2: Shared chain validator and creation enforcement

**Files:** New `crates/daowow-contracts-common/src/entitlements.rs`; export lib.rs; modify `contracts/dao-lock/src/main.rs`, `contracts/settlement-type/src/main.rs`; integration fixtures `proto3_dao_lifecycle.rs`, `proto4_settlement.rs`, new `security_entitlements.rs`.

- [ ] Build valid fixture with actual receipt creation and entropy transition plus native withdrawal headers. Encode payload alongside native deposit-header index.
- [x] Demonstrate old contracts accept substituted root/count or standalone funding creation with otherwise valid shape.
- [x] Shared validator locates exact configured input/output identities and matching canonical deps; bounds witness before allocation and uses borrowed Molecule fields. No raw-versus-expanded dep indexing assumptions unless explicit groups are rejected.
- [x] Move/reuse native realized-capacity calculation without changing per-input floor division. Check withdrawing input data, deposit header number, withdrawal-associated header, nondecreasing AR and occupied capacity.
- [x] Decode payload and invoke InitialEntitlements; require expected data and exact capacity/public lock on exactly one output. No existing funding inputs of that group during creation.
- [x] Route DAO phase2 and settlement creation through validator; forbid multiple group inputs, decoys, duplicate receipts/entropy deps and wrong batch/config/digest/provenance.
- [ ] Rewrite positive legacy fixtures to computed funding; preserve old attack tests and add each-field mutations, missing/extra/wrong deps and u64/heap/witness boundaries. Run full RV builds and named VM suite, strict Clippy and bounded review.

## Task 3 and end-to-end gate

64-liability checkpoint (2026-09-11): all three accumulators now derive exactly
64 liabilities from 32 target-batch depositors and 32 distinct earlier winners.
The validated phase2 output is consumed by a 64-item sponsored final payout.
Creation costs 17.3–31.4M cycles, payout about7.3M, within the ordinary70M gate.
The 256-shard fixture also rejects invalid padded160-KiB and160-KiB+1 payloads
normally, without OOM. Bounded test review approved the fixtures. This closes
the concrete64-liability creation-to-drain case, not maximum valid sparse
proofs or historical provenance. See the 64-liability creation benchmark report.

Distinct-owner follow-up: `phase2_distinct_owner_creation_across_accumulators`
now tests 33 separate liabilities instead of a single consolidated owner. MMR
43,737,635 and IMT 60,690,464 pass, but SMT 73,445,370 fails the 70M assertion.
This regression deliberately remains red; no limits or assertions were relaxed.
Proposed next design decision: DAO lock binds the exact configured settlement
output and delegates full initial entitlement verification to that output's
mandatory type execution, instead of executing the same derivation twice.
This is a proposal awaiting approval, not an implemented or reviewed security
change. Alternatives are lower supported limits or retaining duplicate checks
with further optimization. Full-history/node work is still incomplete.

Later 2026-09-11 creation-limit checkpoint: 25 DAO lifecycle tests pass. Added
failed-round creation, expanded dependency-group acceptance, distinct-outpoint
duplicate canonical dependency rejection and multiple matching DAO input
rejection. Combined 32-entry/32-prize/256-shard cases pass for MMR, SMT and IMT.
These use one participant owner and modest frozen trees; they do not establish
maximum sparse proof lengths or 64 distinct initial liabilities.

The tests exposed native DAO rejection of large input witnesses (error -12)
and excessive repeated config validation. The transport now also supports
`00 || witness_index[u32 LE]` in DAO WitnessArgs.output_type, referencing the
raw version1 payload at an absolute extra witness index >= input count. Inline
version1 remains supported for small payloads. Loading rejects missing, invalid
or oversized references before proof processing; native input_type is unchanged.
This implementation adjustment is required for the large IMT evidence case.

Private validated ledger states now check stored config commitments without
encode/redecode; batch decoding hashes/validates cfg once while preserving all
per-ledger structural checks. Bounded review approved transport and optimization.
See `docs/benchmarks/2026-09-11-entitlement-creation.md`. Full history and real
node validation remain mandatory and have not been executed.

2026-09-11 checkpoint: both contracts invoke the shared validator. Bounded
Rust/security review approved creation enforcement; 18 native DAO lifecycle
tests and standalone forged-creation rejection pass. Historical receipt and
entropy cells are still seeded in these fixtures. Missing/wrong dependencies,
each funding field, malformed witnesses and absolute DAO witness indexing are
covered. Dedicated duplicate-dependency/expanded-group/multiple-DAO cases,
integrated failed-round cases and maximum creation heap remain open.

Payout accounting now decrements funding by owed principal plus prize only,
accepting sponsor-funded output occupancy/excess without repayment or funding
top-ups. The 64-liability final-tail regression exposed monotonic-heap exhaustion;
allocation-free lock-hash scanning fixes it. Sixteen payout tests pass, including
32 small-prize sponsored outputs and a synthetic 64-liability final drain.
See `docs/benchmarks/2026-09-11-settlement-tail.md`. This is not maximum-size
initial-entitlement validation or a genuine full-chain fixture.

Correct payout owed/base conservation for sponsor gifts, then measure 32-entry/32-prize and atomic final-tail costs across supported accumulators. Preserve refund liveness at every state. Full-node maturity/reorg work follows with digest-pinned isolated devnet, native boundary rejection/acceptance, orphaned dependencies and canonical keeper rebuilding. These are mandatory remaining tasks, not satisfied by the codec or creation validator alone.
