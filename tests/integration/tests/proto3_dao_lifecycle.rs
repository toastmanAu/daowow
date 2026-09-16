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

use ckb_testtool::ckb_types::{
    bytes::Bytes,
    core::{
        DepType, EpochNumberWithFraction, HeaderView, ScriptHashType, TransactionBuilder,
        TransactionView,
    },
    packed::*,
    prelude::*,
};
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
    receipt_op: OutPoint,
    deposit_capacity: u64,
    deposit_block: u64,
    deposit_epoch: u64,
}

fn prepare() -> DaoRound {
    prepare_with(ACC_SMT, 4, 1, &default_prize_schedule(), 1)
}

fn prepare_with(
    acc: u8,
    shards: u32,
    minimum: u64,
    schedule: &daowow_core::schedule::PrizeSchedule,
    batch_size: u64,
) -> DaoRound {
    let mut world = World::new(acc);
    let round_id = [0x33; 32];
    let mut cfg = default_config(round_id, acc);
    cfg.entry_shard_count = shards;
    cfg.minimum_tickets = minimum;
    cfg.prize_schedule_hash = schedule.commitment();
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
    let deposit_capacity = batch_size * 1000 * SHANNONS;
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

    // Isolated DAO fixture: model the authenticated receipt created beside the
    // deposit. The atomic creation scripts are exercised in security_ledger.
    let receipt_op = OutPoint::new(deposit_op.tx_hash(), 1);
    let mut receipt_args = vec![2];
    receipt_args.extend_from_slice(&world.config_hash);
    receipt_args.extend_from_slice(&0u32.to_le_bytes());
    receipt_args.extend_from_slice(&batch_id.to_le_bytes());
    receipt_args.extend_from_slice(&[0; 32]);
    let receipt_ref = world.deps.entry_shard_type;
    let receipt_type = world.script_for(&receipt_ref, Bytes::from(receipt_args));
    let receipt_lock = world.shard_public_lock();
    let receipt = daowow_core::lifecycle::BatchCommitment {
        digest: [0; 32],
        first_nonce: 0,
        entry_count: 1,
        ticket_count: 1,
        principal: deposit_capacity,
        input_capacity: deposit_capacity,
    };
    world.context.create_cell_with_out_point(
        receipt_op.clone(),
        CellOutputBuilder::default()
            .capacity(pack_u64(400 * SHANNONS))
            .lock(receipt_lock)
            .type_(Some(receipt_type).pack())
            .build(),
        Bytes::from(receipt.encode().to_vec()),
    );

    DaoRound {
        world,
        cfg,
        round_op,
        round_id,
        deposit_op,
        receipt_op,
        deposit_capacity,
        deposit_block: 100,
        deposit_epoch: 10,
    }
}

