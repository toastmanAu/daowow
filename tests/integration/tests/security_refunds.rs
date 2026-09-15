mod common;
use ckb_testtool::ckb_types::{bytes::Bytes, core::TransactionBuilder, packed::*, prelude::*};
use common::*;

fn refund(n: u64, repayment: u64, since: u64, typed: bool, data: bool) -> Result<u64, String> {
    refund_with_authority(n, repayment, since, typed, data, true)
}

fn refund_with_authority(
    n: u64,
    repayment: u64,
    since: u64,
    typed: bool,
    data: bool,
    authority: bool,
) -> Result<u64, String> {
    refund_across_configs(n, repayment, since, typed, data, authority, 1, 0)
}

fn refund_across_configs(
    n: u64,
    repayment: u64,
    since: u64,
    typed: bool,
    data: bool,
    authority: bool,
    configs: u8,
    sealed: u8,
) -> Result<u64, String> {
    let mut w = World::new(ACC_SMT);
    let (_, participant) = w.always_success();
    let ph = World::participant_hash(&participant);
    let mut tx = TransactionBuilder::default();
    for config_index in 0..configs {
        let mut cfg = default_config([0x71 + config_index; 32], ACC_SMT);
        if sealed != 0 {
            cfg.entry_shard_count = 256;
        }
        let round = w.create_round(&cfg);
        let cfg = full_config(&cfg, &w.deps);
        tx = tx.cell_dep(w.round_config_dep(&round));
        let mut host = SmtHost::new();
        let mut entries = Vec::new();
        for nonce in 0..n {
            let e = EntryDataV1 {
                round_id: cfg.round_id,
                shard_id: 0,
                participant_lock_hash: ph,
                ticket_count: 3,
                principal: 300 * SHANNONS,
                position_base: nonce * 3,
                entry_nonce: nonce,
                entropy_commitment: [0; 32],
            };
            let lock = w.entry_lock_script(&ph);
            let out = CellOutputBuilder::default()
                .capacity(pack_u64(505 * SHANNONS))
                .lock(lock)
                .build();
            let op = w.context.create_cell(out, Bytes::from(e.encode().to_vec()));
            tx = tx.input(CellInput::new(op, since));
            host.insert(&smt_key(&e), &smt_leaf(&e)).unwrap();
            entries.push(e);
        }
        if authority {
            let (shard_op, mut frozen) = w.create_shard(&cfg, 0, 1);
            frozen.state = SHARD_STATE_FROZEN;
            frozen.sequence = n;
            frozen.entry_count = n;
            frozen.ticket_count = 3 * n;
            frozen.principal_total = 300 * SHANNONS * n;
            frozen.accumulator_root = host.root();
            let (cell, _) = w.cell(&shard_op);
            // Seed canonical frozen history, then execute actual initialization
            // and permissionless deadline closure under the shard script.
            w.context.create_cell_with_out_point(
                shard_op.clone(),
                cell.clone(),
                Bytes::from(frozen.encode().to_vec()),
            );
            let state = daowow_core::lifecycle::AggregationState::new(&cfg, &frozen).unwrap();
            let sponsor = w.funding_cell(1000 * SHANNONS);
            let cell = cell.as_builder().capacity(pack_u64(500 * SHANNONS)).build();
            let init = TransactionBuilder::default()
                .cell_dep(w.round_config_dep(&round))
                .input(CellInput::new(shard_op.clone(), 0))
                .input(CellInput::new(sponsor.0, 0))
                .output(cell.clone())
                .output_data(Bytes::from(state.encode().to_vec()))
                .build();
            expect_ok(&mut w.context, &init);
            chain_cell(&mut w, &shard_op, &init, 0);
            let deadline =
                daowow_core::epoch::absolute_epoch_since(cfg.aggregation_deadline).unwrap();
            let closed = state.close(&cfg, deadline).unwrap();
            let close = TransactionBuilder::default()
                .cell_dep(w.round_config_dep(&round))
                .input(CellInput::new(shard_op.clone(), deadline))
                .output(cell)
                .output_data(Bytes::from(closed.encode().to_vec()))
                .build();
            expect_ok(&mut w.context, &close);
            chain_cell(&mut w, &shard_op, &close, 0);
            if sealed != 0 {
                let mut states = vec![closed];
                let mut dependencies = Vec::new();
                for id in 1..cfg.entry_shard_count {
                    let (op, mut empty) = w.create_shard(&cfg, id, 0);
                    empty.state = SHARD_STATE_FROZEN;
                    let state = daowow_core::lifecycle::AggregationState::new(&cfg, &empty)
                        .unwrap()
                        .close(&cfg, deadline)
                        .unwrap();
                    let (cell, _) = w.cell(&op);
                    // Isolated capacity/heap fixture for other closed histories;
                    // security_seal executes their actual transitions separately.
                    w.context.create_cell_with_out_point(
                        op.clone(),
                        cell,
                        Bytes::from(state.encode().to_vec()),
                    );
                    states.push(state);
                    dependencies.push(CellDep::new_builder().out_point(op).build());
                }
                let seal = daowow_core::seal::RoundSeal::new(&cfg, &states).unwrap();
                let (cell, _) = w.cell(&shard_op);
                let (funding, _) = w.funding_cell(100_000 * SHANNONS);
                let seal_tx = TransactionBuilder::default()
                    .set_cell_deps(dependencies)
                    .cell_dep(w.round_config_dep(&round))
                    .input(CellInput::new(shard_op.clone(), 0))
                    .input(CellInput::new(funding, 0))
                    .output(
                        cell.as_builder()
                            .capacity(pack_u64(60_000 * SHANNONS))
                            .build(),
                    )
                    .output_data(Bytes::from(seal.encode()))
                    .build();
                expect_ok(&mut w.context, &seal_tx);
                chain_cell(&mut w, &shard_op, &seal_tx, 0);
                if sealed == 2 {
                    use ckb_testtool::ckb_types::core::{EpochNumberWithFraction, HeaderBuilder};
                    let headers: Vec<_> = [100u64, 164, 228, 292]
                        .into_iter()
                        .map(|number| {
                            HeaderBuilder::default()
                                .number(number)
                                .epoch(EpochNumberWithFraction::new(1, 0, 1000).full_value())
                                .build()
                        })
                        .collect();
                    for header in &headers {
                        w.context.insert_header(header.clone());
                    }
                    w.context
                        .link_cell_with_block(shard_op.clone(), headers[0].hash(), 0);
                    let record = daowow_core::seal::EntropyRecord::new(
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
                    let (cell, _) = w.cell(&shard_op);
                    let entropy = TransactionBuilder::default()
                        .cell_dep(w.round_config_dep(&round))
                        .input(CellInput::new(shard_op.clone(), 0x8000_0000_0000_0100))
                        .set_header_deps(headers.iter().map(|h| h.hash()).collect())
                        .output(cell)
                        .output_data(Bytes::from(record.encode()))
                        .build();
                    expect_ok(&mut w.context, &entropy);
                    chain_cell(&mut w, &shard_op, &entropy, 0);
                }
            }
            tx = tx.cell_dep(CellDep::new_builder().out_point(shard_op).build());
        }
        for e in &entries {
            tx = tx.witness(aggregation_witness(
                &host.inclusion_proof(&[smt_key(e)]).unwrap(),
            ));
        }
    }
    let out = CellOutputBuilder::default()
        .capacity(pack_u64(repayment))
        .lock(participant.clone())
        .type_(if typed {
            Some(participant).pack()
        } else {
            None::<Script>.pack()
        })
        .build();
    let tx = tx
        .output(out)
        .output_data(if data {
            Bytes::from(vec![1])
        } else {
            Bytes::new()
        })
        .build();
    let tx = w.context.complete_tx(tx);
    w.context
        .verify_tx(&tx, MAX_CYCLES)
        .map_err(|e| e.to_string())
}

#[test]
fn same_participant_cross_config_refunds_cannot_reuse_one_payment() {
    assert!(refund_across_configs(
        1,
        1010 * SHANNONS,
        0x2000_0000_0000_00c8,
        false,
        false,
        true,
        2,
        0
    )
    .is_ok());
    assert!(refund_across_configs(
        1,
        505 * SHANNONS,
        0x2000_0000_0000_00c8,
        false,
        false,
        true,
        2,
        0
    )
    .is_err());
}

#[test]
fn sealed_shard_zero_preserves_excluded_entry_refunds() {
    assert!(refund_across_configs(
        2,
        1010 * SHANNONS,
        0x2000_0000_0000_00c8,
        false,
        false,
        true,
        1,
        1
    )
    .is_ok());
    assert!(refund_across_configs(
        2,
        505 * SHANNONS,
        0x2000_0000_0000_00c8,
        false,
        false,
        true,
        1,
        1
    )
    .is_err());
}

#[test]
fn entropy_record_preserves_excluded_entry_refunds() {
    assert!(refund_across_configs(
        2,
        1010 * SHANNONS,
        0x2000_0000_0000_00c8,
        false,
        false,
        true,
        1,
        2
    )
    .is_ok());
    assert!(refund_across_configs(
        2,
        505 * SHANNONS,
        0x2000_0000_0000_00c8,
        false,
        false,
        true,
        1,
        2
    )
    .is_err());
}

#[test]
fn refund_returns_summed_full_capacity() {
    assert!(refund(2, 1010 * SHANNONS, 0x2000_0000_0000_00c8, false, false).is_ok());
    assert!(refund(2, 505 * SHANNONS, 0x2000_0000_0000_00c8, false, false).is_err());
    assert!(refund(1, 300 * SHANNONS, 0x2000_0000_0000_00c8, false, false).is_err());
}

#[test]
fn refund_without_closed_ledger_is_rejected() {
    assert!(refund_with_authority(
        2,
        1010 * SHANNONS,
        0x2000_0000_0000_00c8,
        false,
        false,
        false
    )
    .is_err());
}

#[test]
fn refund_rejects_early_fraction_and_non_epoch_since() {
    for since in [
        0,
        0xa000_0000_0000_00c8,
        0x2100_0000_0000_00c8,
        0x2000_0000_0000_0000 | (1000 << 40) | (999 << 24) | 199,
    ] {
        assert!(refund(1, 505 * SHANNONS, since, false, false).is_err());
    }
}

#[test]
fn refund_requires_ordinary_output() {
    assert!(refund(1, 505 * SHANNONS, 0x2000_0000_0000_00c8, true, false).is_err());
    assert!(refund(1, 505 * SHANNONS, 0x2000_0000_0000_00c8, false, true).is_err());
}
