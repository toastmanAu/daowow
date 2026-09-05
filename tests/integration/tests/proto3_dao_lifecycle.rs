//! Phase-1 prototype #3: DAO custody transition — deposit, phase-one
//! withdraw, phase-two withdraw under DAOWOWDAOLock with the native DAO
//! type, without any privileged key.
//!
//! The mock chain provides headers with DAO fields (C_i, AR_i, S_i, U_i);
//! the native DAO script computes compensation. Phase two's `since` uses an
//! absolute epoch per RFC-0023.
//!
//! Proves:
//! - deposit -> withdrawing preserves capacity/type/block-number and
//!   rejects lock substitution (T-02);
//! - withdrawing -> settlement funding flows realised capacity only to
//!   settlement-type cells bound to the same round;
//! - adversarial: phase-one lock substitution, wrong block number, phase-two
//!   arbitrary operator output.

mod common;

use ckb_testtool::ckb_types::{bytes::Bytes, core::{TransactionView, TransactionBuilder, ScriptHashType, DepType, HeaderView, EpochNumberWithFraction}, packed::*, prelude::*};
use common::*;

const DEPOSIT_AR: u64 = 10_000_000_000_000_000; // 1.0 (10^16 scale)
const WITHDRAW_AR: u64 = 10_100_000_000_000_000; // 1.01 -> 1% compensation

fn dao_field(ar: u64) -> Byte32 {
    let mut buf = [0u8; 32];
    buf[0..8].copy_from_slice(&1_000_000_000u64.to_le_bytes()); // C_i
    buf[8..16].copy_from_slice(&ar.to_le_bytes()); // AR_i
    buf[16..24].copy_from_slice(&500_000_000u64.to_le_bytes()); // S_i
    buf[24..32].copy_from_slice(&1_000_000_000_000u64.to_le_bytes()); // U_i
    Byte32::new(buf)
}

/// Build a header view at `number` with the given AR and epoch.
fn header(number: u64, epoch_number: u64, ar: u64) -> HeaderView {
    use ckb_testtool::ckb_types::core::HeaderBuilder as CoreHeaderBuilder;
    let epoch = EpochNumberWithFraction::new(epoch_number, 0, 1000);
    CoreHeaderBuilder::default()
        .number(number)
        .epoch(epoch.full_value())
        .parent_hash(Byte32::new([1; 32]))
        .timestamp(1_700_000_000u64 + number)
        .dao(dao_field(ar))
        .nonce(0u128)
        .compact_target(0x1a000000u32)
        .version(0u32)
        .transactions_root(Byte32::new([2; 32]))
        .proposals_hash(Byte32::new([3; 32]))
        .extra_hash(Byte32::new([5; 32]))
        .build()
}

/// Phase-2 witness: WitnessArgs with input_type = deposit header index (0).
fn phase2_witness() -> ckb_testtool::ckb_types::packed::Bytes {
    pack_pbytes(
        WitnessArgs::new_builder()
            .input_type(BytesOpt::from(pack_pbytes(&0u64.to_le_bytes())))
            .build()
            .as_bytes()
            .as_ref(),
    )
}

struct DaoRound {
    world: World,
    cfg: RoundConfigV1,
    round_op: OutPoint,
    round_id: Hash32,
    /// deposit cell: lock = dao-lock(round, batch 1), type = DAO, data 8 zeros
    deposit_op: OutPoint,
    deposit_capacity: u64,
    deposit_block: u64,
    deposit_epoch: u64,
}

