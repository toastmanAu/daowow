# Ticket-Indexed Prizes and Redemption Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A batch's prizes are committed per winning ticket, and the holder of a winning claim cell redeems each batch's prize once, into their own lock, by one transaction that updates claim and funding cell together.

**Architecture:** Phase 2a moves prize crediting from participant hashes to ticket ids inside `InitialEntitlements::derive`, commits them as an MMR in a 160-byte `SettlementFundingDataV3`, and drops winner ownership proofs from the phase-two witness. Phase 2b adds a redemption witness, a redemption mode to `settlement-type` (amount, membership, payee, successor, conservation) and to the claim mode of `entry-shard-type` (paid-set insert, lock unchanged), plus VM and devnet proofs.

**Tech Stack:** no_std Rust core, ckb-std 1.1.0 contracts, ckb-testtool 1.1.1, Python devnet harness, `gen_vectors` for JSON/JS vectors.

**Spec:** `docs/superpowers/specs/2026-09-16-prize-redemption-design.md`

## Global Constraints

- `prize_leaf(ticket, amount) = H("DAOWOW_PRIZE_LEAF_V1" ‖ ticket ‖ amount_u64_le)`; `prize_source(commitment, batch_id, digest) = H("DAOWOW_PRIZE_SOURCE_V1" ‖ commitment ‖ batch_id_u64_le ‖ digest)`.
- `SettlementFundingDataV3` is exactly 160 bytes: V2's 112 bytes, then `prize_count` u64 LE, `prize_root` 32, `prize_paid` u64 LE. It replaces V2 everywhere; the name `SettlementFundingDataV2` no longer exists after Task 2.
- Decode rejects `prize_paid > prize_pool`, `(prize_count == 0) != (prize_root == [0; 32])`, and `prize_count == 0 && prize_paid != 0`.
- Redemption witness: `0xFF ‖ u32 n (1..=32) ‖ n × { claim_input_index u32, payment_output_index u32, prize_index u64, amount u64, u32 mmr_len ‖ mmr, u32 absence_len ‖ absence }`, each proof at most `MAX_PROOF_BYTES` (8192), strict, no trailing bytes.
- A funding cell is final only when `payout_cursor == liability_count` and (`prize_count == 0` or `prize_paid == prize_pool`), on both payout and redemption paths.
- Error codes: `CLAIM_ERROR_REDEEM -97`, `SETTLE_ERROR_REDEEM -77`.
- `EntitlementWitness` wire version byte becomes 2 and has no winners section. `WinnerProof` and `ComputedDraw::verify_winners` are removed.
- Rebuild contracts with `cargo build --target riscv64imac-unknown-none-elf --release -p <name>` per contract before integration tests. Commit after each task with the `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>` trailer.

---

## File map

| File | Responsibility |
| --- | --- |
| `crates/daowow-core/src/leaf.rs` | `prize_leaf` |
| `crates/daowow-core/src/redemption.rs` | `prize_source` (next to the paid-set primitives) |
| `crates/daowow-core/src/error.rs` | two new codes |
| `crates/daowow-core/src/encoding.rs` | `SettlementFundingDataV3` |
| `crates/daowow-core/src/computed_draw.rs` | `locate`; winners removed |
| `crates/daowow-core/src/entitlement_witness.rs` | version 2 wire |
| `crates/daowow-core/src/entitlements.rs` (+ `entitlements/tests.rs`) | prize domain in `derive`, `PrizeEntitlement`, `prizes()` |
| `crates/daowow-core/src/witness.rs` | redemption witness codec |
| `crates/daowow-core/tests/gen_vectors.rs`, `tests/vectors/daowow_core_vectors.json`, `apps/web/vectors.js` | regenerated |
| `crates/daowow-contracts-common/src/entitlements.rs` | no winners |
| `contracts/settlement-type/src/main.rs` | redemption mode, final completeness |
| `contracts/entry-shard-type/src/claim.rs` | redemption mode |
| `tests/integration/tests/common/mod.rs` | `redemption_witness`, `seed_claim` |
| `tests/integration/tests/{proto3_dao_lifecycle,proto4_settlement,security_entitlements}.rs` | V3, no winners, end-to-end redeem |
| `tests/integration/tests/claim_redemption.rs`, `security_redemption.rs` (new) | VM suites |
| `tests/integration/examples/devnet_round.rs`, `tests/devnet/test_round_creation.py` | principal-only payout, claim redemption, final drain |

---

## Phase 2a

### Task 1: Prize leaf, source identity, error codes

**Files:**
- Modify: `crates/daowow-core/src/leaf.rs`, `crates/daowow-core/src/redemption.rs`, `crates/daowow-core/src/redemption/tests.rs`, `crates/daowow-core/src/error.rs`

**Interfaces:**
- Produces: `leaf::prize_leaf(ticket: &Hash32, amount: u64) -> Hash32`; `redemption::prize_source(commitment: &Hash32, batch_id: u64, digest: &Hash32) -> Hash32`; `codes::CLAIM_ERROR_REDEEM = -97`, `codes::SETTLE_ERROR_REDEEM = -77`.

- [x] **Step 1: Failing tests**

Append to `crates/daowow-core/src/leaf.rs` tests module (it has `#[cfg(test)] mod tests`; add inside):

```rust
    #[test]
    fn prize_leaf_binds_domain_ticket_and_amount() {
        let mut message = b"DAOWOW_PRIZE_LEAF_V1".to_vec();
        message.extend_from_slice(&[5; 32]);
        message.extend_from_slice(&7u64.to_le_bytes());
        assert_eq!(prize_leaf(&[5; 32], 7), ckb_hash256_one(&message));
        assert_ne!(prize_leaf(&[5; 32], 7), prize_leaf(&[5; 32], 8));
        assert_ne!(prize_leaf(&[5; 32], 7), prize_leaf(&[6; 32], 7));
        assert_ne!(prize_leaf(&[5; 32], 7), liability_leaf(&[5; 32], 0, 7));
    }
```

(`ckb_hash256_one` is `crate::hash::ckb_hash256_one`; import it in the test module.)

Append to `crates/daowow-core/src/redemption/tests.rs`:

```rust
#[test]
fn prize_source_is_a_logical_batch_identity() {
    let mut message = b"DAOWOW_PRIZE_SOURCE_V1".to_vec();
    message.extend_from_slice(&[1; 32]);
    message.extend_from_slice(&(1u64 << 56 | 3).to_le_bytes());
    message.extend_from_slice(&[2; 32]);
    let source = prize_source(&[1; 32], 1u64 << 56 | 3, &[2; 32]);
    assert_eq!(source, crate::hash::ckb_hash256_one(&message));
    assert_ne!(source, prize_source(&[1; 32], 3, &[2; 32]));
    assert_ne!(source, prize_source(&[1; 32], 1u64 << 56 | 3, &[3; 32]));
    assert_ne!(source, prize_source(&[9; 32], 1u64 << 56 | 3, &[2; 32]));
}
```

- [x] **Step 2: Run, expect `cannot find function`**

`cargo test -p daowow-core --lib leaf redemption`

- [x] **Step 3: Implement**

`leaf.rs`, after `liability_leaf`:

```rust
/// Prize obligation leaf for one winning ticket of one batch.
///
/// leaf = H("DAOWOW_PRIZE_LEAF_V1" || ticket_id || amount)
pub fn prize_leaf(ticket: &Hash32, amount: u64) -> Hash32 {
    ckb_hash256(&[b"DAOWOW_PRIZE_LEAF_V1".as_slice(), ticket, &amount.to_le_bytes()])
}
```

`redemption.rs`, before `prize_obligation_key`:

```rust
/// Canonical prize source for a batch: config commitment, batch id and batch
/// digest, exactly as carried in the settlement type's 72-byte args. Never an
/// outpoint, so funding-cell successors keep the same source.
pub fn prize_source(commitment: &Hash32, batch_id: u64, digest: &Hash32) -> Hash32 {
    ckb_hash256(&[
        b"DAOWOW_PRIZE_SOURCE_V1",
        commitment,
        &batch_id.to_le_bytes(),
        digest,
    ])
}
```

`error.rs`: add `pub const SETTLE_ERROR_REDEEM: i8 = -77;` after `SETTLE_ERROR_ROUND_MISMATCH` and `pub const CLAIM_ERROR_REDEEM: i8 = -97;` after `CLAIM_ERROR_RETIRE`.

- [x] **Step 4: Run green, fmt, clippy, commit**

```bash
cargo test -p daowow-core --lib && cargo clippy -p daowow-core --lib -- -D warnings && cargo fmt -p daowow-core -- --check
git add crates/daowow-core/src && git commit -m "feat(core): prize leaf, prize source identity, redemption error codes"
```

---

### Task 2: `SettlementFundingDataV3` replaces V2

**Files:**
- Modify: `crates/daowow-core/src/encoding.rs` (struct at lines 373-424 and its tests), `crates/daowow-core/tests/gen_vectors.rs:82-130`, `crates/daowow-core/src/entitlements.rs:5,113`, `crates/daowow-contracts-common/src/entitlements.rs`, `contracts/settlement-type/src/main.rs` (imports and two decodes), `tests/integration/tests/proto3_dao_lifecycle.rs:765`, `proto4_settlement.rs:174,251,265,384`, `security_entitlements.rs:13`, `tests/integration/examples/devnet_round.rs`, `tests/vectors/daowow_core_vectors.json`, `apps/web/vectors.js`.

