//! Isolated-node fixture exporter. No RPC, signing, or filesystem writes.
use ckb_testtool::ckb_types::{bytes::Bytes, packed::*, prelude::*};
use daowow_core::{encoding::*, hash::ckb_hash256, schedule::PrizeSchedule};
use serde_json::{json, Value};
use std::path::PathBuf;

fn hex(bytes: &[u8]) -> String {
    let mut value = String::from("0x");
    for byte in bytes {
        value.push_str(&format!("{byte:02x}"));
    }
    value
}

fn hash_arg(value: &str) -> [u8; 32] {
    assert!(
        value.starts_with("0x") && value.len() == 66,
        "expected a 32-byte RPC hash"
    );
    let mut hash = [0; 32];
    for (i, byte) in hash.iter_mut().enumerate() {
        *byte = u8::from_str_radix(&value[2 + i * 2..4 + i * 2], 16).expect("hex hash");
    }
    hash
}

fn script(reference: ScriptRef, args: &[u8]) -> Value {
    json!({"code_hash": hex(&reference.code_hash), "hash_type": "data1", "args": hex(args)})
}

/// The participant lock is smoke-minimal deployed as data1, like every script here.
fn script_json(s: &Script) -> Value {
    json!({
        "code_hash": hex(s.code_hash().as_slice()),
        "hash_type": "data1",
        "args": hex(s.args().raw_data().as_ref()),
    })
}

