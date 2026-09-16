//! Phase-1 prototype #4: direct batched settlement — a settlement funding
//! cell pays participants directly with ordinary CKB outputs, in bounded
//! batches, with exact conservation and no claim contract.
//!
//! Proves:
//! - spending seeded funding cells (creation is tested in the DAO lifecycle suite);
//! - batched payouts authorized by position-bound MMR proofs against the
//!   immutable funding root/count, with a contiguous numeric cursor;
//! - outputs are ordinary cells (no type) locked by each participant;
//! - funding conservation: owed liabilities + remaining funding, with sponsor gifts;
//! - adversarial: funding leakage, duplicate payout, wrong destination, bad proof.

mod common;

use ckb_testtool::ckb_types::{
    bytes::Bytes,
    core::{DepType, ScriptHashType, TransactionBuilder, TransactionView},
    packed::*,
    prelude::*,
};
use common::*;
use daowow_core::accumulator::mmr::host::MmrHost;
use daowow_core::leaf::liability_leaf;

const SETTLE_TYPE_ID: u64 = 1;

#[test]
fn public_settlement_lock_requires_the_matching_enforcing_type() {
    for wrong_type in [false, true] {
        let mut world = World::new(ACC_SMT);
        let public_lock = world.settlement_public_lock();
        let (_, ordinary) = world.funding_cell(1000 * SHANNONS);
        let fake_type = if wrong_type {
            Some(
                ordinary
                    .clone()
                    .as_builder()
                    .args(Bytes::from(vec![0; 40]).pack())
                    .build(),
            )
        } else {
            None
        };
        let input = world.context.create_cell(
            CellOutputBuilder::default()
                .capacity(pack_u64(1000 * SHANNONS))
                .lock(public_lock)
                .type_(fake_type.pack())
                .build(),
            Bytes::new(),
        );
        let tx = TransactionBuilder::default()
            .input(CellInput::new(input, 0))
            .output(
                CellOutputBuilder::default()
                    .capacity(pack_u64(1000 * SHANNONS))
                    .lock(ordinary)
                    .build(),
            )
            .output_data(Bytes::new())
            .build();
        let error = expect_fail(&mut world.context, &tx);
        assert!(format!("{error:?}").contains("error code -72"), "{error:?}");
    }
}

#[test]
fn public_lock_mode_cannot_be_used_as_a_permissive_type() {
    let mut world = World::new(ACC_SMT);
    let public_mode = world.settlement_public_lock();
    let (_, ordinary) = world.funding_cell(1000 * SHANNONS);
    let input = world.context.create_cell(
        CellOutputBuilder::default()
            .capacity(pack_u64(1000 * SHANNONS))
            .lock(ordinary.clone())
            .type_(Some(public_mode.clone()).pack())
            .build(),
        Bytes::new(),
    );
    let tx = TransactionBuilder::default()
        .input(CellInput::new(input, 0))
        .output(
            CellOutputBuilder::default()
                .capacity(pack_u64(1000 * SHANNONS))
                .lock(ordinary.clone())
                .build(),
        )
        .output_data(Bytes::new())
        .build();
    let error = expect_fail(&mut world.context, &tx);
    assert!(format!("{error:?}").contains("error code -72"), "{error:?}");

    // Creation in public mode has no group inputs and must also fail.
    let (funding, _) = world.funding_cell(1000 * SHANNONS);
    let tx = TransactionBuilder::default()
        .input(CellInput::new(funding, 0))
        .output(
            CellOutputBuilder::default()
                .capacity(pack_u64(1000 * SHANNONS))
                .lock(ordinary)
                .type_(Some(public_mode).pack())
                .build(),
        )
        .output_data(Bytes::new())
        .build();
    let error = expect_fail(&mut world.context, &tx);
    assert!(format!("{error:?}").contains("error code -72"), "{error:?}");
}

