//! Adversarial suite for the round's entry-opening enforcement: proves the
//! `(SHARD_STATE_OPEN, SHARD_STATE_OPEN)` append arm in
//! contracts/entry-shard-type/src/main.rs refuses an append whose `since`
//! lands before the round's configured `entry_start`.
//!
//! `since` is a lower bound (RFC-0017 absolute epoch), so "not before
//! entry_start" is exactly the shape it can express. The closing side of the
//! same window cannot be a check at all — it is enforced by the freeze
//! transition instead (see the `(OPEN, FROZEN)` arm's `entry_end` check),
//! which is why only opening is tested here.
//!
//! Each test below is a single-input, zero-entry (identity) append
//! transaction: the shard cell's own type script is the only script group
//! that runs, so the asserted exact `i8` identifies the opening guard with
//! no ambiguity from CKB's script-hash execution order.

mod common;

use ckb_testtool::ckb_types::{
    bytes::Bytes,
    core::{TransactionBuilder, TransactionView},
    packed::*,
};
use ckb_testtool::context::Context;
use common::*;
use daowow_core::epoch::ABSOLUTE_EPOCH_FLAG;
use daowow_core::error::codes::SHARD_ERROR_NOT_OPEN;

fn code_of(err: &ckb_testtool::ckb_error::Error) -> i8 {
    let text = format!("{err}");
    text.split("error code ")
        .nth(1)
        .and_then(|rest| rest.split(' ').next())
        .and_then(|s| s.parse::<i8>().ok())
        .unwrap_or_else(|| panic!("could not parse an exact error code from: {err}"))
}

/// Assert the transaction fails with exactly `expected` — never a broad
/// match. Every call site in this file spends only the shard cell (one
/// script group can possibly reject), so the exact code identifies the
/// opening guard under test rather than an artifact of execution order.
fn expect_code(context: &mut Context, tx: &TransactionView, expected: i8) {
    let err = expect_fail(context, tx);
    let code = code_of(&err);
    assert_eq!(code, expected, "unexpected failure: {err}");
}

/// Create a round and its single shard (shard_id 0) with the given timing.
fn open_round_with_entry_start(
    world: &mut World,
    start: u64,
    end: u64,
    deadline: u64,
) -> (OutPoint, OutPoint, RoundConfigV1) {
    let mut cfg = default_config([0xE5; 32], ACC_MMR);
    cfg.entry_start = start;
    cfg.entry_end = end;
    cfg.aggregation_deadline = deadline;
    let round_op = world.create_round(&cfg);
    let (shard_op, _shard0) = world.create_shard(&cfg, 0, 1);
    (round_op, shard_op, cfg)
}

/// An identity (zero-entry) append of the shard head, spent with `since`.
///
/// Adapted from `proto1_entry_shard.rs::build_entry_tx`, parameterised on
/// `since` in place of its hardcoded `CellInput::new(shard_op.clone(), 0)`.
/// Copied rather than editing the shared builder, since other suites depend
/// on its current shape. Zero entries keeps the fixture minimal: the shard
/// data is unchanged (before == after) and the MMR witness carries empty old
/// and new peak sets, so only the opening guard under test can reject.
fn append_with_since(
    world: &mut World,
    round_op: &OutPoint,
    shard_op: &OutPoint,
    _cfg: &RoundConfigV1,
    since: u64,
) -> TransactionView {
    let (cell, data) = world.cell(shard_op);
    let before = EntryShardDataV1::decode(&data).unwrap();
    let witness = daowow_core::witness::encode_shard_append_witness_mmr(&[], &[0u8], &[0u8]);
    TransactionBuilder::default()
        .cell_dep(world.round_config_dep(round_op))
        .input(CellInput::new(shard_op.clone(), since))
        .output(cell)
        .output_data(Bytes::from(before.encode().to_vec()))
        .witness(pack_pbytes(&witness))
        .build()
}

/// An append landing one epoch before the round opens is refused.
///
/// `since` is a lower bound, so "not before `entry_start`" is exactly what it
/// can express. The closing side of the same window cannot be a check at all —
/// it is enforced by the freeze transition, which is why only opening is
/// implemented here.
#[test]
fn an_append_before_entry_start_is_refused() {
    let mut w = World::new(ACC_MMR);
    // entry_start = 100, entry_end = 200, aggregation_deadline = 300
    let (round_op, shard_op, cfg) = open_round_with_entry_start(&mut w, 100, 200, 300);
    let tx = append_with_since(&mut w, &round_op, &shard_op, &cfg, ABSOLUTE_EPOCH_FLAG | 99);
    expect_code(&mut w.context, &tx, SHARD_ERROR_NOT_OPEN);
}

/// The boundary is inclusive: an append exactly at `entry_start` is accepted.
#[test]
fn an_append_at_entry_start_is_accepted() {
    let mut w = World::new(ACC_MMR);
    let (round_op, shard_op, cfg) = open_round_with_entry_start(&mut w, 100, 200, 300);
    let tx = append_with_since(
        &mut w,
        &round_op,
        &shard_op,
        &cfg,
        ABSOLUTE_EPOCH_FLAG | 100,
    );
    expect_ok(&mut w.context, &tx);
}

/// A bare block-number `since` must not be read as an epoch:
/// `absolute_epoch_number` requires `since >> 56 == 0x20`, so `100` without
/// the flag is refused rather than silently treated as epoch 100.
#[test]
fn a_block_number_since_is_refused() {
    let mut w = World::new(ACC_MMR);
    let (round_op, shard_op, cfg) = open_round_with_entry_start(&mut w, 100, 200, 300);
    let tx = append_with_since(&mut w, &round_op, &shard_op, &cfg, 100);
    expect_code(&mut w.context, &tx, SHARD_ERROR_NOT_OPEN);
}