fn main() {
    let mut args: Vec<_> = std::env::args().collect();
    let partial = args.last().is_some_and(|arg| arg == "partial");
    if partial {
        args.pop();
    }
    assert!(
        matches!(args.len(), 4 | 9 | 10),
        "funding_tx_hash funding_index native_dao_type_hash [seal_height seal_hash entropy_hash1 entropy_hash2 entropy_hash3 [realized_capacity]] [partial]"
    );
    let input = CellInput::new(
        OutPoint::new_builder()
            .tx_hash(Byte32::from_slice(&hash_arg(&args[1])).unwrap())
            .index(args[2].parse::<u32>().expect("output index"))
            .build(),
        0,
    );
    let directory = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../target/riscv64imac-unknown-none-elf/release");
    let reference = |name| ScriptRef {
        code_hash: ckb_hash256(&[&std::fs::read(directory.join(name)).expect("built contract")]),
        hash_type: 2,
    };
    let round_type = reference("round-type");
    let schedule = PrizeSchedule::new(&[1]).unwrap();
    // The config's DAO reference is the complete deposit type-script hash,
    // not the genesis holder hash returned by get_consensus.dao_type_hash.
    let native_dao = Script::new_builder()
        .code_hash(Byte32::from_slice(&hash_arg(&args[3])).unwrap())
        .hash_type(1u8)
        .args(Bytes::new())
        .build();
    let cfg = RoundConfigV1 {
        version: 1,
        round_id: ckb_hash256(&[input.as_slice(), &0u64.to_le_bytes()]),
        ticket_price: 100 * 100_000_000,
        minimum_tickets: 1,
        maximum_tickets: 0,
        entry_start: 0,
        entry_end: 2,
        aggregation_deadline: 4,
        dao_term_periods: 1,
        entry_shard_count: 2,
        prize_schedule_hash: schedule.commitment(),
        fee_policy_hash: [8; 32],
        keeper_policy_hash: [7; 32],
        flags: 0,
        accumulator_id: ACC_MMR,
        entry_lock: reference("entry-lock"),
        dao_lock: reference("dao-lock"),
        settlement_type: reference("settlement-type"),
        entry_shard_type: reference("entry-shard-type"),
        dao_type: ScriptRef {
            code_hash: native_dao
                .calc_script_hash()
                .raw_data()
                .as_ref()
                .try_into()
                .unwrap(),
            hash_type: 1,
        },
    };
    cfg.validate().unwrap();
    let empty_shard = |id| EntryShardDataV1 {
        round_id: cfg.round_id,
        shard_id: id,
        state: SHARD_STATE_OPEN,
        sequence: 0,
        entry_count: 0,
        ticket_count: 0,
        principal_total: 0,
        accumulator_root: daowow_core::accumulator::mmr::bag_peaks(&[]).unwrap(),
    };
    let shards: Vec<_> = (0..2)
        .map(|id| {
            let shard = empty_shard(id);
            let mut args = cfg.commitment().to_vec();
            args.extend_from_slice(&id.to_le_bytes());
            json!({"type": script(cfg.entry_shard_type, &args), "data": hex(&shard.encode())})
        })
        .collect();
    let participant = Script::new_builder()
        .code_hash(Byte32::from_slice(&reference("smoke-minimal").code_hash).unwrap())
        .hash_type(2u8)
        .args(Bytes::from_static(b"daowow-fixture"))
        .build();
    let participant_hash: [u8; 32] = participant
        .calc_script_hash()
        .raw_data()
        .as_ref()
        .try_into()
        .unwrap();
    let entry = EntryDataV1 {
        round_id: cfg.round_id,
        shard_id: 0,
        participant_lock_hash: participant_hash,
        ticket_count: 1,
        principal: cfg.ticket_price,
        position_base: 0,
        entry_nonce: 0,
        entropy_commitment: [0; 32],
    };
    let excluded = EntryDataV1 {
        entry_nonce: 1,
        position_base: 1,
        ..entry
    };
    let entries = if partial {
        vec![entry, excluded]
    } else {
        vec![entry]
    };
    let mut mmr = daowow_core::accumulator::mmr::host::MmrHost::new();
    for item in &entries {
        mmr.append(&daowow_core::leaf::entry_leaf(item)).unwrap();
    }
    let mut after =
        daowow_core::shard::apply_entry_batch(Some(&empty_shard(0)), &cfg, &entries).unwrap();
    after.accumulator_root = mmr.root().unwrap();
    let mut new_peaks = vec![mmr.peaks().len() as u8];
    for peak in mmr.peaks() {
        new_peaks.extend_from_slice(peak);
    }
    let append_witness =
        daowow_core::witness::encode_shard_append_witness_mmr(&entries, &[0], &new_peaks);
    let mut entry_args = participant_hash.to_vec();
    entry_args.extend_from_slice(&cfg.commitment());
    // one claim NFT per ticket, locked to the entrant, minted in the append
    let claims: Vec<Value> = entries
        .iter()
        .flat_map(|e| (0..e.ticket_count).map(move |i| (e.shard_id, e.position_base + i)))
        .map(|(shard_id, position)| {
            let args = daowow_core::claim::ClaimArgs {
                commitment: cfg.commitment(),
                shard_id,
                position,
            };
            let lock_size = 32 + 1 + participant.args().raw_data().len() as u64;
            let capacity = daowow_core::claim::claim_occupied_capacity(lock_size);
            json!({
                "type": script(cfg.entry_shard_type, &args.encode()),
                "lock": script_json(&participant),
                "data": hex(&daowow_core::claim::initial_state_bytes(&args)),
                "capacity": format!("0x{:x}", capacity),
            })
        })
        .collect();
    let mut frozen = after;
    frozen.state = SHARD_STATE_FROZEN;
    let mut frozen_empty = empty_shard(1);
    frozen_empty.state = SHARD_STATE_FROZEN;
    let ledger = daowow_core::lifecycle::AggregationState::new(&cfg, &frozen).unwrap();
    let proof = mmr.membership_proof(0).unwrap();
    let (next, receipt) = ledger
        .accept(&cfg, &[entry], &[400 * 100_000_000], &[&proof])
        .unwrap();
    let batch_id = ledger.next_batch_id().unwrap();
    let mut dao_args = cfg.round_id.to_vec();
    dao_args.extend_from_slice(&batch_id.to_le_bytes());
    dao_args.extend_from_slice(&cfg.commitment());
    dao_args.extend_from_slice(&receipt.digest);
    let mut receipt_args = vec![2];
    receipt_args.extend_from_slice(&cfg.commitment());
    receipt_args.extend_from_slice(&0u32.to_le_bytes());
    receipt_args.extend_from_slice(&batch_id.to_le_bytes());
    receipt_args.extend_from_slice(&receipt.digest);
    let ledger_witness =
        daowow_core::witness::encode_ledger_witness(&[daowow_core::witness::LedgerInputProof {
            input_index: 1,
            proof: &proof,
        }])
        .unwrap();
    let witness = WitnessArgs::new_builder()
        .output_type(Some(Bytes::from(schedule.encode())).pack())
        .build();
    let empty_ledger = daowow_core::lifecycle::AggregationState::new(&cfg, &frozen_empty).unwrap();
    let close_since = daowow_core::epoch::absolute_epoch_since(if partial {
        cfg.aggregation_deadline
    } else {
        cfg.entry_end
    })
    .unwrap();
    let closed = [
        next.close(&cfg, close_since).unwrap(),
        empty_ledger.close(&cfg, close_since).unwrap(),
    ];
    let seal = daowow_core::seal::RoundSeal::new(&cfg, &closed).unwrap();
    let record = if args.len() >= 9 {
        Some(
            daowow_core::seal::EntropyRecord::new(
                seal.clone(),
                args[4].parse().expect("seal height"),
                hash_arg(&args[5]),
                [hash_arg(&args[6]), hash_arg(&args[7]), hash_arg(&args[8])],
            )
            .unwrap(),
        )
    } else {
        None
    };
    let entropy = record.as_ref().map(|r| hex(&r.encode()));
    let refund_since = daowow_core::epoch::absolute_epoch_since(cfg.aggregation_deadline).unwrap();
    let refund_closed = if partial { next } else { ledger }
        .close(&cfg, refund_since)
        .unwrap();
    let refund_proof = mmr.membership_proof(if partial { 1 } else { 0 }).unwrap();
    let refund_witness = daowow_core::witness::encode_aggregation_witness(&refund_proof);
    let settlement = if args.len() == 10 {
        let realized: u64 = args[9].parse().expect("realized capacity");
        let evidence = daowow_core::entitlement_witness::EntitlementWitness::encode(
            &schedule,
            &[entry],
            &[400 * 100_000_000],
        )
        .unwrap();
        let derived = daowow_core::entitlements::InitialEntitlements::derive(
            &cfg,
            record.as_ref().unwrap(),
            &schedule,
            &daowow_core::entitlements::EntitlementInput {
                batch_id,
                receipt: &receipt,
                entries: &[entry],
                capacities: &[400 * 100_000_000],
                realized_total: realized,
            },
        )
        .unwrap();
        let funding_witness = WitnessArgs::new_builder()
            .input_type(Some(Bytes::from(0u64.to_le_bytes().to_vec())).pack())
            .output_type(Some(Bytes::from(evidence)).pack())
            .build();
        let mut funding_args = cfg.commitment().to_vec();
        funding_args.extend_from_slice(&batch_id.to_le_bytes());
        funding_args.extend_from_slice(&receipt.digest);
        assert_eq!(derived.liabilities().len(), 1);
        let item = &derived.liabilities()[0];
        let mut liabilities = daowow_core::accumulator::mmr::host::MmrHost::new();
        liabilities
            .append(&daowow_core::leaf::liability_leaf(
                &item.participant_lock_hash,
                item.principal,
                item.prize,
            ))
            .unwrap();
        let payout_proof = liabilities.membership_proof(0).unwrap();
        let payout_witness = daowow_core::witness::encode_settlement_witness(&[(
            b"daowow-fixture",
            &reference("smoke-minimal").code_hash,
            2,
            item,
            &payout_proof,
        )]);
        // The single winning ticket (shard 0, position 0) redeems its prize
        // from the claim minted in the append. Transaction shape agreed with
        // the Python harness: inputs [funding, claim, sponsor]; outputs
        // [funding successor, claim successor, payment, change].
        let funding = *derived.funding();
        assert_eq!(derived.prizes().len(), 1);
        let prize = derived.prizes()[0];
        let claim_args = daowow_core::claim::ClaimArgs {
            commitment: cfg.commitment(),
            shard_id: 0,
            position: 0,
        };
        assert_eq!(prize.ticket, claim_args.ticket_id());
        let source =
            daowow_core::redemption::prize_source(&cfg.commitment(), batch_id, &receipt.digest);
        let paid = daowow_core::accumulator::smt::host::SmtHost::new();
        let key = daowow_core::redemption::prize_obligation_key(&prize.ticket, &source);
        let absence = paid.absence_proof(&[key]).unwrap();
        let claim_before = daowow_core::redemption::PrizeRedemptionState::new(prize.ticket);
        let claim_after = claim_before
            .record_verified_prize(&source, prize.amount, &absence)
            .unwrap();
        let mut prizes = daowow_core::accumulator::mmr::host::MmrHost::new();
        prizes
            .append(&daowow_core::leaf::prize_leaf(&prize.ticket, prize.amount))
            .unwrap();
        let mmr_proof = prizes.membership_proof(0).unwrap();
        let redemption_witness = daowow_core::witness::encode_redemption_witness(&[
            daowow_core::witness::RedemptionItem {
                claim_input_index: 1,
                payment_output_index: 2,
                prize_index: 0,
                amount: prize.amount,
                mmr_proof: &mmr_proof,
                absence_proof: &absence,
            },
        ])
        .unwrap();
        let mut after_redeem = funding;
        after_redeem.prize_paid = funding.prize_pool;
        // Retirement fixtures: the sealed round (config + entropy record cell
        // deps, already assembled by the Python harness) plus the raw
        // committed schedule bytes `retire()` expects as the group input's
        // own witness (not wrapped in a WitnessArgs, unlike the round-creation
        // witness above). The winning ticket's memento content is fully
        // determined here, where the real draw and the post-redemption
        // PrizeRedemptionState are already in hand.
        let draw = daowow_core::computed_draw::ComputedDraw::new(
            &cfg,
            record.as_ref().unwrap(),
            &schedule,
        )
        .unwrap();
        assert_eq!(draw.positions().len(), 1);
        let (rank, _global_position) = draw.positions()[0];
        let memento_args = daowow_core::memento::MementoArgs {
            commitment: cfg.commitment(),
            shard_id: 0,
            position: 0,
        };
        let memento_data = daowow_core::memento::MementoData {
            renderer_version: daowow_core::memento::MEMENTO_RENDERER_V1,
            prize_index: rank as u32,
            paid_count: claim_after.paid_count(),
            paid_total: claim_after.paid_total(),
        };
        let memento_lock_size = 32 + 1 + participant.args().raw_data().len() as u64;
        let memento_capacity = daowow_core::memento::memento_occupied_capacity(memento_lock_size);
        Some(
            json!({"data": hex(&funding.encode()), "type": script(cfg.settlement_type, &funding_args),
            "lock": script(cfg.settlement_type, &[0]), "witness": hex(funding_witness.as_slice()),
            "payout_witness": hex(&payout_witness), "principal": item.principal, "prize": item.prize,
            "prize_pool": funding.prize_pool,
            "redemption": {
                "witness": hex(&redemption_witness),
                "claim_data_after": hex(&claim_after.encode()),
                "funding_data_after": hex(&after_redeem.encode()),
                "amount": prize.amount,
                "claim_input_index": 1,
                "payment_output_index": 2,
            },
            "retirement": {
                "schedule_raw": hex(&schedule.encode()),
                "memento": {
                    "type": script(cfg.entry_shard_type, &memento_args.encode()),
                    "data": hex(&memento_data.encode()),
                    "capacity": format!("0x{memento_capacity:x}"),
                }
            }}),
        )
    } else {
        None
    };
    println!(
        "{}",
        json!({"partial": partial, "config": hex(&cfg.encode()), "round_type": script(round_type, &cfg.round_id),
        "public_lock": script(cfg.entry_shard_type, &[0]), "shards": shards,
        "witness": hex(witness.as_slice()),
        "refund": {"closed_ledger": hex(&refund_closed.encode()),
            "accepted_witness": hex(&daowow_core::witness::encode_aggregation_witness(&proof)),
            "since": format!("0x{refund_since:x}"), "witness": hex(&refund_witness)},
        "append": {"shard_data": hex(&after.encode()), "entry_data": hex(&entry.encode()),
            "excluded_data": hex(&excluded.encode()),
            "entry_lock": script(cfg.entry_lock, &entry_args), "witness": hex(&append_witness),
            "claims": claims},
        "freeze": {"shard_data": [hex(&frozen.encode()), hex(&frozen_empty.encode())],
            "since": format!("0x{:x}", daowow_core::epoch::absolute_epoch_since(cfg.entry_end).unwrap())},
        "aggregation": {"initial_ledger": hex(&ledger.encode()), "next_ledger": hex(&next.encode()),
            "dao_lock": script(cfg.dao_lock, &dao_args), "receipt_type": script(cfg.entry_shard_type, &receipt_args),
            "receipt_data": hex(&receipt.encode()), "witness": hex(&ledger_witness)},
        "seal": {"empty_ledger": hex(&empty_ledger.encode()),
            "closed": [hex(&closed[0].encode()), hex(&closed[1].encode())], "data": hex(&seal.encode())},
        "entropy": entropy, "settlement": settlement})
    );
}
