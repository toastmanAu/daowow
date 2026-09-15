//! Public shard access must always be paired with the enforcing shard type.
mod common;

use ckb_testtool::ckb_types::{bytes::Bytes, core::TransactionBuilder, packed::*, prelude::*};
use common::*;

fn public_lock(w: &mut World) -> Script {
    w.shard_public_lock()
}

fn create_round(w: &mut World, creator_lock: bool) -> (OutPoint, OutPoint) {
    let mut cfg = default_config([0; 32], ACC_MMR);
    cfg.prize_schedule_hash = default_prize_schedule().commitment();
    let (funding, _) = w.funding_cell(10_000 * SHANNONS);
    cfg.round_id = daowow_core::hash::ckb_hash256(&[
        CellInput::new(funding.clone(), 0).as_slice(),
        &0u64.to_le_bytes(),
    ]);
    let round = w.create_round(&cfg);
    let (round_cell, round_data) = w.cell(&round);
    let mut tx = TransactionBuilder::default()
        .witness(creation_schedule_witness(default_prize_schedule().encode()))
        .input(CellInput::new(funding, 0))
        .output(round_cell)
        .output_data(round_data);
    let lock = if creator_lock {
        w.always_success().1
    } else {
        public_lock(w)
    };
    let mut first = None;
    for id in 0..cfg.entry_shard_count {
        let (op, _) = w.create_shard(&cfg, id, 0);
        let (cell, data) = w.cell(&op);
        tx = tx
            .output(cell.as_builder().lock(lock.clone()).build())
            .output_data(data);
        first.get_or_insert(op);
    }
    let tx = tx.build();
    if creator_lock {
        let error = expect_fail(&mut w.context, &tx).to_string();
        assert!(error.contains("error code -35"), "{error}");
    } else {
        expect_ok(&mut w.context, &tx);
        chain_cell(w, first.as_ref().unwrap(), &tx, 1);
    }
    (round, first.unwrap())
}

#[test]
fn creation_rejects_creator_selected_shard_lock() {
    create_round(&mut World::new(ACC_MMR), true);
}

#[test]
fn actual_round_creation_and_permissionless_freeze() {
    let mut w = World::new(ACC_MMR);
    let (round, shard) = create_round(&mut w, false);
    let (cell, data) = w.cell(&shard);
    let mut state = EntryShardDataV1::decode(&data).unwrap();
    state.state = SHARD_STATE_FROZEN;
    let tx = TransactionBuilder::default()
        .cell_dep(w.round_config_dep(&round))
        .input(CellInput::new(shard, 0x2000_0000_0000_0064))
        .output(cell)
        .output_data(Bytes::from(state.encode().to_vec()))
        .build();
    expect_ok(&mut w.context, &tx);
}

// Seed a pre-existing shard to isolate input/output lock and capacity checks.
fn freeze_with_locks(input_public: bool, output_public: bool, drain: bool) {
    let mut w = World::new(ACC_MMR);
    let cfg = default_config([0x81; 32], ACC_MMR);
    let round = w.create_round(&cfg);
    let (op, mut state) = w.create_shard(&cfg, 0, 0);
    let (cell, data) = w.cell(&op);
    let public = public_lock(&mut w);
    let private = w.always_success().1;
    let input = cell
        .clone()
        .as_builder()
        .lock(if input_public {
            public.clone()
        } else {
            private.clone()
        })
        .build();
    w.context
        .create_cell_with_out_point(op.clone(), input, data);
    state.state = SHARD_STATE_FROZEN;
    let output = cell
        .as_builder()
        .lock(if output_public { public } else { private })
        .capacity(pack_u64(if drain { 299 } else { 300 } * SHANNONS))
        .build();
    let tx = TransactionBuilder::default()
        .cell_dep(w.round_config_dep(&round))
        .input(CellInput::new(op, 0x2000_0000_0000_0064))
        .output(output)
        .output_data(Bytes::from(state.encode().to_vec()))
        .build();
    let error = expect_fail(&mut w.context, &tx).to_string();
    assert!(error.contains("error code -35"), "{error}");
}

#[test]
fn update_rejects_creator_selected_input_and_output_locks() {
    freeze_with_locks(false, false, false);
}

#[test]
fn update_rejects_creator_selected_input_lock() {
    freeze_with_locks(false, true, false);
}

#[test]
fn update_rejects_creator_selected_output_lock() {
    freeze_with_locks(true, false, false);
}