**Interfaces:**
- Produces: `pub const SETTLEMENT_FUNDING_SIZE: usize = 160;` `pub struct SettlementFundingDataV3 { round_id, batch_id, realized_total, principal_liability, prize_pool, payout_cursor, liability_count, liabilities_root, prize_count: u64, prize_root: Hash32, prize_paid: u64 }` with `encode() -> [u8; 160]` and `decode(&[u8]) -> Result<Self, CoreError>`.

- [x] **Step 1: Failing codec test**

In `encoding.rs` tests module add:

```rust
    #[test]
    fn settlement_funding_v3_layout_and_consistency() {
        let base = SettlementFundingDataV3 {
            round_id: [1; 32],
            batch_id: 2,
            realized_total: 110,
            principal_liability: 100,
            prize_pool: 10,
            payout_cursor: 0,
            liability_count: 1,
            liabilities_root: [3; 32],
            prize_count: 2,
            prize_root: [4; 32],
            prize_paid: 5,
        };
        let wire = base.encode();
        assert_eq!(wire.len(), SETTLEMENT_FUNDING_SIZE);
        assert_eq!(&wire[112..120], &2u64.to_le_bytes());
        assert_eq!(&wire[120..152], &[4; 32]);
        assert_eq!(&wire[152..160], &5u64.to_le_bytes());
        assert_eq!(SettlementFundingDataV3::decode(&wire), Ok(base));
        assert!(SettlementFundingDataV3::decode(&wire[..112]).is_err());
        let mut over = wire;
        over[152..160].copy_from_slice(&11u64.to_le_bytes()); // paid > pool
        assert!(SettlementFundingDataV3::decode(&over).is_err());
        let mut zero_root = wire;
        zero_root[120..152].fill(0); // count 2 with zero root
        assert!(SettlementFundingDataV3::decode(&zero_root).is_err());
        let mut no_prizes = wire;
        no_prizes[112..120].fill(0);
        no_prizes[120..152].fill(0);
        assert!(SettlementFundingDataV3::decode(&no_prizes).is_err()); // paid 5 with no prizes
        no_prizes[152..160].fill(0);
        assert!(SettlementFundingDataV3::decode(&no_prizes).is_ok());
    }
```

- [x] **Step 2: Implement**

Replace the V2 block (`pub const SETTLEMENT_FUNDING_SIZE` through the end of `impl SettlementFundingDataV2`) with:

```rust
pub const SETTLEMENT_FUNDING_SIZE: usize = 160;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SettlementFundingDataV3 {
    pub round_id: Hash32,
    pub batch_id: u64,
    /// gross realised capacity from the DAO (principal surplus + compensation)
    pub realized_total: u64,
    /// total principal that must be returned to participants
    pub principal_liability: u64,
    /// authorised prize pool; on a successful round the sum of prize leaves
    pub prize_pool: u64,
    /// Index of the next liability to pay in the immutable tree.
    pub payout_cursor: u64,
    /// Immutable number of leaves in the liabilities tree; must be nonzero.
    pub liability_count: u64,
    /// Immutable accumulator root over liability leaves.
    pub liabilities_root: Hash32,
    /// Immutable number of prize leaves (zero on failed rounds).
    pub prize_count: u64,
    /// Immutable MMR root over `prize_leaf(ticket, amount)` sorted by ticket.
    pub prize_root: Hash32,
    /// Sum of prizes redeemed so far; never exceeds `prize_pool`.
    pub prize_paid: u64,
}

impl SettlementFundingDataV3 {
    pub fn encode(&self) -> [u8; SETTLEMENT_FUNDING_SIZE] {
        let mut out = [0u8; SETTLEMENT_FUNDING_SIZE];
        out[0..32].copy_from_slice(&self.round_id);
        write_u64(&mut out, 32, self.batch_id);
        write_u64(&mut out, 40, self.realized_total);
        write_u64(&mut out, 48, self.principal_liability);
        write_u64(&mut out, 56, self.prize_pool);
        write_u64(&mut out, 64, self.payout_cursor);
        write_u64(&mut out, 72, self.liability_count);
        out[80..112].copy_from_slice(&self.liabilities_root);
        write_u64(&mut out, 112, self.prize_count);
        out[120..152].copy_from_slice(&self.prize_root);
        write_u64(&mut out, 152, self.prize_paid);
        out
    }

    pub fn decode(data: &[u8]) -> Result<Self, CoreError> {
        if data.len() != SETTLEMENT_FUNDING_SIZE {
            return Err(CoreError::Encoding);
        }
        let payout_cursor = read_u64(data, 64);
        let liability_count = read_u64(data, 72);
        let prize_pool = read_u64(data, 56);
        let prize_count = read_u64(data, 112);
        let prize_root = read_hash(data, 120);
        let prize_paid = read_u64(data, 152);
        if liability_count == 0
            || payout_cursor > liability_count
            || prize_paid > prize_pool
            || (prize_count == 0) != (prize_root == [0; 32])
            || (prize_count == 0 && prize_paid != 0)
        {
            return Err(CoreError::Encoding);
        }
        Ok(Self {
            round_id: read_hash(data, 0),
            batch_id: read_u64(data, 32),
            realized_total: read_u64(data, 40),
            principal_liability: read_u64(data, 48),
            prize_pool,
            payout_cursor,
            liability_count,
            liabilities_root: read_hash(data, 80),
            prize_count,
            prize_root,
            prize_paid,
        })
    }
}
```

- [x] **Step 3: Rename every consumer**

`grep -rn "SettlementFundingDataV2" --include=*.rs .` and replace with `SettlementFundingDataV3`; every struct literal gains `prize_count: 0, prize_root: [0; 32], prize_paid: 0` (proto4 `setup`, `security_entitlements`, `gen_vectors`, `entitlements.rs` derive until Task 5 fills it). In `gen_vectors.rs` rename the JSON key to `"settlement_funding_v3"` and add `"prize_count"`, `"prize_root"`, `"prize_paid"` entries. Update the doc comment at the top of `contracts/settlement-type/src/main.rs` (`data: SettlementFundingDataV3 (fixed 160 bytes)`).

- [x] **Step 4: Regenerate vectors**

```bash
cargo test -p daowow-core --test gen_vectors
python3 - <<'EOF'
import json
v = json.load(open('tests/vectors/daowow_core_vectors.json'))
open('apps/web/vectors.js','w').write(
  '// generated from tests/vectors/daowow_core_vectors.json\n"use strict";\n'
  'const DAOWOW_VECTORS = ' + json.dumps(v, indent=2, sort_keys=True) + ';\n'
  'if (typeof module !== "undefined" && module.exports) module.exports = DAOWOW_VECTORS;\n'
  'if (typeof window !== "undefined") window.DAOWOW_VECTORS = DAOWOW_VECTORS;\n')
EOF
cd apps/web && npm test 2>&1 | tail -5
```

(If `gen_vectors` writes elsewhere, follow its `println!`/file path; the snippet is the one recorded in `apps/web/PROGRESS.md`.)

- [x] **Step 5: Build and run everything**

```bash
cargo test -p daowow-core --lib && cargo check -p daowow-core --no-default-features
for c in settlement-type dao-lock entry-shard-type; do cargo build --target riscv64imac-unknown-none-elf --release -p $c; done
cd tests/integration && cargo test 2>&1 | grep -E "^test result|FAILED"
```

Expected: all green (the two pre-existing `smoke` failures remain). The funding cell capacity math is unchanged; only the cell data grew by 48 bytes, so any fixture that sized a funding cell at exactly its occupied capacity must add 48 CKB (watch for `-72` conservation failures in `proto4`).

- [x] **Step 6: Commit**

```bash
git add -A crates contracts tests apps/web/vectors.js && git commit -m "feat: settlement funding v3 with prize commitment fields"
```

---

### Task 3: `ComputedDraw::locate`; remove winner verification

**Files:**
- Modify: `crates/daowow-core/src/computed_draw.rs`

**Interfaces:**
- Produces: `pub fn locate(&self, global_position: u64) -> Result<(u32, u64), CoreError>`.
- Removes: `WinnerProof`, `verify_winners`, test helper `winners`.

- [x] **Step 1: Failing test**

In `computed_draw.rs` tests add:

```rust
    #[test]
    fn locate_maps_global_positions_through_accepted_offsets() {
        // shards 0 and 2 accept 2 tickets each; 1 and 3 accept none
        let f = fixture(1, true);
        let d = ComputedDraw::new(&f.cfg, &f.record, &f.schedule).unwrap();
        assert_eq!(d.total_tickets(), 4);
        assert_eq!(d.locate(0), Ok((0, 0)));
        assert_eq!(d.locate(1), Ok((0, 1)));
        assert_eq!(d.locate(2), Ok((2, 0)));
        assert_eq!(d.locate(3), Ok((2, 1)));
        assert_eq!(d.locate(4), Err(CoreError::InvalidArgument));
        assert_eq!(d.locate(u64::MAX), Err(CoreError::InvalidArgument));
    }
```

- [x] **Step 2: Implement `locate`; delete winners**

After `is_success`:

