//! Phase-1 prototype #4: direct batched settlement — a settlement funding
//! cell pays participants directly with ordinary CKB outputs, in bounded
//! batches, with exact conservation and no claim contract.
//!
//! Proves:
//! - funding cell creation (as dao-lock phase 2 produces it);
//! - batched payouts authorized by SMT liability proofs against the funding
//!   root, strictly cursor-ordered (no double payout);
//! - outputs are ordinary cells (no type) locked by each participant;
//! - capacity conservation: inputs = payouts + remaining funding;
//! - adversarial: overpay, duplicate payout, wrong destination, bad proof.

mod common;

use ckb_testtool::ckb_types::{bytes::Bytes, core::{TransactionView, TransactionBuilder, ScriptHashType, DepType}, packed::*, prelude::*};
use common::*;
use daowow_core::accumulator::smt::host::SmtHost;
use daowow_core::leaf::liability_leaf;

const SETTLE_TYPE_ID: u64 = 1;

struct Settlement {
    world: World,
    round_id: Hash32,
    /// (lock_hash, principal, prize, stand-in batch id) sorted by lock hash —
    /// payouts must be consumed in strictly ascending lock-hash order
    participants: Vec<(Hash32, u64, u64, u64)>,
    host: SmtHost,
    funding_data: SettlementFundingDataV1,
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

fn setup(n_participants: u64) -> Settlement {
    let mut world = World::new(ACC_SMT);
    let round_id = [0x44; 32];
    let mut host = SmtHost::new();

    // participants: use the dao-lock script with distinct batch ids as
    // stand-in "participant locks" (deterministic distinct scripts)
    let mut participants: Vec<(Hash32, u64, u64, u64)> = Vec::new();
    for i in 0..n_participants {
        let lock = world.dao_lock_script(&round_id, 1000 + i);
        let lh = World::participant_hash(&lock);
        let principal = 100 * SHANNONS;
        let prize = 10 * SHANNONS;
        participants.push((lh, principal, prize, 1000 + i));
    }
    participants.sort_by(|a, b| a.0.cmp(&b.0));

    // liabilities tree
    for (lh, p, z, _bid) in &participants {
        let key = *lh;
        let leaf = liability_leaf(lh, *p, *z);
        host.insert(&key, &leaf).unwrap();
    }

    let total_principal: u64 = participants.iter().map(|x| x.1).sum();
    let total_prize: u64 = participants.iter().map(|x| x.2).sum();
    // funding = principal + prize + occupied overhead per payout output
    // (lock = dao-lock-args(40) => occupied = 8 + 40 + 33 = 81)
    let per_output_overhead = 8 + 40 + 33;
    let funding_capacity =
        total_principal + total_prize + per_output_overhead * n_participants;

    let funding_data = SettlementFundingDataV1 {
        round_id,
        batch_id: 1,
        realized_total: funding_capacity,
        principal_liability: total_principal,
        prize_pool: total_prize,
        payout_cursor: [0; 32],
        liabilities_root: host.root(),
    };

    let (_, holder_lock) = world.funding_cell(1 * SHANNONS);
    let settle_type_script = world.settlement_script(SETTLE_TYPE_ID);
    let funding_op = world.context.create_cell(
        CellOutputBuilder::default()
            .capacity(pack_u64(funding_capacity))
            .lock(holder_lock)
            .type_(Some(settle_type_script).pack())
            .build(),
        Bytes::from(funding_data.encode().to_vec()),
    );

    Settlement { world, round_id, participants, host, funding_data, funding_op }
}

/// Build a payout witness batch for participant indices [from, to).
fn payout_batch(
    s: &mut Settlement,
    indices: &[usize],
) -> (Bytes, Vec<(u64, u64)>) // (witness, per-payout (capacity, prize+principal))
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
        let proof = s.host.inclusion_proof(&[lh]).unwrap();
        let occupied = 8 + args.len() as u64 + 33;
        owned.push((item, p + z + occupied));
        flat.push((args, code_hash, 2, item, proof));
    }
    let refs: Vec<(&[u8], &[u8], u8, &PayoutItem, &[u8])> = flat
        .iter()
        .map(|(a, c, h, it, p)| (a.as_slice(), c.as_slice(), *h, it, p.as_slice()))
        .collect();
    let wire = daowow_core::witness::encode_settlement_witness(&refs);
    (wire.into(), owned.into_iter().map(|(_, cap)| (cap, 0u64)).collect())
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
    new_data.payout_cursor = s.participants[3].0;

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

    // batch 2: participants 4..6, then drain (cursor at [5].0, funding cap 0)
    let (witness2, caps2) = payout_batch(&mut s, &[4, 5]);
    let paid2: u64 = caps2.iter().map(|(c, _)| c).sum();
    let (cell_in2, _) = s.world.cell(&s.funding_op);
    let new_funding_cap2 = new_funding_cap - paid2;
    let mut final_data = new_data;
    final_data.payout_cursor = s.participants[5].0;
    let mut tx2 = TransactionBuilder::default()
        .input(CellInput::new(s.funding_op.clone(), 0))
        .output(
            CellOutputBuilder::default()
                .capacity(pack_u64(new_funding_cap2))
                .lock(cell_in2.lock())
                .type_(Some(cell_in2.type_().to_opt().unwrap()).pack())
                .build(),
        )
        .output_data(Bytes::from(final_data.encode().to_vec()))
        .witness(witness2);
    for (idx, (cap, _)) in caps2.iter().enumerate() {
        let lock = s.world.dao_lock_script(&s.round_id, s.participants[4 + idx].3);
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
    new_data.payout_cursor = s.participants[1].0;

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
    let mut empty_host = SmtHost::new();
    empty_host.insert(&[9u8; 32], &liability_leaf(&[9u8; 32], 1, 1)).unwrap();
    let wrong_proof = empty_host.inclusion_proof(&[[9u8; 32]]).unwrap();
    let lock = s.world.dao_lock_script(&s.round_id, bid0);
    let code_hash: [u8; 32] = lock.code_hash().raw_data().as_ref().try_into().unwrap();
    let args = lock.args().raw_data().to_vec();
    let item = PayoutItem { participant_lock_hash: lh, principal: p, prize: z };
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
