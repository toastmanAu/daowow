//! Phase-1 prototype #1: Entry shard contention and accumulator updates
//! through the real entry-shard-type contract on CKB-VM.
//!
//! Proves:
//! - round + shard creation;
//! - contended shard head consumed and replaced sequentially (UTXO
//!   serialization of a single mutable head);
//! - batched entries per shard transaction;
//! - parallel shards;
//! - SMT insert-certificate authorization of the accumulator transition;
//! - entry cells bound one-to-one to witnessed entries;
//! - adversarial: forged root, principal mismatch, sequence jump, spurious
//!   entry cell, re-open frozen shard.

mod common;

use common::pack_pbytes;
fn packed_bytes(b: impl AsRef<[u8]>) -> ckb_testtool::ckb_types::packed::Bytes {
    pack_pbytes(b.as_ref())
}

use ckb_testtool::ckb_types::{
    bytes::Bytes,
    core::{DepType, ScriptHashType, TransactionBuilder, TransactionView},
    packed::*,
    prelude::*,
};
use common::*;

/// Build an entry transaction (SMT accumulator).
fn build_entry_tx(
    world: &mut World,
    cfg: &RoundConfigV1,
    round_op: &OutPoint,
    shard_op: &OutPoint,
    shard_before: &EntryShardDataV1,
    host: &mut SmtHost,
    entries: &[EntryDataV1],
    participant_hash: &Hash32,
    spurious_entry_cells: usize,
) -> (TransactionView, EntryShardDataV1) {
    // Each certificate authenticates one exact insertion; chain roots in
    // witness entry order rather than proving every leaf against final root.
    let mut certs: Vec<(Vec<u8>, Vec<u8>)> = Vec::new();
    for e in entries {
        let absence = host.absence_proof(&[smt_key(e)]).unwrap();
        host.insert(&smt_key(e), &smt_leaf(e)).unwrap();
        let inclusion = host.inclusion_proof(&[smt_key(e)]).unwrap();
        certs.push((absence, inclusion));
    }
    let cert_refs: Vec<(&[u8], &[u8])> = certs
        .iter()
        .map(|(a, b)| (a.as_slice(), b.as_slice()))
        .collect();
    let witness = smt_append_witness(entries, &cert_refs);

    // expected post-state (tolerates deliberately-invalid entries used in
    // adversarial tests: the contract must reject them anyway)
    let mut after = match daowow_core::shard::apply_entry_batch(Some(shard_before), cfg, entries) {
        Ok(s) => s,
        Err(_) => {
            let mut s = *shard_before;
            s.sequence += entries.len() as u64;
            s.entry_count += entries.len() as u64;
            s.ticket_count += entries.iter().map(|e| e.ticket_count).sum::<u64>();
            s.principal_total += entries.iter().map(|e| e.principal).sum::<u64>();
            s
        }
    };
    after.accumulator_root = host.root();

    // cells
    let (shard_in, _) = world.cell(shard_op);
    let shard_type_script = shard_in.type_().to_opt().unwrap();
    let (funding_op, _) = world.funding_cell(100_000 * SHANNONS);
    let (_, participant_lock) = world.always_success();
    let entry_lock_script = world.entry_lock_script(participant_hash);

    let mut builder = TransactionBuilder::default()
        .cell_dep(world.round_config_dep(round_op))
        .input(CellInput::new(shard_op.clone(), 0))
        .input(CellInput::new(funding_op, 0))
        .output(
            CellOutputBuilder::default()
                .capacity(pack_u64(shard_in.capacity().unpack()))
                .lock(shard_in.lock())
                .type_(Some(shard_type_script).pack())
                .build(),
        )
        .output_data(Bytes::from(after.encode().to_vec()));
    for e in entries {
        let entry_out = CellOutputBuilder::default()
            .capacity(pack_u64(entry_cell_capacity(e)))
            .lock(entry_lock_script.clone())
            .build();
        builder = builder
            .output(entry_out)
            .output_data(Bytes::from(e.encode().to_vec()));
    }
    for _ in 0..spurious_entry_cells {
        let fake = make_entry(cfg, &after, participant_hash, 1, &[0xEE; 32]);
        let out = CellOutputBuilder::default()
            .capacity(pack_u64(entry_cell_capacity(&fake)))
            .lock(entry_lock_script.clone())
            .build();
        builder = builder
            .output(out)
            .output_data(Bytes::from(fake.encode().to_vec()));
    }
    builder = builder
        .witness(packed_bytes(witness))
        .witness(packed_bytes(WitnessArgs::new_builder().build().as_bytes()));
    let built = builder.build();
    (built, after)
}

