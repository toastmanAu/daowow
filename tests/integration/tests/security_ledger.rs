mod common;
use ckb_testtool::ckb_types::{bytes::Bytes, core::TransactionBuilder, packed::*, prelude::*};
use common::*;
use daowow_core::lifecycle::AggregationState;
use daowow_core::witness::{encode_ledger_witness, LedgerInputProof};

struct Fixture {
    w: World,
    cfg: RoundConfigV1,
    round: OutPoint,
    shard: OutPoint,
    state: AggregationState,
    entries: Vec<(OutPoint, EntryDataV1, Vec<u8>)>,
}

fn fixture(count: usize) -> Fixture {
    let mut w = World::new(ACC_SMT);
    let mut cfg = default_config([0; 32], ACC_SMT);
    cfg.prize_schedule_hash = default_prize_schedule().commitment();
    let (funding, _) = w.funding_cell(100_000 * SHANNONS);
    cfg.round_id = daowow_core::hash::ckb_hash256(&[
        CellInput::new(funding.clone(), 0).as_slice(),
        &0u64.to_le_bytes(),
    ]);
    let round = w.create_round(&cfg);
    let cfg = full_config(&cfg, &w.deps);
    let (round_cell, round_data) = w.cell(&round);
    let mut create = TransactionBuilder::default()
        .witness(creation_schedule_witness(default_prize_schedule().encode()))
        .input(CellInput::new(funding, 0))
        .output(round_cell)
        .output_data(round_data);
    let mut shard = None;
    for id in 0..cfg.entry_shard_count {
        let (op, _) = w.create_shard(&cfg, id, 0);
        let (cell, data) = w.cell(&op);
        create = create
            .output(cell.as_builder().capacity(pack_u64(500 * SHANNONS)).build())
            .output_data(data);
        shard.get_or_insert(op);
    }
    let tx = create.build();
    expect_ok(&mut w.context, &tx);
    let shard = shard.unwrap();
    chain_cell(&mut w, &shard, &tx, 1);
    let (cell, data) = w.cell(&shard);
    let mut frozen = EntryShardDataV1::decode(&data).unwrap();
    let mut host = SmtHost::new();
    let mut entries = Vec::new();
    for n in 0..count {
        let (_, participant_lock) = w.always_success();
        let participant_lock = participant_lock
            .as_builder()
            .args(pack_pbytes(&[n as u8]))
            .build();
        let participant = World::participant_hash(&participant_lock);
        let e = make_entry(&cfg, &frozen, &participant, 1, &[n as u8; 32]);
        let absence = host.absence_proof(&[smt_key(&e)]).unwrap();
        host.insert(&smt_key(&e), &smt_leaf(&e)).unwrap();
        let inclusion = host.inclusion_proof(&[smt_key(&e)]).unwrap();
        frozen = daowow_core::shard::apply_entry_batch(Some(&frozen), &cfg, &[e]).unwrap();
        frozen.accumulator_root = host.root();
        let lock = w.entry_lock_script(&participant);
        let entry_cell = CellOutputBuilder::default()
            .capacity(pack_u64(entry_cell_capacity(&e)))
            .lock(lock)
            .build();
        let (funding, _) = w.funding_cell(1000 * SHANNONS);
        let tx = TransactionBuilder::default()
            .cell_dep(w.round_config_dep(&round))
            .input(CellInput::new(shard.clone(), 0))
            .input(CellInput::new(funding, 0))
            .output(cell.clone())
            .output_data(Bytes::from(frozen.encode().to_vec()))
            .output(entry_cell.clone())
            .output_data(Bytes::from(e.encode().to_vec()))
            .witness(smt_append_witness(
                &[e],
                &[(absence.as_slice(), inclusion.as_slice())],
            ))
            .build();
        expect_ok(&mut w.context, &tx);
        chain_cell(&mut w, &shard, &tx, 0);
        let op = w
            .context
            .create_cell(entry_cell, Bytes::from(e.encode().to_vec()));
        chain_cell(&mut w, &op, &tx, 1);
        entries.push((op, e, Vec::new()));
    }
    for (_, e, proof) in &mut entries {
        *proof = host.inclusion_proof(&[smt_key(e)]).unwrap();
    }
    frozen.state = SHARD_STATE_FROZEN;
    let freeze = TransactionBuilder::default()
        .cell_dep(w.round_config_dep(&round))
        .input(CellInput::new(shard.clone(), 0x2000_0000_0000_0064))
        .output(cell.clone())
        .output_data(Bytes::from(frozen.encode().to_vec()))
        .build();
    expect_ok(&mut w.context, &freeze);
    chain_cell(&mut w, &shard, &freeze, 0);
    let state = AggregationState::new(&cfg, &frozen).unwrap();
    let init = TransactionBuilder::default()
        .cell_dep(w.round_config_dep(&round))
        .input(CellInput::new(shard.clone(), 0))
        .output(cell)
        .output_data(Bytes::from(state.encode().to_vec()))
        .build();
    expect_ok(&mut w.context, &init);
    chain_cell(&mut w, &shard, &init, 0);
    Fixture {
        w,
        cfg,
        round,
        shard,
        state,
        entries,
    }
}