fn phase1_tx(
    r: &mut DaoRound,
    substitute_lock: bool,
    wrong_block: bool,
) -> (TransactionView, Script) {
    let (cell, _) = r.world.cell(&r.deposit_op);
    let good_lock = r.world.dao_lock_script(&r.round_id, 1);
    let evil_lock = r.world.funding_cell(1 * SHANNONS).1;
    let out_lock = if substitute_lock {
        evil_lock
    } else {
        good_lock
    };
    let block_number = if wrong_block { 999 } else { r.deposit_block };
    let tx = TransactionBuilder::default()
        .cell_dep(r.world.round_config_dep(&r.round_op))
        .cell_dep(
            CellDepBuilder::default()
                .out_point(r.world.dao_cell_op.clone())
                .dep_type(pack_byte(DepType::Code as u8))
                .build(),
        )
        .cell_dep(
            CellDepBuilder::default()
                .out_point(r.receipt_op.clone())
                .dep_type(pack_byte(DepType::Code as u8))
                .build(),
        )
        .input(CellInput::new(
            r.deposit_op.clone(),
            daowow_core::epoch::absolute_epoch_since(
                r.deposit_epoch + u64::from(r.cfg.dao_term_periods) * 180,
            )
            .unwrap(),
        ))
        .header_dep(header(r.deposit_block, r.deposit_epoch, DEPOSIT_AR).hash())
        .output(
            CellOutputBuilder::default()
                .capacity(pack_u64(cell.capacity().unpack()))
                .lock(out_lock.clone())
                .type_(Some(cell.type_().to_opt().unwrap()).pack())
                .build(),
        )
        .output_data(Bytes::from(block_number.to_le_bytes().to_vec()))
        .witness(pack_pbytes(
            WitnessArgs::new_builder().build().as_bytes().as_ref(),
        ))
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
fn phase1_rejects_dependency_groups() {
    let mut r = prepare();
    let (tx, _) = phase1_tx(&mut r, false, false);
    let tx = r.world.context.complete_tx(tx);
    let deps: Vec<_> = tx.cell_deps().into_iter().collect();
    let members = OutPointVec::new_builder()
        .set(deps.iter().map(|dep| dep.out_point()).collect())
        .build();
    let (_, lock) = r.world.always_success();
    let group = r.world.context.create_cell(
        CellOutputBuilder::default()
            .capacity(pack_u64(1000 * SHANNONS))
            .lock(lock)
            .build(),
        members.as_bytes(),
    );
    let tx = tx
        .as_advanced_builder()
        .set_cell_deps(vec![CellDepBuilder::default()
            .out_point(group)
            .dep_type(pack_byte(DepType::DepGroup as u8))
            .build()])
        .build();
    let err = r.world.context.verify_tx(&tx, MAX_CYCLES).unwrap_err();
    assert!(err.to_string().contains("-58"), "{err}");
}

#[test]
fn phase1_rejects_duplicate_raw_dependencies() {
    let mut r = prepare();
    let (tx, _) = phase1_tx(&mut r, false, false);
    let tx = r.world.context.complete_tx(tx);
    let duplicate = tx.cell_deps().get(2).unwrap();
    let tx = tx.as_advanced_builder().cell_dep(duplicate).build();
    let err = r.world.context.verify_tx(&tx, MAX_CYCLES).unwrap_err();
    assert!(err.to_string().contains("-58"), "{err}");
}

#[test]
fn phase1_rejects_missing_batch_receipt() {
    let mut r = prepare();
    let (tx, _) = phase1_tx(&mut r, false, false);
    let tx = tx
        .as_advanced_builder()
        .set_cell_deps(tx.cell_deps().into_iter().take(2).collect())
        .build();
    expect_fail(&mut r.world.context, &tx);
}

#[test]
fn phase1_rejects_copied_deposit_and_forged_receipt_data() {
    for forged_data in [false, true] {
        let mut r = prepare();
        if forged_data {
            let (cell, data) = r.world.cell(&r.receipt_op);
            let mut receipt = daowow_core::lifecycle::BatchCommitment::decode(&data).unwrap();
            receipt.digest = [1; 32];
            r.world.context.create_cell_with_out_point(
                r.receipt_op.clone(),
                cell,
                Bytes::from(receipt.encode().to_vec()),
            );
        } else {
            let (cell, data) = r.world.cell(&r.deposit_op);
            r.deposit_op = r.world.context.create_cell(cell, data);
            r.world.context.link_cell_with_block(
                r.deposit_op.clone(),
                header(r.deposit_block, r.deposit_epoch, DEPOSIT_AR).hash(),
                0,
            );
        }
        let (tx, _) = phase1_tx(&mut r, false, false);
        let error = expect_fail(&mut r.world.context, &tx);
        assert!(format!("{error:?}").contains("error code -58"), "{error:?}");
    }
}

#[test]
fn phase1_rejects_withdrawal_before_configured_term() {
    let mut r = prepare();
    let (tx, _) = phase1_tx(&mut r, false, false);
    let tx = tx
        .as_advanced_builder()
        .set_inputs(vec![CellInput::new(r.deposit_op.clone(), 0)])
        .build();
    let error = expect_fail(&mut r.world.context, &tx);
    assert!(format!("{error:?}").contains("error code -58"), "{error:?}");
}

fn phase2_fixture() -> (DaoRound, TransactionView) {
    phase2_fixture_with(ACC_SMT, 4, 1, default_prize_schedule(), 1)
}

fn phase2_fixture_with(
    acc: u8,
    shards: u32,
    minimum: u64,
    schedule: daowow_core::schedule::PrizeSchedule,
    batch_size: u64,
) -> (DaoRound, TransactionView) {
    phase2_fixture_owners(acc, shards, minimum, schedule, batch_size, false)
}

fn phase2_fixture_owners(
    acc: u8,
    shards: u32,
    minimum: u64,
    schedule: daowow_core::schedule::PrizeSchedule,
    batch_size: u64,
    distinct_owners: bool,
) -> (DaoRound, TransactionView) {
    phase2_fixture_history(
        acc,
        shards,
        minimum,
        schedule,
        batch_size,
        distinct_owners,
        1,
    )
}

fn phase2_fixture_history(
    acc: u8,
    shards: u32,
    minimum: u64,
    schedule: daowow_core::schedule::PrizeSchedule,
    batch_size: u64,
    distinct_owners: bool,
    predecessor_entries: usize,
) -> (DaoRound, TransactionView) {
    let mut r = prepare_with(acc, shards, minimum, &schedule, batch_size);
    let cfg = full_config(&r.cfg, &r.world.deps);
    let (_, participant) = r.world.always_success();
    let participant_hash = World::participant_hash(&participant);
    let entry_count = batch_size + predecessor_entries as u64;
    let batch_id = predecessor_entries.div_ceil(32) as u64;
    let capacities = vec![1000 * SHANNONS; batch_size as usize];
    let entries: Vec<_> = (0..entry_count)
        .map(|nonce| EntryDataV1 {
            round_id: cfg.round_id,
            shard_id: 0,
            participant_lock_hash: if distinct_owners {
                let lock = participant
                    .clone()
                    .as_builder()
                    .args(Bytes::from(nonce.to_le_bytes().to_vec()).pack())
                    .build();
                World::participant_hash(&lock)
            } else {
                participant_hash
            },
            ticket_count: 1,
            principal: cfg.ticket_price,
            position_base: nonce,
            entry_nonce: nonce,
            entropy_commitment: [nonce as u8; 32],
        })
        .collect();
    let leaves: Vec<_> = entries.iter().map(daowow_core::leaf::entry_leaf).collect();
    let (root, proofs): (Hash32, Vec<Vec<u8>>) = match acc {
        ACC_SMT => {
            let mut host = SmtHost::new();
            for (i, leaf) in leaves.iter().enumerate() {
                host.insert(&daowow_core::accumulator::nonce_key(i as u64), leaf)
                    .unwrap();
            }
            (
                host.root(),
                (0..entry_count)
                    .map(|i| {
                        host.inclusion_proof(&[daowow_core::accumulator::nonce_key(i)])
                            .unwrap()
                    })
                    .collect(),
            )
        }
        ACC_MMR => {
            let mut host = daowow_core::accumulator::mmr::host::MmrHost::new();
            for leaf in &leaves {
                host.append(leaf).unwrap();
            }
            (
                host.root().unwrap(),
                (0..entry_count)
                    .map(|i| host.membership_proof(i).unwrap())
                    .collect(),
            )
        }
        ACC_IMT => {
            let mut host = daowow_core::accumulator::imt::host::ImtHost::new();
            for leaf in &leaves {
                host.append(leaf);
            }
            (
                host.root(),
                (0..entry_count)
                    .map(|i| host.membership_proof(i).unwrap())
                    .collect(),
            )
        }
        _ => unreachable!(),
    };
    let frozen = EntryShardDataV1 {
        round_id: cfg.round_id,
        shard_id: 0,
        state: SHARD_STATE_FROZEN,
        sequence: entry_count,
        entry_count,
        ticket_count: entry_count,
        principal_total: entry_count * cfg.ticket_price,
        accumulator_root: root,
    };
    let mut first = daowow_core::lifecycle::AggregationState::new(&cfg, &frozen).unwrap();
    for (chunk, chunk_proofs) in entries[..predecessor_entries]
        .chunks(32)
        .zip(proofs[..predecessor_entries].chunks(32))
    {
        first = first
            .accept(
                &cfg,
                chunk,
                &vec![1000 * SHANNONS; chunk.len()],
                &chunk_proofs.iter().map(Vec::as_slice).collect::<Vec<_>>(),
            )
            .unwrap()
            .0;
    }
    let (second, receipt) = first
        .accept(
            &cfg,
            &entries[predecessor_entries..],
            &capacities,
            &proofs[predecessor_entries..]
                .iter()
                .map(Vec::as_slice)
                .collect::<Vec<_>>(),
        )
        .unwrap();
    let mut ledgers = vec![second.close(&cfg, 0x2000_0000_0000_00c8).unwrap()];
    for id in 1..cfg.entry_shard_count {
        let empty = EntryShardDataV1 {
            round_id: cfg.round_id,
            shard_id: id,
            state: SHARD_STATE_FROZEN,
            sequence: 0,
            entry_count: 0,
            ticket_count: 0,
            principal_total: 0,
            accumulator_root: empty_root(acc),
        };
        ledgers.push(
            daowow_core::lifecycle::AggregationState::new(&cfg, &empty)
                .unwrap()
                .close(&cfg, 0x2000_0000_0000_00c8)
                .unwrap(),
        );
    }
    let mut record = daowow_core::seal::EntropyRecord::new(
        daowow_core::seal::RoundSeal::new(&cfg, &ledgers).unwrap(),
        300,
        [1; 32],
        [[2; 32], [3; 32], [4; 32]],
    )
    .unwrap();
    if predecessor_entries > 1 {
        // Deterministic fixture search ONLY: select a historical entropy record
        // whose 32 winners all precede this batch. Real entropy is header-bound
        // and not keeper-selectable; this seeded test does not prove provenance.
        for candidate in 0u64..1000 {
            let hash = daowow_core::hash::ckb_hash256(&[
                b"64-liability-fixture",
                &candidate.to_le_bytes(),
            ]);
            record = daowow_core::seal::EntropyRecord::new(
                daowow_core::seal::RoundSeal::new(&cfg, &ledgers).unwrap(),
                300,
                [1; 32],
                [hash, [3; 32], [4; 32]],
            )
            .unwrap();
            let draw =
                daowow_core::computed_draw::ComputedDraw::new(&cfg, &record, &schedule).unwrap();
            if draw
                .positions()
                .iter()
                .all(|(_, position)| *position < predecessor_entries as u64)
            {
                break;
            }
        }
        let draw = daowow_core::computed_draw::ComputedDraw::new(&cfg, &record, &schedule).unwrap();
        assert!(draw
            .positions()
            .iter()
            .all(|(_, position)| *position < predecessor_entries as u64));
    }
    // Seed historical canonical receipt/entropy cells in this isolated phase2
    // fixture. Their creation transitions have separate VM suites; this is not
    // a mined end-to-end or reorg/maturity fixture.
    let mut receipt_args = vec![2];
    receipt_args.extend_from_slice(&cfg.commitment());
    receipt_args.extend_from_slice(&0u32.to_le_bytes());
    receipt_args.extend_from_slice(&batch_id.to_le_bytes());
    receipt_args.extend_from_slice(&receipt.digest);
    let shard_ref = r.world.deps.entry_shard_type;
    let receipt_type = r.world.script_for(&shard_ref, Bytes::from(receipt_args));
    let public_lock = r.world.shard_public_lock();
    let receipt_op = r.world.context.create_cell(
        CellOutputBuilder::default()
            .capacity(pack_u64(400 * SHANNONS))
            .lock(public_lock.clone())
            .type_(Some(receipt_type).pack())
            .build(),
        Bytes::from(receipt.encode().to_vec()),
    );
    let mut entropy_args = cfg.commitment().to_vec();
    entropy_args.extend_from_slice(&0u32.to_le_bytes());
    let entropy_type = r.world.script_for(&shard_ref, Bytes::from(entropy_args));
    let entropy_op = r.world.context.create_cell(
        CellOutputBuilder::default()
            .capacity(pack_u64(60000 * SHANNONS))
            .lock(public_lock)
            .type_(Some(entropy_type).pack())
            .build(),
        Bytes::from(record.encode()),
    );

    // build the withdrawing cell (as phase 1 would produce)
    let (cell, _) = r.world.cell(&r.deposit_op);
    let good_lock = r
        .world
        .dao_lock_script_with_digest(&r.round_id, batch_id, &receipt.digest);
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
    let settle_type_script = r
        .world
        .settlement_script_with_digest(batch_id, &receipt.digest);
    // Native DAO compensation applies only to unoccupied capacity.
    let occupied = cell
        .occupied_capacity(ckb_testtool::ckb_types::core::Capacity::bytes(8).unwrap())
        .unwrap()
        .as_u64();
    let funding_capacity = occupied
        + ((r.deposit_capacity - occupied) as u128 * WITHDRAW_AR as u128 / DEPOSIT_AR as u128)
            as u64;
    let draw = daowow_core::computed_draw::ComputedDraw::new(&cfg, &record, &schedule).unwrap();
    let winners: Vec<_> = draw
        .positions()
        .iter()
        .map(|(_, position)| {
            (
                entries[*position as usize],
                proofs[*position as usize].as_slice(),
            )
        })
        .collect();
    let views: Vec<_> = winners
        .iter()
        .map(|(entry, proof)| daowow_core::computed_draw::WinnerProof { entry, proof })
        .collect();
    let input = daowow_core::entitlements::EntitlementInput {
        batch_id,
        receipt: &receipt,
        entries: &entries[predecessor_entries..],
        capacities: &capacities,
        realized_total: funding_capacity,
        winners: &views,
    };
    let expected =
        daowow_core::entitlements::InitialEntitlements::derive(&cfg, &record, &schedule, &input)
            .unwrap();
    let funding_data = *expected.funding();
    let payload = daowow_core::entitlement_witness::EntitlementWitness::encode(
        &schedule,
        &entries[predecessor_entries..],
        &capacities,
        &winners,
    )
    .unwrap();
    let witness = WitnessArgs::new_builder()
        .input_type(Some(Bytes::from(0u64.to_le_bytes().to_vec())).pack())
        .output_type(Some(Bytes::from(payload)).pack())
        .build();

    let tx = TransactionBuilder::default()
        .cell_dep(r.world.round_config_dep(&r.round_op))
        .cell_dep(
            CellDepBuilder::default()
                .out_point(receipt_op)
                .dep_type(pack_byte(0))
                .build(),
        )
        .cell_dep(
            CellDepBuilder::default()
                .out_point(entropy_op)
                .dep_type(pack_byte(0))
                .build(),
        )
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
                .lock(r.world.settlement_public_lock())
                .type_(Some(settle_type_script).pack())
                .build(),
        )
        .output_data(Bytes::from(funding_data.encode().to_vec()))
        .witness(witness.as_bytes())
        .build();
    (r, tx)
}

