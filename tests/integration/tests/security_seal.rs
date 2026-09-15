mod common;
use ckb_testtool::ckb_types::{bytes::Bytes, core::TransactionBuilder, packed::*, prelude::*};
use common::*;
use daowow_core::{lifecycle::AggregationState, seal::RoundSeal};

#[test]
fn complete_closed_universe_seals_once() {
    seal_case(4);
}

#[test]
fn maximum_closed_universe_seals_once() {
    seal_case(256);
}

fn seal_case(shards: u32) {
    let mut w = World::new(ACC_MMR);
    let mut cfg = default_config([0x93; 32], ACC_MMR);
    cfg.entry_shard_count = shards;
    let round = w.create_round(&cfg);
    let cfg = full_config(&cfg, &w.deps);
    let mut ops = Vec::new();
    let mut states = Vec::new();
    for id in 0..cfg.entry_shard_count {
        let (op, mut frozen) = w.create_shard(&cfg, id, 0);
        frozen.state = SHARD_STATE_FROZEN;
        let (cell, _) = w.cell(&op);
        let cell = cell
            .as_builder()
            .capacity(pack_u64(if id == 0 {
                60_000 * SHANNONS
            } else {
                1000 * SHANNONS
            }))
            .build();
        // Seed frozen history; execute both ledger transitions under real scripts.
        w.context.create_cell_with_out_point(
            op.clone(),
            cell.clone(),
            Bytes::from(frozen.encode().to_vec()),
        );
        let state = AggregationState::new(&cfg, &frozen).unwrap();
        let init = TransactionBuilder::default()
            .cell_dep(w.round_config_dep(&round))
            .input(CellInput::new(op.clone(), 0))
            .output(cell.clone())
            .output_data(Bytes::from(state.encode().to_vec()))
            .build();
        expect_ok(&mut w.context, &init);
        chain_cell(&mut w, &op, &init, 0);
        let closed = state.close(&cfg, 0x2000_0000_0000_0064).unwrap();
        let close = TransactionBuilder::default()
            .cell_dep(w.round_config_dep(&round))
            .input(CellInput::new(op.clone(), 0x2000_0000_0000_0064))
            .output(cell)
            .output_data(Bytes::from(closed.encode().to_vec()))
            .build();
        expect_ok(&mut w.context, &close);
        chain_cell(&mut w, &op, &close, 0);
        ops.push(op);
        states.push(closed);
    }
    let seal = RoundSeal::new(&cfg, &states).unwrap();
    assert!(RoundSeal::new(&cfg, &states[..3]).is_err());
    let mut reversed = states.clone();
    reversed.reverse();
    assert!(RoundSeal::new(&cfg, &reversed).is_err());
    let mut open = states.clone();
    open[1] = AggregationState::new(&cfg, states[1].frozen()).unwrap();
    assert!(RoundSeal::new(&cfg, &open).is_err());
    assert_eq!(RoundSeal::decode(&seal.encode(), &cfg).unwrap(), seal);
    let mut trailing = seal.encode();
    trailing.push(0);
    assert!(RoundSeal::decode(&trailing, &cfg).is_err());
    assert_eq!(
        RoundSeal::entropy_heights(100).unwrap(),
        [164, 228, 292, 356]
    );
    assert!(RoundSeal::entropy_heights(u64::MAX - 255).is_err());
    let (cell, _) = w.cell(&ops[0]);
    let mut tx = TransactionBuilder::default()
        .cell_dep(w.round_config_dep(&round))
        .input(CellInput::new(ops[0].clone(), 0))
        .output(cell)
        .output_data(Bytes::from(seal.encode()));
    for op in ops.iter().skip(1) {
        tx = tx.cell_dep(CellDep::new_builder().out_point(op.clone()).build());
    }
    let tx = tx.build();
    expect_ok(&mut w.context, &tx);
    let (original, original_data) = w.cell(&ops[0]);
    let open_zero = AggregationState::new(&cfg, states[0].frozen()).unwrap();
    w.context.create_cell_with_out_point(
        ops[0].clone(),
        original.clone(),
        Bytes::from(open_zero.encode().to_vec()),
    );
    expect_fail(&mut w.context, &tx);
    w.context
        .create_cell_with_out_point(ops[0].clone(), original.clone(), original_data);
    let smaller = original
        .clone()
        .as_builder()
        .capacity(pack_u64(999 * SHANNONS))
        .build();
    expect_fail(
        &mut w.context,
        &tx.clone()
            .as_advanced_builder()
            .set_outputs(vec![smaller])
            .build(),
    );
    let (sponsor, _) = w.funding_cell(1000 * SHANNONS);
    expect_fail(
        &mut w.context,
        &tx.clone()
            .as_advanced_builder()
            .set_inputs(vec![CellInput::new(sponsor, 0)])
            .build(),
    );
    let (dep_cell, dep_data) = w.cell(&ops[1]);
    let (_, permissive) = w.always_success();
    w.context.create_cell_with_out_point(
        ops[1].clone(),
        dep_cell
            .clone()
            .as_builder()
            .type_(Some(permissive).pack())
            .build(),
        dep_data.clone(),
    );
    expect_fail(&mut w.context, &tx);
    w.context
        .create_cell_with_out_point(ops[1].clone(), dep_cell, dep_data);
    let mut deps: Vec<_> = tx.cell_deps().into_iter().collect();
    deps.pop();
    expect_fail(
        &mut w.context,
        &tx.clone().as_advanced_builder().set_cell_deps(deps).build(),
    );
    let mut forged = seal.encode();
    forged[179] ^= 1;
    expect_fail(
        &mut w.context,
        &tx.clone()
            .as_advanced_builder()
            .set_outputs_data(vec![pack_pbytes(&forged)])
            .build(),
    );
    chain_cell(&mut w, &ops[0], &tx, 0);
    expect_fail(&mut w.context, &tx);
    authenticate_entropy(&mut w, &cfg, &round, &ops[0], seal);
}

