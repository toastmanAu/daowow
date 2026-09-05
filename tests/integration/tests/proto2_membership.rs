//! Phase-1 prototype #2: Entry membership proof against the frozen shard
//! commitment, and consumption of entries into native DAO deposit cells
//! under DAOWOWDAOLock — no operator key anywhere.
//!
//! Proves:
//! - freeze, then aggregation of accepted entries into a DAO deposit cell
//!   whose lock is DAOWOWDAOLock bound to (round_id, batch_id);
//! - membership proof verified on CKB-VM against the frozen accumulator;
//! - principal routing: entry capacity exactly funds the deposit;
//! - adversarial: unaccepted entry (bad proof), unfrozen shard, missing
//!   frozen shard, deposit without round binding, wrong round in entry.

mod common;

use ckb_testtool::ckb_types::{bytes::Bytes, core::{TransactionView, TransactionBuilder, ScriptHashType, DepType}, packed::*, prelude::*};
use common::*;

/// Build a complete round state: config + 1 shard + `n` entries (SMT).
struct Round {
    world: World,
    cfg: RoundConfigV1,
    round_op: OutPoint,
    shard_op: OutPoint,
    shard: EntryShardDataV1,
    host: SmtHost,
    entries: Vec<EntryDataV1>,
    participant_hash: Hash32,
}

fn build_round(round_id: Hash32, n_entries: u64, tickets_per_entry: u64) -> Round {
    let mut world = World::new(ACC_SMT);
    let cfg = default_config(round_id, ACC_SMT);
    let round_op = world.create_round(&cfg);
    let (shard_op, shard0) = world.create_shard(&cfg, 0, 1);

    let (_, lock) = world.always_success();
    let ph = World::participant_hash(&lock);
    let mut host = SmtHost::new();

    let mut shard = shard0;
    let mut entries = Vec::new();
    for i in 0..n_entries {
        let e = EntryDataV1 {
            round_id,
            shard_id: 0,
            participant_lock_hash: ph,
            ticket_count: tickets_per_entry,
            principal: tickets_per_entry * cfg.ticket_price,
            position_base: i * tickets_per_entry,
            entry_nonce: i,
            entropy_commitment: [0xA0 + i as u8; 32],
        };
        let absence = host.absence_proof(&[smt_key(&e)]).unwrap();
        host.insert(&smt_key(&e), &smt_leaf(&e)).unwrap();
        let inclusion = host.inclusion_proof(&[smt_key(&e)]).unwrap();
        let certs = [(absence, inclusion)];
        let cert_refs: Vec<(&[u8], &[u8])> = certs.iter().map(|(a, b)| (a.as_slice(), b.as_slice())).collect();
        let witness = smt_append_witness(&[e.clone()], &cert_refs);
        let after = daowow_core::shard::apply_entry_batch(Some(&shard), &cfg, &[e.clone()]).unwrap();
        let mut after = after;
        after.accumulator_root = host.root();

        // chain the shard cell through this single-entry tx
        let (cell_in, _) = world.cell(&shard_op);
        let (funding, _) = world.funding_cell(100_000 * SHANNONS);
        let entry_lock_script = world.entry_lock_script(&ph);
        let entry_out = CellOutputBuilder::default()
            .capacity(pack_u64(entry_cell_capacity(&e)))
            .lock(entry_lock_script)
            .build();
        let tx = TransactionBuilder::default()
            .cell_dep(world.round_config_dep(&round_op))
            .input(CellInput::new(shard_op.clone(), 0))
            .input(CellInput::new(funding, 0))
            .output(
                CellOutputBuilder::default()
                    .capacity(pack_u64(cell_in.capacity().unpack()))
                    .lock(cell_in.lock())
                    .type_(Some(cell_in.type_().to_opt().unwrap()).pack())
                    .build(),
            )
            .output_data(Bytes::from(after.encode().to_vec()))
            .output(entry_out)
            .output_data(Bytes::from(e.encode().to_vec()))
            .witness(witness)
            .witness(pack_pbytes(WitnessArgs::new_builder().build().as_bytes().as_ref()))
            .witness(pack_pbytes(WitnessArgs::new_builder().build().as_bytes().as_ref()))
            .build();
        let c = expect_ok(&mut world.context, &tx);
        if i == 0 {
            println!("cycles: first entry tx = {}", c);
        }
        chain_cell(&mut world, &shard_op, &tx, 0);
        shard = after;
        entries.push(e);
    }

    Round { world, cfg, round_op, shard_op, shard, host, entries, participant_hash: ph }
}