#[test]
fn phase2_rejects_maximum_sized_invalid_payload_without_exhausting_heap() {
    let (mut r, tx) = phase2_fixture_history(
        ACC_IMT,
        256,
        1,
        daowow_core::schedule::PrizeSchedule::new(&[1; 32]).unwrap(),
        32,
        true,
        1024,
    );
    let tx = detach_evidence(tx);
    for size in [160 * 1024, 160 * 1024 + 1] {
        let mut witnesses: Vec<_> = tx.witnesses().into_iter().collect();
        let mut payload = witnesses[1].raw_data().to_vec();
        payload.resize(size, 0); // Invalid trailing data, not a valid large proof.
        witnesses[1] = Bytes::from(payload).pack();
        let bad = tx
            .clone()
            .as_advanced_builder()
            .set_witnesses(witnesses)
            .build();
        let error = expect_fail(&mut r.world.context, &bad);
        // Must reject normally, not VM OOM (-1) or cycle exhaustion.
        assert!(
            format!("{error:?}").contains("error code -72"),
            "size={size}: {error:?}"
        );
    }
}

#[test]
fn phase2_creates_64_distinct_liabilities_across_accumulators() {
    for acc in [ACC_MMR, ACC_SMT, ACC_IMT] {
        let (mut r, tx) = phase2_fixture_history(
            acc,
            256,
            1,
            daowow_core::schedule::PrizeSchedule::new(&[1; 32]).unwrap(),
            32,
            true,
            1024,
        );
        let funding =
            SettlementFundingDataV3::decode(&tx.outputs_data().get(0).unwrap().raw_data()).unwrap();
        assert_eq!(funding.liability_count, 64);
        assert_eq!(funding.principal_liability, 32_000 * SHANNONS);
        assert_eq!(funding.batch_id, 32);
        let tx = detach_evidence(tx);
        let cycles = expect_ok(&mut r.world.context, &tx);
        println!(
            "64-liability creation accumulator={acc} cycles={cycles} evidence_bytes={}",
            tx.witnesses().get(1).unwrap().raw_data().len()
        );
        drain_created_funding(&mut r, &tx);
    }
}

