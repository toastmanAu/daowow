# DAOWOW Architecture

## Cell graph

```text
RoundConfigCell (immutable)
       |
       +-- EntryShardCell 0 -- EntryCells...
       +-- EntryShardCell 1 -- EntryCells...
       +-- ...
       +-- EntryShardCell N -- EntryCells...

Freeze all shards
       |
       v
Frozen entry commitments
       |
       v
Atomic Entry -> DAO aggregation batches
       |
       +-- DAODeposit batch 0
       +-- DAODeposit batch 1
       +-- ...
       |
       v
Entropy + positional draw
       |
       v
DAO phase 1 -> DAO phase 2
       |
       v
Finalised batch funding
       |
       v
Settlement shards
       |
       v
ordinary participant CKB payout cells
```

## Why Method B

Method B gives DAOWOW bounded DAO cell counts, more coherent deposit timing, simpler compensation accounting and scalable withdrawals. It does introduce a pre-DAO collection phase, which is why EntryLock refund paths and non-custodial transition restrictions are mandatory.

## Why immutable RoundConfig

One global mutable Round cell would serialize all normal operations. RoundConfig is therefore a static reference; live state is derived from the existence and state of shard, batch, DAO and settlement cells.

## Why EntryShardCells

CKB scripts validate the current transaction rather than searching arbitrary global chain history. Independent EntryCells alone cannot prove that a coordinator's final Entry root contains every eligible entry. Shard accumulators create a finite set of on-chain heads whose frozen commitments define the Entry universe.

## Why direct payouts

Claim contracts introduce claim-state tracking, double-claim logic, extra participant transactions and potential contention. V1 should prefer bounded settlement transactions that directly create ordinary participant-owned CKB cells.

## Script composition

Native DAO type script handles DAO rules. DAOWOWDAOLock handles DAOWOW custody and destination rules. Never expect the DAO type itself to protect Round-specific ownership constraints.
