//! Sub-project 3: claim retirement authenticated against the sealed round.
//! Proves the accepted non-winner path end-to-end on CKB-VM: a claim that
//! was never drawn, with nothing paid, may be consumed with no successor
//! and no memento.

mod common;
use ckb_testtool::ckb_types::{bytes::Bytes, core::TransactionBuilder, packed::*, prelude::*};
use common::*;

#[test]
fn a_non_winner_retires_once_the_round_is_sealed() {
    let mut w = World::new(ACC_MMR);
    let round = sealed_round_with_entropy(&mut w, 4, 8);
    let (_, lock) = w.always_success();
    let (claim_op, args) = seed_claim(
        &mut w,
        &lock,
        round.non_winning_shard,
        round.non_winning_position,
    );

    let tx = TransactionBuilder::default()
        .input(CellInput::new_builder().previous_output(claim_op).build())
        .output(
            CellOutputBuilder::default()
                .capacity(pack_u64(claim_cell_capacity(&lock)))
                .lock(lock.clone())
                .build(),
        )
        .output_data(Bytes::new().pack())
        .cell_dep(round.config_dep.clone())
        .cell_dep(round.entropy_dep.clone())
        .witness(schedule_witness(&round.schedule))
        .build();
    expect_ok(&mut w.context, &tx);
    let _ = args;
}

#[test]
fn a_winner_retires_and_receives_one_memento() {
    let mut w = World::new(ACC_MMR);
    let round = sealed_round_with_entropy(&mut w, 4, 8);
    let (_, lock) = w.always_success();
    let (claim_op, args) = seed_paid_claim(&mut w, &lock, &round);
    let tx = retire_with_memento(&mut w, &round, &lock, claim_op, &args);
    expect_ok(&mut w.context, &tx);
}

#[test]
fn a_memento_transfers_and_burns() {
    let mut w = World::new(ACC_MMR);
    let round = sealed_round_with_entropy(&mut w, 4, 8);
    let (_, lock) = w.always_success();
    let memento_op = seed_memento(&mut w, &lock, &round);
    let transfer_tx = transfer_memento(&mut w, &lock, memento_op.clone());
    expect_ok(&mut w.context, &transfer_tx);
    let burn_tx = burn_memento(&mut w, memento_op);
    expect_ok(&mut w.context, &burn_tx);
}

#[test]
fn a_non_winner_retires_at_the_maximum_shard_count() {
    // Measurement, not a behavioural case. `RoundConfigV1::validate` permits
    // `entry_shard_count` up to 256, and retire() decodes AND re-encodes the
    // whole seal on the 512 KiB bump allocator that never frees: the record
    // load, `RoundSeal::decode`'s ledger collect, `RoundSeal::new`'s to_vec,
    // and `ComputedDraw::new`'s internal `record.encode()` all land on it.
    // Everything previously measured was at 4 shards. If the retire path
    // exhausts the heap at a large shard count the script aborts, and because
    // the seal is immutable EVERY claim in that round is permanently
    // unretirable — one of the two error directions this feature exists to
    // avoid. This proves the path survives the configured maximum.
    let mut w = World::new(ACC_MMR);
    let round = sealed_round_with_entropy(&mut w, 256, 512);
    let lock = w.always_success().1;
    let (claim_op, _) = seed_claim(
        &mut w,
        &lock,
        round.non_winning_shard,
        round.non_winning_position,
    );
    let tx = TransactionBuilder::default()
        .input(CellInput::new_builder().previous_output(claim_op).build())
        .output(
            CellOutputBuilder::default()
                .capacity(pack_u64(claim_cell_capacity(&lock)))
                .lock(lock.clone())
                .build(),
        )
        .output_data(Bytes::new().pack())
        .cell_dep(round.config_dep.clone())
        .cell_dep(round.entropy_dep.clone())
        .witness(schedule_witness(&round.schedule))
        .build();
    let cycles = expect_ok(&mut w.context, &tx);
    println!("retire at 256 shards: {cycles} cycles");
}
