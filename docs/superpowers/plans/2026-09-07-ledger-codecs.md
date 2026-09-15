# Ledger Codecs Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the approved shard ledger canonical, validated wire encodings and batch identities ready for contract integration.

**Architecture:** Extend the existing pure `AggregationState`, preserving its membership-checked accepted-prefix transition. Add canonical receipt and witness codecs. This is the first independently testable implementation unit; it does not connect spending scripts.

**Tech Stack:** Rust 1.98.1, existing no_std/alloc core, offline locked Cargo dependencies.

**Spec:** `docs/superpowers/specs/2026-09-07-shard-aggregation-ledger-design.md` (user approved).

**2026-09-08 checkpoint:** Tasks 1–3 are implemented in lifecycle.rs and
witness.rs, with tests-first missing-feature failures and subsequent passing
tests/default/no_std Clippy. Bounded semantic review found no concrete codec
issue. The shard-origin finding is repaired and reviewed; settlement ordering
is now repaired using immutable indexed MMR liabilities after rejecting the
compressed-SMT deletion proposal. Initial entitlement authentication remains
open. The downstream
contract plan remains unwritten, so this whole roadmap is not complete.

## Global Constraints

- No deployment, wallet operation or historical manifest replacement is part of this work.
- Entry funds cannot pay these costs.
- No caller may construct trusted state by accepting arbitrary witness bytes.
- Receipt reclamation requires a separately reviewed successor rule, not a bypass.
- No new dependencies. Preserve all existing dirty work.
- This plan covers codecs and core transitions only. On-chain implementation must wait for the outstanding independent semantic review.
- The workspace's `.git` is read-only: leave reviewed changes uncommitted; do not attempt to bypass that restriction.

## Delivery order and ownership

Review checkpoint: bounded semantic review permits this core-codec unit to
proceed, but does not clear the whole on-chain prerequisite. An unresolved
settlement cursor-skipping/griefing finding is recorded in
`docs/security-progress.md`; downstream settlement needs authenticated
contiguous progression, not just increasing membership-proven payout keys.
The review also found an untyped-config bypass of complete shard creation.
Before wiring the ledger, authenticate round-type execution or independently
enforce creation of all canonical shards. This corrects an implementation
assumption beneath the approved uniqueness requirement; codecs alone do not
repair it.

1. This plan: core codecs, batch IDs and witness format.
2. A separate contract plan: canonical public shard lock, ledger transitions,
   shared atomic-batch validation, receipt creation and terminal-state refunds.
3. A separate compatibility/integration plan: DAO receipt provenance,
   digest-bound settlement args, builders, adversarial VM tests, cycle and
   node checks. Steps 2 and 3 must land together before claiming a usable path.

The second and third plans are not represented as complete here. Their exact
interfaces depend on the semantic review and the tested core interfaces below.
No core test count will be used to mark the on-chain security gate complete.

## Task 1: Batch IDs and receipt codec

**Files:** modify `crates/daowow-core/src/lifecycle.rs`; tests in its existing
`tests` module. No contract files change.

**Interfaces produced:**

```rust
pub const BATCH_RECEIPT_SIZE: usize = 73;
pub fn batch_id(shard_id: u32, ordinal: u64) -> Result<u64, CoreError>;
impl BatchCommitment {
    pub fn encode(&self) -> [u8; BATCH_RECEIPT_SIZE];
    pub fn decode(data: &[u8]) -> Result<Self, CoreError>;
}
```

- [ ] Add failing boundary and receipt tests:

```rust
#[test]
fn batch_ids_are_disjoint_and_checked() {
    assert_eq!(batch_id(0, 0), Ok(0));
    assert_eq!(batch_id(1, 0), Ok(1u64 << 56));
    assert_eq!(batch_id(255, (1u64 << 56) - 1), Ok(u64::MAX));
    assert!(batch_id(256, 0).is_err());
    assert!(batch_id(0, 1u64 << 56).is_err());
}

#[test]
fn receipt_wire_is_exact() {
    let batch = BatchCommitment {
        digest: [9; 32], first_nonce: 0, entry_count: 2,
        ticket_count: 4, principal: 400, input_capacity: 500,
    };
    let wire = batch.encode();
    assert_eq!(wire.len(), 73);
    assert_eq!(wire[0], 2);
    assert_eq!(&wire[1..33], &[9; 32]);
    assert_eq!(BatchCommitment::decode(&wire), Ok(batch));
    for end in 0..wire.len() {
        assert!(BatchCommitment::decode(&wire[..end]).is_err());
    }
    let mut extra = wire.to_vec();
    extra.push(0);
    assert!(BatchCommitment::decode(&extra).is_err());
    let mut version = wire;
    version[0] = 1;
    assert!(BatchCommitment::decode(&version).is_err());
}
```

