//! Generates machine-readable deterministic vectors (tests/vectors/).
//! Run: cargo test -p daowow-core --test gen_vectors -- --nocapture

use daowow_core::accumulator::{imt, mmr, nonce_key, smt};
use daowow_core::draw::{candidate, draw_seed, rejection_sample};
use daowow_core::encoding::*;
use daowow_core::hash::ckb_hash256_one;
use daowow_core::leaf::{entropy_commitment, entry_leaf, liability_leaf, missing_reveal_fallback};
use serde_json::json;
use std::fs;

fn hex(b: &[u8]) -> String {
    b.iter().map(|x| format!("{:02x}", x)).collect()
}

#[test]
fn gen_vectors() {
    let round_id = ckb_hash256_one(b"DAOWOW-VECTOR-ROUND-1");
    let participant = ckb_hash256_one(b"DAOWOW-VECTOR-PARTICIPANT-1");

    // 1. domain hash
    let domain_hash = ckb_hash256_one(b"DAOWOW_DOMAIN_TEST_V1");

    // 2. entry leaf
    let entry = EntryDataV1 {
        round_id,
        shard_id: 3,
        participant_lock_hash: participant,
        ticket_count: 7,
        principal: 7 * 100,
        position_base: 13,
        entry_nonce: 4,
        entropy_commitment: ckb_hash256_one(b"DAOWOW-VECTOR-COMMIT"),
    };
    let leaf = entry_leaf(&entry);

    // 3. commitment + fallback
    let commitment = entropy_commitment(b"secret", &round_id, &participant);
    let fallback = missing_reveal_fallback(&commitment);

    // 4. liability leaf
    let liab = liability_leaf(&participant, 100, 10);

    // 5. SMT append certificate for nonce 4 over 3 prior leaves
    let mut t = smt::host::SmtHost::new();
    for i in 0u64..3 {
        let mut e = entry;
        e.entry_nonce = i;
        e.position_base = i * 7;
        t.insert(&nonce_key(i), &entry_leaf(&e)).unwrap();
    }
    let mut e4 = entry;
    e4.entry_nonce = 3;
    e4.position_base = 21;
    let absence = t.absence_proof(&[nonce_key(3)]).unwrap();
    t.insert(&nonce_key(3), &entry_leaf(&e4)).unwrap();
    let inclusion = t.inclusion_proof(&[nonce_key(3)]).unwrap();
    let smt_root = t.root();

    // 6. MMR append
    let mut m = mmr::host::MmrHost::new();
    for i in 0u64..5 {
        m.append(&ckb_hash256_one(format!("mmr-{i}").as_bytes()))
            .unwrap();
    }
    let mmr_root = m.root().unwrap();
    let mmr_proof = m.membership_proof(2).unwrap();

    // 7. IMT append + membership
    let mut im = imt::host::ImtHost::new();
    for i in 0u64..5 {
        im.append(&ckb_hash256_one(format!("imt-{i}").as_bytes()));
    }
    let imt_root = im.root();
    let imt_proof = im.membership_proof(2).unwrap();

    // 8. draw seed + rejection sampling
    let seed = draw_seed(&round_id, &smt_root, 1_000_000, &commitment, &fallback);
    let (pos, retry) = rejection_sample(&seed, 0, 1_000_000).unwrap();
    let cand0 = candidate(&seed, 0, 0);

    // 9. indexed settlement funding wire format
    let mut liabilities = mmr::host::MmrHost::new();
    liabilities.append(&liab).unwrap();
    let funding = SettlementFundingDataV3 {
        round_id,
        batch_id: 1,
        realized_total: 110,
        principal_liability: 100,
        prize_pool: 10,
        payout_cursor: 0,
        liability_count: 1,
        liabilities_root: liabilities.root().unwrap(),
        prize_count: 0,
        prize_root: [0; 32],
        prize_paid: 0,
    };

    // 10. encoded sizes
    let sizes = json!({
        "round_config": ROUND_CONFIG_SIZE,
        "shard_data": SHARD_DATA_SIZE,
        "entry_data": ENTRY_DATA_SIZE,
        "batch_data": BATCH_DATA_SIZE,
        "settlement_funding": SETTLEMENT_FUNDING_SIZE,
        "payout_item": PAYOUT_ITEM_SIZE,
    });

    // Cell-encoding oracles for the JavaScript decoders in apps/web/chain/.
    // Every field gets a distinct, non-zero, non-repeating value: a decoder
    // reading a neighbouring offset must produce a visibly wrong number, which
    // a zero-filled or uniform sample would hide. u64s are emitted as STRINGS
    // because JSON numbers are IEEE-754 doubles and shannon amounts exceed
    // 2^53, so a numeric encoding would silently round.
    let sref = |n: u8, ht: u8| ScriptRef {
        code_hash: ckb_hash256_one(&[n]),
        hash_type: ht,
    };
    let oracle_cfg = RoundConfigV1 {
        version: 1,
        round_id,
        ticket_price: 100_000_000_000,
        minimum_tickets: 50,
        maximum_tickets: 200,
        entry_start: 1_001,
        entry_end: 1_002,
        aggregation_deadline: 1_003,
        dao_term_periods: 2,
        entry_shard_count: 1,
        prize_schedule_hash: ckb_hash256_one(b"VECTOR-PRIZE-SCHEDULE"),
        fee_policy_hash: ckb_hash256_one(b"VECTOR-FEE-POLICY"),
        keeper_policy_hash: ckb_hash256_one(b"VECTOR-KEEPER-POLICY"),
        flags: 7,
        accumulator_id: ACC_SMT,
        entry_lock: sref(11, 2),
        dao_lock: sref(12, 2),
        settlement_type: sref(13, 2),
        entry_shard_type: sref(14, 2),
        dao_type: sref(15, 1),
    };
    let oracle_shard = EntryShardDataV1 {
        round_id,
        shard_id: 0,
        state: SHARD_STATE_OPEN,
        sequence: 3,
        entry_count: 4,
        ticket_count: 5,
        principal_total: 500_000_000_000,
        accumulator_root: ckb_hash256_one(b"VECTOR-ACC-ROOT"),
    };
    let script_ref_json = |r: &ScriptRef| {
        json!({ "code_hash": hex(&r.code_hash), "hash_type": r.hash_type })
    };
    let cell_encodings = json!({
        "round_config": {
            "hex": hex(&oracle_cfg.encode()),
            "commitment": hex(&oracle_cfg.commitment()),
            "fields": {
                "version": oracle_cfg.version,
                "round_id": hex(&oracle_cfg.round_id),
                "ticket_price": oracle_cfg.ticket_price.to_string(),
                "minimum_tickets": oracle_cfg.minimum_tickets.to_string(),
                "maximum_tickets": oracle_cfg.maximum_tickets.to_string(),
                "entry_start": oracle_cfg.entry_start.to_string(),
                "entry_end": oracle_cfg.entry_end.to_string(),
                "aggregation_deadline": oracle_cfg.aggregation_deadline.to_string(),
                "dao_term_periods": oracle_cfg.dao_term_periods,
                "entry_shard_count": oracle_cfg.entry_shard_count,
                "prize_schedule_hash": hex(&oracle_cfg.prize_schedule_hash),
                "fee_policy_hash": hex(&oracle_cfg.fee_policy_hash),
                "keeper_policy_hash": hex(&oracle_cfg.keeper_policy_hash),
                "flags": oracle_cfg.flags,
                "accumulator_id": oracle_cfg.accumulator_id,
                "entry_lock": script_ref_json(&oracle_cfg.entry_lock),
                "dao_lock": script_ref_json(&oracle_cfg.dao_lock),
                "settlement_type": script_ref_json(&oracle_cfg.settlement_type),
                "entry_shard_type": script_ref_json(&oracle_cfg.entry_shard_type),
                "dao_type": script_ref_json(&oracle_cfg.dao_type),
            },
        },
        "shard_data": {
            "hex": hex(&oracle_shard.encode()),
            "fields": {
                "round_id": hex(&oracle_shard.round_id),
                "shard_id": oracle_shard.shard_id,
                "state": oracle_shard.state,
                "sequence": oracle_shard.sequence.to_string(),
                "entry_count": oracle_shard.entry_count.to_string(),
                "ticket_count": oracle_shard.ticket_count.to_string(),
                "principal_total": oracle_shard.principal_total.to_string(),
                "accumulator_root": hex(&oracle_shard.accumulator_root),
            },
        },
    });

    // Prize schedule v2 oracle. The web client renders the payout table, so it
    // needs the selection RULE pinned, not only the bytes: places_at is the
    // number of paying places at each interesting ticket count, including both
    // sides of every threshold.
    let demo_schedule = daowow_core::schedule::PrizeSchedule::new_tiered(
        &[40, 25, 20, 10, 5],
        &[1, 8, 20, 50, 100],
    )
    .unwrap();
    let mut places_at = serde_json::Map::new();
    for tickets in [1u64, 7, 8, 19, 20, 49, 50, 99, 100, 1000] {
        places_at.insert(
            tickets.to_string(),
            json!(demo_schedule.weights_for(tickets).unwrap().len()),
        );
    }
    // The v1 wire, so the client's decoder is pinned to Rust on both paths
    // rather than only on v2. v1 IS v2 with thresholds [1..n].
    let v1_schedule = daowow_core::schedule::PrizeSchedule::new(&[40, 25, 20, 10, 5]).unwrap();
    let mut v1_places = serde_json::Map::new();
    for tickets in [1u64, 3, 5, 7, 8, 20, 100] {
        v1_places.insert(
            tickets.to_string(),
            json!(v1_schedule.weights_for(tickets).unwrap().len()),
        );
    }
    let prize_schedule_v1 = json!({
        "hex": hex(&v1_schedule.encode()),
        "commitment": hex(&v1_schedule.commitment()),
        "thresholds": v1_schedule.thresholds(),
        "places_at": v1_places,
    });

    // Capacity oracles for the entry quote. Both lock sizes matter: a JoyID
    // lock has 22-byte args and secp has 20, so a claim cell is 222 or 220
    // CKB. The client must compute from the CONNECTED wallet's lock rather
    // than assume either.
    let capacity = json!({
        "claim_occupied_ckb": {
            "joyid_lock_55": daowow_core::claim::claim_occupied_capacity(32 + 1 + 22) / 100_000_000,
            "secp_lock_53": daowow_core::claim::claim_occupied_capacity(32 + 1 + 20) / 100_000_000,
        },
        "memento_occupied_ckb": {
            "secp_lock_53": daowow_core::memento::memento_occupied_capacity(32 + 1 + 20) / 100_000_000,
        },
        "entry_cell_overhead_ckb": 8 + ENTRY_DATA_SIZE as u64 + 33 + 64,
    });

    // Aggregation ledger oracles, for the JavaScript builders in gate 3a.
    //
    // A DEDICATED config rather than `oracle_cfg`, and the reason is worth
    // stating: `oracle_cfg` is ACC_SMT while the client runs ACC_MMR, and
    // `oracle_shard` is OPEN with `sequence != entry_count`, which
    // `AggregationState::new_bound` refuses outright. So the ledger fixture
    // carries its own config and its commitment travels with the vectors,
    // leaving the JavaScript tests self-contained.
    let ledger_cfg = RoundConfigV1 {
        accumulator_id: ACC_MMR,
        ..oracle_cfg
    };
    let ledger_entries = [
        EntryDataV1 {
            round_id,
            shard_id: 0,
            participant_lock_hash: ckb_hash256_one(b"VECTOR-LEDGER-PARTICIPANT-A"),
            ticket_count: 3,
            principal: 3 * ledger_cfg.ticket_price,
            position_base: 0,
            entry_nonce: 0,
            entropy_commitment: [0; 32],
        },
        EntryDataV1 {
            round_id,
            shard_id: 0,
            participant_lock_hash: ckb_hash256_one(b"VECTOR-LEDGER-PARTICIPANT-B"),
            ticket_count: 2,
            principal: 2 * ledger_cfg.ticket_price,
            position_base: 3,
            entry_nonce: 1,
            entropy_commitment: [0; 32],
        },
    ];
    // The frozen shard the ledger is born from. Replaying the entries is the
    // only way to get the accumulator root, exactly as a client must.
    let mut ledger_mmr = mmr::host::MmrHost::new();
    for entry in &ledger_entries {
        ledger_mmr.append(&entry_leaf(entry)).unwrap();
    }
    let ledger_frozen = EntryShardDataV1 {
        round_id,
        shard_id: 0,
        state: SHARD_STATE_FROZEN,
        sequence: 2,
        entry_count: 2,
        ticket_count: 5,
        principal_total: 5 * ledger_cfg.ticket_price,
        accumulator_root: ledger_mmr.root().unwrap(),
    };
    // 237 CKB of slack over principal, the real entry-cell overhead.
    let ledger_capacities: Vec<u64> = ledger_entries
        .iter()
        .map(|e| e.principal + 23_700_000_000)
        .collect();
    let ledger_proofs: Vec<Vec<u8>> = (0..ledger_entries.len() as u64)
        .map(|pos| ledger_mmr.membership_proof(pos).unwrap())
        .collect();
    let proof_refs: Vec<&[u8]> = ledger_proofs.iter().map(|p| p.as_slice()).collect();

    let ledger_genesis =
        daowow_core::lifecycle::AggregationState::new(&ledger_cfg, &ledger_frozen).unwrap();
    let (ledger_after, ledger_batch) = ledger_genesis
        .accept(
            &ledger_cfg,
            &ledger_entries,
            &ledger_capacities,
            &proof_refs,
        )
        .unwrap();

    let state_json = |s: &daowow_core::lifecycle::AggregationState| {
        json!({
            "hex": hex(&s.encode()),
            "fields": {
                "accepted_entries": s.accepted_entries().to_string(),
                "accepted_tickets": s.accepted_tickets().to_string(),
                "accepted_batches": s.accepted_batches().to_string(),
                "closed": s.is_closed(),
            },
        })
    };
    let aggregation_state = json!({
        "note": "ACC_MMR variant of cell_encodings.round_config; see gen_vectors.rs",
        "config": {
            "hex": hex(&ledger_cfg.encode()),
            "commitment": hex(&ledger_cfg.commitment()),
        },
        "frozen": {
            "hex": hex(&ledger_frozen.encode()),
            "fields": {
                "state": ledger_frozen.state,
                "sequence": ledger_frozen.sequence.to_string(),
                "entry_count": ledger_frozen.entry_count.to_string(),
                "ticket_count": ledger_frozen.ticket_count.to_string(),
                "principal_total": ledger_frozen.principal_total.to_string(),
                "accumulator_root": hex(&ledger_frozen.accumulator_root),
            },
        },
        "entries": ledger_entries
            .iter()
            .zip(&ledger_capacities)
            .map(|(e, c)| json!({ "hex": hex(&e.encode()), "capacity": c.to_string() }))
            .collect::<Vec<_>>(),
        "genesis": state_json(&ledger_genesis),
        "after_batch": state_json(&ledger_after),
    });
    let batch_commitment = json!({
        "hex": hex(&ledger_batch.encode()),
        "fields": {
            "digest": hex(&ledger_batch.digest),
            "first_nonce": ledger_batch.first_nonce.to_string(),
            "entry_count": ledger_batch.entry_count.to_string(),
            "ticket_count": ledger_batch.ticket_count.to_string(),
            "principal": ledger_batch.principal.to_string(),
            "input_capacity": ledger_batch.input_capacity.to_string(),
        },
    });
    // The ledger cell sits at input 0, so the entry cells start at 1.
    let witness_records: Vec<daowow_core::witness::LedgerInputProof<'_>> = ledger_proofs
        .iter()
        .enumerate()
        .map(|(i, p)| daowow_core::witness::LedgerInputProof {
            input_index: i as u32 + 1,
            proof: p.as_slice(),
        })
        .collect();
    let ledger_witness = json!({
        "hex": hex(&daowow_core::witness::encode_ledger_witness(&witness_records).unwrap()),
        "records": witness_records
            .iter()
            .map(|r| json!({ "input_index": r.input_index, "proof": hex(r.proof) }))
            .collect::<Vec<_>>(),
    });
    let batch_id = json!([
        { "shard_id": 0, "ordinal": 0,
          "value": daowow_core::lifecycle::batch_id(0, 0).unwrap().to_string() },
        { "shard_id": 1, "ordinal": 5,
          "value": daowow_core::lifecycle::batch_id(1, 5).unwrap().to_string() },
        { "shard_id": 255, "ordinal": 1,
          "value": daowow_core::lifecycle::batch_id(255, 1).unwrap().to_string() },
    ]);

    // Gate 3b/3c oracles: the seal, the entropy record, the four scheduled
    // heights, and the settlement funding cell.
    //
    // The seal is built from the SAME ledger fixture as `aggregation_state`,
    // closed. RoundSeal::new refuses any ledger that is not closed and bound to
    // the commitment, which is why gate 3a needed `close` before this could
    // exist. Every ledger here accepted all its entries, so entry_end governs
    // the close rather than the aggregation deadline (lifecycle.rs:341).
    let closed_ledger = ledger_after
        .close(
            &ledger_cfg,
            daowow_core::epoch::absolute_epoch_since(ledger_cfg.entry_end).unwrap(),
        )
        .unwrap();
    let round_seal = daowow_core::seal::RoundSeal::new(&ledger_cfg, &[closed_ledger]).unwrap();
    // A round number would hide arithmetic mistakes in the +64..+256 offsets.
    let seal_inclusion: u64 = 1_234_567;
    let inclusion_hash = ckb_hash256_one(b"VECTOR-SEAL-INCLUSION");
    let chain_hashes = [
        ckb_hash256_one(b"VECTOR-ENTROPY-64"),
        ckb_hash256_one(b"VECTOR-ENTROPY-128"),
        ckb_hash256_one(b"VECTOR-ENTROPY-192"),
    ];
    let entropy_record = daowow_core::seal::EntropyRecord::new(
        round_seal.clone(),
        seal_inclusion,
        inclusion_hash,
        chain_hashes,
    )
    .unwrap();
    let round_seal_json = json!({
        "hex": hex(&round_seal.encode()),
        "shard_count": ledger_cfg.entry_shard_count,
        "ledger_hex": hex(&closed_ledger.encode()),
    });
    let entropy_record_json = json!({
        "hex": hex(&entropy_record.encode()),
        "inclusion_height": seal_inclusion.to_string(),
        "inclusion_hash": hex(&inclusion_hash),
        "entropy_hashes": chain_hashes.iter().map(|h| hex(h)).collect::<Vec<_>>(),
    });
    let entropy_heights = json!([1_000u64, seal_inclusion, 9_007_199_254_740_000u64]
        .iter()
        .map(|&inclusion| {
            let heights = daowow_core::seal::RoundSeal::entropy_heights(inclusion).unwrap();
            json!({
                "inclusion": inclusion.to_string(),
                "heights": heights.iter().map(|h| h.to_string()).collect::<Vec<_>>(),
            })
        })
        .collect::<Vec<_>>());

    // Distinct non-zero values in every field, so a decoder reading a
    // neighbouring offset produces a visibly wrong result — the same reason
    // oracle_entry does it.
    let settlement_funding = SettlementFundingDataV3 {
        round_id: ckb_hash256_one(b"VECTOR-FUNDING-ROUND"),
        batch_id: 0x0102_0304_0506_0708,
        realized_total: 547_400_000_000 + 1_111,
        principal_liability: 500_000_000_000,
        prize_pool: 2_222_222,
        payout_cursor: 3,
        liability_count: 7,
        liabilities_root: ckb_hash256_one(b"VECTOR-LIABILITIES-ROOT"),
        prize_count: 2,
        prize_root: ckb_hash256_one(b"VECTOR-PRIZE-ROOT"),
        prize_paid: 444_444,
    };
    let settlement_funding_json = json!({
        "hex": hex(&settlement_funding.encode()),
        "fields": {
            "round_id": hex(&settlement_funding.round_id),
            "batch_id": settlement_funding.batch_id.to_string(),
            "realized_total": settlement_funding.realized_total.to_string(),
            "principal_liability": settlement_funding.principal_liability.to_string(),
            "prize_pool": settlement_funding.prize_pool.to_string(),
            "payout_cursor": settlement_funding.payout_cursor.to_string(),
            "liability_count": settlement_funding.liability_count.to_string(),
            "liabilities_root": hex(&settlement_funding.liabilities_root),
            "prize_count": settlement_funding.prize_count.to_string(),
            "prize_root": hex(&settlement_funding.prize_root),
            "prize_paid": settlement_funding.prize_paid.to_string(),
        },
    });
    // The decoder must accept what the encoder wrote, or the JS would be pinned
    // to bytes the contract itself cannot read.
    assert_eq!(
        SettlementFundingDataV3::decode(&settlement_funding.encode()).unwrap(),
        settlement_funding
    );
    assert_eq!(
        daowow_core::seal::EntropyRecord::decode(&entropy_record.encode(), &ledger_cfg).unwrap(),
        entropy_record
    );

    let prize_schedule_v2 = json!({
        "note": "demo schedule; v1 wire is unchanged and lives in the v1 tests",
        "hex": hex(&demo_schedule.encode()),
        "commitment": hex(&demo_schedule.commitment()),
        "weights": demo_schedule.weights_for(u64::MAX).unwrap(),
        "thresholds": demo_schedule.thresholds(),
        "places_at": places_at,
    });

    // Entry, ticket and claim oracles for the browser's entry path. One
    // canonical entry with distinct non-zero values per field, so a decoder or
    // encoder reading a neighbouring offset produces a visibly wrong result.
    let oracle_entry = EntryDataV1 {
        round_id: ckb_hash256_one(b"VECTOR-ENTRY-ROUND"),
        shard_id: 3,
        participant_lock_hash: ckb_hash256_one(b"VECTOR-ENTRY-PARTICIPANT"),
        ticket_count: 7,
        principal: 70_000_000_000,
        position_base: 11,
        entry_nonce: 13,
        entropy_commitment: ckb_hash256_one(b"VECTOR-ENTRY-COMMIT"),
    };
    let oracle_commitment = ckb_hash256_one(b"VECTOR-CLAIM-CONFIG");
    let oracle_claim = daowow_core::claim::ClaimArgs {
        commitment: oracle_commitment,
        shard_id: oracle_entry.shard_id,
        position: oracle_entry.position_base,
    };
    let entry_encoding = json!({
        "entry": {
            "hex": hex(&oracle_entry.encode()),
            "leaf": hex(&daowow_core::leaf::entry_leaf(&oracle_entry)),
            "fields": {
                "round_id": hex(&oracle_entry.round_id),
                "shard_id": oracle_entry.shard_id,
                "participant_lock_hash": hex(&oracle_entry.participant_lock_hash),
                "ticket_count": oracle_entry.ticket_count.to_string(),
                "principal": oracle_entry.principal.to_string(),
                "position_base": oracle_entry.position_base.to_string(),
                "entry_nonce": oracle_entry.entry_nonce.to_string(),
                "entropy_commitment": hex(&oracle_entry.entropy_commitment),
            },
        },
        "claim": {
            "config_commitment": hex(&oracle_commitment),
            "shard_id": oracle_claim.shard_id,
            "position": oracle_claim.position.to_string(),
            "ticket_id": hex(&oracle_claim.ticket_id()),
            "args_hex": hex(&oracle_claim.encode()),
            "initial_state_hex": hex(&daowow_core::claim::initial_state_bytes(&oracle_claim)),
        },
    });

    // MMR append witness oracles for the browser. Two cases, because the
    // empty shard is the one a client hits first and its old peak list is the
    // single byte 0x00 rather than an absent field.
    let peak_bytes = |host: &daowow_core::accumulator::mmr::host::MmrHost| {
        let mut out = vec![host.peaks().len() as u8];
        for peak in host.peaks() {
            out.extend_from_slice(peak);
        }
        out
    };
    let witness_entry = |nonce: u64| EntryDataV1 {
        round_id: ckb_hash256_one(b"VECTOR-WITNESS-ROUND"),
        shard_id: 0,
        participant_lock_hash: ckb_hash256_one(b"VECTOR-WITNESS-PARTICIPANT"),
        ticket_count: 1,
        principal: 10_000_000_000,
        position_base: nonce,
        entry_nonce: nonce,
        entropy_commitment: ckb_hash256_one(&[nonce as u8]),
    };

    // From an empty shard: append two entries.
    let mut h0 = daowow_core::accumulator::mmr::host::MmrHost::new();
    let empty_old = peak_bytes(&h0);
    let empty_entries = [witness_entry(0), witness_entry(1)];
    for e in &empty_entries {
        h0.append(&daowow_core::leaf::entry_leaf(e)).unwrap();
    }
    let empty_new = peak_bytes(&h0);

    // From a shard that already holds one entry: append two more, so the old
    // peak list is non-empty and the client cannot pass an empty one by luck.
    let mut h1 = daowow_core::accumulator::mmr::host::MmrHost::new();
    h1.append(&daowow_core::leaf::entry_leaf(&witness_entry(9)))
        .unwrap();
    let seeded_old = peak_bytes(&h1);
    let seeded_root_before = h1.root().unwrap();
    let seeded_entries = [witness_entry(10), witness_entry(11)];
    for e in &seeded_entries {
        h1.append(&daowow_core::leaf::entry_leaf(e)).unwrap();
    }
    let seeded_new = peak_bytes(&h1);

    let mmr_witness = json!({
        "from_empty": {
            "old_peaks_hex": hex(&empty_old),
            "new_peaks_hex": hex(&empty_new),
            "root_after": hex(&h0.root().unwrap()),
            "witness_hex": hex(&daowow_core::witness::encode_shard_append_witness_mmr(
                &empty_entries, &empty_old, &empty_new)),
        },
        "from_one_entry": {
            "seed_entry_nonce": 9,
            "root_before": hex(&seeded_root_before),
            "old_peaks_hex": hex(&seeded_old),
            "new_peaks_hex": hex(&seeded_new),
            "root_after": hex(&h1.root().unwrap()),
            "witness_hex": hex(&daowow_core::witness::encode_shard_append_witness_mmr(
                &seeded_entries, &seeded_old, &seeded_new)),
        },
        "entry_leaves": {
            "0": hex(&daowow_core::leaf::entry_leaf(&witness_entry(0))),
            "1": hex(&daowow_core::leaf::entry_leaf(&witness_entry(1))),
            "9": hex(&daowow_core::leaf::entry_leaf(&witness_entry(9))),
            "10": hex(&daowow_core::leaf::entry_leaf(&witness_entry(10))),
            "11": hex(&daowow_core::leaf::entry_leaf(&witness_entry(11))),
        },
    });

    let v = json!({
        "meta": {
            "hash": "blake2b-256 personalization ckb-default-hash",
            "integers": "little-endian unless noted",
            "generated_by": "daowow-core gen_vectors",
        },
        "domain_hash": { "input": "DAOWOW_DOMAIN_TEST_V1", "output": hex(&domain_hash) },
        "entry_leaf": {
            "domain": "DAOWOW_ENTRY_LEAF_V1 || EntryDataV1 canonical bytes",
            "entry_canonical_hex": hex(&entry.encode()),
            "leaf": hex(&leaf),
        },
        "entropy": {
            "commitment_domain": "DAOWOW_ENTRY_COMMIT_V1",
            "commitment": hex(&commitment),
            "missing_reveal_fallback": hex(&fallback),
        },
        "liability_leaf": { "leaf": hex(&liab) },
        "settlement_funding_v3": {
            "canonical_hex": hex(&funding.encode()),
            "payout_cursor": funding.payout_cursor,
            "liability_count": funding.liability_count,
            "liabilities_root": hex(&funding.liabilities_root),
            "prize_count": funding.prize_count,
            "prize_root": hex(&funding.prize_root),
            "prize_paid": funding.prize_paid,
        },
        "smt": {
            "key_domain": "32-byte big-endian nonce",
            "root_after_4_appends": hex(&smt_root),
            "absence_proof_hex": hex(&absence),
            "inclusion_proof_hex": hex(&inclusion),
        },
        "mmr": {
            "root_after_5_appends": hex(&mmr_root),
            "membership_proof_pos2_hex": hex(&mmr_proof),
        },
        "imt": {
            "depth": imt::IMT_DEPTH,
            "root_after_5_appends": hex(&imt_root),
            "membership_proof_pos2_hex": hex(&imt_proof),
        },
        "draw": {
            "seed_domain": "DAOWOW_DRAW_SEED_V1",
            "seed": hex(&seed),
            "candidate_0_0": hex(&cand0),
            "rejection_sample_prize0_n1000000": { "position": pos, "retry": retry },
        },
        "canonical_sizes": sizes,
        "mmr_witness": mmr_witness,
        "entry_encoding": entry_encoding,
        "prize_schedule_v1": prize_schedule_v1,
        "prize_schedule_v2": prize_schedule_v2,
        "capacity": capacity,
        "cell_encodings": cell_encodings,
        "aggregation_state": aggregation_state,
        "batch_commitment": batch_commitment,
        "ledger_witness": ledger_witness,
        "batch_id": batch_id,
        "round_seal": round_seal_json,
        "entropy_record": entropy_record_json,
        "entropy_heights": entropy_heights,
        "settlement_funding": settlement_funding_json,
    });

    let out = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../tests/vectors/daowow_core_vectors.json"
    );
    fs::write(out, serde_json::to_string_pretty(&v).unwrap()).unwrap();
    println!("written {}", out);
}

/// Guards the oracle the JavaScript decoders are pinned to. If encode and
/// decode ever disagree, `apps/web/chain/codec.js` would be pinned to a lie
/// and its tests would still be green.
#[test]
fn cell_encoding_oracles_round_trip() {
    let round_id = ckb_hash256_one(b"DAOWOW-VECTOR-ROUND-1");
    let shard = EntryShardDataV1 {
        round_id,
        shard_id: 0,
        state: SHARD_STATE_OPEN,
        sequence: 3,
        entry_count: 4,
        ticket_count: 5,
        principal_total: 500_000_000_000,
        accumulator_root: ckb_hash256_one(b"VECTOR-ACC-ROOT"),
    };
    assert_eq!(EntryShardDataV1::decode(&shard.encode()).unwrap(), shard);
}