#[test]
fn round_and_shard_creation() {
    let mut world = World::new(ACC_SMT);
    let cfg = default_config([1; 32], ACC_SMT);
    let round_op = world.create_round(&cfg);
    let (_shard_op, shard) = world.create_shard(&cfg, 0, 1);
    assert_eq!(shard.entry_count, 0);
    assert_eq!(shard.state, SHARD_STATE_OPEN);
    let _ = round_op;
}

#[test]
fn contended_shard_head_serializes_via_utxo() {
    // Two participants enter the same shard one after another. The second
    // transaction must consume the NEW head produced by the first — the CKB
    // cell model serializes contention naturally; this test proves the head
    // transitions are valid end-to-end on CKB-VM.
    let mut world = World::new(ACC_SMT);
    let cfg = default_config([2; 32], ACC_SMT);
    let round_op = world.create_round(&cfg);
    let (shard_op, shard0) = world.create_shard(&cfg, 0, 1);

    let mut host = SmtHost::new();

    let (_, lock_a) = world.always_success();
    let ph_a = World::participant_hash(&lock_a);
    let e1 = make_entry(&cfg, &shard0, &ph_a, 3, &[0xA1; 32]);
    let (tx1, shard1) = build_entry_tx(
        &mut world,
        &cfg,
        &round_op,
        &shard_op,
        &shard0,
        &mut host,
        &[e1],
        &ph_a,
        0,
    );
    let c1 = expect_ok(&mut world.context, &tx1);
    println!("cycles: entry tx on empty shard = {}", c1);
    chain_cell(&mut world, &shard_op, &tx1, 0);

    // head is now shard1; participant B retries on the new head
    let (_, lock_b) = world.always_success();
    let ph_b = World::participant_hash(&lock_b);
    let e2 = make_entry(&cfg, &shard1, &ph_b, 1, &[0xB1; 32]);
    assert_eq!(e2.entry_nonce, 1);
    assert_eq!(e2.position_base, 3);
    let (tx2, shard2) = build_entry_tx(
        &mut world,
        &cfg,
        &round_op,
        &shard_op,
        &shard1,
        &mut host,
        &[e2],
        &ph_b,
        0,
    );
    let c2 = expect_ok(&mut world.context, &tx2);
    println!("cycles: entry tx on 1-entry shard = {}", c2);
    chain_cell(&mut world, &shard_op, &tx2, 0);

    let (_, data) = world.cell(&shard_op);
    assert_eq!(EntryShardDataV1::decode(&data).unwrap(), shard2);
}

#[test]
fn batched_entries_and_parallel_shards() {
    let mut world = World::new(ACC_SMT);
    let cfg = default_config([3; 32], ACC_SMT);
    let round_op = world.create_round(&cfg);
    let (shard_a_op, shard_a) = world.create_shard(&cfg, 0, 1);
    let (shard_b_op, shard_b) = world.create_shard(&cfg, 1, 2);

    let (_, lock) = world.always_success();
    let ph = World::participant_hash(&lock);
    let mut host_a = SmtHost::new();
    let mut host_b = SmtHost::new();

    let ea = make_entry_batch(&cfg, &shard_a, &ph, &[2, 1], &[[0xC1; 32], [0xC2; 32]]);
    let eb = [make_entry(&cfg, &shard_b, &ph, 5, &[0xC3; 32])];

    let (tx_a, after_a) = build_entry_tx(
        &mut world,
        &cfg,
        &round_op,
        &shard_a_op,
        &shard_a,
        &mut host_a,
        &ea,
        &ph,
        0,
    );
    let (tx_b, after_b) = build_entry_tx(
        &mut world,
        &cfg,
        &round_op,
        &shard_b_op,
        &shard_b,
        &mut host_b,
        &eb,
        &ph,
        0,
    );
    let ca = expect_ok(&mut world.context, &tx_a);
    let cb = expect_ok(&mut world.context, &tx_b);
    println!(
        "cycles: shard A (2-entry batch) = {} | shard B (1 entry) = {}",
        ca, cb
    );
    assert_eq!(after_a.ticket_count, 3);
    assert_eq!(after_a.sequence, 2);
    assert_eq!(after_b.ticket_count, 5);
}