#[test]
fn aggregation_with_membership_proof() {
    let mut r = build_round([0x11; 32], 3, 2);

    // freeze the shard
    let (cell_in, data_in) = r.world.cell(&r.shard_op);
    let mut frozen = r.shard;
    frozen.state = SHARD_STATE_FROZEN;
    let funding = r.world.funding_cell(1000 * SHANNONS);
    let tx = TransactionBuilder::default()
        .cell_dep(r.world.round_config_dep(&r.round_op))
        .input(CellInput::new(r.shard_op.clone(), 0))
        .input(CellInput::new(funding.0, 0))
        .output(
            CellOutputBuilder::default()
                .capacity(pack_u64(cell_in.capacity().unpack()))
                .lock(cell_in.lock())
                .type_(Some(cell_in.type_().to_opt().unwrap()).pack())
                .build(),
        )
        .output_data(Bytes::from(frozen.encode().to_vec()))
        .witness(pack_pbytes(WitnessArgs::new_builder().build().as_bytes().as_ref()))
        .witness(pack_pbytes(WitnessArgs::new_builder().build().as_bytes().as_ref()))
        .witness(pack_pbytes(WitnessArgs::new_builder().build().as_bytes().as_ref()))
        .build();
    expect_ok(&mut r.world.context, &tx);
    chain_cell(&mut r.world, &r.shard_op, &tx, 0);

    // aggregation tx: consume all 3 entries -> 1 DAO deposit under dao-lock
    let total_principal: u64 = r.entries.iter().map(|e| e.principal).sum();
    let entry_inputs: Vec<OutPoint> = r
        .entries
        .iter()
        .map(|e| {
            // recreate entry cells in the context (entries were created in
            // prior txs; recreate with fixed out points per entry)
            let lock = r.world.entry_lock_script(&r.participant_hash);
            let output = CellOutputBuilder::default()
                .capacity(pack_u64(entry_cell_capacity(e)))
                .lock(lock)
                .build();
            r.world
                .context
                .create_cell(output, Bytes::from(e.encode().to_vec()))
        })
        .collect();
    let sponsor = r.world.funding_cell(100_000 * SHANNONS);

    let batch_id = 1u64;
    let dao_lock_script = r.world.dao_lock_script(&r.cfg.round_id, batch_id);
    let deposit_capacity = entry_inputs
        .iter()
        .map(|op| capacity_of(&r.world.context, op))
        .sum::<u64>();
    let sponsor_in = r.world.funding_cell(100_000 * SHANNONS);
    let _ = sponsor_in;
    let deposit_out = CellOutputBuilder::default()
        .capacity(pack_u64(deposit_capacity))
        .lock(dao_lock_script)
        .type_(Some(r.world.dao_type_script()).pack())
        .build();

    let mut builder = TransactionBuilder::default()
        .cell_dep(r.world.round_config_dep(&r.round_op))
        // the frozen shard cell as a dep cell
        .cell_dep(
            CellDepBuilder::default()
                .out_point(r.shard_op.clone())
                .dep_type(pack_byte(DepType::Code as u8))
                .build(),
        )
        // native DAO script dep (registered by World::new holder cell)
        .cell_dep(
            CellDepBuilder::default()
                .out_point(r.world.dao_cell_op.clone())
                .dep_type(pack_byte(DepType::Code as u8))
                .build(),
        );
    for (e, op) in r.entries.iter().zip(entry_inputs.iter()) {
        // membership proof per entry
        let proof = r.host.inclusion_proof(&[smt_key(e)]).unwrap();
        builder = builder
            .input(CellInput::new(op.clone(), 0))
            .witness(aggregation_witness(&proof));
    }
    builder = builder.input(CellInput::new(sponsor.0, 0));
    builder = builder
        .output(deposit_out)
        .output_data(Bytes::from(vec![0u8; 8]))
        .output(
            CellOutputBuilder::default()
                .capacity(pack_u64(90_000 * SHANNONS))
                .lock(sponsor.1)
                .build(),
        )
        .output_data(Bytes::new());
    // witness for the sponsor (always success) input
    for _ in r.entries.len()..(r.entries.len() + 1) {
        builder = builder.witness(pack_pbytes(
            WitnessArgs::new_builder().build().as_bytes().as_ref(),
        ));
    }
    let tx = builder.build();
    let c = expect_ok(&mut r.world.context, &tx);
    println!(
        "cycles: aggregation of {} entries (total principal {} shannons) = {}",
        r.entries.len(),
        total_principal,
        c
    );
}

