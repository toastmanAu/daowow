# ADR-0001: EntryShard accumulator — MMR selected for the prototype

Status: accepted (prototype v0.2 sprint)
Date: 2026-09-05

## Context

EntryShardCells must commit to every accepted Entry and support two on-chain
operations: (1) authorizing an append transition (old accumulator state + new
entries -> new accumulator state) during entry collection, and (2) verifying
membership of an aggregated Entry against the frozen commitment during DAO
aggregation (threat T-03: coordinator omitting eligible entries).

Three candidates were implemented in `daowow-core` and measured on CKB-VM via
`contracts/accumulator-bench` + ckb-testtool (numbers in
`tests/vectors/accumulator_bench.json`, regeneration command in
`toolchain.lock.md`):

- **SMT** — CKB sparse Merkle tree (vendored nervosnetwork/sparse-merkle-tree
  0.6.1 with a pure-Rust CKB-blake2b hasher). Keys are 32-byte big-endian
  entry nonces; the universe is dense (0..entry_count).
- **MMR** — Merkle Mountain Range with an explicit peak list; the bagged root
  is H(0x02 || peak_count || peaks...).
- **IMT** — fixed-depth (32) incremental Merkle tree with frontier branch.

## Measured (CKB-VM cycles, ckb-testtool; see bench JSON for full table)

| acc | append @n=0 | append @n=4095 | witness @4095 | mem/op @4095 | mem proof @4095 |
|---|---|---|---|---|---|
| SMT | 833,357 | 1,112,176 | 1,074 B | 602,231 | 467 B |
| MMR | 74,983 | 184,588 | 534 B | 107,912 | 419 B |
| IMT | 8,024,178 | 8,117,106 | 1,132 B | 249,094 | 1,024 B |

(All runs include ~50–70K cycles of script startup; deltas are meaningful,
absolute overhead is not.)

## Decision

**MMR is selected for DAOWOW prototype v0.2.**

Rationale:

1. **Append authorization is native and sound.** The witness carries the old
   peak list; the contract checks `bag(old_peaks) == old_root`, derives the
   new peaks deterministically, and requires equality with the output peak
   list and the new root. No history rewriting is possible without breaking
   the hash chain to the committed old root. The SMT needed an "insert
   certificate" (absence proof under the old root + inclusion proof under the
   new root + per-height sibling-equality comparison) which is 11x more
   expensive on-chain.
2. **Cheapest appends and membership at every measured size** (5–10x vs SMT,
   3–4x vs IMT for appends).
3. **Costs grow logarithmically** (append 75K -> 185K from n=0 to 4095; SMT
   and IMT are flat-to-growing or flat-but-huge respectively).
4. **Bounded state**: the peak list (<= 64 peaks for 2^64 leaves) is derivable
   and small; shard cell data stays fixed-size.

Rejected alternatives:

- **SMT**: excellent membership properties and an audited implementation, but
  the append certificate is complex and expensive on CKB-VM. Keep the vendored
  verifier for possible future use (e.g., settlement liabilities root, where
  updates are batched off-chain and only membership is proven on-chain — note
  the settlement contract currently uses the SMT for liability proofs; see
  "Consequences").
- **IMT**: constant 1,024 B proofs and frontier witness are simple, but the
  fixed 32-level cost (8M cycles per append) makes entry collection
  prohibitively expensive at scale.

## Consequences

- `EntryShardDataV1.accumulator_root` = bagged MMR root; the append witness
  carries the old and new peak lists (`daowow_core::accumulator::mmr`).
- The aggregation path verifies MMR membership proofs
  (`mmr::verify_membership(root, count, pos, leaf, proof)`).
- The settlement liabilities root still uses the SMT (dense participant-key
  membership, updates happen once at funding creation). Unifying both onto
  MMR membership is a possible simplification for v0.3; the funding cell never
  mutates its liabilities root after creation, so the SMT's weak spot
  (append authorization) is not exercised there.
- The SMT insert-certificate construction (absence + inclusion + sibling
  equality) is believed sound and is documented in
  `crates/daowow-core/src/accumulator/smt.rs`; it remains available if dense
  keyed sets are ever needed mutably on-chain.

## Spec deltas required by this decision

1. `schemas/daowow.mol` `EntryShardDataV1` — unchanged shape, but the
   `accumulator_root` semantic is fixed to the MMR bagged root, and `state`
   (OPEN/FROZEN, 1 byte) is added to the canonical encoding.
2. `EntryDataV1` — `position_base` (u64) added so ticket ranges are
   self-evidencing from the entry alone (protocol v0.2 §4 requires contiguous
   positions; without this field the position of an entry is not provable
   on-chain without replaying shard history).
3. Shard `sequence` advances by the number of entries created in the
   transaction (v0.2 said "exactly one"), enabling bounded batched entry
   collection; the batch bound becomes a keeper policy parameter.