#[test]
fn adversarial_entry_txs_rejected() {
    let mut world = World::new(ACC_SMT);
    let cfg = default_config([4; 32], ACC_SMT);
    let round_op = world.create_round(&cfg);
    let (shard_op, shard0) = world.create_shard(&cfg, 0, 1);
    let (_, lock) = world.always_success();
    let ph = World::participant_hash(&lock);
    let mut host = SmtHost::new();

    // 1. forged accumulator root (no valid certificate)
    let e = make_entry(&cfg, &shard0, &ph, 1, &[0xD1; 32]);
    let (tx, _) = build_entry_tx(
        &mut world,
        &cfg,
        &round_op,
        &shard_op,
        &shard0,
        &mut host,
        &[e],
        &ph,
        0,
    );
    let forged_root = [0x99u8; 32];
    let view = tx.as_advanced_builder();
    let mut outs: Vec<CellOutput> = Vec::new();
    let mut datas: Vec<ckb_testtool::ckb_types::packed::Bytes> = Vec::new();
    for (i, o) in tx.outputs().into_iter().enumerate() {
        let mut d = tx.outputs_data().get(i).unwrap().raw_data().to_vec();
        if d.len() == SHARD_DATA_SIZE {
            d[69..101].copy_from_slice(&forged_root);
        }
        outs.push(o);
        datas.push(packed_bytes(&d));
    }
    let tampered = view.set_outputs(outs).set_outputs_data(datas).build();
    let err = expect_fail(&mut world.context, &tampered);
    println!("forged root rejected: {:?}", err);

    // 2. principal mismatch
    let mut e2 = make_entry(&cfg, &shard0, &ph, 2, &[0xD2; 32]);
    e2.principal = 1;
    let mut host2 = SmtHost::new();
    let (tx2, _) = build_entry_tx(
        &mut world,
        &cfg,
        &round_op,
        &shard_op,
        &shard0,
        &mut host2,
        &[e2],
        &ph,
        0,
    );
    let err = expect_fail(&mut world.context, &tx2);
    println!("principal mismatch rejected: {:?}", err);

    // 3. sequence jump
    let mut host3 = SmtHost::new();
    let e3 = make_entry(&cfg, &shard0, &ph, 1, &[0xD3; 32]);
    let (tx3, _) = build_entry_tx(
        &mut world,
        &cfg,
        &round_op,
        &shard_op,
        &shard0,
        &mut host3,
        &[e3],
        &ph,
        0,
    );
    let view3 = tx3.as_advanced_builder();
    let mut datas3: Vec<ckb_testtool::ckb_types::packed::Bytes> = Vec::new();
    for (i, d) in tx3.outputs_data().into_iter().enumerate() {
        let mut raw = d.raw_data().to_vec();
        if i == 0 && raw.len() == SHARD_DATA_SIZE {
            let seq = u64::from_le_bytes(raw[37..45].try_into().unwrap()) + 100;
            raw[37..45].copy_from_slice(&seq.to_le_bytes());
        }
        datas3.push(packed_bytes(&raw));
    }
    let tx3b = view3.set_outputs_data(datas3).build();
    let err = expect_fail(&mut world.context, &tx3b);
    println!("sequence jump rejected: {:?}", err);

    // 4. spurious entry cell not covered by the witness
    let mut host4 = SmtHost::new();
    let e4 = make_entry(&cfg, &shard0, &ph, 1, &[0xD4; 32]);
    let (tx4, _) = build_entry_tx(
        &mut world,
        &cfg,
        &round_op,
        &shard_op,
        &shard0,
        &mut host4,
        &[e4],
        &ph,
        1,
    );
    let err = expect_fail(&mut world.context, &tx4);
    println!("uncovered entry cell rejected: {:?}", err);

    // 5. entry cell for another shard (round mismatch)
    let mut host5 = SmtHost::new();
    let mut e5 = make_entry(&cfg, &shard0, &ph, 1, &[0xD5; 32]);
    e5.shard_id = 3;
    let (tx5, _) = build_entry_tx(
        &mut world,
        &cfg,
        &round_op,
        &shard_op,
        &shard0,
        &mut host5,
        &[e5],
        &ph,
        0,
    );
    let err = expect_fail(&mut world.context, &tx5);
    println!("wrong shard id rejected: {:?}", err);
}