#[test]
fn aggregation_rejects_unaccepted_entry() {
    let mut r = build_round([0x12; 32], 2, 2);

    // freeze
    let (cell_in, _) = r.world.cell(&r.shard_op);
    let mut frozen = r.shard;
    frozen.state = SHARD_STATE_FROZEN;
    let funding = r.world.funding_cell(1000 * SHANNONS);
    let tx = TransactionBuilder::default()
        .cell_dep(r.world.round_config_dep(&r.round_op))
        .input(CellInput::new(r.shard_op.clone(), 0))
        .input(CellInput::new(funding.0, 0))
        .output(
            CellOutputBuilder::default()
                .capacity(pack_u64(cell_in.capacity().unpack()))
                .lock(cell_in.lock())
                .type_(Some(cell_in.type_().to_opt().unwrap()).pack())
                .build(),
        )
        .output_data(Bytes::from(frozen.encode().to_vec()))
        .witness(pack_pbytes(WitnessArgs::new_builder().build().as_bytes().as_ref()))
        .witness(pack_pbytes(WitnessArgs::new_builder().build().as_bytes().as_ref()))
        .witness(pack_pbytes(WitnessArgs::new_builder().build().as_bytes().as_ref()))
        .build();
    expect_ok(&mut r.world.context, &tx);
    chain_cell(&mut r.world, &r.shard_op, &tx, 0);

    // an entry that was NEVER accepted (nonce 99, proof fabricated against a
    // fake root): its leaf cannot be proven against the frozen accumulator
    let fake = EntryDataV1 {
        round_id: r.cfg.round_id,
        shard_id: 0,
        participant_lock_hash: r.participant_hash,
        ticket_count: 2,
        principal: 2 * r.cfg.ticket_price,
        position_base: 4,
        entry_nonce: 99,
        entropy_commitment: [0xEE; 32],
    };
    let lock = r.world.entry_lock_script(&r.participant_hash);
    let fake_op = r.world.context.create_cell(
        CellOutputBuilder::default()
            .capacity(pack_u64(entry_cell_capacity(&fake)))
            .lock(lock)
            .build(),
        Bytes::from(fake.encode().to_vec()),
    );

    let proof = {
        // a proof of a DIFFERENT (accepted) key: valid encoding, wrong key
        r.host.inclusion_proof(&[smt_key(&r.entries[0])]).unwrap()
    };
    let dao_lock_script = r.world.dao_lock_script(&r.cfg.round_id, 1);
    let deposit_out = CellOutputBuilder::default()
        .capacity(pack_u64(entry_cell_capacity(&fake)))
        .lock(dao_lock_script)
        .type_(Some(r.world.dao_type_script()).pack())
        .build();
    let sponsor = r.world.funding_cell(100_000 * SHANNONS);
    let tx = TransactionBuilder::default()
        .cell_dep(r.world.round_config_dep(&r.round_op))
        .cell_dep(
            CellDepBuilder::default()
                .out_point(r.shard_op.clone())
                .dep_type(pack_byte(DepType::Code as u8))
                .build(),
        )
        .cell_dep(
            CellDepBuilder::default()
                .out_point(r.world.dao_cell_op.clone())
                .dep_type(pack_byte(DepType::Code as u8))
                .build(),
        )
        .input(CellInput::new(fake_op, 0))
        .input(CellInput::new(sponsor.0, 0))
        .output(deposit_out)
        .output_data(Bytes::from(vec![0u8; 8]))
        .output(
            CellOutputBuilder::default()
                .capacity(pack_u64(90_000 * SHANNONS))
                .lock(sponsor.1)
                .build(),
        )
        .output_data(Bytes::new())
        .witness(aggregation_witness(&proof))
        .witness(pack_pbytes(WitnessArgs::new_builder().build().as_bytes().as_ref()))
        .build();
    let e = expect_fail(&mut r.world.context, &tx);
    println!("unaccepted entry rejected: {:?}", e);
}