#[test]
fn settlement_rejects_shared_payout_across_type_groups() {
    // Without transaction-wide group isolation both funding cells count
    // the one payout, freeing the other payment for an arbitrary output.
    let mut s = setup(4);
    let (witness, caps) = payout_batch(&mut s, &[0]);
    let paid = caps[0].0;
    let (input, data) = s.world.cell(&s.funding_op);
    let capacity: u64 = input.capacity().unpack();
    let second = input
        .clone()
        .as_builder()
        .type_(Some(s.world.settlement_script(2)).pack())
        .build();
    let second_op = s.world.context.create_cell(second.clone(), data);
    let mut after = s.funding_data;
    after.payout_cursor = 1;
    let payout_lock = s.world.dao_lock_script(&s.round_id, s.participants[0].3);
    let tx = TransactionBuilder::default()
        .input(CellInput::new(s.funding_op.clone(), 0))
        .input(CellInput::new(second_op, 0))
        .output(
            input
                .clone()
                .as_builder()
                .capacity(pack_u64(capacity - paid))
                .build(),
        )
        .output_data(Bytes::from(after.encode().to_vec()))
        .output(
            second
                .as_builder()
                .capacity(pack_u64(capacity - paid))
                .build(),
        )
        .output_data(Bytes::from(after.encode().to_vec()))
        .output(
            CellOutputBuilder::default()
                .capacity(pack_u64(paid))
                .lock(payout_lock)
                .build(),
        )
        .output_data(Bytes::new())
        .output(
            CellOutputBuilder::default()
                .capacity(pack_u64(paid))
                .lock(input.lock())
                .build(),
        )
        .output_data(Bytes::new())
        .witness(witness.clone())
        .witness(witness)
        .build();
    let error = expect_fail(&mut s.world.context, &tx);
    assert!(format!("{error:?}").contains("error code -72"), "{error:?}");
}

struct Settlement {
    world: World,
    round_id: Hash32,
    /// (lock_hash, principal, prize, stand-in batch id) sorted by lock hash —
    /// payouts must be consumed in strictly ascending lock-hash order
    participants: Vec<(Hash32, u64, u64, u64)>,
    host: MmrHost,
    funding_data: SettlementFundingDataV3,
    funding_op: OutPoint,
}

/// Participant "locks": reuse the always-success script per participant is
/// identical for everyone; instead we derive distinct participant scripts by
/// deploying the same binary with distinct args is not possible for
/// always-success — so participants are distinguished by distinct funding
/// locks built from the entry-lock binary with distinct args (its logic is
/// irrelevant here because settlement outputs are checked by hash only in
/// the witness; the actual lock script bytes are carried in the witness).
fn packed_bytes_wire(b: Vec<u8>) -> ckb_testtool::ckb_types::packed::Bytes {
    pack_pbytes(&b)
}

fn setup_short(n_participants: u64) -> Settlement {
    let mut s = setup(n_participants);
    // shrink the funding cell by 1 shannon: conservation now impossible
    let (cell, data) = s.world.cell(&s.funding_op);
    let cap: u64 = cell.capacity().unpack();
    let short = cell.as_builder().capacity(pack_u64(cap - 1)).build();
    s.world
        .context
        .create_cell_with_out_point(s.funding_op.clone(), short, data);
    s
}

fn partial_payout(s: &mut Settlement, indices: &[usize]) -> TransactionView {
    let (wire, caps) = payout_batch(s, indices);
    let (input, _) = s.world.cell(&s.funding_op);
    let capacity: u64 = input.capacity().unpack();
    let paid: u64 = caps.iter().map(|p| p.0).sum();
    let mut after = s.funding_data;
    after.payout_cursor += indices.len() as u64;
    let mut tx = TransactionBuilder::default()
        .input(CellInput::new(s.funding_op.clone(), 0))
        .output(
            input
                .as_builder()
                .capacity(pack_u64(capacity - paid))
                .build(),
        )
        .output_data(Bytes::from(after.encode().to_vec()))
        .witness(wire);
    for (index, cap) in indices.iter().zip(caps) {
        let lock = s
            .world
            .dao_lock_script(&s.round_id, s.participants[*index].3);
        tx = tx
            .output(
                CellOutputBuilder::default()
                    .capacity(pack_u64(cap.0))
                    .lock(lock)
                    .build(),
            )
            .output_data(Bytes::new());
    }
    tx.build()
}

#[test]
fn settlement_rejects_skipping_to_a_later_liability() {
    for indices in [&[5][..], &[0, 2][..]] {
        let mut s = setup(6);
        let skipped = partial_payout(&mut s, indices);
        let error = expect_fail(&mut s.world.context, &skipped);
        assert!(format!("{error:?}").contains("error code -73"), "{error:?}");
    }
}

