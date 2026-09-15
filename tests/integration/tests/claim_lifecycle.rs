//! Claim NFT sub-project 1: accepted mint and transfer cases on CKB-VM.
//! Spec: docs/superpowers/specs/2026-09-16-claim-mint-transfer-design.md

mod common;

use ckb_testtool::ckb_types::{
    bytes::Bytes,
    core::{TransactionBuilder, TransactionView},
    packed::*,
    prelude::*,
};
use common::*;
use daowow_core::accumulator::smt::host::SmtHost;
use daowow_core::encoding::{EntryDataV1, EntryShardDataV1, RoundConfigV1, ACC_SMT};

struct Fixture {
    w: World,
    cfg: RoundConfigV1,
    round: OutPoint,
    shard: OutPoint,
    shard_data: EntryShardDataV1,
    host: SmtHost,
    lock: Script,
    /// (claim out point, position) for every minted claim
    claims: Vec<(OutPoint, u64)>,
}

fn fixture() -> Fixture {
    let mut w = World::new(ACC_SMT);
    let cfg = default_config([5; 32], ACC_SMT);
    let round = w.create_round(&cfg);
    let (shard, shard_data) = w.create_shard(&cfg, 0, 1);
    let (_, lock) = w.always_success();
    Fixture {
        w,
        cfg,
        round,
        shard,
        shard_data,
        host: SmtHost::new(),
        lock,
        claims: Vec::new(),
    }
}

/// Append `ticket_counts` entries for the fixture lock, minting one claim per
/// ticket, run it, and register the new claim cells as live. Returns the
/// verified cycle count; the tx must not be re-verified after chaining.
fn append(f: &mut Fixture, ticket_counts: &[u64]) -> (u64, Vec<EntryDataV1>) {
    let participant = World::participant_hash(&f.lock);
    let commitments: Vec<[u8; 32]> = (0..ticket_counts.len())
        .map(|i| [i as u8 + 1; 32])
        .collect();
    let entries = make_entry_batch(
        &f.cfg,
        &f.shard_data,
        &participant,
        ticket_counts,
        &commitments,
    );
    let mut certs = Vec::new();
    for e in &entries {
        let absence = f.host.absence_proof(&[smt_key(e)]).unwrap();
        f.host.insert(&smt_key(e), &smt_leaf(e)).unwrap();
        let inclusion = f.host.inclusion_proof(&[smt_key(e)]).unwrap();
        certs.push((absence, inclusion));
    }
    let cert_refs: Vec<(&[u8], &[u8])> = certs
        .iter()
        .map(|(a, b)| (a.as_slice(), b.as_slice()))
        .collect();
    let mut after =
        daowow_core::shard::apply_entry_batch(Some(&f.shard_data), &f.cfg, &entries).unwrap();
    after.accumulator_root = f.host.root();
    let (shard_in, _) = f.w.cell(&f.shard);
    let (funding, _) = f.w.funding_cell(100_000 * SHANNONS);
    let entry_lock = f.w.entry_lock_script(&participant);
    let mut b = TransactionBuilder::default()
        .cell_dep(f.w.round_config_dep(&f.round))
        .input(CellInput::new(f.shard.clone(), 0))
        .input(CellInput::new(funding, 0))
        .output(shard_in.clone())
        .output_data(Bytes::from(after.encode().to_vec()).pack());
    for e in &entries {
        b = b
            .output(
                CellOutputBuilder::default()
                    .capacity(pack_u64(entry_cell_capacity(e)))
                    .lock(entry_lock.clone())
                    .build(),
            )
            .output_data(Bytes::from(e.encode().to_vec()).pack());
    }
    let lock = f.lock.clone();
    let claim_cells = claim_outputs_for(&mut f.w, &entries, &|_| lock.clone());
    let first_claim_index = 1 + entries.len();
    for (cell, data) in &claim_cells {
        b = b.output(cell.clone()).output_data(data.clone().pack());
    }
    let tx = b
        .witness(smt_append_witness(&entries, &cert_refs).pack())
        .build();
    let cycles = expect_ok(&mut f.w.context, &tx);
    chain_cell(&mut f.w, &f.shard, &tx, 0);
    f.shard_data = after;
    // register every claim output as a live cell for later transfers
    let mut idx = first_claim_index;
    for e in &entries {
        for k in 0..e.ticket_count {
            let (cell, data) = &claim_cells[idx - first_claim_index];
            let op = f.w.context.create_cell(cell.clone(), data.clone());
            chain_cell(&mut f.w, &op, &tx, idx);
            f.claims.push((op, e.position_base + k));
            idx += 1;
        }
    }
    (cycles, entries)
}

