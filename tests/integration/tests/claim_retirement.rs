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
