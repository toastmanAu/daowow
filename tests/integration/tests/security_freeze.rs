mod common;
use ckb_testtool::ckb_types::{bytes::Bytes, core::TransactionBuilder, packed::*, prelude::*};
use common::*;

fn freeze(since: u64) -> Result<u64, String> {
    let mut w = World::new(ACC_MMR);
    let cfg = default_config([0x72; 32], ACC_MMR);
    let round = w.create_round(&cfg);
    let (op, mut state) = w.create_shard(&cfg, 0, 1);
    let (cell, _) = w.cell(&op);
    state.state = SHARD_STATE_FROZEN;
    let tx = TransactionBuilder::default()
        .cell_dep(w.round_config_dep(&round))
        .input(CellInput::new(op, since))
        .output(cell)
        .output_data(Bytes::from(state.encode().to_vec()))
        .build();
    let tx = w.context.complete_tx(tx);
    w.context
        .verify_tx(&tx, MAX_CYCLES)
        .map_err(|e| e.to_string())
}

#[test]
fn freeze_enforces_absolute_epoch_boundary() {
    assert!(freeze(0x2000_0000_0000_0064).is_ok());
    for since in [
        0,
        0x2000_0000_0000_0063,
        0xa000_0000_0000_0064,
        0x2100_0000_0000_0064,
        0x2000_0000_0000_0000 | (1000 << 40) | (999 << 24) | 99,
    ] {
        let error = freeze(since).unwrap_err();
        assert!(error.contains("error code -34"), "{error}");
    }
}