#[test]
fn freeze_and_frozen_immutability() {
    let mut world = World::new(ACC_SMT);
    let cfg = default_config([5; 32], ACC_SMT);
    let round_op = world.create_round(&cfg);
    let (shard_op, shard0) = world.create_shard(&cfg, 0, 1);
    let (_, lock) = world.always_success();
    let ph = World::participant_hash(&lock);
    let mut host = SmtHost::new();
    let e = make_entry(&cfg, &shard0, &ph, 2, &[0xE1; 32]);
    let (_tx, _shard1) = build_entry_tx(
        &mut world,
        &cfg,
        &round_op,
        &shard_op,
        &shard0,
        &mut host,
        &[e],
        &ph,
        0,
    );

    // empty shard freeze: OPEN -> FROZEN preserving counters
    let (cell_in, data_in) = world.cell(&shard_op);
    let shard_in_data = EntryShardDataV1::decode(&data_in).unwrap();
    let mut frozen = shard_in_data;
    frozen.state = SHARD_STATE_FROZEN;
    let funding = world.funding_cell(1000 * SHANNONS);
    let tx = TransactionBuilder::default()
        .cell_dep(world.round_config_dep(&round_op))
        .input(CellInput::new(
            shard_op.clone(),
            daowow_core::epoch::absolute_epoch_since(cfg.entry_end).unwrap(),
        ))
        .input(CellInput::new(funding.0, 0))
        .output(
            CellOutputBuilder::default()
                .capacity(pack_u64(cell_in.capacity().unpack()))
                .lock(cell_in.lock())
                .type_(Some(cell_in.type_().to_opt().unwrap()).pack())
                .build(),
        )
        .output_data(Bytes::from(frozen.encode().to_vec()))
        .witness(packed_bytes(WitnessArgs::new_builder().build().as_bytes()))
        .witness(packed_bytes(WitnessArgs::new_builder().build().as_bytes()))
        .build();
    let cf = expect_ok(&mut world.context, &tx);
    println!("cycles: freeze = {}", cf);
    chain_cell(&mut world, &shard_op, &tx, 0);

    // frozen counter mutation must fail
    let (cell_in2, _) = world.cell(&shard_op);
    let mut bad = frozen;
    bad.ticket_count = 999;
    let funding2 = world.funding_cell(1000 * SHANNONS);
    let tx_bad = TransactionBuilder::default()
        .cell_dep(world.round_config_dep(&round_op))
        .input(CellInput::new(shard_op.clone(), 0))
        .input(CellInput::new(funding2.0, 0))
        .output(
            CellOutputBuilder::default()
                .capacity(pack_u64(cell_in2.capacity().unpack()))
                .lock(cell_in2.lock())
                .type_(Some(cell_in2.type_().to_opt().unwrap()).pack())
                .build(),
        )
        .output_data(Bytes::from(bad.encode().to_vec()))
        .witness(packed_bytes(WitnessArgs::new_builder().build().as_bytes()))
        .witness(packed_bytes(WitnessArgs::new_builder().build().as_bytes()))
        .build();
    let err = expect_fail(&mut world.context, &tx_bad);
    println!("frozen mutation rejected: {:?}", err);
}