fn aggregation(
    f: &mut Fixture,
    positions: &[usize],
) -> ckb_testtool::ckb_types::core::TransactionView {
    let entries: Vec<_> = positions.iter().map(|&i| f.entries[i].1).collect();
    let capacities: Vec<_> = entries.iter().map(entry_cell_capacity).collect();
    let proofs: Vec<_> = positions
        .iter()
        .map(|&i| f.entries[i].2.as_slice())
        .collect();
    let (next, batch) = f
        .state
        .accept(&f.cfg, &entries, &capacities, &proofs)
        .unwrap();
    let batch_id = f.state.next_batch_id().unwrap();
    let (shard_cell, _) = f.w.cell(&f.shard);
    let mut tx = TransactionBuilder::default()
        .cell_dep(f.w.round_config_dep(&f.round))
        .input(CellInput::new(f.shard.clone(), 0));
    for &i in positions {
        tx = tx.input(CellInput::new(f.entries[i].0.clone(), 0));
    }
    let (funding, _) = f.w.funding_cell(1000 * SHANNONS);
    tx = tx.input(CellInput::new(funding, 0));
    let records: Vec<_> = proofs
        .iter()
        .enumerate()
        .map(|(i, proof)| LedgerInputProof {
            input_index: (i + 1) as u32,
            proof,
        })
        .collect();
    let witness = encode_ledger_witness(&records).unwrap();
    let dao_lock =
        f.w.dao_lock_script_with_digest(&f.cfg.round_id, batch_id, &batch.digest);
    let mut args = vec![2];
    args.extend_from_slice(&f.cfg.commitment());
    args.extend_from_slice(&0u32.to_le_bytes());
    args.extend_from_slice(&batch_id.to_le_bytes());
    args.extend_from_slice(&batch.digest);
    let ty =
        f.w.script_for(&f.w.deps.entry_shard_type.clone(), Bytes::from(args));
    let public = f.w.shard_public_lock();
    tx.output(shard_cell)
        .output_data(Bytes::from(next.encode().to_vec()))
        .output(
            CellOutputBuilder::default()
                .capacity(pack_u64(batch.input_capacity))
                .lock(dao_lock)
                .type_(Some(f.w.dao_type_script()).pack())
                .build(),
        )
        .output_data(Bytes::from(vec![0; 8]))
        .output(
            CellOutputBuilder::default()
                .capacity(pack_u64(300 * SHANNONS))
                .lock(public)
                .type_(Some(ty).pack())
                .build(),
        )
        .output_data(Bytes::from(batch.encode().to_vec()))
        .witness(pack_pbytes(&witness))
        .build()
}