#[test]
fn settlement_rejects_replay_after_cursor_advances() {
    let mut s = setup(6);
    let first = partial_payout(&mut s, &[0]);
    expect_ok(&mut s.world.context, &first);
    chain_cell(&mut s.world, &s.funding_op, &first, 0);
    let (_, data) = s.world.cell(&s.funding_op);
    s.funding_data = SettlementFundingDataV3::decode(&data).unwrap();
    let replay = partial_payout(&mut s, &[0]);
    let error = expect_fail(&mut s.world.context, &replay);
    assert!(format!("{error:?}").contains("error code -73"), "{error:?}");
    let valid = partial_payout(&mut s, &[1]);
    expect_ok(&mut s.world.context, &valid);
}

#[test]
fn settlement_rejects_mutated_root_count_and_cursor() {
    for field in 0..3 {
        let mut s = setup(6);
        let tx = partial_payout(&mut s, &[0]);
        let mut after =
            SettlementFundingDataV3::decode(&tx.outputs_data().get(0).unwrap().raw_data()).unwrap();
        match field {
            0 => after.liabilities_root = [9; 32],
            1 => after.liability_count += 1,
            _ => after.payout_cursor += 1,
        }
        let mut data: Vec<_> = tx.outputs_data().into_iter().collect();
        data[0] = Bytes::from(after.encode().to_vec()).pack();
        let tx = tx.as_advanced_builder().set_outputs_data(data).build();
        let error = expect_fail(&mut s.world.context, &tx);
        let expected = if field == 2 {
            "error code -74"
        } else {
            "error code -76"
        };
        assert!(format!("{error:?}").contains(expected), "{error:?}");
    }
}

#[test]
fn settlement_cannot_finish_with_unpaid_indices() {
    let mut s = setup(4);
    let tx = partial_payout(&mut s, &[0, 1]);
    let outputs: Vec<_> = tx.outputs().into_iter().skip(1).collect();
    let data: Vec<_> = tx.outputs_data().into_iter().skip(1).collect();
    let paid: u64 = outputs
        .iter()
        .map(|cell: &CellOutput| {
            let cap: u64 = cell.capacity().unpack();
            cap
        })
        .sum();
    let (input, input_data) = s.world.cell(&s.funding_op);
    // Valid occupied capacity, but an underfunded initial tree. Conservation
    // alone must not allow finalisation while two committed indices remain.
    s.world.context.create_cell_with_out_point(
        s.funding_op.clone(),
        input.as_builder().capacity(pack_u64(paid)).build(),
        input_data,
    );
    let tx = tx
        .as_advanced_builder()
        .set_outputs(outputs)
        .set_outputs_data(data)
        .build();
    let error = expect_fail(&mut s.world.context, &tx);
    assert!(format!("{error:?}").contains("error code -74"), "{error:?}");
}

#[test]
fn settlement_rejects_underoccupied_remainder() {
    let mut s = setup(3);
    let tx = partial_payout(&mut s, &[0, 1]);
    // 255 CKB remains, but the digest-bound public funding cell occupies 259 CKB.
    let error = expect_fail(&mut s.world.context, &tx);
    assert!(format!("{error:?}").contains("error code -72"), "{error:?}");
}

#[test]
fn settlement_rejects_cursor_replay_and_lock_change() {
    for mutate_cursor in [true, false] {
        let mut s = setup(4);
        let tx = partial_payout(&mut s, &[0]);
        let mut outputs: Vec<CellOutput> = tx.outputs().into_iter().collect();
        let mut data: Vec<ckb_testtool::ckb_types::packed::Bytes> =
            tx.outputs_data().into_iter().collect();
        if mutate_cursor {
            data[0] = Bytes::from(s.funding_data.encode().to_vec()).pack();
        } else {
            let (_, evil) = s.world.funding_cell(1000 * SHANNONS);
            let evil = evil.as_builder().args(Bytes::from(vec![9]).pack()).build();
            outputs[0] = outputs[0].clone().as_builder().lock(evil).build();
        }
        let tx = tx
            .as_advanced_builder()
            .set_outputs(outputs)
            .set_outputs_data(data)
            .build();
        let error = expect_fail(&mut s.world.context, &tx);
        let expected = if mutate_cursor {
            "error code -74"
        } else {
            "error code -72"
        };
        assert!(format!("{error:?}").contains(expected), "{error:?}");
    }
}

