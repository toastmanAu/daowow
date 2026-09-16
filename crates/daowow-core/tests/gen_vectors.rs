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
    });

    let out = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../tests/vectors/daowow_core_vectors.json"
    );
    fs::write(out, serde_json::to_string_pretty(&v).unwrap()).unwrap();
    println!("written {}", out);
}
