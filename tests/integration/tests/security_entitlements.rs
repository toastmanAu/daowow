//! Creation must be backed by an authenticated native DAO withdrawal, not
//! merely plausible funding data and a public settlement lock.
mod common;
use ckb_testtool::ckb_types::{bytes::Bytes, core::TransactionBuilder, packed::*, prelude::*};
use common::*;

#[test]
fn standalone_funding_creation_cannot_assert_its_own_entitlements() {
    let mut world = World::new(ACC_MMR);
    let cfg = default_config([0x94; 32], ACC_MMR);
    let round = world.create_round(&cfg);
    let (input, _) = world.funding_cell(1000 * SHANNONS);
    let funding = SettlementFundingDataV3 {
        round_id: cfg.round_id,
        batch_id: 0,
        realized_total: 900 * SHANNONS,
        principal_liability: 800 * SHANNONS,
        prize_pool: 100 * SHANNONS,
        payout_cursor: 0,
        liability_count: 1,
        liabilities_root: [7; 32],
        prize_count: 0,
        prize_root: [0; 32],
        prize_paid: 0,
    };
    let tx = TransactionBuilder::default()
        .cell_dep(world.round_config_dep(&round))
        .input(CellInput::new(input, 0))
        .output(
            CellOutputBuilder::default()
                .capacity(pack_u64(900 * SHANNONS))
                .lock(world.settlement_public_lock())
                .type_(Some(world.settlement_script(0)).pack())
                .build(),
        )
        .output_data(Bytes::from(funding.encode().to_vec()))
        .build();
    expect_fail(&mut world.context, &tx);
}