- [ ] Run `cargo test --offline --locked -p daowow-core --lib lifecycle::`;
  confirm the new tests fail because the interfaces are absent.
- [ ] Implement checked ID construction:

```rust
pub fn batch_id(shard_id: u32, ordinal: u64) -> Result<u64, CoreError> {
    if shard_id >= 256 || ordinal >= (1u64 << 56) {
        return Err(CoreError::Overflow);
    }
    Ok((u64::from(shard_id) << 56) | ordinal)
}
```

Receipt encoding places the version at 0, digest at 1..33 and five LE u64s
at 33, 41, 49, 57 and 65, respectively. Decode checks length and version
before indexing. Use `u64::from_le_bytes`; no platform-size wire fields.
Decode is structural, not authentication: receipt creation must still compare
every field with the computed batch. Document this on the public function.

- [ ] Run the lifecycle tests and both core Clippy variants. Review the diff
  for accidental changes to `DAOWOW_ENTRY_BATCH_V2` hashing. Leave uncommitted.

## Task 2: Canonical ledger codec and batch count

**Files:** modify `crates/daowow-core/src/lifecycle.rs` only.

**Consumes:** Task 1 `batch_id` and existing `AggregationState::{new,accept,close}`.
**Produces:** private `accepted_batches: u64` plus these methods:

```rust
pub const AGGREGATION_STATE_SIZE: usize = 207;
impl AggregationState {
    pub fn encode(&self) -> [u8; AGGREGATION_STATE_SIZE];
    pub fn decode(data: &[u8], cfg: &RoundConfigV1) -> Result<Self, CoreError>;
    pub fn frozen(&self) -> &EntryShardDataV1;
    pub fn accepted_batches(&self) -> u64;
    pub fn is_closed(&self) -> bool;
    pub fn next_batch_id(&self) -> Result<u64, CoreError>;
}
```

- [ ] Add these tests inside the existing module, using its existing
  `fixture() -> (RoundConfigV1, EntryShardDataV1, Vec<EntryDataV1>, MmrHost)`:

```rust
#[test]
fn ledger_codec_rejects_noncanonical_state() {
    let (cfg, frozen, _, _) = fixture();
    let state = AggregationState::new(&cfg, &frozen).unwrap();
    let wire = state.encode();
    assert_eq!(wire.len(), 207);
    assert_eq!(AggregationState::decode(&wire, &cfg), Ok(state));
    for end in 0..207 {
        assert!(AggregationState::decode(&wire[..end], &cfg).is_err());
    }
    for (offset, value) in [(0, 1), (102, 255), (206, 2)] {
        let mut bad = wire;
        bad[offset] = value;
        assert!(AggregationState::decode(&bad, &cfg).is_err());
    }
    let mut bad_count = wire;
    bad_count[166..174].copy_from_slice(&1u64.to_le_bytes());
    assert!(AggregationState::decode(&bad_count, &cfg).is_err());
}
```

Extend the existing successful-accept tests with exact batch-count increments,
`next_batch_id`, post-accept encode/decode equality and closed-state equality.
Add same-config mutated frozen metadata and accepted-principal/capacity
inconsistency rejection cases by modifying their exact wire fields.

- [ ] Run the lifecycle tests; confirm absent codec/accessor errors.
- [ ] Implement encoding with these exclusive-end ranges:

```text
0       version = 2
1..102  frozen.encode()
102..134 config commitment
134..142 accepted entries
142..150 accepted tickets
150..158 accepted principal
158..166 accepted capacity
166..174 accepted batches
174..206 batches root
206     closed flag
```

Decode reconstructs the frozen state with `EntryShardDataV1::decode` and
validates it through `AggregationState::new(cfg, &frozen)`. Verify the stored
config commitment equals that initial state's commitment. Enforce:

```text
accepted_entries <= frozen.entry_count
accepted_tickets <= frozen.ticket_count
accepted_tickets >= accepted_entries
accepted_principal == checked(accepted_tickets * cfg.ticket_price)
accepted_capacity >= accepted_principal
accepted_entries == 0 iff accepted_tickets == 0
accepted_entries == 0 iff accepted_batches == 0
accepted_batches <= accepted_entries
accepted_entries <= checked(accepted_batches * MAX_BATCH_ENTRIES)
accepted_batches <= 2^56
```