/// Consume the validated phase2 output, not an independently seeded liability
/// tree. Canonical history before phase2 is still seeded by the fixture.
fn drain_created_funding(r: &mut DaoRound, creation: &TransactionView) {
    let cfg = full_config(&r.cfg, &r.world.deps);
    let (_, receipt_bytes) = r
        .world
        .cell(&creation.cell_deps().get(1).unwrap().out_point());
    let receipt = daowow_core::lifecycle::BatchCommitment::decode(&receipt_bytes).unwrap();
    let (_, entropy_bytes) = r
        .world
        .cell(&creation.cell_deps().get(2).unwrap().out_point());
    let record = daowow_core::seal::EntropyRecord::decode(&entropy_bytes, &cfg).unwrap();
    let raw = creation.witnesses().get(1).unwrap().raw_data();
    let evidence = daowow_core::entitlement_witness::EntitlementWitness::decode(&raw).unwrap();
    let funding =
        SettlementFundingDataV3::decode(&creation.outputs_data().get(0).unwrap().raw_data())
            .unwrap();
    let winners = evidence.winner_proofs();
    let entitlement = daowow_core::entitlements::InitialEntitlements::derive(
        &cfg,
        &record,
        evidence.schedule(),
        &daowow_core::entitlements::EntitlementInput {
            batch_id: funding.batch_id,
            receipt: &receipt,
            entries: evidence.entries(),
            capacities: evidence.capacities(),
            realized_total: funding.realized_total,
            winners: &winners,
        },
    )
    .unwrap();
    let items = entitlement.liabilities();
    assert_eq!(items.len(), 64);
    let mut host = daowow_core::accumulator::mmr::host::MmrHost::new();
    for item in items {
        host.append(&daowow_core::leaf::liability_leaf(
            &item.participant_lock_hash,
            item.principal,
            item.prize,
        ))
        .unwrap();
    }
    assert_eq!(host.root().unwrap(), funding.liabilities_root);
    let (_, base_lock) = r.world.always_success();
    let mut locks = Vec::new();
    let mut proofs = Vec::new();
    let mut outputs = Vec::new();
    let mut gifts = 0;
    for (i, item) in items.iter().enumerate() {
        let entry = evidence
            .entries()
            .iter()
            .chain(winners.iter().map(|w| w.entry))
            .find(|entry| entry.participant_lock_hash == item.participant_lock_hash)
            .unwrap();
        let lock = base_lock
            .clone()
            .as_builder()
            .args(Bytes::from(entry.entry_nonce.to_le_bytes().to_vec()).pack())
            .build();
        assert_eq!(World::participant_hash(&lock), item.participant_lock_hash);
        let owed = item.principal + item.prize;
        let output_capacity = owed.max(49 * SHANNONS); // 8 capacity +33 script +8 args.
        gifts += output_capacity - owed;
        outputs.push(
            CellOutputBuilder::default()
                .capacity(pack_u64(output_capacity))
                .lock(lock.clone())
                .build(),
        );
        locks.push(lock);
        proofs.push(host.membership_proof(i as u64).unwrap());
    }
    let args: Vec<_> = locks.iter().map(|lock| lock.args().raw_data()).collect();
    let codes: Vec<_> = locks
        .iter()
        .map(|lock| lock.code_hash().raw_data())
        .collect();
    let refs: Vec<_> = items
        .iter()
        .enumerate()
        .map(|(i, item)| {
            (
                args[i].as_ref(),
                codes[i].as_ref(),
                u8::from(locks[i].hash_type()),
                item,
                proofs[i].as_slice(),
            )
        })
        .collect();
    let witness = daowow_core::witness::encode_settlement_witness(&refs);
    let creation = r.world.context.complete_tx(creation.clone());
    let funding_op = OutPoint::new(creation.hash(), 0);
    r.world.context.create_cell_with_out_point(
        funding_op.clone(),
        creation.outputs().get(0).unwrap(),
        creation.outputs_data().get(0).unwrap().raw_data(),
    );
    let (sponsor, sponsor_lock) = r.world.funding_cell(gifts + 100 * SHANNONS);
    let mut tx = TransactionBuilder::default()
        .input(CellInput::new(funding_op, 0))
        .input(CellInput::new(sponsor, 0))
        .witness(Bytes::from(witness));
    for output in outputs {
        tx = tx.output(output).output_data(Bytes::new());
    }
    let tx = tx
        .output(
            CellOutputBuilder::default()
                .capacity(pack_u64(99 * SHANNONS))
                .lock(sponsor_lock)
                .build(),
        )
        .output_data(Bytes::new())
        .build();
    let cycles = expect_ok(&mut r.world.context, &tx);
    println!(
        "64-liability created-funding drain accumulator={} cycles={cycles} sponsor_gifts={gifts}",
        cfg.accumulator_id
    );
    let mut outputs: Vec<_> = tx.outputs().into_iter().collect();
    outputs[0] = outputs[0]
        .clone()
        .as_builder()
        .capacity(pack_u64(1))
        .build();
    expect_fail(
        &mut r.world.context,
        &tx.as_advanced_builder().set_outputs(outputs).build(),
    );
}