#[test]
fn entry_lock_cannot_delegate_to_missing_or_substituted_ledger_type() {
    for substitute in [false, true] {
        let mut f = fixture(1);
        let valid = aggregation(&mut f, &[0]);
        expect_ok(&mut f.w.context, &valid);
        let (_, permissive) = f.w.always_success();
        let (input, data) = f.w.cell(&f.shard);
        let decoy = input
            .as_builder()
            .lock(permissive.clone())
            .type_(if substitute {
                Some(permissive.clone()).pack()
            } else {
                None::<Script>.pack()
            })
            .build();
        f.w.context
            .create_cell_with_out_point(f.shard.clone(), decoy, data);
        // Remove both genuine output type authorities too. The entry lock
        // itself must reject the untyped/permissive ledger impersonation.
        let outputs: Vec<_> = valid
            .outputs()
            .into_iter()
            .take(2)
            .enumerate()
            .map(|(i, cell)| {
                if i == 0 {
                    cell.as_builder()
                        .lock(permissive.clone())
                        .type_(if substitute {
                            Some(permissive.clone()).pack()
                        } else {
                            None::<Script>.pack()
                        })
                        .build()
                } else {
                    cell
                }
            })
            .collect();
        let tx = valid
            .as_advanced_builder()
            .set_outputs(outputs)
            .set_outputs_data(vec![pack_pbytes(&f.state.encode()), pack_pbytes(&[0; 8])])
            .build();
        let tx = f.w.context.complete_tx(tx);
        let error = f.w.context.verify_tx(&tx, MAX_CYCLES).unwrap_err();
        assert!(error.to_string().contains("-45"), "{error}");
    }
}

#[test]
fn maximum_atomic_batch_executes_all_authorities() {
    let mut f = fixture(daowow_core::lifecycle::MAX_BATCH_ENTRIES);
    let positions: Vec<_> = (0..f.entries.len()).collect();
    let tx = aggregation(&mut f, &positions);
    // Regression budget, not a node admission or production batch-size claim.
    let tx = f.w.context.complete_tx(tx);
    let cycles = f.w.context.verify_tx(&tx, MAX_CYCLES).unwrap();
    println!("atomic SMT maximum batch (32 distinct participants): {cycles} cycles");
}

#[test]
fn closed_partial_ledger_cannot_reopen_or_aggregate() {
    let mut f = fixture(2);
    let first = aggregation(&mut f, &[0]);
    expect_ok(&mut f.w.context, &first);
    f.state = AggregationState::decode(
        first.outputs_data().get(0).unwrap().raw_data().as_ref(),
        &f.cfg,
    )
    .unwrap();
    chain_cell(&mut f.w, &f.shard, &first, 0);
    let pending = aggregation(&mut f, &[1]);
    let closed = f.state.close(&f.cfg, 0x2000_0000_0000_00c8).unwrap();
    let (cell, _) = f.w.cell(&f.shard);
    let close = TransactionBuilder::default()
        .cell_dep(f.w.round_config_dep(&f.round))
        .input(CellInput::new(f.shard.clone(), 0x2000_0000_0000_00c8))
        .output(cell.clone())
        .output_data(Bytes::from(closed.encode().to_vec()))
        .build();
    let early = close
        .clone()
        .as_advanced_builder()
        .set_inputs(vec![CellInput::new(f.shard.clone(), 0x2000_0000_0000_00c7)])
        .build();
    expect_fail(&mut f.w.context, &early);
    expect_ok(&mut f.w.context, &close);
    chain_cell(&mut f.w, &f.shard, &close, 0);
    // The same outpoint is remapped to the verified successor by this harness.
    expect_fail(&mut f.w.context, &pending);
    let reopen = close
        .clone()
        .as_advanced_builder()
        .set_outputs_data(vec![pack_pbytes(&f.state.encode())])
        .build();
    expect_fail(&mut f.w.context, &reopen);
    expect_ok(&mut f.w.context, &close);
    for index in 0..2 {
        let (_, participant) = f.w.always_success();
        let participant = participant
            .as_builder()
            .args(pack_pbytes(&[index as u8]))
            .build();
        let refund = TransactionBuilder::default()
            .cell_dep(f.w.round_config_dep(&f.round))
            .cell_dep(CellDep::new_builder().out_point(f.shard.clone()).build())
            .input(CellInput::new(
                f.entries[index].0.clone(),
                0x2000_0000_0000_00c8,
            ))
            .output(
                CellOutputBuilder::default()
                    .capacity(pack_u64(entry_cell_capacity(&f.entries[index].1)))
                    .lock(participant)
                    .build(),
            )
            .output_data(Bytes::new())
            .witness(aggregation_witness(&f.entries[index].2))
            .build();
        if index == 0 {
            // Harness retains spent entry fixtures: even a copied accepted entry
            // must not claim a refund against the terminal accepted prefix.
            expect_fail(&mut f.w.context, &refund);
        } else {
            expect_ok(&mut f.w.context, &refund);
        }
    }
}