fn setup(n_participants: u64) -> Settlement {
    setup_amounts(n_participants, 245 * SHANNONS, 10 * SHANNONS)
}

fn setup_amounts(n_participants: u64, principal: u64, prize: u64) -> Settlement {
    let mut world = World::new(ACC_SMT);
    let round_id = [0x44; 32];
    let mut host = MmrHost::new();

    // participants: use the dao-lock script with distinct batch ids as
    // stand-in "participant locks" (deterministic distinct scripts)
    let mut participants: Vec<(Hash32, u64, u64, u64)> = Vec::new();
    for i in 0..n_participants {
        let lock = world.dao_lock_script(&round_id, 1000 + i);
        let lh = World::participant_hash(&lock);
        participants.push((lh, principal, prize, 1000 + i));
    }
    participants.sort_by(|a, b| a.0.cmp(&b.0));

    // liabilities tree
    for (lh, p, z, _bid) in &participants {
        let leaf = liability_leaf(lh, *p, *z);
        host.append(&leaf).unwrap();
    }

    let total_principal: u64 = participants.iter().map(|x| x.1).sum();
    let total_prize: u64 = participants.iter().map(|x| x.2).sum();
    // Principal already includes full deposited capacity. Output occupancy
    // is not an additional liability charged to this funding cell.
    let funding_capacity = total_principal + total_prize;

    let funding_data = SettlementFundingDataV3 {
        round_id,
        batch_id: 1,
        realized_total: funding_capacity,
        principal_liability: total_principal,
        prize_pool: total_prize,
        payout_cursor: 0,
        liability_count: n_participants,
        liabilities_root: host.root().unwrap(),
        prize_count: 0,
        prize_root: [0; 32],
        prize_paid: 0,
    };

    let holder_lock = world.settlement_public_lock();
    let settle_type_script = world.settlement_script(SETTLE_TYPE_ID);
    let funding_op = world.context.create_cell(
        CellOutputBuilder::default()
            .capacity(pack_u64(funding_capacity))
            .lock(holder_lock)
            .type_(Some(settle_type_script).pack())
            .build(),
        Bytes::from(funding_data.encode().to_vec()),
    );

    Settlement {
        world,
        round_id,
        participants,
        host,
        funding_data,
        funding_op,
    }
}

/// Build a payout witness batch for participant indices [from, to).
fn payout_batch(s: &mut Settlement, indices: &[usize]) -> (Bytes, Vec<(u64, u64)>) // (witness, per-payout (capacity, prize+principal))
{
    let mut owned: Vec<(PayoutItem, u64)> = Vec::new();
    let mut flat: Vec<(Vec<u8>, Vec<u8>, u8, PayoutItem, Vec<u8>)> = Vec::new();
    for &i in indices {
        let (lh, p, z, bid) = s.participants[i];
        let lock = s.world.dao_lock_script(&s.round_id, bid);
        let code_hash: Vec<u8> = lock.code_hash().raw_data().to_vec();
        let args = lock.args().raw_data().to_vec();
        let item = PayoutItem {
            participant_lock_hash: lh,
            principal: p,
            prize: z,
        };
        let proof = s.host.membership_proof(i as u64).unwrap();
        let occupied = (8 + args.len() as u64 + 33) * SHANNONS;
        owned.push((item, (p + z).max(occupied)));
        flat.push((args, code_hash, 2, item, proof));
    }
    let refs: Vec<(&[u8], &[u8], u8, &PayoutItem, &[u8])> = flat
        .iter()
        .map(|(a, c, h, it, p)| (a.as_slice(), c.as_slice(), *h, it, p.as_slice()))
        .collect();
    let wire = daowow_core::witness::encode_settlement_witness(&refs);
    (
        wire.into(),
        owned.into_iter().map(|(_, cap)| (cap, 0u64)).collect(),
    )
}

