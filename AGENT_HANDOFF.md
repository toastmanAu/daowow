# DAOWOW Coding Agent Handoff

## Objective

Build a testnet-first reference implementation of DAOWOW, a non-custodial prize-linked Nervos DAO protocol.

Participants buy fixed-price positional tickets by locking CKB into DAOWOW Entry Cells. After the entry window closes, entries are aggregated in bounded batches directly into native Nervos DAO deposit cells. Once the configured DAO term completes, the deposits are withdrawn, participant principal is returned, and only the realised DAO compensation—after explicitly authorised costs—is distributed according to a deterministic positional draw.

## Canonical architecture

**Method B:** sharded entry collection → frozen entry universe → batched native DAO deposits → immutable draw entropy → native DAO withdrawal → sharded direct settlement.

The Round operator is a transaction coordinator, not a custodian.

## Primary security properties

1. Participant principal cannot become prize money.
2. No privileged operator key can redirect pooled principal.
3. Entry/ticket ownership becomes immutable before draw entropy is available.
4. Draw results are reproducible from public chain data.
5. Any protocol progression that can safely be permissionless should be permissionless.
6. Pre-DAO failure must provide a participant refund path.
7. Every Shannon leaving the Round is accounted for.
8. The protocol can progress in bounded transaction batches.

## Recommended repository implementation stack

### On-chain

- Rust
- `ckb-std`
- Molecule serialization where structured binary data is required
- `ckb-testtool` for script tests

### Off-chain

- TypeScript
- CCC as the primary CKB SDK / transaction composition layer
- CKB RPC / indexer access through an abstraction layer

### Testing

- Rust unit tests
- `ckb-testtool` integration tests
- property-based tests for accounting and draw code
- deterministic cross-language vectors shared between Rust and TypeScript
- local CKB integration tests
- CKB testnet end-to-end tests

## Suggested monorepo

```text
apps/
  web/                    later
  explorer/               later

crates/
  daowow-core/            pure deterministic protocol logic
  daowow-molecule/        generated schemas / shared encoding
  daowow-indexer/         optional Rust indexer components

contracts/
  round-type/
  entry-shard-type/
  entry-lock/
  dao-lock/
  batch-type/
  reveal-type/
  settlement-type/

packages/
  sdk/                    TypeScript DAOWOW SDK
  coordinator/            tx builders
  keeper/                 permissionless transition runner
  verifier/               independent round verifier

schemas/
  daowow.mol

tests/
  vectors/
  integration/
  adversarial/

docs/
```

## Implementation order

1. Pure protocol math and canonical encoding.
2. Round config and EntryShard prototype.
3. Accumulator benchmark and selection.
4. Entry/refund lock semantics.
5. Atomic Entry → native DAO aggregation.
6. Native DAO phase-one and phase-two under DAOWOW lock.
7. Entropy/draw implementation with deterministic vectors.
8. Finalised batch accounting.
9. Settlement shard and direct payout batching.
10. Keeper/coordinator tooling.
11. Independent verifier.
12. Testnet deployment.
13. UI only after the underlying flows are stable.

## Stop conditions

Stop and update the protocol design if any of these occur:

- complete Entry-set inclusion cannot be proven cheaply enough;
- DAO lock composition requires privileged signing;
- settlement requires a single contended cell at realistic scale;
- occupied-capacity overhead materially breaks principal-return UX;
- block-derived randomness cannot meet the threat model;
- transaction cycle/size limits make current batching assumptions unsafe.

Do not hide these findings behind frontend abstractions.