/// Transfer `claims` to `to`, one successor each, byte-identical data.
fn transfer_tx(f: &mut Fixture, claims: &[OutPoint], to: &Script) -> TransactionView {
    let (funding, _) = f.w.funding_cell(1_000 * SHANNONS);
    let mut b = TransactionBuilder::default().input(CellInput::new(funding, 0));
    for op in claims {
        let (cell, data) = f.w.cell(op);
        b = b
            .input(CellInput::new(op.clone(), 0))
            .output(cell.as_builder().lock(to.clone()).build())
            .output_data(data.pack());
    }
    b.build()
}

#[test]
fn append_mints_one_claim_per_ticket_across_entries() {
    let mut f = fixture();
    let (_, entries) = append(&mut f, &[3, 2]);
    assert_eq!(f.claims.len(), 5);
    assert_eq!(entries[1].position_base, 3);
    let positions: Vec<u64> = f.claims.iter().map(|(_, p)| *p).collect();
    assert_eq!(positions, vec![0, 1, 2, 3, 4]);
}

#[test]
fn consecutive_appends_mint_disjoint_positions() {
    let mut f = fixture();
    append(&mut f, &[2]);
    append(&mut f, &[1, 1]);
    let positions: Vec<u64> = f.claims.iter().map(|(_, p)| *p).collect();
    assert_eq!(positions, vec![0, 1, 2, 3]);
}

#[test]
fn holder_transfers_one_claim() {
    let mut f = fixture();
    append(&mut f, &[2]);
    let (_, recipient) = f.w.always_success();
    let recipient = recipient.as_builder().args(pack_pbytes(b"bob")).build();
    let op = f.claims[0].0.clone();
    let tx = transfer_tx(&mut f, &[op], &recipient);
    let cycles = expect_ok(&mut f.w.context, &tx);
    println!("claim transfer cycles: {cycles}");
}

#[test]
fn holder_transfers_two_claims_in_one_transaction() {
    let mut f = fixture();
    append(&mut f, &[2]);
    let (_, recipient) = f.w.always_success();
    let recipient = recipient.as_builder().args(pack_pbytes(b"carol")).build();
    let ops: Vec<OutPoint> = f.claims.iter().map(|(op, _)| op.clone()).collect();
    let tx = transfer_tx(&mut f, &ops, &recipient);
    expect_ok(&mut f.w.context, &tx);
}

#[test]
fn transfer_to_own_lock_is_allowed() {
    let mut f = fixture();
    append(&mut f, &[1]);
    let me = f.lock.clone();
    let op = f.claims[0].0.clone();
    let tx = transfer_tx(&mut f, &[op], &me);
    expect_ok(&mut f.w.context, &tx);
}

#[test]
fn max_batch_append_with_claims_fits_cycle_budget() {
    let mut f = fixture();
    let counts = vec![4u64; daowow_core::lifecycle::MAX_BATCH_ENTRIES];
    let (cycles, _) = append(&mut f, &counts);
    println!(
        "append {} entries / {} claims: {} cycles; claim cell {} shannons",
        counts.len(),
        f.claims.len(),
        cycles,
        claim_cell_capacity(&f.lock)
    );
    assert!(cycles < MAX_CYCLES);
}