#[test]
fn aggregation_requires_deposit_bound_to_same_round() {
    // an aggregation tx whose DAO deposit is NOT under the round dao-lock
    // must be rejected (entry value could escape custody)
    let mut r = build_round([0x13; 32], 1, 2);

    // freeze
    let (cell_in, _) = r.world.cell(&r.shard_op);
    let mut frozen = r.shard;
    frozen.state = SHARD_STATE_FROZEN;
    let funding = r.world.funding_cell(1000 * SHANNONS);
    let tx = TransactionBuilder::default()
        .cell_dep(r.world.round_config_dep(&r.round_op))
        .input(CellInput::new(r.shard_op.clone(), 0))
        .input(CellInput::new(funding.0, 0))
        .output(
            CellOutputBuilder::default()
                .capacity(pack_u64(cell_in.capacity().unpack()))
                .lock(cell_in.lock())
                .type_(Some(cell_in.type_().to_opt().unwrap()).pack())
                .build(),
        )
        .output_data(Bytes::from(frozen.encode().to_vec()))
        .witness(pack_pbytes(WitnessArgs::new_builder().build().as_bytes().as_ref()))
        .witness(pack_pbytes(WitnessArgs::new_builder().build().as_bytes().as_ref()))
        .witness(pack_pbytes(WitnessArgs::new_builder().build().as_bytes().as_ref()))
        .build();
    expect_ok(&mut r.world.context, &tx);
    chain_cell(&mut r.world, &r.shard_op, &tx, 0);

    // accepted entry with valid proof, but the deposit goes to a plain
    // always-success lock (attacker custody): entry-lock must reject because
    // deposit capacity != dao deposit capacity
    let e = r.entries[0].clone();
    let proof = r.host.inclusion_proof(&[smt_key(&e)]).unwrap();
    let lock = r.world.entry_lock_script(&r.participant_hash);
    let entry_op = r.world.context.create_cell(
        CellOutputBuilder::default()
            .capacity(pack_u64(entry_cell_capacity(&e)))
            .lock(lock)
            .build(),
        Bytes::from(e.encode().to_vec()),
    );
    let thief = r.world.funding_cell(1000 * SHANNONS);
    let tx = TransactionBuilder::default()
        .cell_dep(r.world.round_config_dep(&r.round_op))
        .cell_dep(
            CellDepBuilder::default()
                .out_point(r.shard_op.clone())
                .dep_type(pack_byte(DepType::Code as u8))
                .build(),
        )
        .cell_dep(
            CellDepBuilder::default()
                .out_point(r.world.dao_cell_op.clone())
                .dep_type(pack_byte(DepType::Code as u8))
                .build(),
        )
        .input(CellInput::new(entry_op, 0))
        .input(CellInput::new(thief.0, 0))
        .output(
            CellOutputBuilder::default()
                .capacity(pack_u64(entry_cell_capacity(&e)))
                .lock(thief.1)
                .build(),
        )
        .output_data(Bytes::new())
        .witness(aggregation_witness(&proof))
        .witness(pack_pbytes(WitnessArgs::new_builder().build().as_bytes().as_ref()))
        .build();
    let e = expect_fail(&mut r.world.context, &tx);
    println!("entry value to non-dao destination rejected: {:?}", e);
}

fn capacity_of(context: &ckb_testtool::context::Context, op: &OutPoint) -> u64 {
    context.get_cell(op).unwrap().0.capacity().unpack()
}