fn prepare() -> DaoRound {
    let mut world = World::new(ACC_SMT);
    let round_id = [0x33; 32];
    let mut cfg = default_config(round_id, ACC_SMT);
    cfg.dao_lock = world.deps.dao_lock;
    cfg.settlement_type = world.deps.settlement_type;
    cfg.dao_type = world.deps.dao_type;
    let round_op = world.create_round(&cfg);

    // headers: deposit at block 100 (epoch 10), withdraw phase-1 at block 200
    let dep_header = header(100, 10, DEPOSIT_AR);
    let wdr_header = header(200, 190, WITHDRAW_AR); // epoch 200 > 10 + 180
    world.context.insert_header(dep_header.clone());
    world.context.insert_header(wdr_header);

    let batch_id = 1u64;
    let dao_lock_script = world.dao_lock_script(&round_id, batch_id);
    // sponsor funding cell that becomes the deposit
    let (funding_op, _) = world.funding_cell(1000 * SHANNONS);
    let deposit_capacity = 1000 * SHANNONS;
    let _ = funding_op;
    // (no script checks a plain deposit creation; we register the deposit
    // cell directly in the context)
    let deposit_op = world.context.create_cell(
        CellOutputBuilder::default()
            .capacity(pack_u64(deposit_capacity))
            .lock(dao_lock_script)
            .type_(Some(world.dao_type_script()).pack())
            .build(),
        Bytes::from(vec![0u8; 8]),
    );
    // link the deposit cell with its inclusion block + header dep
    world
        .context
        .link_cell_with_block(deposit_op.clone(), dep_header.hash(), 0);

    DaoRound {
        world,
        cfg,
        round_op,
        round_id,
        deposit_op,
        deposit_capacity,
        deposit_block: 100,
        deposit_epoch: 10,
    }
}

fn phase1_tx(r: &mut DaoRound, substitute_lock: bool, wrong_block: bool) -> (TransactionView, Script) {
    let (cell, _) = r.world.cell(&r.deposit_op);
    let good_lock = r.world.dao_lock_script(&r.round_id, 1);
    let evil_lock = r.world.funding_cell(1 * SHANNONS).1;
    let out_lock = if substitute_lock { evil_lock } else { good_lock };
    let block_number = if wrong_block { 999 } else { r.deposit_block };
    let tx = TransactionBuilder::default()
        .cell_dep(r.world.round_config_dep(&r.round_op))
        .cell_dep(
            CellDepBuilder::default()
                .out_point(r.world.dao_cell_op.clone())
                .dep_type(pack_byte(DepType::Code as u8))
                .build(),
        )
        .input(CellInput::new(r.deposit_op.clone(), 0))
        .header_dep(header(r.deposit_block, r.deposit_epoch, DEPOSIT_AR).hash())
        .output(
            CellOutputBuilder::default()
                .capacity(pack_u64(cell.capacity().unpack()))
                .lock(out_lock.clone())
                .type_(Some(cell.type_().to_opt().unwrap()).pack())
                .build(),
        )
        .output_data(Bytes::from(block_number.to_le_bytes().to_vec()))
        .witness(pack_pbytes(WitnessArgs::new_builder().build().as_bytes().as_ref()))
        .build();
    (tx, out_lock)
}

#[test]
fn deposit_to_withdrawing_preserves_custody() {
    let mut r = prepare();
    let (tx, _) = phase1_tx(&mut r, false, false);
    let c = expect_ok(&mut r.world.context, &tx);
    println!("cycles: DAO phase 1 (deposit -> withdrawing) = {}", c);
}

#[test]
fn phase1_rejects_lock_substitution() {
    let mut r = prepare();
    let (tx, _) = phase1_tx(&mut r, true, false);
    let e = expect_fail(&mut r.world.context, &tx);
    println!("phase-1 lock substitution rejected: {:?}", e);
}

#[test]
fn phase1_rejects_wrong_block_number() {
    let mut r = prepare();
    let (tx, _) = phase1_tx(&mut r, false, true);
    let e = expect_fail(&mut r.world.context, &tx);
    println!("phase-1 wrong block number rejected: {:?}", e);
}