#[test]
fn settlement_accepts_sponsor_gift_without_charging_funding() {
    let mut s = setup(4);
    let tx = partial_payout(&mut s, &[0]);
    let (sponsor, sponsor_lock) = s.world.funding_cell(100 * SHANNONS);
    let mut outputs: Vec<_> = tx.outputs().into_iter().collect();
    outputs[1] = outputs[1]
        .clone()
        .as_builder()
        .capacity(pack_u64(260 * SHANNONS))
        .build();
    let tx = tx
        .as_advanced_builder()
        .input(CellInput::new(sponsor, 0))
        .set_outputs(outputs)
        .output(
            CellOutputBuilder::default()
                .capacity(pack_u64(94 * SHANNONS))
                .lock(sponsor_lock)
                .build(),
        )
        .output_data(Bytes::new())
        .build();
    // Funding pays 255; sponsor gives 5 and pays the 1 CKB test fee.
    expect_ok(&mut s.world.context, &tx);
    for delta in [-1i64, 1] {
        let mut outputs: Vec<_> = tx.outputs().into_iter().collect();
        outputs[0] = outputs[0]
            .clone()
            .as_builder()
            .capacity(pack_u64(((765 * SHANNONS) as i64 + delta) as u64))
            .build();
        let bad = tx
            .clone()
            .as_advanced_builder()
            .set_outputs(outputs)
            .build();
        expect_fail(&mut s.world.context, &bad);
    }
}

/// Drain all remaining liabilities; sponsors supply occupancy gifts and fees.
fn final_payout(s: &mut Settlement) -> TransactionView {
    let indices: Vec<_> = (s.funding_data.payout_cursor as usize..s.participants.len()).collect();
    let (wire, caps) = payout_batch(s, &indices);
    let owed: u64 = indices
        .iter()
        .map(|i| s.participants[*i].1 + s.participants[*i].2)
        .sum();
    let total_outputs: u64 = caps.iter().map(|p| p.0).sum();
    let (sponsor, sponsor_lock) = s.world.funding_cell(total_outputs - owed + 100 * SHANNONS);
    let mut tx = TransactionBuilder::default()
        .input(CellInput::new(s.funding_op.clone(), 0))
        .input(CellInput::new(sponsor, 0))
        .witness(wire);
    for (index, (cap, _)) in indices.iter().zip(caps) {
        tx = tx
            .output(
                CellOutputBuilder::default()
                    .capacity(pack_u64(cap))
                    .lock(
                        s.world
                            .dao_lock_script(&s.round_id, s.participants[*index].3),
                    )
                    .build(),
            )
            .output_data(Bytes::new());
    }
    tx.output(
        CellOutputBuilder::default()
            .capacity(pack_u64(99 * SHANNONS))
            .lock(sponsor_lock)
            .build(),
    )
    .output_data(Bytes::new())
    .build()
}

#[test]
fn settlement_drains_small_prizes_with_sponsored_occupancy() {
    let mut s = setup_amounts(32, 0, 10 * SHANNONS);
    let tx = final_payout(&mut s);
    // 320 CKB of prizes, 4,320 CKB of occupancy gifts, no funding remainder.
    let cycles = expect_ok(&mut s.world.context, &tx);
    println!("cycles: 32 small-prize sponsored final payouts = {cycles}");
    let mut outputs: Vec<_> = tx.outputs().into_iter().collect();
    outputs[0] = outputs[0]
        .clone()
        .as_builder()
        .capacity(pack_u64(144 * SHANNONS))
        .build();
    expect_fail(
        &mut s.world.context,
        &tx.as_advanced_builder().set_outputs(outputs).build(),
    );
}

#[test]
fn settlement_drains_maximum_64_liability_tail() {
    // A 32-entry batch can have 32 distinct depositors plus 32 distinct
    // prize-only global winners before consolidation. Every final tail must
    // remain payable even when a partial remainder would be underoccupied.
    let mut s = setup_amounts(64, 0, 10 * SHANNONS);
    let tx = final_payout(&mut s);
    let cycles = expect_ok(&mut s.world.context, &tx);
    assert!(cycles < 70_000_000, "64-liability tail cost: {cycles}");
    println!("cycles: 64-liability sponsored final tail = {cycles}");
}