```rust
    /// Map a drawn global position to `(shard_id, shard-local position)`.
    /// Empty shards share an offset with their successor, so the search runs
    /// from the last shard backwards; a position at or beyond the accepted
    /// total is not a ticket.
    pub fn locate(&self, global_position: u64) -> Result<(u32, u64), CoreError> {
        if global_position >= self.total {
            return Err(CoreError::InvalidArgument);
        }
        for (id, offset) in self.offsets.iter().enumerate().rev() {
            if global_position >= *offset {
                return Ok((id as u32, global_position - offset));
            }
        }
        Err(CoreError::InvalidArgument)
    }
```

Delete `WinnerProof`, `verify_winners`, the `winners` test helper, and these tests that only exercised owner verification: `rejects_missing_extra_wrong_owner_and_tampered_proofs`, `owner_verification_supports_each_configured_accumulator`, `forged_owner_ranges_fail_without_overflow_or_index_panics`, `genuine_frozen_proofs_do_not_authorize_excluded_entries`. In `draws_only_accepted_prefixes_across_empty_shards` and `failed_and_empty_rounds_require_no_winner_proofs`, remove the `verify_winners` assertions and keep the position/`is_success` assertions (rename the second to `failed_and_empty_rounds_draw_nothing`). Keep the `Fixture`, `fixture`, `fixture_with_accumulator` items: Task 5's tests use them. Remove now-unused imports (`imt`, `mmr`, `smt`, `nonce_key`) from the deleted method.

- [x] **Step 3: Green, commit**

```bash
cargo test -p daowow-core --lib computed_draw && cargo clippy -p daowow-core --lib -- -D warnings
git add crates/daowow-core/src/computed_draw.rs && git commit -m "feat(core): ComputedDraw::locate; drop winner ownership verification"
```

`entitlements` and `entitlement_witness` will not compile until Tasks 4 and 5; run only the `computed_draw` filter here and note it.

---

### Task 4: Entitlement witness version 2

**Files:**
- Modify: `crates/daowow-core/src/entitlement_witness.rs`

**Interfaces:**
- Produces: `EntitlementWitness::decode(&[u8])` accepting `[2] ‖ u32 schedule_len ‖ schedule ‖ u32 n ‖ n × (EntryDataV1 ‖ u64 capacity)`; `EntitlementWitness::encode(schedule, entries, capacities) -> Result<Vec<u8>, CoreError>`; `schedule()`, `entries()`, `capacities()`. `winner_proofs()` and `MAX_WINNER_PROOF_BYTES` are removed.

- [x] **Step 1: Update tests first**

In the tests module: remove winner tuples from every `encode` call (`EntitlementWitness::encode(&s, &[e], &[500])`), delete `winner_proofs()` assertions, change the version-byte assertions from `1` to `2`, and drop `whole_payload_limit_accepts_exact_boundary_and_rejects_valid_oversize` (its subject was the winners section). Replace it with:

```rust
    #[test]
    fn version_two_has_no_winner_section_and_rejects_version_one() {
        let s = PrizeSchedule::new(&[1]).unwrap();
        let wire = EntitlementWitness::encode(&s, &[entry()], &[500]).unwrap();
        assert_eq!(wire[0], 2);
        let expected = 1 + 4 + s.encode().len() + 4 + ENTRY_DATA_SIZE + 8;
        assert_eq!(wire.len(), expected);
        let mut v1 = wire.clone();
        v1[0] = 1;
        assert!(EntitlementWitness::decode(&v1).is_err());
        let mut trailing = wire.clone();
        trailing.extend_from_slice(&0u32.to_le_bytes()); // an old empty winners count
        assert!(EntitlementWitness::decode(&trailing).is_err());
    }
```

`decoded_evidence_derives_entitlements_and_rejects_altered_capacity` loses its `winners` plumbing; its `EntitlementInput` literal drops the `winners` field (Task 5 changes the struct; this test compiles only after Task 5, which is fine since both land before the next full run).

- [x] **Step 2: Implement**

In `decode`: expect `[2]`; delete the winners loop, the `winners`/`proofs` fields and `MAX_WINNER_PROOF_BYTES`. In `encode`: signature `(schedule, entries, capacities)`, size = `1 + 4 + schedule.len() + 4 + entries.len() * (ENTRY_DATA_SIZE + 8)`, push `2`. Delete `winner_proofs`. Update the module doc.

- [x] **Step 3: Commit (compilation completes in Task 5)**

```bash
git add crates/daowow-core/src/entitlement_witness.rs && git commit -m "feat(core): entitlement witness v2 without winner proofs"
```

---

### Task 5: Prize domain in `derive`; creation path and fixtures

**Files:**
- Modify: `crates/daowow-core/src/entitlements.rs`, `entitlements/tests.rs`, `crates/daowow-contracts-common/src/entitlements.rs:190-215`, `tests/integration/tests/proto3_dao_lifecycle.rs:617-650,754-790`, `tests/integration/examples/devnet_round.rs:247-270`

**Interfaces:**
- Produces: `pub struct PrizeEntitlement { pub ticket: Hash32, pub amount: u64 }`; `InitialEntitlements::prizes(&self) -> &[PrizeEntitlement]` (sorted by ticket ascending); `EntitlementInput` without `winners`.

- [x] **Step 1: Failing tests**

Rewrite `independent_batches_pay_the_same_global_winners_and_full_capacity` in `entitlements/tests.rs`:

```rust
#[test]
fn success_round_credits_prizes_to_tickets_and_principal_to_depositors() {
    use crate::{leaf::prize_leaf, ticket::ticket_id};
    let f = fixture(1, true);
    let d = ComputedDraw::new(&f.cfg, &f.record, &f.schedule).unwrap();
    assert_eq!(d.positions(), &[(0, 3), (1, 2), (2, 1), (3, 0)]);
    let commitment = f.cfg.commitment();
    // weights [4,3,2,1] over pool 100: 40, 30, 20, 10 to global 3, 2, 1, 0
    let mut expected = vec![
        PrizeEntitlement { ticket: ticket_id(&commitment, 2, 1), amount: 40 },
        PrizeEntitlement { ticket: ticket_id(&commitment, 2, 0), amount: 30 },
        PrizeEntitlement { ticket: ticket_id(&commitment, 0, 1), amount: 20 },
        PrizeEntitlement { ticket: ticket_id(&commitment, 0, 0), amount: 10 },
    ];
    expected.sort_by(|a, b| a.ticket.cmp(&b.ticket));
    for shard in [0, 2] {
        let receipt = receipt(&f, shard);
        let input = EntitlementInput {
            batch_id: batch_id(shard as u32, 0).unwrap(),
            receipt: &receipt,
            entries: &f.entries[shard][..1],
            capacities: &[250],
            realized_total: 350,
        };
        let derived = InitialEntitlements::derive(&f.cfg, &f.record, &f.schedule, &input).unwrap();
        // principal only, to the depositor of this batch
        assert_eq!(
            derived.liabilities(),
            &[PayoutItem {
                participant_lock_hash: [10 + shard as u8; 32],
                principal: 250,
                prize: 0
            }]
        );
        assert_eq!(derived.prizes(), expected.as_slice());
        let mut tree = MmrHost::new();
        for p in derived.prizes() {
            tree.append(&prize_leaf(&p.ticket, p.amount)).unwrap();
        }
        let f3 = derived.funding();
        assert_eq!(f3.prize_count, 4);
        assert_eq!(f3.prize_root, tree.root().unwrap());
        assert_eq!(f3.prize_paid, 0);
        assert_eq!(f3.prize_pool, 100);
        assert_eq!(f3.principal_liability, 250);
        assert_eq!(f3.liability_count, 1);
        for (i, p) in derived.prizes().iter().enumerate() {
            mmr::verify_membership(
                &f3.prize_root,
                4,
                i as u64,
                &prize_leaf(&p.ticket, p.amount),
                &tree.membership_proof(i as u64).unwrap(),
            )
            .unwrap();
        }
    }
}
```

Update the other tests: remove `winners` from every `EntitlementInput`; in `zero_yield_omits_zero_total_winner_only_records` assert `prizes().is_empty()` and `prize_count == 0` when the pool is zero; in `rejects_unaccepted_batch_ids_missing_winners_and_realized_underflow` delete the `input.winners = &[]` case and rename to `rejects_unaccepted_batch_ids_and_realized_underflow`; in `failed_round_returns_yield_to_depositor_without_winners` additionally assert `derived.prizes().is_empty()` and `funding().prize_count == 0`. Add:

```rust
#[test]
fn prize_domain_conserves_and_is_sorted_and_unique() {
    let f = fixture(1, true);
    let receipt = receipt(&f, 0);
    let input = EntitlementInput {
        batch_id: batch_id(0, 0).unwrap(),
        receipt: &receipt,
        entries: &f.entries[0][..1],
        capacities: &[250],
        realized_total: 350,
    };
    let derived = InitialEntitlements::derive(&f.cfg, &f.record, &f.schedule, &input).unwrap();
    let prizes = derived.prizes();
    assert!(prizes.windows(2).all(|w| w[0].ticket < w[1].ticket));
    let total: u64 = prizes.iter().map(|p| p.amount).sum();
    let principal: u64 = derived.liabilities().iter().map(|l| l.principal + l.prize).sum();
    assert_eq!(total + principal, 350);
}
```