#[test]
fn shard_capacity_cannot_decrease() {
    freeze_with_locks(true, true, true);
}

#[test]
fn creator_lock_cannot_drain_a_shard() {
    freeze_with_locks(false, false, true);
}

#[test]
fn public_lock_rejects_missing_and_unrecognized_types() {
    for case in 0..5 {
        let mut w = World::new(ACC_MMR);
        let public = public_lock(&mut w);
        let shard_ref = w.deps.entry_shard_type;
        let ty = match case {
            0 => None,
            1 => Some(w.always_success().1),
            2 => Some(public.clone()),
            3 => Some(w.script_for(&shard_ref, Bytes::from(vec![2; 77]))),
            _ => Some(w.script_for(&shard_ref, Bytes::from(vec![1]))),
        };
        let input = CellOutputBuilder::default()
            .capacity(pack_u64(300 * SHANNONS))
            .lock(public)
            .type_(ty.pack())
            .build();
        let op = w.context.create_cell(input, Bytes::new());
        let (_, change) = w.funding_cell(300 * SHANNONS);
        let tx = TransactionBuilder::default()
            .input(CellInput::new(op, 0))
            .output(
                CellOutputBuilder::default()
                    .capacity(pack_u64(300 * SHANNONS))
                    .lock(change)
                    .build(),
            )
            .output_data(Bytes::new())
            .build();
        expect_fail(&mut w.context, &tx);
    }
}

#[test]
fn public_lock_validates_every_input_and_allows_multiple_canonical_shards() {
    for add_untyped_input in [false, true] {
        let mut w = World::new(ACC_MMR);
        let cfg = default_config([0x82; 32], ACC_MMR);
        let round = w.create_round(&cfg);
        let mut tx = TransactionBuilder::default().cell_dep(w.round_config_dep(&round));
        for id in 0..2 {
            let (op, mut state) = w.create_shard(&cfg, id, 0);
            let (cell, _) = w.cell(&op);
            state.state = SHARD_STATE_FROZEN;
            tx = tx
                .input(CellInput::new(op, 0x2000_0000_0000_0064))
                .output(cell)
                .output_data(Bytes::from(state.encode().to_vec()));
        }
        if add_untyped_input {
            let lock = w.shard_public_lock();
            let extra = w.context.create_cell(
                CellOutputBuilder::default()
                    .capacity(pack_u64(100 * SHANNONS))
                    .lock(lock)
                    .build(),
                Bytes::new(),
            );
            tx = tx.input(CellInput::new(extra, 0));
            let change_lock = w.always_success().1;
            tx = tx
                .output(
                    CellOutputBuilder::default()
                        .capacity(pack_u64(100 * SHANNONS))
                        .lock(change_lock)
                        .build(),
                )
                .output_data(Bytes::new());
            let error = expect_fail(&mut w.context, &tx.build()).to_string();
            assert!(error.contains("error code -35"), "{error}");
        } else {
            expect_ok(&mut w.context, &tx.build());
        }
    }
}

#[test]
fn public_mode_cannot_be_used_as_a_spent_type() {
    let mut w = World::new(ACC_MMR);
    let ty = w.shard_public_lock();
    let lock = w.always_success().1;
    let cell = CellOutputBuilder::default()
        .capacity(pack_u64(300 * SHANNONS))
        .lock(lock)
        .type_(Some(ty).pack())
        .build();
    let op = w.context.create_cell(cell.clone(), Bytes::new());
    let tx = TransactionBuilder::default()
        .input(CellInput::new(op, 0))
        .output(cell)
        .output_data(Bytes::new())
        .build();
    let error = expect_fail(&mut w.context, &tx).to_string();
    assert!(error.contains("error code -35"), "{error}");
}

#[test]
fn public_mode_cannot_be_used_as_a_creation_type() {
    let mut w = World::new(ACC_MMR);
    let (funding, lock) = w.funding_cell(300 * SHANNONS);
    let ty = public_lock(&mut w);
    let tx = TransactionBuilder::default()
        .input(CellInput::new(funding, 0))
        .output(
            CellOutputBuilder::default()
                .capacity(pack_u64(300 * SHANNONS))
                .lock(lock)
                .type_(Some(ty).pack())
                .build(),
        )
        .output_data(Bytes::new())
        .build();
    expect_fail(&mut w.context, &tx);
}