#[test]
fn authenticated_receipt_cannot_be_consumed_or_recreated() {
    let mut f = fixture(1);
    let batch = aggregation(&mut f, &[0]);
    expect_ok(&mut f.w.context, &batch);
    let cell = batch.outputs().get(2).unwrap();
    let data = batch.outputs_data().get(2).unwrap().raw_data();
    let receipt = f.w.context.create_cell(cell.clone(), data.clone());
    chain_cell(&mut f.w, &receipt, &batch, 2);
    let consume = TransactionBuilder::default()
        .cell_dep(f.w.round_config_dep(&f.round))
        .input(CellInput::new(receipt, 0))
        .build();
    expect_fail(&mut f.w.context, &consume);
    let recreate = consume
        .as_advanced_builder()
        .output(cell)
        .output_data(data)
        .build();
    expect_fail(&mut f.w.context, &recreate);
}

#[test]
fn consecutive_atomic_batches_execute_all_authorities() {
    let mut f = fixture(2);
    for i in 0..2 {
        let tx = aggregation(&mut f, &[i]);
        let cycles = expect_ok(&mut f.w.context, &tx);
        println!("atomic SMT batch {i}: {cycles} cycles");
        f.state = AggregationState::decode(
            tx.outputs_data().get(0).unwrap().raw_data().as_ref(),
            &f.cfg,
        )
        .unwrap();
        chain_cell(&mut f.w, &f.shard, &tx, 0);
    }
}

#[test]
fn atomic_batch_rejects_diversion_and_forged_outputs() {
    let mut f = fixture(1);
    let valid = aggregation(&mut f, &[0]);
    expect_ok(&mut f.w.context, &valid);
    for case in 0..9 {
        let mut outputs: Vec<_> = valid.outputs().into_iter().collect();
        let mut data: Vec<_> = valid.outputs_data().into_iter().collect();
        match case {
            0 => {
                outputs.remove(2);
                data.remove(2);
            }
            1 => {
                outputs.push(outputs[2].clone());
                data.push(data[2].clone());
            }
            2 => {
                outputs.push(outputs[1].clone());
                data.push(data[1].clone());
            }
            3 => {
                outputs[1] = outputs[1]
                    .clone()
                    .as_builder()
                    .capacity(pack_u64(entry_cell_capacity(&f.entries[0].1) - 1))
                    .build();
            }
            4 => {
                data[1] = pack_pbytes(&[1; 8]);
            }
            5 => {
                outputs[1] = outputs[1]
                    .clone()
                    .as_builder()
                    .type_(None::<Script>.pack())
                    .build();
            }
            6 => {
                let mut bad = data[2].raw_data().to_vec();
                bad[1] ^= 1;
                data[2] = pack_pbytes(&bad);
            }
            7 => {
                let mut bad = data[0].raw_data().to_vec();
                bad[142] ^= 1;
                data[0] = pack_pbytes(&bad);
            }
            _ => {
                let mut args = outputs[2]
                    .type_()
                    .to_opt()
                    .unwrap()
                    .args()
                    .raw_data()
                    .to_vec();
                args[37] ^= 1;
                let ty = outputs[2]
                    .type_()
                    .to_opt()
                    .unwrap()
                    .as_builder()
                    .args(pack_pbytes(&args))
                    .build();
                outputs[2] = outputs[2]
                    .clone()
                    .as_builder()
                    .type_(Some(ty).pack())
                    .build();
            }
        }
        let tx = valid
            .clone()
            .as_advanced_builder()
            .set_outputs(outputs)
            .set_outputs_data(data)
            .build();
        expect_fail(&mut f.w.context, &tx);
    }
}