- [x] **Step 2: Run, expect compile errors on `winners` and `prizes`**

- [x] **Step 3: Implement `derive`**

In `entitlements.rs`: remove `winners` from `EntitlementInput` and the `computed_draw::WinnerProof` import; add

```rust
/// One winning ticket's obligation from this batch, immutable once committed.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PrizeEntitlement {
    pub ticket: crate::hash::Hash32,
    pub amount: u64,
}
```

and a `prizes: Vec<PrizeEntitlement>` field on `InitialEntitlements` with `pub fn prizes(&self) -> &[PrizeEntitlement]`. Replace the body from `let owners = draw.verify_winners(...)` through the funding literal with:

```rust
        let mut amounts: BTreeMap<crate::hash::Hash32, (u64, u64)> = BTreeMap::new();
        for (e, capacity) in input.entries.iter().zip(input.capacities) {
            let item = amounts.entry(e.participant_lock_hash).or_default();
            item.0 = item.0.checked_add(*capacity).ok_or(CoreError::Overflow)?;
        }
        let mut prizes: Vec<PrizeEntitlement> = Vec::new();
        if draw.is_success() {
            let commitment = cfg.commitment();
            let allocated = schedule.allocate(draw.total_tickets(), prize_pool)?;
            if allocated.len() != draw.positions().len() {
                return Err(CoreError::StateTransition);
            }
            for (i, ((prize_index, position), amount)) in
                draw.positions().iter().zip(allocated).enumerate()
            {
                if *prize_index != i as u64 {
                    return Err(CoreError::StateTransition);
                }
                if amount == 0 {
                    continue;
                }
                let (shard_id, local) = draw.locate(*position)?;
                prizes.push(PrizeEntitlement {
                    ticket: crate::ticket::ticket_id(&commitment, shard_id, local),
                    amount,
                });
            }
            prizes.sort_by(|a, b| a.ticket.cmp(&b.ticket));
            if prizes.windows(2).any(|w| w[0].ticket == w[1].ticket) {
                return Err(CoreError::StateTransition);
            }
        } else {
            // existing failed-round pro rata allocation into `amounts`, unchanged
        }
```
 Keep the liabilities loop unchanged (on success every `prize` in `amounts` is 0, so `owed == principal`; the `owed == 0` rejection still applies). Then:

```rust
        let mut prize_peaks = [[0u8; 32]; mmr::MAX_PEAKS];
        let mut prize_total = 0u64;
        for (i, p) in prizes.iter().enumerate() {
            prize_total = prize_total.checked_add(p.amount).ok_or(CoreError::Overflow)?;
            prize_peaks = mmr::append_peaks(
                &prize_peaks[..mmr::peaks_shape(i as u64)?],
                i as u64,
                &crate::leaf::prize_leaf(&p.ticket, p.amount),
            )?;
        }
        let paid_by_liabilities = sum; // existing accumulator over owed
        if paid_by_liabilities
            .checked_add(prize_total)
            .ok_or(CoreError::Overflow)?
            != input.realized_total
            || liabilities.is_empty()
        {
            return Err(CoreError::Conservation);
        }
        let prize_count = prizes.len() as u64;
        let prize_root = if prize_count == 0 {
            [0; 32]
        } else {
            mmr::bag_peaks(&prize_peaks[..mmr::peaks_shape(prize_count)?])?
        };
        let count = liabilities.len() as u64;
        let root = mmr::bag_peaks(&peaks[..mmr::peaks_shape(count)?])?;
        Ok(Self {
            funding: SettlementFundingDataV3 {
                round_id: cfg.round_id,
                batch_id: input.batch_id,
                realized_total: input.realized_total,
                principal_liability: principal_total,
                prize_pool,
                payout_cursor: 0,
                liability_count: count,
                liabilities_root: root,
                prize_count,
                prize_root,
                prize_paid: 0,
            },
            liabilities,
            prizes,
        })
```

On a successful round `prize_total == prize_pool` because `allocate_prizes_complete` sums exactly to the pool; the conservation check enforces it.

- [x] **Step 4: Contracts-common and fixtures**