#[test]
fn phase2_flows_to_settlement_only() {
    let mut r = prepare();

    // build the withdrawing cell (as phase 1 would produce)
    let (cell, _) = r.world.cell(&r.deposit_op);
    let good_lock = r.world.dao_lock_script(&r.round_id, 1);
    let withdrawing_op = {
        let wdr_header = header(200, 190, WITHDRAW_AR);
        let op = r.world.context.create_cell(
            CellOutputBuilder::default()
                .capacity(pack_u64(cell.capacity().unpack()))
                .lock(good_lock)
                .type_(Some(r.world.dao_type_script()).pack())
                .build(),
            Bytes::from(r.deposit_block.to_le_bytes().to_vec()),
        );
        r.world
            .context
            .link_cell_with_block(op.clone(), wdr_header.hash(), 0);
        op
    };

    // phase 2: absolute epoch since >= deposit epoch + 180 epochs
    let since_epoch = EpochNumberWithFraction::new(r.deposit_epoch + 180, 0, 1000);
    let since = (0x20u64 << 56) | since_epoch.full_value();
    let dep_hash = header(r.deposit_block, r.deposit_epoch, DEPOSIT_AR).hash();
    let wdr_hash = header(200, 190, WITHDRAW_AR).hash();

    // settlement funding cell (created under settlement-type)
    let settle_type_script = r.world.settlement_script(1);
    let funding_data = SettlementFundingDataV1 {
        round_id: r.round_id,
        batch_id: 1,
        realized_total: 0, // filled below by capacity math
        principal_liability: r.deposit_capacity,
        prize_pool: 0,
        payout_cursor: [0; 32],
        liabilities_root: [0; 32],
    };
    // funding cell capacity = whole withdrawing capacity (fee = 0)
    let funding_capacity = cell.capacity().unpack();
    let funding_data = SettlementFundingDataV1 { realized_total: funding_capacity, ..funding_data };

    let tx = TransactionBuilder::default()
        .cell_dep(r.world.round_config_dep(&r.round_op))
        .cell_dep(
            CellDepBuilder::default()
                .out_point(r.world.dao_cell_op.clone())
                .dep_type(pack_byte(DepType::Code as u8))
                .build(),
        )
        .input(CellInput::new(withdrawing_op, since))
        .header_dep(dep_hash)
        .header_dep(wdr_hash)
        .output(
            CellOutputBuilder::default()
                .capacity(pack_u64(funding_capacity))
                .lock(r.world.funding_cell(1 * SHANNONS).1)
                .type_(Some(settle_type_script).pack())
                .build(),
        )
        .output_data(Bytes::from(funding_data.encode().to_vec()))
        .witness(phase2_witness())
        .build();
    let c = expect_ok(&mut r.world.context, &tx);
    println!("cycles: DAO phase 2 (withdrawing -> settlement funding) = {}", c);
}

#[test]
fn phase2_rejects_arbitrary_operator_output() {
    let mut r = prepare();

    let (cell, _) = r.world.cell(&r.deposit_op);
    let good_lock = r.world.dao_lock_script(&r.round_id, 1);
    let withdrawing_op = {
        let wdr_header = header(200, 190, WITHDRAW_AR);
        let op = r.world.context.create_cell(
            CellOutputBuilder::default()
                .capacity(pack_u64(cell.capacity().unpack()))
                .lock(good_lock)
                .type_(Some(r.world.dao_type_script()).pack())
                .build(),
            Bytes::from(r.deposit_block.to_le_bytes().to_vec()),
        );
        r.world
            .context
            .link_cell_with_block(op.clone(), wdr_header.hash(), 0);
        op
    };
    let since_epoch = EpochNumberWithFraction::new(r.deposit_epoch + 180, 0, 1000);
    let since = (0x20u64 << 56) | since_epoch.full_value();
    let dep_hash = header(r.deposit_block, r.deposit_epoch, DEPOSIT_AR).hash();
    let wdr_hash = header(200, 190, WITHDRAW_AR).hash();

    // attacker output: plain cell, no settlement marker
    let evil = r.world.funding_cell(1000 * SHANNONS);
    let tx = TransactionBuilder::default()
        .cell_dep(r.world.round_config_dep(&r.round_op))
        .cell_dep(
            CellDepBuilder::default()
                .out_point(r.world.dao_cell_op.clone())
                .dep_type(pack_byte(DepType::Code as u8))
                .build(),
        )
        .input(CellInput::new(withdrawing_op, since))
        .header_dep(dep_hash)
        .header_dep(wdr_hash)
        .output(
            CellOutputBuilder::default()
                .capacity(pack_u64(r.deposit_capacity))
                .lock(evil.1)
                .build(),
        )
        .output_data(Bytes::new())
        .witness(phase2_witness())
        .build();
    let e = expect_fail(&mut r.world.context, &tx);
    println!("phase-2 arbitrary operator output rejected: {:?}", e);
}