#[test]
fn atomic_batch_requires_exact_input_indices_and_membership() {
    let mut f = fixture(2);
    let valid = aggregation(&mut f, &[0, 1]);
    expect_ok(&mut f.w.context, &valid);
    let original = valid.witnesses().get(0).unwrap().raw_data().to_vec();
    for case in 0..5 {
        let mut bad = original.clone();
        let second = 5 + 8 + f.entries[0].2.len();
        match case {
            0 => bad[second..second + 4].copy_from_slice(&1u32.to_le_bytes()),
            1 => {
                bad[1..5].copy_from_slice(&1u32.to_le_bytes());
                bad.truncate(second);
            }
            2 => bad[5..9].copy_from_slice(&0u32.to_le_bytes()),
            3 => bad[13] ^= 1,
            _ => {
                bad[5..9].copy_from_slice(&2u32.to_le_bytes());
                bad[second..second + 4].copy_from_slice(&1u32.to_le_bytes());
            }
        }
        let tx = valid
            .clone()
            .as_advanced_builder()
            .set_witnesses(vec![pack_pbytes(&bad)])
            .build();
        expect_fail(&mut f.w.context, &tx);
    }
}

#[test]
fn frozen_shard_initializes_and_closes_empty_ledger() {
    let mut w = World::new(ACC_MMR);
    let cfg = default_config([0x91; 32], ACC_MMR);
    let round = w.create_round(&cfg);
    let cfg = full_config(&cfg, &w.deps);
    let (op, mut frozen) = w.create_shard(&cfg, 0, 0);
    frozen.state = SHARD_STATE_FROZEN;
    let (cell, _) = w.cell(&op);
    let cell = cell.as_builder().capacity(pack_u64(500 * SHANNONS)).build();
    w.context.create_cell_with_out_point(
        op.clone(),
        cell.clone(),
        Bytes::from(frozen.encode().to_vec()),
    );
    let state = AggregationState::new(&cfg, &frozen).unwrap();
    let tx = TransactionBuilder::default()
        .cell_dep(w.round_config_dep(&round))
        .input(CellInput::new(op.clone(), 0))
        .output(cell.clone())
        .output_data(Bytes::from(state.encode().to_vec()))
        .build();
    expect_ok(&mut w.context, &tx);
    chain_cell(&mut w, &op, &tx, 0);
    for since in [0x2000_0000_0000_0063, 0x2000_0000_0000_0064] {
        let closed = state.close(&cfg, 0x2000_0000_0000_0064).unwrap();
        let tx = TransactionBuilder::default()
            .cell_dep(w.round_config_dep(&round))
            .input(CellInput::new(op.clone(), since))
            .output(cell.clone())
            .output_data(Bytes::from(closed.encode().to_vec()))
            .build();
        if since & 0xffff == 99 {
            expect_fail(&mut w.context, &tx);
        } else {
            expect_ok(&mut w.context, &tx);
        }
    }
}