#[test]
fn settlement_rejects_underpaying_owed_capacity() {
    let mut s = setup(4);
    let tx = partial_payout(&mut s, &[0]);
    let mut outputs: Vec<_> = tx.outputs().into_iter().collect();
    outputs[1] = outputs[1]
        .clone()
        .as_builder()
        .capacity(pack_u64(255 * SHANNONS - 1))
        .build();
    expect_fail(
        &mut s.world.context,
        &tx.as_advanced_builder().set_outputs(outputs).build(),
    );
}

#[test]
fn settlement_batched_direct_payouts() {
    let mut s = setup(6);

    // batch 1: participants 0..4
    let (witness, caps) = payout_batch(&mut s, &[0, 1, 2, 3]);
    let funding_cap: u64 = {
        let (c, _) = s.world.cell(&s.funding_op);
        c.capacity().unpack()
    };
    let paid: u64 = caps.iter().map(|(c, _)| c).sum();
    let new_funding_cap = funding_cap - paid;
    let mut new_data = s.funding_data;
    new_data.payout_cursor = 4;

    let settle_type_script = s.world.settlement_script(SETTLE_TYPE_ID);
    let (cell_in, _) = s.world.cell(&s.funding_op);
    let mut builder = TransactionBuilder::default()
        .input(CellInput::new(s.funding_op.clone(), 0))
        .output(
            CellOutputBuilder::default()
                .capacity(pack_u64(new_funding_cap))
                .lock(cell_in.lock())
                .type_(Some(settle_type_script).pack())
                .build(),
        )
        .output_data(Bytes::from(new_data.encode().to_vec()))
        .witness(witness);
    for (idx, (cap, _)) in caps.iter().enumerate() {
        let lock = s.world.dao_lock_script(&s.round_id, s.participants[idx].3);
        builder = builder
            .output(
                CellOutputBuilder::default()
                    .capacity(pack_u64(*cap))
                    .lock(lock)
                    .build(),
            )
            .output_data(Bytes::new());
    }
    let tx = builder.build();
    let c = expect_ok(&mut s.world.context, &tx);
    println!("cycles: settlement batch of 4 direct payouts = {}", c);
    chain_cell(&mut s.world, &s.funding_op, &tx, 0);

    // Final batch consumes the funding cell; never create a zero-capacity
    // remainder, which is invalid under node-level occupied-capacity rules.
    let (witness2, caps2) = payout_batch(&mut s, &[4, 5]);
    let paid2: u64 = caps2.iter().map(|(c, _)| c).sum();
    assert_eq!(new_funding_cap, paid2);
    let mut tx2 = TransactionBuilder::default()
        .input(CellInput::new(s.funding_op.clone(), 0))
        .witness(witness2);
    for (idx, (cap, _)) in caps2.iter().enumerate() {
        let lock = s
            .world
            .dao_lock_script(&s.round_id, s.participants[4 + idx].3);
        tx2 = tx2
            .output(
                CellOutputBuilder::default()
                    .capacity(pack_u64(*cap))
                    .lock(lock)
                    .build(),
            )
            .output_data(Bytes::new());
    }
    let tx2 = tx2.build();
    let c2 = expect_ok(&mut s.world.context, &tx2);
    println!("cycles: settlement batch of 2 (drain) = {}", c2);
}

#[test]
fn settlement_rejects_overpay() {
    let mut s = setup_short(2);
    let (witness, caps) = payout_batch(&mut s, &[0, 1]);
    let funding_cap: u64 = {
        let (c, _) = s.world.cell(&s.funding_op);
        c.capacity().unpack()
    };
    let paid: u64 = caps.iter().map(|(c, _)| c).sum();
    // funding is 1 shannon short: remainder would be negative — use 0 and let
    // the contract reject the conservation violation
    let new_funding_cap = funding_cap.saturating_sub(paid);
    let mut new_data = s.funding_data;
    new_data.payout_cursor = 2;

    let settle_type_script = s.world.settlement_script(SETTLE_TYPE_ID);
    let (cell_in, _) = s.world.cell(&s.funding_op);
    let mut builder = TransactionBuilder::default()
        .input(CellInput::new(s.funding_op.clone(), 0))
        .output(
            CellOutputBuilder::default()
                .capacity(pack_u64(new_funding_cap))
                .lock(cell_in.lock())
                .type_(Some(settle_type_script).pack())
                .build(),
        )
        .output_data(Bytes::from(new_data.encode().to_vec()))
        .witness(witness);
    for (idx, (cap, _)) in caps.iter().enumerate() {
        let lock = s.world.dao_lock_script(&s.round_id, s.participants[idx].3);
        builder = builder
            .output(
                CellOutputBuilder::default()
                    .capacity(pack_u64(*cap))
                    .lock(lock)
                    .build(),
            )
            .output_data(Bytes::new());
    }
    let tx = builder.build();
    let e = expect_fail(&mut s.world.context, &tx);
    println!("settlement conservation violation rejected: {:?}", e);
}