#[test]
fn phase2_delegation_requires_exact_new_settlement_type() {
    for mutation in 0..7 {
        let (mut r, tx) = phase2_fixture();
        let output = tx.outputs().get(0).unwrap();
        let original_type = output.type_().to_opt().unwrap();
        let mut builder = tx.clone().as_advanced_builder();
        if mutation == 0 {
            let existing = r
                .world
                .context
                .create_cell(output.clone(), tx.outputs_data().get(0).unwrap().raw_data());
            builder = builder.input(CellInput::new(existing, 0));
        } else if mutation == 1 {
            builder = builder
                .output(output.clone())
                .output_data(tx.outputs_data().get(0).unwrap().raw_data());
        } else {
            let changed = match mutation {
                2 => None,
                3 => Some(
                    original_type
                        .clone()
                        .as_builder()
                        .hash_type(pack_byte(0))
                        .build(),
                ),
                4 => {
                    let (_, ordinary) = r.world.always_success();
                    Some(ordinary)
                }
                index => {
                    let mut args = original_type.args().raw_data().to_vec();
                    if index == 5 {
                        args = vec![0];
                    } else {
                        args[40] ^= 1;
                    }
                    Some(
                        original_type
                            .clone()
                            .as_builder()
                            .args(Bytes::from(args).pack())
                            .build(),
                    )
                }
            };
            builder = builder.set_outputs(vec![output.as_builder().type_(changed.pack()).build()]);
        }
        let bad = builder.build();
        let error = expect_fail(&mut r.world.context, &bad);
        assert!(
            format!("{error:?}").contains("error code -59"),
            "mutation={mutation}: {error:?}"
        );
    }
}