For zero acceptance also require zero capacity and the initial empty batch
root. A nonempty root cannot be authenticated from its byte value: document
that contract callers must load the state from a canonical typed cell.
Use u128 for the batch-size bound, avoiding overflow of an otherwise valid
comparison. Structural decoding cannot establish elapsed closure time.

Initialize batch count to zero in `new`. In `accept`, validate the prior
ordinal with `batch_id`, increment `next.accepted_batches` with checked add
once per successful batch, never per entry, and retain rollback semantics.
The final valid ordinal 2^56-1 may produce count 2^56; further accepts fail.

- [ ] Run all core unit tests and strict default/no_std Clippy. Check the
  immutable frozen state and hash domains have not changed. Leave uncommitted.

## Task 3: Canonical indexed aggregation witness

**Files:** modify `crates/daowow-core/src/witness.rs`; tests in its existing module.

**Interfaces produced:**

```rust
#[derive(Debug, PartialEq, Eq)]
pub struct LedgerInputProof<'a> {
    pub input_index: u32,
    pub proof: &'a [u8],
}
pub fn encode_ledger_witness(inputs: &[LedgerInputProof<'_>])
    -> Result<Vec<u8>, CoreError>;
pub fn decode_ledger_witness(data: &[u8])
    -> Result<Vec<LedgerInputProof<'_>>, CoreError>;
```

- [ ] Add failing tests:

```rust
#[test]
fn ledger_witness_binds_distinct_absolute_indices() {
    let records = [
        LedgerInputProof { input_index: 3, proof: b"proof-a" },
        LedgerInputProof { input_index: 1, proof: b"proof-b" },
    ];
    let wire = encode_ledger_witness(&records).unwrap();
    assert_eq!(decode_ledger_witness(&wire).unwrap(), records);
    let duplicate = [
        LedgerInputProof { input_index: 3, proof: b"a" },
        LedgerInputProof { input_index: 3, proof: b"b" },
    ];
    assert!(encode_ledger_witness(&duplicate).is_err());
    assert!(encode_ledger_witness(&[]).is_err());
    for end in 0..wire.len() {
        assert!(decode_ledger_witness(&wire[..end]).is_err());
    }
    let mut trailing = wire;
    trailing.push(0);
    assert!(decode_ledger_witness(&trailing).is_err());
}
```

Add hand-written duplicate-index wire rejection; zero/33/u32::MAX count;
declared proof length larger than remaining data; unknown version; and a
32-record round trip. Input indices need not be numerically sorted: nonce
order is checked against actual entry cells by contracts, not this codec.

- [ ] Run `cargo test --offline --locked -p daowow-core --lib witness::`;
  confirm the new symbols are missing before implementing them.
- [ ] Implement the format `02 || count[u32] || records`, each record
  `input_index[u32] || proof_length[u32] || proof`. Validate count before
  allocating the result. Use checked offsets and slice `get` before every
  read; reject duplicate indices with at most 32-record linear comparisons.
  Encoder uses `u32::try_from(proof.len())`; decoder must consume all bytes.
  Empty proof bytes remain structurally legal because validity is specific
  to the selected accumulator. Preserve the existing aggregation witness
  codec for refund membership proofs; do not silently reinterpret its bytes.
- [ ] Run all core tests, default/no_std Clippy and formatting checks.
  Review the diff; leave uncommitted.

## Completion evidence and next handoff

- [ ] Record actual command results, not historical test counts:

```sh
cargo test --offline --locked -p daowow-core --lib
cargo clippy --offline --locked -p daowow-core -- -D warnings
cargo clippy --offline --locked -p daowow-core --no-default-features -- -D warnings
cargo fmt --all -- --check
git diff --check
```

- [ ] Request read-only Rust semantic review of these three tasks and resolve
  important findings before consuming the new interfaces in contracts.
- [ ] Update `docs/security-progress.md` with the codec checkpoint explicitly
  marked core-only. Keep on-chain lifecycle, draw and settlement-authentication
  gates open.
- [ ] Write the contract plan using the tested interfaces above and the
  prerequisite review findings. That plan must cover all approved transaction
  rules; this document deliberately does not claim to implement them.

## Self-review coverage

This unit covers the specification's 207-byte state, 73-byte receipt, batch
ID bounds and indexed witness. Canonical type authority, public locks,
capacity routing, receipt creation, refund authentication and DAO provenance
are excluded from this unit and remain explicitly assigned to downstream
contract work. No speculative contract helper API is required by these tasks.