#[test]
fn settlement_rejects_duplicate_and_bad_proof() {
    let mut s = setup(3);
    // duplicate payout: two witness items for participant 0 (order violated)
    let (dup_wire, _) = payout_batch(&mut s, &[0, 0]);
    let funding_cap: u64 = {
        let (c, _) = s.world.cell(&s.funding_op);
        c.capacity().unpack()
    };
    let settle_type_script = s.world.settlement_script(SETTLE_TYPE_ID);
    let settle_type_script2 = settle_type_script.clone();
    let (cell_in, _) = s.world.cell(&s.funding_op);
    let per_output_overhead = 8 + 40 + 33;
    let p0 = s.participants[0];
    let cap0 = p0.1 + p0.2 + per_output_overhead;
    let lock0 = s.world.dao_lock_script(&s.round_id, p0.3);
    let tx = TransactionBuilder::default()
        .input(CellInput::new(s.funding_op.clone(), 0))
        .output(
            CellOutputBuilder::default()
                .capacity(pack_u64(funding_cap - 2 * cap0))
                .lock(cell_in.lock())
                .type_(Some(settle_type_script).pack())
                .build(),
        )
        .output_data(Bytes::from(s.funding_data.encode().to_vec()))
        .witness(dup_wire)
        .output(
            CellOutputBuilder::default()
                .capacity(pack_u64(cap0))
                .lock(lock0.clone())
                .build(),
        )
        .output_data(Bytes::new())
        .output(
            CellOutputBuilder::default()
                .capacity(pack_u64(cap0))
                .lock(lock0)
                .build(),
        )
        .output_data(Bytes::new())
        .build();
    let e = expect_fail(&mut s.world.context, &tx);
    println!("duplicate payout rejected: {:?}", e);

    // bad proof: valid encoding, proof of the wrong key (fabricated against
    // an empty tree -> cannot verify against funding root)
    let (lh, p, z, bid0) = s.participants[0];
    let mut empty_host = MmrHost::new();
    empty_host
        .append(&liability_leaf(&[9u8; 32], 1, 1))
        .unwrap();
    let wrong_proof = empty_host.membership_proof(0).unwrap();
    let lock = s.world.dao_lock_script(&s.round_id, bid0);
    let code_hash: [u8; 32] = lock.code_hash().raw_data().as_ref().try_into().unwrap();
    let args = lock.args().raw_data().to_vec();
    let item = PayoutItem {
        participant_lock_hash: lh,
        principal: p,
        prize: z,
    };
    let wire = daowow_core::witness::encode_settlement_witness(&[(
        args.as_slice(),
        code_hash.as_slice(),
        2,
        &item,
        wrong_proof.as_slice(),
    )]);
    let tx2 = TransactionBuilder::default()
        .input(CellInput::new(s.funding_op.clone(), 0))
        .output(
            CellOutputBuilder::default()
                .capacity(pack_u64(funding_cap - cap0))
                .lock(cell_in.lock())
                .type_(Some(settle_type_script2).pack())
                .build(),
        )
        .output_data(Bytes::from(s.funding_data.encode().to_vec()))
        .witness(packed_bytes_wire(wire))
        .output(
            CellOutputBuilder::default()
                .capacity(pack_u64(cap0))
                .lock(lock)
                .build(),
        )
        .output_data(Bytes::new())
        .build();
    let e = expect_fail(&mut s.world.context, &tx2);
    println!("bad liability proof rejected: {:?}", e);
}