#[test]
fn phase2_distinct_owner_creation_across_accumulators() {
    let mut costs = Vec::new();
    for acc in [ACC_MMR, ACC_SMT, ACC_IMT] {
        let schedule = daowow_core::schedule::PrizeSchedule::new(&[1; 32]).unwrap();
        let (mut r, tx) = phase2_fixture_owners(acc, 256, 1, schedule, 32, true);
        let funding =
            SettlementFundingDataV3::decode(&tx.outputs_data().get(0).unwrap().raw_data()).unwrap();
        assert!(funding.liability_count >= 32);
        let tx = r.world.context.complete_tx(detach_evidence(tx));
        let cycles = r.world.context.verify_tx(&tx, 3_500_000_000).unwrap();
        println!(
            "distinct-owner creation accumulator={acc} liabilities={} cycles={cycles}",
            funding.liability_count
        );
        costs.push(cycles);
    }
    assert!(
        costs.iter().all(|cycles| *cycles < MAX_CYCLES),
        "distinct-owner costs: {costs:?}"
    );
}

#[test]
fn phase2_maximum_batch_prizes_and_shards_across_accumulators() {
    let mut measured = Vec::new();
    for acc in [ACC_MMR, ACC_SMT, ACC_IMT] {
        let schedule = daowow_core::schedule::PrizeSchedule::new(&[1; 32]).unwrap();
        let (mut r, tx) = phase2_fixture_with(acc, 256, 1, schedule, 32);
        let tx = r.world.context.complete_tx(detach_evidence(tx));
        let cycles = r.world.context.verify_tx(&tx, 3_500_000_000).unwrap();
        println!("phase2 max dimensions accumulator={acc} cycles={cycles}");
        measured.push(cycles);
    }
    assert!(
        measured.iter().all(|cycles| *cycles < MAX_CYCLES),
        "ordinary-budget costs: {measured:?}"
    );
}

#[test]
fn phase2_native_witness_size_boundary() {
    for size in [16_000, 32_000, 33_000] {
        let (mut r, tx) = phase2_fixture();
        let raw = tx.witnesses().get(0).unwrap().raw_data();
        let witness = WitnessArgs::from_slice(&raw)
            .unwrap()
            .as_builder()
            .lock(Some(Bytes::from(vec![0; size])).pack())
            .build();
        let tx = tx
            .as_advanced_builder()
            .set_witnesses(vec![witness.as_bytes().pack()])
            .build();
        let tx = r.world.context.complete_tx(tx);
        let result = r.world.context.verify_tx(&tx, MAX_CYCLES);
        if size < 33_000 {
            assert!(result.is_ok(), "{result:?}");
        } else {
            assert!(
                format!("{result:?}").contains("error code -12"),
                "{result:?}"
            );
        }
    }
}

fn detach_evidence(tx: TransactionView) -> TransactionView {
    let witness = WitnessArgs::from_slice(&tx.witnesses().get(0).unwrap().raw_data()).unwrap();
    let payload = witness.output_type().to_opt().unwrap().raw_data();
    // Tag0 + absolute u32 witness index. Extra witness follows all inputs.
    let mut reference = vec![0];
    reference.extend_from_slice(&1u32.to_le_bytes());
    let witness = witness
        .as_builder()
        .output_type(Some(Bytes::from(reference)).pack())
        .build();
    tx.as_advanced_builder()
        .set_witnesses(vec![witness.as_bytes().pack(), payload.pack()])
        .build()
}

#[test]
fn phase2_detached_evidence_is_authenticated_and_bounded() {
    let (mut r, tx) = phase2_fixture();
    let tx = detach_evidence(tx);
    expect_ok(&mut r.world.context, &tx);
    for mutation in 0..5 {
        let mut witnesses: Vec<_> = tx.witnesses().into_iter().collect();
        match mutation {
            0 => {
                witnesses.pop();
            }
            1 => {
                witnesses[1] = Bytes::from(vec![0; 160 * 1024 + 1]).pack();
            }
            2 => {
                let mut data = witnesses[1].raw_data().to_vec();
                data[0] = 2;
                witnesses[1] = Bytes::from(data).pack();
            }
            index => {
                let witness = WitnessArgs::from_slice(&witnesses[0].raw_data()).unwrap();
                let mut reference = vec![0];
                reference
                    .extend_from_slice(&(if index == 3 { 0u32 } else { u32::MAX }).to_le_bytes());
                witnesses[0] = witness
                    .as_builder()
                    .output_type(Some(Bytes::from(reference)).pack())
                    .build()
                    .as_bytes()
                    .pack();
            }
        }
        expect_fail(
            &mut r.world.context,
            &tx.clone()
                .as_advanced_builder()
                .set_witnesses(witnesses)
                .build(),
        );
    }
}

#[test]
fn phase2_accepts_expanded_dependency_group() {
    let (mut r, tx) = phase2_fixture();
    let tx = r.world.context.complete_tx(tx);
    let members = OutPointVec::new_builder()
        .set(
            tx.cell_deps()
                .into_iter()
                .map(|dep| dep.out_point())
                .collect(),
        )
        .build();
    let (_, lock) = r.world.always_success();
    let group = r.world.context.create_cell(
        CellOutputBuilder::default()
            .capacity(pack_u64(1000 * SHANNONS))
            .lock(lock)
            .build(),
        members.as_bytes(),
    );
    let tx = tx
        .as_advanced_builder()
        .set_cell_deps(vec![CellDepBuilder::default()
            .out_point(group)
            .dep_type(pack_byte(DepType::DepGroup as u8))
            .build()])
        .build();
    // Do not complete_tx again: verify the actual expanded-group-only layout.
    r.world.context.verify_tx(&tx, MAX_CYCLES).unwrap();
}