`crates/daowow-contracts-common/src/entitlements.rs`: delete `let winners = evidence.winner_proofs();` and the `winners: &winners,` field. `proto3_dao_lifecycle.rs`: in `phase2_fixture_history` delete the `winners`/`views` construction (lines ~617-632), drop `winners` from `EntitlementInput`, call `EntitlementWitness::encode(&schedule, &entries[predecessor_entries..], &capacities)`; in `drain_created_funding` delete `let winners = ...`, the `winners:` field, and change the entry lookup to `evidence.entries().iter().find(...)` (winners no longer contribute entries; the 64-liability assertion is on principal-only items now, so the `assert_eq!(items.len(), 64)` stays valid only if all 64 owners have principal in this batch: check the fixture's `distinct_owners`/`predecessor_entries` and, if the count drops, assert the new count and print it). `devnet_round.rs`: remove the `winners` array and field, call `encode(&schedule, &[entry], &[400 * 100_000_000])`, and add to the settlement JSON `"prizes": derived.prizes().iter().map(|p| json!({"ticket": hex(&p.ticket), "amount": p.amount})).collect::<Vec<_>>()`.

- [x] **Step 5: Full run**

```bash
cargo test -p daowow-core --lib && cargo check -p daowow-core --no-default-features && cargo clippy -p daowow-core --lib -- -D warnings && cargo test -p daowow-core --test gen_vectors
for c in settlement-type dao-lock entry-shard-type entry-lock round-type; do cargo build --target riscv64imac-unknown-none-elf --release -p $c; done
cd tests/integration && cargo test 2>&1 | grep -E "^test result|FAILED"
```

Expected: green apart from the two pre-existing `smoke` failures. `proto3` tests that asserted prize amounts on participant payouts (`phase2_failed_round_returns_deposits_and_all_yield` stays valid; success-round tests that asserted `prize > 0` on liabilities must now assert `prize == 0` and inspect `prizes()`).

- [x] **Step 6: Commit**

```bash
git add -A crates tests && git commit -m "feat: ticket-indexed prize domain in initial entitlements"
```

---

## Phase 2b

### Task 6: Redemption witness codec

**Files:**
- Modify: `crates/daowow-core/src/witness.rs` (+ its tests)

**Interfaces:**
- Produces:
  - `pub const REDEMPTION_WITNESS_TAG: u8 = 0xFF; pub const MAX_REDEMPTION_ITEMS: usize = 32;`
  - `pub struct RedemptionItem<'a> { pub claim_input_index: u32, pub payment_output_index: u32, pub prize_index: u64, pub amount: u64, pub mmr_proof: &'a [u8], pub absence_proof: &'a [u8] }`
  - `pub fn encode_redemption_witness(items: &[RedemptionItem<'_>]) -> Result<Vec<u8>, CoreError>`
  - `pub fn decode_redemption_witness(data: &[u8]) -> Result<Vec<RedemptionItem<'_>>, CoreError>`
  - `pub fn is_redemption_witness(data: &[u8]) -> bool` (`data.first() == Some(&0xFF)`)

- [x] **Step 1: Failing tests**

```rust
    #[test]
    fn redemption_witness_round_trips_and_is_strict() {
        let items = [
            RedemptionItem { claim_input_index: 1, payment_output_index: 2, prize_index: 0, amount: 40, mmr_proof: &[1, 2, 3], absence_proof: &[4, 5] },
            RedemptionItem { claim_input_index: 3, payment_output_index: 4, prize_index: 2, amount: 7, mmr_proof: &[9], absence_proof: &[8, 8, 8, 8] },
        ];
        let wire = encode_redemption_witness(&items).unwrap();
        assert_eq!(wire[0], REDEMPTION_WITNESS_TAG);
        assert!(is_redemption_witness(&wire));
        assert!(!is_redemption_witness(&encode_settlement_witness(&[])));
        let decoded = decode_redemption_witness(&wire).unwrap();
        assert_eq!(decoded.len(), 2);
        assert_eq!(decoded[1].amount, 7);
        assert_eq!(decoded[1].absence_proof, &[8, 8, 8, 8]);
        assert!(decode_redemption_witness(&wire[..wire.len() - 1]).is_err());
        let mut trailing = wire.clone();
        trailing.push(0);
        assert!(decode_redemption_witness(&trailing).is_err());
        assert!(decode_redemption_witness(&[]).is_err());
        assert!(encode_redemption_witness(&[]).is_err());
        let too_many = vec![items[0]; MAX_REDEMPTION_ITEMS + 1];
        assert!(encode_redemption_witness(&too_many).is_err());
        let big = vec![0u8; crate::accumulator::MAX_PROOF_BYTES + 1];
        let oversize = [RedemptionItem { mmr_proof: &big, ..items[0] }];
        assert!(encode_redemption_witness(&oversize).is_err());
        let mut forged_count = wire.clone();
        forged_count[1..5].copy_from_slice(&33u32.to_le_bytes());
        assert!(decode_redemption_witness(&forged_count).is_err());
    }
```

(`RedemptionItem` derives `Clone, Copy, Debug, PartialEq, Eq`.)

- [x] **Step 2: Implement**

```rust
pub const REDEMPTION_WITNESS_TAG: u8 = 0xFF;
pub const MAX_REDEMPTION_ITEMS: usize = 32;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RedemptionItem<'a> {
    pub claim_input_index: u32,
    pub payment_output_index: u32,
    pub prize_index: u64,
    pub amount: u64,
    pub mmr_proof: &'a [u8],
    pub absence_proof: &'a [u8],
}

pub fn is_redemption_witness(data: &[u8]) -> bool {
    data.first() == Some(&REDEMPTION_WITNESS_TAG)
}

pub fn encode_redemption_witness(items: &[RedemptionItem<'_>]) -> Result<Vec<u8>, CoreError> {
    use crate::accumulator::MAX_PROOF_BYTES;
    if items.is_empty() || items.len() > MAX_REDEMPTION_ITEMS {
        return Err(CoreError::Encoding);
    }
    let mut out = alloc::vec![REDEMPTION_WITNESS_TAG];
    write_u32(&mut out, items.len() as u32);
    for item in items {
        if item.mmr_proof.len() > MAX_PROOF_BYTES || item.absence_proof.len() > MAX_PROOF_BYTES {
            return Err(CoreError::Encoding);
        }
        write_u32(&mut out, item.claim_input_index);
        write_u32(&mut out, item.payment_output_index);
        out.extend_from_slice(&item.prize_index.to_le_bytes());
        out.extend_from_slice(&item.amount.to_le_bytes());
        write_u32(&mut out, item.mmr_proof.len() as u32);
        out.extend_from_slice(item.mmr_proof);
        write_u32(&mut out, item.absence_proof.len() as u32);
        out.extend_from_slice(item.absence_proof);
    }
    Ok(out)
}

pub fn decode_redemption_witness(data: &[u8]) -> Result<Vec<RedemptionItem<'_>>, CoreError> {
    use crate::accumulator::MAX_PROOF_BYTES;
    if data.len() < 5 || data[0] != REDEMPTION_WITNESS_TAG {
        return Err(CoreError::Encoding);
    }
    let n = read_u32(data, 1) as usize;
    if n == 0 || n > MAX_REDEMPTION_ITEMS {
        return Err(CoreError::Encoding);
    }
    let mut off = 5usize;
    let mut out = Vec::with_capacity(n);
    for _ in 0..n {
        let head = read_bytes(data, &mut off, 24)?;
        let claim_input_index = u32::from_le_bytes(head[0..4].try_into().unwrap());
        let payment_output_index = u32::from_le_bytes(head[4..8].try_into().unwrap());
        let prize_index = u64::from_le_bytes(head[8..16].try_into().unwrap());
        let amount = u64::from_le_bytes(head[16..24].try_into().unwrap());
        let mmr_len = u32::from_le_bytes(read_bytes(data, &mut off, 4)?.try_into().unwrap()) as usize;
        if mmr_len > MAX_PROOF_BYTES {
            return Err(CoreError::Encoding);
        }
        let mmr_proof = read_bytes(data, &mut off, mmr_len)?;
        let abs_len = u32::from_le_bytes(read_bytes(data, &mut off, 4)?.try_into().unwrap()) as usize;
        if abs_len > MAX_PROOF_BYTES {
            return Err(CoreError::Encoding);
        }
        let absence_proof = read_bytes(data, &mut off, abs_len)?;
        out.push(RedemptionItem { claim_input_index, payment_output_index, prize_index, amount, mmr_proof, absence_proof });
    }
    if off != data.len() {
        return Err(CoreError::Encoding);
    }
    Ok(out)
}
```

(`read_bytes(data, &mut off, len)` is the existing helper in `witness.rs`; `write_u32` there appends to a `Vec`.)

- [x] **Step 3: Green, commit**

```bash
cargo test -p daowow-core --lib witness && cargo clippy -p daowow-core --lib -- -D warnings
git add crates/daowow-core/src/witness.rs && git commit -m "feat(core): redemption witness codec"
```

---

### Task 7: Settlement-type redemption mode and final completeness

**Files:**
- Modify: `contracts/settlement-type/src/main.rs`

**Interfaces:**
- Consumes: `decode_redemption_witness`, `is_redemption_witness`, `prize_leaf`, `mmr::verify_membership`, `daowow_core::claim::{ClaimArgs, CLAIM_ARGS_SIZE, CLAIM_TAG}`, `config_by_commitment`, `script_matches`.

- [x] **Step 1: Dispatch on the witness**

After `before` is decoded and the immutable-field comparison passes (extend that comparison with `prize_count`, `prize_root`), load the witness and branch:

```rust
    let witness_raw = match load_witness(0, Source::GroupInput) {
        Ok(w) => w,
        Err(_) => return err(SETTLE_ERROR_DATA),
    };
    if daowow_core::witness::is_redemption_witness(&witness_raw) {
        return redeem(&script, &args, &before, after_opt, is_final, &witness_raw);
    }
```

where `after_opt` is `Some(&after)` unless `is_final`. In the payout path add, alongside the existing `is_final && cursor != before.liability_count` check: `if is_final && before.prize_count != 0 && before.prize_paid != before.prize_pool { return err(SETTLE_ERROR_REDEEM); }` and in the non-final case `if after.prize_paid != before.prize_paid { return err(SETTLE_ERROR_ROUND_MISMATCH); }`.

- [x] **Step 2: Write `redeem`**

```rust
fn redeem(
    script: &ckb_std::ckb_types::packed::Script,
    args: &[u8],
    before: &SettlementFundingDataV3,
    after: Option<&SettlementFundingDataV3>,
    is_final: bool,
    witness_raw: &[u8],
) -> i8 {
    use daowow_core::claim::{ClaimArgs, CLAIM_ARGS_SIZE, CLAIM_TAG};
    if before.prize_count == 0 {
        return err(SETTLE_ERROR_REDEEM);
    }
    let items = match daowow_core::witness::decode_redemption_witness(witness_raw) {
        Ok(i) => i,
        Err(_) => return err(SETTLE_ERROR_DATA),
    };
    let commitment: [u8; 32] = args[..32].try_into().unwrap();
    let Some(cfg) = daowow_contracts_common::config_by_commitment(
        &commitment,
        &before.round_id,
        Source::CellDep,
    ) else {
        return err(SETTLE_ERROR_DATA);
    };
    if !daowow_contracts_common::script_matches(script, &cfg.settlement_type) {
        return err(SETTLE_ERROR_DATA);
    }
    let in_cap = match load_cell_capacity(0, Source::GroupInput) {
        Ok(c) => c,
        Err(_) => return err(SETTLE_ERROR_CONSERVATION),
    };
    let new_funding_cap = if is_final {
        0
    } else {
        match load_cell_capacity(0, Source::GroupOutput) {
            Ok(c) => c,
            Err(_) => return err(SETTLE_ERROR_CONSERVATION),
        }
    };
    if !is_final {
        if load_cell(0, Source::GroupInput).unwrap().lock()
            != load_cell(0, Source::GroupOutput).unwrap().lock()
        {
            return err(SETTLE_ERROR_CONSERVATION);
        }
        let occupied = match ckb_std::high_level::load_cell_occupied_capacity(0, Source::GroupOutput) {
            Ok(c) => c,
            Err(_) => return err(SETTLE_ERROR_CONSERVATION),
        };
        if new_funding_cap < occupied {
            return err(SETTLE_ERROR_CONSERVATION);
        }
    }
    let mut paid: u64 = 0;
    let mut prev_prize: Option<u64> = None;
    let mut used_claims: alloc::vec::Vec<u32> = alloc::vec::Vec::new();
    let mut used_payments: alloc::vec::Vec<u32> = alloc::vec::Vec::new();
    for item in &items {
        if prev_prize.is_some_and(|p| item.prize_index <= p)
            || used_claims.contains(&item.claim_input_index)
            || used_payments.contains(&item.payment_output_index)
            || item.amount == 0
        {
            return err(SETTLE_ERROR_REDEEM);
        }
        prev_prize = Some(item.prize_index);
        used_claims.push(item.claim_input_index);
        used_payments.push(item.payment_output_index);
        // the claim input: canonical claim type of this round
        let claim = match load_cell(item.claim_input_index as usize, Source::Input) {
            Ok(c) => c,
            Err(_) => return err(SETTLE_ERROR_REDEEM),
        };
        let Some(claim_type) = claim.type_().to_opt() else {
            return err(SETTLE_ERROR_REDEEM);
        };
        let claim_args = claim_type.args().raw_data();
        if !daowow_contracts_common::script_matches(&claim_type, &cfg.entry_shard_type)
            || claim_args.len() != CLAIM_ARGS_SIZE
            || claim_args[0] != CLAIM_TAG
            || claim_args[1..33] != commitment
        {
            return err(SETTLE_ERROR_REDEEM);
        }
        let ticket = match ClaimArgs::decode(&claim_args) {
            Ok(a) => a.ticket_id(),
            Err(_) => return err(SETTLE_ERROR_REDEEM),
        };
        if mmr::verify_membership(
            &before.prize_root,
            before.prize_count,
            item.prize_index,
            &daowow_core::leaf::prize_leaf(&ticket, item.amount),
            item.mmr_proof,
        )
        .is_err()
        {
            return err(SETTLE_ERROR_PROOF);
        }
        // successor claim with the identical type script must exist
        let mut successor = false;
        let mut i = 0usize;
        while let Ok(cell) = load_cell(i, Source::Output) {
            if cell.type_().to_opt().is_some_and(|t| t.as_slice() == claim_type.as_slice()) {
                successor = true;
                break;
            }
            i += 1;
        }
        if !successor {
            return err(SETTLE_ERROR_REDEEM);
        }
        // payment: ordinary cell under the claim's current lock
        let payment = match load_cell(item.payment_output_index as usize, Source::Output) {
            Ok(c) => c,
            Err(_) => return err(SETTLE_ERROR_REDEEM),
        };
        if payment.lock().as_slice() != claim.lock().as_slice()
            || payment.type_().to_opt().is_some()
            || !matches!(load_cell_data(item.payment_output_index as usize, Source::Output), Ok(d) if d.is_empty())
        {
            return err(SETTLE_ERROR_REDEEM);
        }
        let cap = match load_cell_capacity(item.payment_output_index as usize, Source::Output) {
            Ok(c) => c,
            Err(_) => return err(SETTLE_ERROR_CONSERVATION),
        };
        let occupied = match ckb_std::high_level::load_cell_occupied_capacity(
            item.payment_output_index as usize,
            Source::Output,
        ) {
            Ok(c) => c,
            Err(_) => return err(SETTLE_ERROR_CONSERVATION),
        };
        if cap < item.amount || cap < occupied {
            return err(SETTLE_ERROR_CONSERVATION);
        }
        paid = match paid.checked_add(item.amount) {
            Some(p) => p,
            None => return err(SETTLE_ERROR_CONSERVATION),
        };
    }
    let prize_paid = match before.prize_paid.checked_add(paid) {
        Some(p) if p <= before.prize_pool => p,
        _ => return err(SETTLE_ERROR_REDEEM),
    };
    match after {
        Some(after) => {
            if after.payout_cursor != before.payout_cursor || after.prize_paid != prize_paid {
                return err(SETTLE_ERROR_REDEEM);
            }
        }
        None => {
            if before.payout_cursor != before.liability_count || prize_paid != before.prize_pool {
                return err(SETTLE_ERROR_REDEEM);
            }
        }
    }
    match paid.checked_add(new_funding_cap) {
        Some(expected) if expected == in_cap => 0,
        _ => err(SETTLE_ERROR_CONSERVATION),
    }
}
```

Update the module doc comment with the redemption mode summary.

- [x] **Step 3: Build**

`cargo build --target riscv64imac-unknown-none-elf --release -p settlement-type` clean. Run `cd tests/integration && cargo test --test proto4_settlement --test proto3_dao_lifecycle` to confirm the payout path is unchanged (green).

- [x] **Step 4: Commit**

```bash
git add contracts/settlement-type/src/main.rs && git commit -m "feat(contract): settlement redemption mode and final completeness"
```

---

### Task 8: Claim script redemption mode

**Files:**
- Modify: `contracts/entry-shard-type/src/claim.rs`

**Interfaces:**
- Consumes: `prize_source`, `PrizeRedemptionState`, `decode_redemption_witness`, `SettlementFundingDataV3`, `config_by_commitment`, `script_matches`.

- [x] **Step 1: Implement**

Replace the `(true, Some(data))` arm:

```rust
        (true, Some(data)) => {
            let input = match load_cell_data(0, Source::GroupInput) {
                Ok(d) => d,
                Err(_) => return err(CLAIM_ERROR_DATA),
            };
            match validate_transfer(&args, &input, &data) {
                Ok(()) => Ok(0),
                Err(CoreError::StateTransition) => redeem(script, &args, &input, &data),
                Err(_) => err(CLAIM_ERROR_DATA),
            }
        }
```

and add:

```rust
/// Data changed: this must be an authenticated redemption. The funding cell
/// of one batch transitions in this transaction, its redemption witness names
/// this claim, and the output state is exactly the input state with that
/// source's prize recorded. Lock must not change.
fn redeem(script: &Script, args: &ClaimArgs, input: &[u8], output: &[u8]) -> Result<i8, i8> {
    use daowow_core::encoding::{SettlementFundingDataV3, SETTLEMENT_FUNDING_SIZE};
    use daowow_core::redemption::{prize_source, PrizeRedemptionState};
    let in_lock = load_cell(0, Source::GroupInput).map_err(|_| CLAIM_ERROR_DATA)?.lock();
    let out_lock = load_cell(0, Source::GroupOutput).map_err(|_| CLAIM_ERROR_DATA)?.lock();
    if in_lock.as_slice() != out_lock.as_slice() {
        return err(CLAIM_ERROR_TRANSITION);
    }
    // exactly one settlement funding input of this commitment
    let mut funding: Option<(usize, [u8; 72])> = None;
    let mut own_index: Option<usize> = None;
    let mut i = 0usize;
    while let Ok(cell) = load_cell(i, Source::Input) {
        if let Some(t) = cell.type_().to_opt() {
            let a = t.args().raw_data();
            if t.as_slice() == script.as_slice() {
                if own_index.replace(i).is_some() {
                    return err(CLAIM_ERROR_GROUP);
                }
            } else if a.len() == 72 && a[..32] == args.commitment {
                if funding.is_some() {
                    return err(CLAIM_ERROR_REDEEM);
                }
                let mut fixed = [0u8; 72];
                fixed.copy_from_slice(&a);
                funding = Some((i, fixed));
            }
        }
        i += 1;
    }
    let (Some((funding_index, funding_args)), Some(own_index)) = (funding, own_index) else {
        return err(CLAIM_ERROR_REDEEM);
    };
    let funding_data = load_cell_data(funding_index, Source::Input).map_err(|_| CLAIM_ERROR_REDEEM)?;
    if funding_data.len() != SETTLEMENT_FUNDING_SIZE {
        return err(CLAIM_ERROR_REDEEM);
    }
    let funding_state = SettlementFundingDataV3::decode(&funding_data).map_err(|_| CLAIM_ERROR_REDEEM)?;
    let Some(cfg) = daowow_contracts_common::config_by_commitment(
        &args.commitment,
        &funding_state.round_id,
        Source::CellDep,
    ) else {
        return err(CLAIM_ERROR_REDEEM);
    };
    let funding_type = load_cell(funding_index, Source::Input)
        .map_err(|_| CLAIM_ERROR_REDEEM)?
        .type_()
        .to_opt()
        .ok_or(CLAIM_ERROR_REDEEM)?;
    if !daowow_contracts_common::script_matches(&funding_type, &cfg.settlement_type)
        || !daowow_contracts_common::script_matches(script, &cfg.entry_shard_type)
    {
        return err(CLAIM_ERROR_REDEEM);
    }
    let witness = ckb_std::high_level::load_witness(funding_index, Source::Input)
        .map_err(|_| CLAIM_ERROR_REDEEM)?;
    let items = daowow_core::witness::decode_redemption_witness(&witness)
        .map_err(|_| CLAIM_ERROR_REDEEM)?;
    let mut mine = None;
    for item in &items {
        if item.claim_input_index as usize == own_index {
            if mine.is_some() {
                return err(CLAIM_ERROR_REDEEM);
            }
            mine = Some(*item);
        }
    }
    let Some(item) = mine else {
        return err(CLAIM_ERROR_REDEEM);
    };
    let batch_id = u64::from_le_bytes(funding_args[32..40].try_into().unwrap());
    let digest: [u8; 32] = funding_args[40..72].try_into().unwrap();
    let source = prize_source(&args.commitment, batch_id, &digest);
    let before = PrizeRedemptionState::decode(input).map_err(|_| CLAIM_ERROR_DATA)?;
    let expected = before
        .record_verified_prize(&source, item.amount, item.absence_proof)
        .map_err(|_| CLAIM_ERROR_REDEEM)?;
    if output != expected.encode() {
        return err(CLAIM_ERROR_REDEEM);
    }
    Ok(0)
}
```

`err` in this file returns `Result<i8, i8>`, so `.map_err(|_| CODE)?` and `err(CODE)` compose. Import `Script` is already there.

- [x] **Step 2: Build, run existing claim suites (still green), commit**

```bash
cargo build --target riscv64imac-unknown-none-elf --release -p entry-shard-type
cd tests/integration && cargo test --test claim_lifecycle --test security_claims
git add contracts/entry-shard-type/src/claim.rs && git commit -m "feat(contract): claim redemption mode"
```

The `transfer_to_a_paid_looking_state_is_rejected_as_transition` test now expects `-97` (no funding input) instead of `-95`; update its constant.

---

### Task 9: VM suites for redemption

**Files:**
- Modify: `tests/integration/tests/common/mod.rs` (add `seed_claim`, `redemption_witness`)
- Create: `tests/integration/tests/claim_redemption.rs`, `tests/integration/tests/security_redemption.rs`
- Modify: `tests/integration/tests/proto3_dao_lifecycle.rs` (one end-to-end test)

**Interfaces:**
- `pub fn seed_claim(world: &mut World, lock: &Script, shard_id: u32, position: u64) -> (OutPoint, ClaimArgs)` creates a live claim cell with initial state.
- `pub fn redemption_witness(items: &[RedemptionItem<'_>]) -> ckb_testtool::ckb_types::packed::Bytes`.

- [x] **Step 1: Fixture (seeded funding, no DAO)**

`claim_redemption.rs`:

```rust
mod common;
use ckb_testtool::ckb_types::{bytes::Bytes, core::{TransactionBuilder, TransactionView}, packed::*, prelude::*};
use common::*;
use daowow_core::accumulator::{mmr::host::MmrHost, smt::host::SmtHost};
use daowow_core::encoding::{RoundConfigV1, SettlementFundingDataV3, ACC_SMT};
use daowow_core::redemption::{prize_obligation_key, prize_payment_leaf, prize_source, PrizeRedemptionState};
use daowow_core::witness::RedemptionItem;

const BATCH: u64 = 1;
const DIGEST: [u8; 32] = [0xD1; 32];

struct Fx {
    w: World,
    cfg: RoundConfigV1,
    round: OutPoint,
    funding: OutPoint,
    funding_data: SettlementFundingDataV3,
    prizes: MmrHost,
    /// (claim out point, args, amount, prize index, holder lock, paid-set host)
    claims: Vec<(OutPoint, daowow_core::claim::ClaimArgs, u64, u64, Script, SmtHost)>,
    depositor: Script,
    liabilities: MmrHost,
}

/// One batch whose prize domain is `amounts` for tickets (0, i); principal
/// liability of one participant already fully paid unless `cursor_open`.
fn fixture(amounts: &[u64], cursor_open: bool) -> Fx {
    let mut w = World::new(ACC_SMT);
    let cfg = default_config([0x51; 32], ACC_SMT);
    let round = w.create_round(&cfg);
    let cfg = full_config(&cfg, &w.deps);
    let mut items: Vec<(daowow_core::claim::ClaimArgs, u64)> = amounts
        .iter()
        .enumerate()
        .map(|(i, a)| (daowow_core::claim::ClaimArgs { commitment: cfg.commitment(), shard_id: 0, position: i as u64 }, *a))
        .collect();
    items.sort_by(|a, b| a.0.ticket_id().cmp(&b.0.ticket_id()));
    let mut prizes = MmrHost::new();
    for (args, amount) in &items {
        prizes.append(&daowow_core::leaf::prize_leaf(&args.ticket_id(), *amount)).unwrap();
    }
    let prize_pool: u64 = amounts.iter().sum();
    let (_, depositor) = w.always_success();
    let depositor = depositor.as_builder().args(pack_pbytes(b"depositor")).build();
    let depositor_hash = World::participant_hash(&depositor);
    let mut liabilities = MmrHost::new();
    liabilities.append(&daowow_core::leaf::liability_leaf(&depositor_hash, 100 * SHANNONS, 0)).unwrap();
    let funding_data = SettlementFundingDataV3 {
        round_id: cfg.round_id,
        batch_id: BATCH,
        realized_total: 100 * SHANNONS + prize_pool,
        principal_liability: 100 * SHANNONS,
        prize_pool,
        payout_cursor: if cursor_open { 0 } else { 1 },
        liability_count: 1,
        liabilities_root: liabilities.root().unwrap(),
        prize_count: items.len() as u64,
        prize_root: prizes.root().unwrap(),
        prize_paid: 0,
    };
    let capacity = if cursor_open { 100 * SHANNONS + prize_pool } else { prize_pool };
    let type_script = w.settlement_script_with_digest(BATCH, &DIGEST);
    let lock = w.settlement_public_lock();
    let funding = w.context.create_cell(
        CellOutputBuilder::default().capacity(pack_u64(capacity)).lock(lock).type_(Some(type_script).pack()).build(),
        Bytes::from(funding_data.encode().to_vec()),
    );
    let (_, holder) = w.always_success();
    let holder = holder.as_builder().args(pack_pbytes(b"holder")).build();
    let mut claims = Vec::new();
    for (index, (args, amount)) in items.iter().enumerate() {
        let (op, _) = seed_claim(&mut w, &holder, 0, args.position);
        claims.push((op, *args, *amount, index as u64, holder.clone(), SmtHost::new()));
    }
    Fx { w, cfg, round, funding, funding_data, prizes, claims, depositor, liabilities }
}
```

(`Fx` gains `depositor: Script` and `liabilities: MmrHost` so the principal-payout test can build a payout witness with `liabilities.membership_proof(0)` and pay `depositor`.)

`funding_cell` capacity: a prize pool of a few hundred CKB keeps the funding cell above its occupied capacity (8 + 33 + 105 + 160 = 306 bytes); use amounts like `[400 * SHANNONS, 300 * SHANNONS]` in tests.

Redemption builder:

```rust
/// Redeem `which` claims (indexes into fx.claims) in one tx; `pay_to` overrides
/// the payment lock (None = the claim's own lock); returns the tx.
fn redeem_tx(fx: &mut Fx, which: &[usize], pay_to: Option<Script>, final_drain: bool) -> TransactionView {
    let (funding_cell, _) = fx.w.cell(&fx.funding);
    let in_cap: u64 = funding_cell.capacity().unpack();
    let total: u64 = which.iter().map(|i| fx.claims[*i].2).sum();
    let mut after = fx.funding_data;
    after.prize_paid += total;
    let (sponsor, sponsor_lock) = fx.w.funding_cell(1_000 * SHANNONS);
    let mut b = TransactionBuilder::default()
        .cell_dep(fx.w.round_config_dep(&fx.round))
        .input(CellInput::new(fx.funding.clone(), 0))
        .input(CellInput::new(sponsor, 0));
    let mut outputs: Vec<(CellOutput, Bytes)> = Vec::new();
    if !final_drain {
        outputs.push((funding_cell.as_builder().capacity(pack_u64(in_cap - total)).build(), Bytes::from(after.encode().to_vec())));
    }
    let mut items_owned: Vec<(u32, u32, u64, u64, Vec<u8>, Vec<u8>)> = Vec::new();
    for (k, i) in which.iter().enumerate() {
        let (op, args, amount, prize_index, lock, host) = &mut fx.claims[*i];
        let claim_input_index = 2 + k as u32;
        b = b.input(CellInput::new(op.clone(), 0));
        let (cell, data) = fx.w.cell(op);
        let source = prize_source(&fx.cfg.commitment(), BATCH, &DIGEST);
        let key = prize_obligation_key(&args.ticket_id(), &source);
        let absence = host.absence_proof(&[key]).unwrap();
        let state = PrizeRedemptionState::decode(&data).unwrap();
        let next = state.record_verified_prize(&source, *amount, &absence).unwrap();
        host.insert(&key, &prize_payment_leaf(&args.ticket_id(), &source, *amount)).unwrap();
        outputs.push((cell.clone(), Bytes::from(next.encode().to_vec())));
        let payee = pay_to.clone().unwrap_or(lock.clone());
        let payment_output_index = outputs.len() as u32; // index the payment will take
        outputs.push((CellOutputBuilder::default().capacity(pack_u64(*amount)).lock(payee).build(), Bytes::new()));
        items_owned.push((claim_input_index, payment_output_index, *prize_index, *amount, fx.prizes.membership_proof(*prize_index).unwrap(), absence));
    }
    let items: Vec<RedemptionItem> = items_owned.iter().map(|(c, p, x, a, m, ab)| RedemptionItem { claim_input_index: *c, payment_output_index: *p, prize_index: *x, amount: *a, mmr_proof: m, absence_proof: ab }).collect();
    // sort by prize index as the contract requires
    let mut items = items;
    items.sort_by_key(|i| i.prize_index);
    let witness = redemption_witness(&items);
    b = b.witness(witness);
    for (cell, data) in outputs {
        b = b.output(cell).output_data(data.pack());
    }
    b.output(CellOutputBuilder::default().capacity(pack_u64(900 * SHANNONS)).lock(sponsor_lock).build()).output_data(Bytes::new().pack()).build()
}
```

After a successful `expect_ok`, the caller chains: `chain_cell(&mut fx.w, &fx.funding, &tx, 0)` (when not final), updates `fx.funding_data = after`, and for each redeemed claim `chain_cell(&mut fx.w, &op, &tx, <its output index>)`.

Accepted tests: `one_claim_redeems_its_prize`, `two_claims_redeem_in_one_transaction`, `transferred_claim_redeems_into_new_holder_lock` (transfer via the Task-5 pattern from sub-project 1, then redeem with `pay_to: None` so payment goes to the new lock), `principal_payout_then_redemptions_then_final_drain` (fixture with `cursor_open: true`: first a payout tx built like `proto4`'s `partial_payout` paying `100 * SHANNONS` to `fx.depositor` with `fx.liabilities.membership_proof(0)`, cursor 0 to 1, funding successor keeps the prize pool; then redemptions; the last one with `final_drain: true`), and `max_items_redemption_fits_cycle_budget` (32 claims, print cycles).

- [x] **Step 2: Rejected tests (`security_redemption.rs`, same fixture copied)**

Each builds `redeem_tx` then mutates: duplicate redemption (run once, chain, run the same claim again: `-94`/`-97` from the claim script since the absence proof fails, and `SETTLE_ERROR_PROOF` is not reached); payment to a stranger lock (`pay_to: Some(stranger)` → `-77`); wrong amount (edit witness amount and payment capacity → `-73`); wrong prize index (`-73`); forged mmr proof (`-73`); stale absence proof (reuse a pre-payment proof after chaining → `-97`); claim successor missing (drop the claim output → claim `-96`); claim data updated without the funding input (build a tx with only the claim in/out and the new data → `-97`); funding `prize_paid` advanced with no items (payout-shaped witness but `prize_paid` bumped → `-76`); two items sharing one payment output (`-77`); lock change inside redemption (claim output lock differs → `-95`); final drain with prizes unpaid (`final_drain: true` with one of two claims → `-77`); payout final with prizes unpaid (`cursor_open` fixture, payout tx consuming the cell → `-77`). Assert exact codes with the `code_of` helper from `security_claims.rs`.

- [x] **Step 3: End-to-end in `proto3`**

Add `phase2_prizes_redeem_by_claim_then_final_drain`: use `phase2_fixture()` (one entry, one ticket), `expect_ok` the creation tx, decode the created funding's `prizes()` via `InitialEntitlements::derive` as `drain_created_funding` does, seed a claim cell for `(shard 0, position 0)` under the fixture participant lock (`seed_claim`), pay the principal liability with a non-final payout (cursor 0 → 1), then redeem the single prize with `final_drain: true`. Assert the funding cell is consumed and the payment equals the prize amount.

- [x] **Step 4: Run all three, record cycles, commit**

```bash
cd tests/integration && cargo test --test claim_redemption --test security_redemption --test proto3_dao_lifecycle -- --nocapture 2>&1 | grep -E "cycles|test result|FAILED"
git add tests/integration && git commit -m "test: claim redemption lifecycle and adversarial cases"
```

---

### Task 10: Devnet example and Python harness

**Files:**
- Modify: `tests/integration/examples/devnet_round.rs` (settlement JSON), `tests/devnet/test_round_creation.py:755-800`, `tests/devnet/settlement_reorg.py` if it asserts the payout consumed the funding cell.

- [x] **Step 1: Example emits the redemption**

In the settlement branch: after computing `derived`, build the claim's expected redemption for position 0 of shard 0 (the fixture's single ticket): `prize_source(commitment, batch_id, receipt.digest)`, an `SmtHost` absence proof for `prize_obligation_key(ticket, source)`, the successor state via `record_verified_prize`, the MMR membership proof at the prize's index (find it in `derived.prizes()`), and `encode_redemption_witness(&[RedemptionItem { claim_input_index: 1, payment_output_index: 1, prize_index, amount, mmr_proof, absence_proof }])`. Emit `"redemption": {"witness": hex, "claim_data_after": hex, "amount": amount, "prize_index": prize_index}`; the redemption is the final drain, so it has no funding output. `"payout_witness"` now pays principal only (`item.prize == 0`) and the payout is no longer final: emit `"funding_data_after_payout": hex(funding with payout_cursor 1)` and `"principal": item.principal`.

- [x] **Step 2: Python**

Replace the final payout with two transactions:

1. `payout`: inputs funding (index 0) and sponsor; outputs `[funding successor with data settlement["funding_data_after_payout"] and capacity realized - principal, participant payment of principal, change]`; witness `payout_witness`. Assert the participant cell holds `400 * CKB` and the funding cell is live.
2. `redeem`: inputs `[funding successor (index 0), claim cell (entry_hash, 4)]` plus sponsor; cell deps `protocol_deps`; outputs `[claim successor (same lock/type, data claim_data_after), payment to fixture lock of amount, change]`; witnesses `[redemption["witness"], "0x", "0x"]`. Assert the funding cell is dead, the payment equals `redemption["amount"]`, the claim successor is live with the new data, and a replay of the same redeem transaction is rejected.

Update the `assertEqual(int(live...capacity), 400 * CKB + settlement["prize"])` in the partial branch to check the two cells separately, and pass both transactions to `recover_settlement_history` if it replays the payout after a reorg (read `settlement_reorg.py:47-80`; if it asserts the funding cell is dead after the payout, assert it after the redeem instead).

- [x] **Step 3: Run**

```bash
cargo build -p daowow-integration-tests --examples
DAOWOW_RUN_ISOLATED_NODE=1 python3 -m unittest discover -s tests/devnet -v 2>&1 | tail -5
git add tests && git commit -m "test(devnet): principal payout, claim redemption and final drain on the isolated node"
```

Expected: 15 tests OK. Do not rebuild any contract binary while this runs.

---

### Task 11: Review and results

- [x] **Step 1:** Full verification (core tests, no-std, clippy, all contract builds, integration suite, devnet).
- [x] **Step 2:** Read-only `rust-reviewer` on the settlement redemption mode, the claim redemption mode, `derive`, the witness codec and both new suites. Ask specifically: can a claim be paid twice across two transactions; can a claim redeem a prize belonging to another ticket; can payment go anywhere but the claim's lock; can `prize_paid` move without a claim or a claim's paid set move without funding; can a funding cell be drained with prizes unpaid; does any test assert less than its name claims (name each).
- [x] **Step 3:** Mutation probes: remove each guard listed in Task 7's `redeem` and Task 8's `redeem` one at a time; the named security test must fail.
- [x] **Step 4:** Append `## Results` here (counts, cycles for 1/2/32-item redemptions, codes observed, review verdict, what remains: retirement, memento, unclaimed handling, web model) and one status line in `docs/testnet-beta-plan.md`. Commit.

---

## Results (2026-09-16, executed inline on branch `feat/prize-redemption`)

**Suites**

| Suite | Result |
| --- | --- |
| `cargo test -p daowow-core --lib` | 124 passed (prize leaf/source, V3 codec, `locate`, witness v2, prize domain, redemption witness incl. heap bound) |
| no-std check, clippy `-D warnings`, rustfmt | clean |
| `claim_redemption` | 5 passed |
| `security_redemption` | 22 passed |
| `proto3_dao_lifecycle` | 30 passed (incl. end-to-end: two derived prizes redeemed by seeded claims, then final principal drain) |
| every other integration suite | green; `smoke` keeps its 2 pre-existing failures |
| isolated Docker devnet (`DAOWOW_RUN_ISOLATED_NODE=1`) | 15 passed in 1238s: four claim redemptions committed on the node (prize 0.70 CKB topped up to a 61 CKB payment cell), principal payout as the final drain, orphaned funding and orphaned redemption recovered after a reorg, replay of a committed redemption rejected, unchanged-successor redemption rejected |

**Measurements** (ckb-testtool)

| Shape | Cycles |
| --- | --- |
| phase-two funding creation, 32 entries (evidence 4,750 bytes, was 32 winner proofs larger) | 13.9M to 14.1M |
| one-claim redemption | 1,273,014 |
| two-claim redemption | 2,414,096 |
| final-drain redemption of two claims | 2,388,145 |
| 32-claim redemption (final) | 49,301,152 of 70M |
| final principal payout after prizes complete | 136,249 |

**Protocol properties surfaced by the tests, now documented**

- A funding successor must keep at least its own occupied capacity (about 307 CKB); when the unpaid remainder would drop below it, the remaining items must go in one final transaction. For a small prize pool the viable order is redemption first (the cell keeps principal), then the principal payout as the final drain; both orders are accepted by the contracts.
- A payment cell must cover its own occupied capacity (47 to 61 CKB), so a prize smaller than that is topped up by the sponsor; the settlement counts only the authenticated amount.
- The settlement now requires the claim successor's paid counters to advance by exactly the item and its root to change. Without this, an unchanged successor passed the claim script as a transfer while the settlement paid the prize, letting one ticket drain other winners' prizes. Found while writing the duplicate-redemption test; pinned by `unchanged_claim_successor_cannot_collect_a_prize`.
- CKB executes script groups in script-hash order, so when both scripts reject, the reported code is not determined by input order. Tests that pin a settlement-only guard keep the claim side consistent (`wrong_amount_is_rejected`, `items_out_of_prize_order_are_rejected_by_the_settlement_only`, no-claim-input case) and vice versa (`forged_paid_root_in_the_successor_is_rejected_by_the_claim_only`).

**Review** (read-only rust-reviewer): no CRITICAL/HIGH. MEDIUM: 32 items at the 8192-byte per-proof cap encode to 525,317 bytes, above the 512 KiB never-freed heap that every claim script loads the witness into; fixed with a 128 KiB whole-witness bound (7 maximal items, or 32 realistic ones). MEDIUM: `wrapping_add` in the settlement counter check, replaced with `checked_add`. LOW: two `unwrap` calls replaced; three guards without isolating tests now have them. Double-pay, cross-ticket, payee redirection, one-sided updates, premature drain and panics on attacker data: none found.

**Mutation probes** (guard removed, named test fails, restored): settlement successor counters/root (`unchanged_claim_successor_cannot_collect_a_prize`), payment lock (`payment_to_a_stranger_is_rejected`), prize ordering (`items_out_of_prize_order_are_rejected_by_the_settlement_only`), prize membership (`wrong_amount_is_rejected`); claim lock unchanged (`lock_change_inside_a_redemption_is_rejected`), claim successor byte-exact (`forged_paid_root_in_the_successor_is_rejected_by_the_claim_only`). Defence-in-depth guards that are shadowed by design: the final-drain completeness gate in redemption mode (conservation fails first), `amount == 0` and duplicate claim index (both scripts reject).

**Not implemented**: retirement, memento, non-winner claim recovery, unclaimed-prize expiry, artwork, wallet display, the web entry quote and the local UI model (`apps/web/engine.js` still pays prizes to participants in its simulation). Follow-ups: single-pass output scans in both contracts (successor search is O(items x outputs)); the entry UI quote for claim capacity.