fn authenticate_entropy(
    w: &mut World,
    cfg: &RoundConfigV1,
    round: &OutPoint,
    op: &OutPoint,
    seal: RoundSeal,
) {
    use ckb_testtool::ckb_types::core::HeaderBuilder;
    use daowow_core::seal::EntropyRecord;
    let headers: Vec<_> = [100u64, 164, 228, 292]
        .into_iter()
        .map(|number| {
            HeaderBuilder::default()
                .number(number)
                .epoch(
                    ckb_testtool::ckb_types::core::EpochNumberWithFraction::new(1, 0, 1000)
                        .full_value(),
                )
                .build()
        })
        .collect();
    for header in &headers {
        w.context.insert_header(header.clone());
    }
    w.context
        .link_cell_with_block(op.clone(), headers[0].hash(), 0);
    let record = EntropyRecord::new(
        seal,
        100,
        headers[0].hash().into(),
        [
            headers[1].hash().into(),
            headers[2].hash().into(),
            headers[3].hash().into(),
        ],
    )
    .unwrap();
    let mut extra = record.encode();
    extra.push(0);
    assert!(EntropyRecord::decode(&extra, cfg).is_err());
    let mut truncated = record.encode();
    truncated.pop();
    assert!(EntropyRecord::decode(&truncated, cfg).is_err());
    assert_eq!(
        EntropyRecord::decode(&record.encode(), cfg).unwrap(),
        record
    );
    let (cell, _) = w.cell(op);
    let tx = TransactionBuilder::default()
        .cell_dep(w.round_config_dep(round))
        .input(CellInput::new(op.clone(), 0x8000_0000_0000_0100))
        .set_header_deps(headers.iter().map(|h| h.hash()).collect())
        .output(cell.clone())
        .output_data(Bytes::from(record.encode()))
        .build();
    expect_ok(&mut w.context, &tx);
    let bad_height = HeaderBuilder::default()
        .number(165u64)
        .epoch(ckb_testtool::ckb_types::core::EpochNumberWithFraction::new(1, 0, 1000).full_value())
        .build();
    w.context.insert_header(bad_height.clone());
    let mut fifth: Vec<_> = headers.iter().map(|h| h.hash()).collect();
    fifth.push(bad_height.hash());
    expect_fail(
        &mut w.context,
        &tx.clone()
            .as_advanced_builder()
            .set_header_deps(fifth)
            .build(),
    );
    let (_, creator) = w.always_success();
    expect_fail(
        &mut w.context,
        &tx.clone()
            .as_advanced_builder()
            .set_outputs(vec![cell.clone().as_builder().lock(creator).build()])
            .build(),
    );
    let capacity: u64 = cell.capacity().unpack();
    expect_fail(
        &mut w.context,
        &tx.clone()
            .as_advanced_builder()
            .set_outputs(vec![cell
                .clone()
                .as_builder()
                .capacity(pack_u64(capacity - 1))
                .build()])
            .build(),
    );
    let mut altered_seal = record.encode();
    altered_seal[180] ^= 1;
    expect_fail(
        &mut w.context,
        &tx.clone()
            .as_advanced_builder()
            .set_outputs_data(vec![pack_pbytes(&altered_seal)])
            .build(),
    );
    let wrong_record = EntropyRecord::new(
        record.seal().clone(),
        100,
        headers[0].hash().into(),
        [
            bad_height.hash().into(),
            headers[2].hash().into(),
            headers[3].hash().into(),
        ],
    )
    .unwrap();
    let mut wrong_headers: Vec<_> = headers.iter().map(|h| h.hash()).collect();
    wrong_headers[1] = bad_height.hash();
    expect_fail(
        &mut w.context,
        &tx.clone()
            .as_advanced_builder()
            .set_header_deps(wrong_headers)
            .set_outputs_data(vec![pack_pbytes(&wrong_record.encode())])
            .build(),
    );
    for since in [
        0,
        256,
        0x8000_0000_0000_00ff,
        0xa000_0000_0000_0100,
        0x8100_0000_0000_0100,
    ] {
        let bad = tx
            .clone()
            .as_advanced_builder()
            .set_inputs(vec![CellInput::new(op.clone(), since)])
            .build();
        expect_fail(&mut w.context, &bad);
    }
    let mut reordered: Vec<_> = headers.iter().map(|h| h.hash()).collect();
    reordered.swap(1, 2);
    expect_fail(
        &mut w.context,
        &tx.clone()
            .as_advanced_builder()
            .set_header_deps(reordered)
            .build(),
    );
    expect_fail(
        &mut w.context,
        &tx.clone()
            .as_advanced_builder()
            .set_header_deps(headers[..3].iter().map(|h| h.hash()).collect())
            .build(),
    );
    let mut forged = record.encode();
    let end = forged.len() - 1;
    forged[end] ^= 1;
    expect_fail(
        &mut w.context,
        &tx.clone()
            .as_advanced_builder()
            .set_outputs_data(vec![pack_pbytes(&forged)])
            .build(),
    );
    let false_anchor = HeaderBuilder::default()
        .number(99u64)
        .epoch(ckb_testtool::ckb_types::core::EpochNumberWithFraction::new(1, 0, 1000).full_value())
        .build();
    w.context.insert_header(false_anchor.clone());
    let mut deps: Vec<_> = headers.iter().map(|h| h.hash()).collect();
    deps[0] = false_anchor.hash();
    expect_fail(
        &mut w.context,
        &tx.clone()
            .as_advanced_builder()
            .set_header_deps(deps)
            .build(),
    );
    chain_cell(w, op, &tx, 0);
    expect_fail(&mut w.context, &tx);
    expect_fail(
        &mut w.context,
        &tx.clone()
            .as_advanced_builder()
            .set_outputs_data(vec![pack_pbytes(&record.seal().encode())])
            .build(),
    );
}