#[test]
fn phase2_rejects_duplicate_canonical_dependencies() {
    for index in [1, 2] {
        let (mut r, tx) = phase2_fixture();
        let op = tx.cell_deps().get(index).unwrap().out_point();
        let (cell, data) = r.world.cell(&op);
        // Distinct outpoint avoids node deduplication of identical raw deps.
        let duplicate = r.world.context.create_cell(cell, data);
        let tx = tx
            .as_advanced_builder()
            .cell_dep(
                CellDepBuilder::default()
                    .out_point(duplicate)
                    .dep_type(pack_byte(DepType::Code as u8))
                    .build(),
            )
            .build();
        let error = expect_fail(&mut r.world.context, &tx);
        assert!(format!("{error:?}").contains("error code -72"), "{error:?}");
    }
}

#[test]
fn phase2_rejects_multiple_matching_withdrawal_inputs() {
    let (mut r, tx) = phase2_fixture();
    let input = tx.inputs().get(0).unwrap();
    let (cell, data) = r.world.cell(&input.previous_output());
    let duplicate = r.world.context.create_cell(cell, data);
    r.world.context.link_cell_with_block(
        duplicate.clone(),
        header(200, 190, WITHDRAW_AR).hash(),
        0,
    );
    let tx = tx
        .as_advanced_builder()
        .input(CellInput::new(duplicate, input.since().unpack()))
        .witness(tx.witnesses().get(0).unwrap())
        .build();
    let error = expect_fail(&mut r.world.context, &tx);
    assert!(format!("{error:?}").contains("error code -60"), "{error:?}");
}

#[test]
fn phase2_failed_round_returns_deposits_and_all_yield() {
    let (mut r, tx) = phase2_fixture_with(ACC_SMT, 4, 100, default_prize_schedule(), 2);
    let funding =
        SettlementFundingDataV3::decode(&tx.outputs_data().get(0).unwrap().raw_data()).unwrap();
    assert_eq!(funding.principal_liability, 2000 * SHANNONS);
    assert_eq!(funding.liability_count, 1); // Same owner consolidated before allocation.
    assert_eq!(
        funding.principal_liability + funding.prize_pool,
        funding.realized_total
    );
    expect_ok(&mut r.world.context, &tx);
}

#[test]
fn phase2_flows_to_settlement_only() {
    let (mut r, tx) = phase2_fixture();
    let c = expect_ok(&mut r.world.context, &tx);
    println!(
        "cycles: DAO phase 2 (withdrawing -> settlement funding) = {}",
        c
    );
}

#[test]
fn phase2_rejects_forged_initial_liability_root() {
    let (mut r, tx) = phase2_fixture();
    let mut data =
        SettlementFundingDataV3::decode(&tx.outputs_data().get(0).unwrap().raw_data()).unwrap();
    data.liabilities_root = [0x99; 32];
    let bad = tx
        .as_advanced_builder()
        .set_outputs_data(vec![Bytes::from(data.encode().to_vec()).pack()])
        .build();
    expect_fail(&mut r.world.context, &bad);
}

#[test]
fn phase2_rejects_each_forged_initial_funding_field() {
    for mutation in 0..5 {
        let (mut r, tx) = phase2_fixture();
        let mut data =
            SettlementFundingDataV3::decode(&tx.outputs_data().get(0).unwrap().raw_data()).unwrap();
        match mutation {
            0 => data.liability_count += 1,
            1 => data.principal_liability -= 1,
            2 => data.prize_pool += 1,
            3 => data.payout_cursor = 1,
            _ => data.round_id = [0x95; 32],
        }
        let bad = tx
            .as_advanced_builder()
            .set_outputs_data(vec![Bytes::from(data.encode().to_vec()).pack()])
            .build();
        expect_fail(&mut r.world.context, &bad);
    }
}

#[test]
fn phase2_rejects_missing_or_substituted_canonical_dependencies() {
    // Fixture dependency slots: config0, receipt1, entropy2, native DAO3.
    for dep_index in [1usize, 2] {
        for mutation in 0..5 {
            let (mut r, tx) = phase2_fixture();
            if mutation == 0 {
                let deps: Vec<_> = tx
                    .cell_deps()
                    .into_iter()
                    .enumerate()
                    .filter_map(|(i, d)| (i != dep_index).then_some(d))
                    .collect();
                let bad = tx.as_advanced_builder().set_cell_deps(deps).build();
                expect_fail(&mut r.world.context, &bad);
                continue;
            }
            let op = tx.cell_deps().get(dep_index).unwrap().out_point();
            let (mut cell, data) = r.world.cell(&op);
            let mut bytes = data.to_vec();
            match mutation {
                1 => {
                    let arbitrary = r.world.always_success().1;
                    cell = cell.as_builder().lock(arbitrary).build();
                }
                2 => {
                    cell = cell.as_builder().type_(None::<Script>.pack()).build();
                }
                3 => {
                    bytes[0] ^= 1;
                }
                _ => {
                    let t = cell.type_().to_opt().unwrap();
                    let mut args = t.args().raw_data().to_vec();
                    let offset = if dep_index == 1 { 37 } else { 32 };
                    args[offset] ^= 1;
                    cell = cell
                        .as_builder()
                        .type_(Some(t.as_builder().args(Bytes::from(args).pack()).build()).pack())
                        .build();
                }
            }
            r.world
                .context
                .create_cell_with_out_point(op, cell, Bytes::from(bytes));
            expect_fail(&mut r.world.context, &tx);
        }
    }
}

