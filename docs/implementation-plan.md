# Implementation Plan

## Milestone 0 — toolchain and reproducibility

Deliver:
- pinned Rust toolchain;
- current ckb-std / ckb-testtool versions;
- CCC setup and agent skills installed;
- local node/dev chain instructions;
- CI capable of compiling scripts and running tests;
- `toolchain.lock.md`.

Exit: clean clone can run all baseline tests.

## Milestone 1 — deterministic core library

Implement pure logic for:
- Round IDs / domains;
- canonical integer encoding;
- ticket positioning;
- prize schedule validation;
- rejection sampling;
- accounting/conservation;
- settlement sharding.

Generate shared test vectors.

Exit: Rust and TypeScript produce identical vectors.

## Milestone 2 — EntryShard prototype

Implement one RoundConfig + one/many EntryShard scripts and Entry Cell creation.

Benchmark:
- tx size;
- cycles;
- occupied capacity;
- contention/retry behaviour.

Exit: parallel entries across multiple shards pass integration tests.

## Milestone 3 — accumulator bakeoff

Prototype at least:
- SMT;
- MMR;
- incremental binary Merkle tree.

Measure append/update proof and membership verification in CKB-VM.

Select based on proof correctness, cycle cost, proof size, implementation complexity and auditability.

Exit: written ADR documenting choice.

## Milestone 4 — Entry lifecycle + refunds

Implement:
- entry validation;
- shard freeze;
- aggregation deadline;
- refund path;
- deterministic cap behaviour if cap retained.

Exit: adversarial tests prove Entry cannot both refund and aggregate.

## Milestone 5 — native DAO integration

Implement DAOWOWDAOLock and builders for:
- native DAO deposit;
- phase-one withdrawal;
- phase-two withdrawal.

Use official DAO RFC + current system script as source of truth.

Exit: local/testtool transaction suite demonstrates full lifecycle without operator key.

## Milestone 6 — batch accounting

Implement BatchCommitment / FinalizedBatch data and exact principal + realised-yield accounting.

Exit: multiple deposits included at different blocks/epochs settle correctly.

## Milestone 7 — entropy and draw

Implement candidate commit/reveal + predetermined block entropy only after threat-model review.

Add deterministic vectors and reorg-handling policy.

Exit: independent verifier reproduces final seed and winners.

## Milestone 8 — settlement shards

Implement direct batched payouts.

Exit: multiple settlement shards process concurrently; conservation property holds; participant receives ordinary CKB output.

## Milestone 9 — keeper/coordinator SDK

Build TypeScript tooling using CCC for:
- round creation;
- entry;
- shard retry;
- freeze;
- aggregation;
- DAO progression;
- settlement;
- verifier/export.

Exit: fully automated local Round with at least 20 simulated participants.

## Milestone 10 — testnet E2E

Deploy scripts to CKB testnet and run real Round(s).

Exit: publish tx hashes, full verifier output, measured costs/cycles, and protocol deltas.

## Milestone 11 — UI

Only after protocol flows are stable. Build mobile-first web UI / explorer and wallet connection through CCC.
