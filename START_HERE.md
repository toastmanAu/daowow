# DAOWOW — Coding Agent START HERE

DAOWOW is a Nervos CKB protocol that pools participant CKB into the native Nervos DAO, preserves each participant's principal liability, and raffles only the realised DAO compensation between positional ticket holders.

**Core rule:** Pool the principal. Raffle the yield.

## Your first mission

Do **not** begin by building a UI or by writing all contracts at once. First prove the CKB mechanics and data-structure assumptions that could invalidate the protocol.

### Phase 0 — environment and source-of-truth setup

1. Read `AGENT_HANDOFF.md`.
2. Read `docs/protocol-v0.2.md` and `docs/architecture.md`.
3. Read `reference/RFC-0023-dao-deposit-withdraw.md` completely.
4. Inspect the current Nervos `ckb-system-scripts` DAO implementation before writing withdrawal code.
5. Use Rust + `ckb-std` for on-chain scripts and `ckb-testtool` for script tests unless strong evidence supports a better current stack.
6. Use CCC for TypeScript transaction construction / wallet integration. Before generating CCC code, install/read the CCC Agent Skills and its current machine-readable docs. Do not invent CCC APIs.
7. Create a local CKB dev/test environment and record all exact tool versions in `toolchain.lock.md`.

### Phase 1 — prove these four things first

Build isolated prototypes for:

1. **Entry shard contention and accumulator:** one mutable shard cell accepts entries and updates a deterministic commitment.
2. **Entry membership proof:** prove an accepted Entry belongs to a frozen shard commitment using the candidate accumulator structure.
3. **DAO custody transition:** custom DAOWOW lock + native DAO type can atomically deposit, phase-one withdraw, and phase-two withdraw without a privileged key.
4. **Direct batched settlement:** a settlement funding cell can produce participant-owned ordinary CKB outputs while preserving exact accounting.

No other major implementation should proceed until these are demonstrated by executable tests.

## Critical unknown

The hardest unresolved problem is proving the complete accepted Entry universe on-chain without requiring a global chain scan. The current preferred solution is a fixed set of mutable EntryShardCells whose accumulators commit to every accepted Entry. Compare Sparse Merkle Tree, Merkle Mountain Range, and incremental Merkle tree approaches empirically on CKB-VM.

## Mandatory rules for the coding agent

- Treat CKB as a cell/UTXO model. Do not import EVM mental models.
- Never add an operator key that can redirect participant principal.
- Never trust an off-chain Merkle root without an on-chain verification path.
- Never let draw entropy become knowable before the accepted ticket set is immutable.
- Never assume all entries, DAO deposits, withdrawals, or payouts fit in one transaction.
- Never approximate DAO compensation in consensus-critical code; follow native DAO rules.
- Never silently deduct occupied-capacity overhead from principal; surface it explicitly.
- Use integers / shannons throughout accounting.
- Every protocol transition requires positive and adversarial tests.

## Deliverable from the first implementation sprint

Produce a `prototype-report.md` containing:

- measured cycles and transaction sizes for each prototype;
- occupied capacity per cell type;
- chosen accumulator primitive and why;
- measured membership proof cost;
- max practical entries per aggregation transaction;
- max tested DAO cells per withdrawal transaction;
- direct payout outputs per settlement batch;
- any protocol-spec change required by empirical results.

If a protocol assumption fails, change the spec before trying to code around it.