#[test]
fn phase2_rejects_malformed_or_substituted_witness_fields() {
    for mutation in 0..6 {
        let (mut r, tx) = phase2_fixture();
        let original = WitnessArgs::from_slice(&tx.witnesses().get(0).unwrap().raw_data()).unwrap();
        let mut builder = original.clone().as_builder();
        match mutation {
            0 => builder = builder.output_type(None::<Bytes>.pack()),
            1 => {
                builder = builder.input_type(Some(Bytes::from(1u64.to_le_bytes().to_vec())).pack())
            }
            2 => {
                builder = builder.output_type(
                    Some(Bytes::from(vec![
                        0;
                        daowow_core::entitlement_witness::MAX_ENTITLEMENT_BYTES
                            + 1
                    ]))
                    .pack(),
                )
            }
            3 => {
                builder = builder.lock(
                    Some(Bytes::from(vec![
                        0;
                        daowow_core::entitlement_witness::MAX_ENTITLEMENT_BYTES
                            + 1025
                    ]))
                    .pack(),
                )
            }
            4 => {
                let mut payload = original.output_type().to_opt().unwrap().raw_data().to_vec();
                payload[0] = 2;
                builder = builder.output_type(Some(Bytes::from(payload)).pack());
            }
            _ => builder = builder.input_type(Some(Bytes::from(vec![0; 7])).pack()),
        }
        let bad = tx
            .as_advanced_builder()
            .set_witnesses(vec![builder.build().as_bytes().pack()])
            .build();
        expect_fail(&mut r.world.context, &bad);
    }
}

#[test]
fn phase2_uses_absolute_dao_input_witness_after_sponsor_input() {
    let (mut r, tx) = phase2_fixture();
    let (sponsor, lock) = r.world.funding_cell(100 * SHANNONS);
    let mut outputs: Vec<_> = tx.outputs().into_iter().collect();
    outputs.push(
        CellOutputBuilder::default()
            .capacity(pack_u64(99 * SHANNONS))
            .lock(lock)
            .build(),
    );
    let mut data: Vec<_> = tx.outputs_data().into_iter().collect();
    data.push(Bytes::new().pack());
    let empty = WitnessArgs::new_builder().build().as_bytes().pack();
    let tx = tx
        .as_advanced_builder()
        .set_inputs(vec![
            CellInput::new(sponsor, 0),
            tx.inputs().get(0).unwrap(),
        ])
        .set_outputs(outputs)
        .set_outputs_data(data)
        .set_witnesses(vec![empty.clone(), tx.witnesses().get(0).unwrap()])
        .build();
    expect_ok(&mut r.world.context, &tx);
    let bad = tx
        .as_advanced_builder()
        .set_witnesses(vec![tx.witnesses().get(1).unwrap(), empty])
        .build();
    expect_fail(&mut r.world.context, &bad);
}

#[test]
fn phase2_rejects_creator_selected_settlement_lock() {
    let (mut r, tx) = phase2_fixture();
    let (_, arbitrary) = r.world.funding_cell(1000 * SHANNONS);
    let output = tx
        .outputs()
        .get(0)
        .unwrap()
        .as_builder()
        .lock(arbitrary)
        .build();
    let tx = tx.as_advanced_builder().set_outputs(vec![output]).build();
    let error = expect_fail(&mut r.world.context, &tx);
    let message = format!("{error:?}");
    // Either DAO routing or settlement creation must reject the lock;
    // script-group execution order is not part of the protocol.
    assert!(
        message.contains("error code -59") || message.contains("error code -72"),
        "{message}"
    );
}

#[test]
fn phase2_rejects_decoy_settlement_and_diverted_remainder() {
    let (mut r, tx) = phase2_fixture();
    let output = tx.outputs().get(0).unwrap();
    let total: u64 = output.capacity().unpack();
    let mut data =
        SettlementFundingDataV3::decode(tx.outputs_data().get(0).unwrap().raw_data().as_ref())
            .unwrap();
    data.realized_total = 300 * SHANNONS;
    let decoy = output
        .clone()
        .as_builder()
        .capacity(pack_u64(300 * SHANNONS))
        .build();
    let diverted = CellOutputBuilder::default()
        .capacity(pack_u64(total - 300 * SHANNONS))
        .lock(output.lock())
        .build();
    let tx = tx
        .as_advanced_builder()
        .set_outputs(vec![decoy, diverted])
        .set_outputs_data(vec![
            Bytes::from(data.encode().to_vec()).pack(),
            Bytes::new().pack(),
        ])
        .build();
    let error = expect_fail(&mut r.world.context, &tx);
    assert!(format!("{error:?}").contains("error code -72"), "{error:?}");
}

#[test]
fn phase2_rejects_wrong_batch_and_underclaimed_yield() {
    for wrong_batch in [true, false] {
        let (mut r, tx) = phase2_fixture();
        let output = tx.outputs().get(0).unwrap();
        let mut data =
            SettlementFundingDataV3::decode(tx.outputs_data().get(0).unwrap().raw_data().as_ref())
                .unwrap();
        let cap = if wrong_batch {
            data.batch_id = 2;
            data.realized_total
        } else {
            data.realized_total = r.deposit_capacity;
            r.deposit_capacity
        };
        let tx = tx
            .as_advanced_builder()
            .set_outputs(vec![output.as_builder().capacity(pack_u64(cap)).build()])
            .set_outputs_data(vec![Bytes::from(data.encode().to_vec()).pack()])
            .build();
        let error = expect_fail(&mut r.world.context, &tx);
        let expected = if wrong_batch {
            "error code -76"
        } else {
            "error code -72"
        };
        assert!(format!("{error:?}").contains(expected), "{error:?}");
    }
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
