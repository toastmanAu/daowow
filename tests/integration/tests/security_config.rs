mod common;
use ckb_testtool::ckb_types::{bytes::Bytes, core::TransactionBuilder, packed::*, prelude::*};
use common::*;

#[test]
fn substituted_config_is_rejected_by_all_spending_contracts() {
    for kind in 0..3 {
        let mut w = World::new(ACC_MMR);
        let cfg = default_config([0x73; 32], ACC_MMR);
        let real = w.create_round(&cfg);
        let (real_cell, real_data) = w.cell(&real);
        let mut fake = RoundConfigV1::decode(&real_data).unwrap();
        fake.keeper_policy_hash = [0xab; 32];
        assert!(fake.validate().is_ok());
        let (_, participant) = w.always_success();
        // A config-shaped cell with an attacker-controlled type script.
        let fake_type = participant
            .clone()
            .as_builder()
            .args(Bytes::from(vec![0; 8]))
            .build();
        let fake_cell = real_cell.as_builder().type_(Some(fake_type).pack()).build();
        let forged = w
            .context
            .create_cell(fake_cell, Bytes::from(fake.encode().to_vec()));
        let ph = World::participant_hash(&participant);
        let (input, output, output_data) = match kind {
            0 => {
                let e = EntryDataV1 {
                    round_id: cfg.round_id,
                    shard_id: 0,
                    participant_lock_hash: ph,
                    ticket_count: 3,
                    principal: 300 * SHANNONS,
                    position_base: 0,
                    entry_nonce: 0,
                    entropy_commitment: [0; 32],
                };
                let lock = w.entry_lock_script(&ph);
                let out = CellOutputBuilder::default()
                    .capacity(pack_u64(600 * SHANNONS))
                    .lock(lock)
                    .build();
                let op = w.context.create_cell(out, Bytes::from(e.encode().to_vec()));
                (
                    op,
                    CellOutputBuilder::default()
                        .capacity(pack_u64(600 * SHANNONS))
                        .lock(participant)
                        .build(),
                    Bytes::new(),
                )
            }
            1 => {
                let (op, mut state) = w.create_shard(&cfg, 0, 1);
                let (out, _) = w.cell(&op);
                state.state = SHARD_STATE_FROZEN;
                (op, out, Bytes::from(state.encode().to_vec()))
            }
            _ => {
                let lock = w.dao_lock_script(&cfg.round_id, 1);
                let out = CellOutputBuilder::default()
                    .capacity(pack_u64(600 * SHANNONS))
                    .lock(lock)
                    .build();
                let op = w.context.create_cell(out.clone(), Bytes::from(vec![0; 8]));
                (op, out, Bytes::from(vec![0; 8]))
            }
        };
        let tx = TransactionBuilder::default()
            .cell_dep(w.round_config_dep(&forged))
            .input(CellInput::new(input, 0x2000_0000_0000_00c8))
            .output(output)
            .output_data(output_data)
            .build();
        let error = expect_fail(&mut w.context, &tx).to_string();
        let code = [-43, -37, -56][kind];
        assert!(error.contains(&format!("error code {code}")), "{error}");
    }
}

#[test]
fn existing_config_cannot_create_a_duplicate_shard() {
    let mut w = World::new(ACC_MMR);
    let cfg = default_config([0x74; 32], ACC_MMR);
    let r = w.create_round(&cfg);
    let (s, _) = w.create_shard(&cfg, 0, 1);
    let (out, data) = w.cell(&s);
    let (funding, _) = w.funding_cell(1000 * SHANNONS);
    let tx = TransactionBuilder::default()
        .cell_dep(w.round_config_dep(&r))
        .input(CellInput::new(funding, 0))
        .output(out)
        .output_data(data)
        .build();
    let error = expect_fail(&mut w.context, &tx).to_string();
    assert!(error.contains("error code -37"), "{error}");
}
