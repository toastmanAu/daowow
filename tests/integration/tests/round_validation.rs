//! Execute round-type itself; inserting a config with Context::create_cell
//! does not validate its creation transaction.
mod common;

use ckb_testtool::ckb_types::{bytes::Bytes, core::TransactionBuilder, packed::*, prelude::*};
use common::*;

fn creation(valid: bool, complete_shards: bool) -> Result<u64, String> {
    creation_with_config_type(valid, complete_shards, true)
}

fn creation_with_config_type(
    valid: bool,
    complete_shards: bool,
    typed_config: bool,
) -> Result<u64, String> {
    creation_with_schedule(
        valid,
        complete_shards,
        typed_config,
        Some(default_prize_schedule().encode()),
        false,
    )
}

fn creation_with_schedule(
    valid: bool,
    complete_shards: bool,
    typed_config: bool,
    schedule: Option<Vec<u8>>,
    commit_supplied: bool,
) -> Result<u64, String> {
    creation_at_index(
        valid,
        complete_shards,
        typed_config,
        schedule,
        commit_supplied,
        0,
        65,
    )
}

fn creation_at_index(
    valid: bool,
    complete_shards: bool,
    typed_config: bool,
    schedule: Option<Vec<u8>>,
    commit_supplied: bool,
    config_index: usize,
    lock_length: usize,
) -> Result<u64, String> {
    let mut world = World::new(ACC_MMR);
    let mut cfg = default_config([0x42; 32], ACC_MMR);
    cfg.prize_schedule_hash = if commit_supplied {
        daowow_core::hash::ckb_hash256(&[b"DAOWOW_PRIZE_SCHEDULE_V1", schedule.as_ref().unwrap()])
    } else {
        default_prize_schedule().commitment()
    };
    let (funding, lock) = world.funding_cell(10_000 * SHANNONS);
    cfg.round_id = daowow_core::hash::ckb_hash256(&[
        CellInput::new(funding.clone(), 0).as_slice(),
        &(config_index as u64).to_le_bytes(),
    ]);
    if !valid {
        cfg.ticket_price = 0;
    }
    let config_cell = world.create_round(&cfg);
    let (output, data) = world.cell(&config_cell);
    let output = if typed_config {
        output
    } else {
        output.as_builder().type_(None::<Script>.pack()).build()
    };
    let change = CellOutputBuilder::default()
        .capacity(pack_u64(1_000 * SHANNONS))
        .lock(lock)
        .build();
    assert!(config_index <= 1);
    let mut tx = TransactionBuilder::default().input(CellInput::new(funding, 0));
    if config_index == 1 {
        tx = tx.output(change.clone()).output_data(Bytes::new());
    }
    tx = tx.output(output).output_data(data);
    if config_index == 0 {
        tx = tx.output(change).output_data(Bytes::new());
    }
    // Isolate invalid-config validation from other scripts' dependency
    // checks, whose execution order is not an assertion of this test.
    let count = if !valid {
        0
    } else if complete_shards {
        cfg.entry_shard_count
    } else {
        cfg.entry_shard_count - 1
    };
    for id in 0..count {
        let (op, _) = world.create_shard(&cfg, id, u64::from(id));
        let (cell, data) = world.cell(&op);
        tx = tx.output(cell).output_data(data);
    }
    if let Some(schedule) = schedule {
        if config_index == 1 {
            tx = tx.witness(
                WitnessArgs::new_builder()
                    .lock(Some(Bytes::from(vec![0u8; 65])).pack())
                    .build()
                    .as_bytes(),
            );
        }
        tx = tx.witness(
            WitnessArgs::new_builder()
                .lock(Some(Bytes::from(vec![0u8; lock_length])).pack())
                .output_type(Some(Bytes::from(schedule)).pack())
                .build()
                .as_bytes(),
        );
    }
    let tx = world.context.complete_tx(tx.build());
    world
        .context
        .verify_tx(&tx, MAX_CYCLES)
        .map_err(|e| e.to_string())
}

#[test]
fn maximum_schedule_and_extra_witness_slot_are_supported() {
    for typed in [true, false] {
        let schedule = daowow_core::schedule::PrizeSchedule::new(&[1; 32])
            .unwrap()
            .encode();
        let cycles =
            creation_at_index(true, true, typed, Some(schedule.clone()), true, 1, 65).unwrap();
        println!("creation max32 config_index1 typed={typed}: {cycles} cycles");
        assert!(creation_at_index(true, true, typed, Some(schedule), true, 1, 4096).is_err());
    }
}

#[test]
fn round_and_shards_require_available_valid_committed_schedule() {
    for typed in [true, false] {
        assert!(
            creation_with_schedule(true, true, typed, None, false).is_err(),
            "missing schedule accepted (typed={typed})"
        );
        let wrong = daowow_core::schedule::PrizeSchedule::new(&[1])
            .unwrap()
            .encode();
        assert!(creation_with_schedule(true, true, typed, Some(wrong), false).is_err());
        let mut zero = default_prize_schedule().encode();
        zero[5..13].fill(0);
        let mut excessive = vec![1, 33, 0, 0, 0];
        for _ in 0..33 {
            excessive.extend_from_slice(&1u64.to_le_bytes());
        }
        for bad in [vec![], zero, excessive] {
            assert!(
                creation_with_schedule(true, true, typed, Some(bad), true).is_err(),
                "invalid committed schedule accepted (typed={typed})"
            );
        }
    }
}

#[test]
fn valid_round_creation_allows_sponsor_change() {
    creation(true, true).unwrap();
}

#[test]
fn zero_ticket_price_is_rejected_on_vm() {
    let error = creation(false, true).expect_err("round-type must execute config validation");
    assert!(error.contains("error code -17"), "{error}");
}

#[test]
fn round_creation_requires_every_configured_shard() {
    let error = creation(true, false).expect_err("missing shard must prevent round creation");
    // Both round-type and every shard-type enforce this invariant; VM group
    // order determines which rejection is reported first.
    assert!(
        error.contains("error code -17") || error.contains("error code -36"),
        "{error}"
    );
}

#[test]
fn untyped_config_cannot_create_an_incomplete_shard_set() {
    let error = creation_with_config_type(true, false, false)
        .expect_err("shard-type must independently reject missing shards");
    assert!(error.contains("error code -36"), "{error}");
}

#[test]
fn untyped_config_can_create_the_complete_canonical_shard_set() {
    creation_with_config_type(true, true, false).unwrap();
}

#[test]
fn round_updates_preserve_configuration() {
    for mutate in [false, true] {
        let mut world = World::new(ACC_MMR);
        let cfg = default_config([0x43; 32], ACC_MMR);
        let op = world.create_round(&cfg);
        let (cell, data) = world.cell(&op);
        let mut updated = RoundConfigV1::decode(&data).unwrap();
        if mutate {
            updated.ticket_price += 1;
        }
        let tx = TransactionBuilder::default()
            .input(CellInput::new(op, 0))
            .output(cell)
            .output_data(Bytes::from(updated.encode().to_vec()))
            .build();
        let tx = world.context.complete_tx(tx);
        let result = world.context.verify_tx(&tx, MAX_CYCLES);
        if mutate {
            let error = result
                .expect_err("configuration must be immutable")
                .to_string();
            assert!(error.contains("error code -21"), "{error}");
        } else {
            result.unwrap();
        }
    }
}
