//! Claim NFT sub-project 1: rejected mint and transfer cases on CKB-VM.
//! Spec: docs/superpowers/specs/2026-09-16-claim-mint-transfer-design.md

mod common;

use ckb_testtool::ckb_types::{
    bytes::Bytes,
    core::{DepType, TransactionBuilder, TransactionView},
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

/// The happy-path append for `ticket_counts`, returned unbuilt: the builder
/// (shard + entry outputs, no claims, no witness), the entries, the claim
/// cells the rule expects, and the witness. Tests add altered claims then
/// `.witness(w).build()`.
fn build_append(
    f: &mut Fixture,
    ticket_counts: &[u64],
) -> (
    TransactionBuilder,
    Vec<EntryDataV1>,
    Vec<(CellOutput, Bytes)>,
    ckb_testtool::ckb_types::packed::Bytes,
) {
    let participant = World::participant_hash(&f.lock);
    let commitments: Vec<[u8; 32]> = (0..ticket_counts.len())
        .map(|i| [i as u8 + 0x40; 32])
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
        .output(shard_in)
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
    let claims = claim_outputs_for(&mut f.w, &entries, &|_| lock.clone());
    let witness = smt_append_witness(&entries, &cert_refs).pack();
    (b, entries, claims, witness)
}

fn claim_args(f: &World, shard_id: u32, position: u64) -> daowow_core::claim::ClaimArgs {
    daowow_core::claim::ClaimArgs {
        commitment: f.config_hash,
        shard_id,
        position,
    }
}

fn claim_cell(f: &mut Fixture, shard_id: u32, position: u64) -> (CellOutput, Bytes) {
    let lock = f.lock.clone();
    let t = f.w.claim_type_script(shard_id, position);
    let args = claim_args(&f.w, shard_id, position);
    (
        CellOutputBuilder::default()
            .capacity(pack_u64(claim_cell_capacity(&lock)))
            .lock(lock)
            .type_(Some(t).pack())
            .build(),
        Bytes::from(daowow_core::claim::initial_state_bytes(&args).to_vec()),
    )
}

fn code_of(err: &ckb_testtool::ckb_error::Error) -> String {
    let text = format!("{err}");
    text.split("error code ")
        .nth(1)
        .and_then(|rest| rest.split(' ').next())
        .unwrap_or("?")
        .to_string()
}

fn expect_code(f: &mut Fixture, tx: &TransactionView, code: &str) {
    let err = expect_fail(&mut f.w.context, tx);
    assert_eq!(code_of(&err), code, "unexpected failure: {err}");
}

const SHARD_CLAIM_CELL: &str = "-38";
const CLAIM_MINT: &str = "-94";
const CLAIM_TRANSITION: &str = "-95";
const CLAIM_GROUP: &str = "-93";
const CLAIM_RETIRE: &str = "-96";
const CLAIM_REDEEM: &str = "-97";
const CLAIM_UNIVERSE: &str = "-98";

#[test]
fn append_without_a_claim_per_ticket_is_rejected() {
    let mut f = fixture();
    let (mut b, _, mut claims, w) = build_append(&mut f, &[2]);
    claims.pop();
    for (c, d) in claims {
        b = b.output(c).output_data(d.pack());
    }
    expect_code(&mut f, &b.witness(w).build(), SHARD_CLAIM_CELL);
}

#[test]
fn append_with_an_extra_claim_is_rejected() {
    let mut f = fixture();
    let (mut b, _, claims, w) = build_append(&mut f, &[2]);
    for (c, d) in &claims {
        b = b.output(c.clone()).output_data(d.pack());
    }
    let (c, d) = claim_cell(&mut f, 0, 2);
    b = b.output(c).output_data(d.pack());
    expect_code(&mut f, &b.witness(w).build(), SHARD_CLAIM_CELL);
}

#[test]
fn duplicate_position_is_rejected() {
    // two claims both at position 0 instead of 0 and 1 (count still matches).
    // This shape has TWO independently-failing script groups: the shard
    // transition (SHARD_CLAIM_CELL, from validate_mint's duplicate-position
    // check) and the claim group itself (CLAIM_GROUP, since two identical-args
    // outputs collapse into one group with more than one member). CKB runs
    // script groups in script-hash order and reports whichever fails first,
    // and that order depends on the deployed binary's own hash — any change
    // to the entry-shard-type binary (e.g. adding a new dispatch mode) can
    // flip which of the two legitimate rejections is observed. Either is a
    // correct rejection of this malformed mint.
    let mut f = fixture();
    let (mut b, _, claims, w) = build_append(&mut f, &[2]);
    let (c0, d0) = claims[0].clone();
    b = b
        .output(c0.clone())
        .output_data(d0.pack())
        .output(c0)
        .output_data(d0.pack());
    let err = expect_fail(&mut f.w.context, &b.witness(w).build());
    let code = code_of(&err);
    assert!(
        code == SHARD_CLAIM_CELL || code == CLAIM_GROUP,
        "unexpected failure: {err}"
    );
}

#[test]
fn remint_of_an_earlier_position_is_rejected() {
    let mut f = fixture();
    append(&mut f, &[1]); // position 0 exists
    let (mut b, _, _, w) = build_append(&mut f, &[1]); // new ticket is position 1
    let (c, d) = claim_cell(&mut f, 0, 0);
    b = b.output(c).output_data(d.pack());
    expect_code(&mut f, &b.witness(w).build(), SHARD_CLAIM_CELL);
}

#[test]
fn claim_beyond_the_new_range_is_rejected() {
    let mut f = fixture();
    let (mut b, _, _, w) = build_append(&mut f, &[1]);
    let (c, d) = claim_cell(&mut f, 0, 1);
    b = b.output(c).output_data(d.pack());
    expect_code(&mut f, &b.witness(w).build(), SHARD_CLAIM_CELL);
}

#[test]
fn claim_locked_to_a_stranger_is_rejected() {
    let mut f = fixture();
    let (mut b, _, claims, w) = build_append(&mut f, &[1]);
    let (_, stranger) = f.w.always_success();
    let stranger = stranger.as_builder().args(pack_pbytes(b"mallory")).build();
    let (c, d) = claims[0].clone();
    b = b
        .output(c.as_builder().lock(stranger).build())
        .output_data(d.pack());
    expect_code(&mut f, &b.witness(w).build(), SHARD_CLAIM_CELL);
}

#[test]
fn claim_with_nonzero_paid_state_is_rejected() {
    let mut f = fixture();
    let (mut b, _, claims, w) = build_append(&mut f, &[1]);
    let (c, d) = claims[0].clone();
    let mut d = d.to_vec();
    d[73] = 1;
    b = b.output(c).output_data(Bytes::from(d).pack());
    // both the shard rule and the claim script reject; the shard group runs first
    let err = expect_fail(&mut f.w.context, &b.witness(w).build());
    assert!(
        [SHARD_CLAIM_CELL, "-92"].contains(&code_of(&err).as_str()),
        "unexpected failure: {err}"
    );
}

#[test]
fn claim_whose_data_ticket_mismatches_args_is_rejected() {
    let mut f = fixture();
    let (mut b, _, claims, w) = build_append(&mut f, &[1]);
    let (c, _) = claims[0].clone();
    let other = claim_args(&f.w, 0, 7);
    b = b
        .output(c)
        .output_data(Bytes::from(daowow_core::claim::initial_state_bytes(&other).to_vec()).pack());
    let err = expect_fail(&mut f.w.context, &b.witness(w).build());
    assert!(
        [SHARD_CLAIM_CELL, "-92"].contains(&code_of(&err).as_str()),
        "unexpected failure: {err}"
    );
}

#[test]
fn claim_for_another_shard_in_the_same_transaction_is_rejected() {
    // the shard-1 claim's own script finds no shard-1 transition
    let mut f = fixture();
    let (mut b, _, claims, w) = build_append(&mut f, &[1]);
    for (c, d) in &claims {
        b = b.output(c.clone()).output_data(d.pack());
    }
    let (c, d) = claim_cell(&mut f, 1, 0);
    b = b.output(c).output_data(d.pack());
    expect_code(&mut f, &b.witness(w).build(), CLAIM_MINT);
}

#[test]
fn claim_minted_in_a_freeze_transaction_is_rejected() {
    let mut f = fixture();
    append(&mut f, &[1]);
    let (cell, _) = f.w.cell(&f.shard);
    let mut frozen = f.shard_data;
    frozen.state = daowow_core::encoding::SHARD_STATE_FROZEN;
    let (claim, data) = claim_cell(&mut f, 0, 1); // never minted
    let tx = TransactionBuilder::default()
        .cell_dep(f.w.round_config_dep(&f.round))
        .input(CellInput::new(f.shard.clone(), 0x2000_0000_0000_0064))
        .output(cell)
        .output_data(Bytes::from(frozen.encode().to_vec()).pack())
        .output(claim)
        .output_data(data.pack())
        .build();
    expect_code(&mut f, &tx, SHARD_CLAIM_CELL);
}

#[test]
fn claim_minted_with_no_shard_transition_is_rejected() {
    let mut f = fixture();
    let (funding, _) = f.w.funding_cell(1_000 * SHANNONS);
    let (claim, data) = claim_cell(&mut f, 0, 0);
    let tx = TransactionBuilder::default()
        .input(CellInput::new(funding, 0))
        .output(claim)
        .output_data(data.pack())
        .build();
    expect_code(&mut f, &tx, CLAIM_MINT);
}

#[test]
fn claim_minted_beside_a_shard_cell_dep_only_is_rejected() {
    let mut f = fixture();
    let (funding, _) = f.w.funding_cell(1_000 * SHANNONS);
    let (claim, data) = claim_cell(&mut f, 0, 0);
    let tx = TransactionBuilder::default()
        .cell_dep(
            CellDepBuilder::default()
                .out_point(f.shard.clone())
                .dep_type(pack_byte(DepType::Code as u8))
                .build(),
        )
        .input(CellInput::new(funding, 0))
        .output(claim)
        .output_data(data.pack())
        .build();
    expect_code(&mut f, &tx, CLAIM_MINT);
}

#[test]
fn claim_minted_beside_a_valid_ledger_initialization_is_rejected() {
    // A frozen shard (101-byte data) initialising its aggregation ledger
    // (207-byte data) is a legitimate transition of the SAME type identity.
    // Without the claim script's data-length gate on the OUTPUT side this
    // transaction would mint a claim with no append counting at all.
    let mut f = fixture();
    append(&mut f, &[1]);
    let cfg = full_config(&f.cfg, &f.w.deps);
    let mut frozen = f.shard_data;
    frozen.state = daowow_core::encoding::SHARD_STATE_FROZEN;
    let (cell, _) = f.w.cell(&f.shard);
    f.w.context.create_cell_with_out_point(
        f.shard.clone(),
        cell.clone(),
        Bytes::from(frozen.encode().to_vec()),
    );
    let state = daowow_core::lifecycle::AggregationState::new(&cfg, &frozen).unwrap();
    let (sponsor, _) = f.w.funding_cell(1_000 * SHANNONS);
    let ledger_cell = cell.as_builder().capacity(pack_u64(500 * SHANNONS)).build();
    let init = TransactionBuilder::default()
        .cell_dep(f.w.round_config_dep(&f.round))
        .input(CellInput::new(f.shard.clone(), 0))
        .input(CellInput::new(sponsor, 0))
        .output(ledger_cell.clone())
        .output_data(Bytes::from(state.encode().to_vec()).pack())
        .build();
    // control: the initialisation itself is accepted by the shard script
    expect_ok(&mut f.w.context, &init);
    let (claim, data) = claim_cell(&mut f, 0, 1); // position never minted
    let with_claim = init
        .as_advanced_builder()
        .output(claim)
        .output_data(data.pack())
        .build();
    expect_code(&mut f, &with_claim, CLAIM_MINT);
}

#[test]
fn transfer_with_altered_data_is_rejected() {
    let mut f = fixture();
    append(&mut f, &[1]);
    let (_, to) = f.w.always_success();
    let op = f.claims[0].0.clone();
    let tx = transfer_tx(&mut f, &[op], &to);
    let mut data = tx.outputs_data().get(0).unwrap().raw_data().to_vec();
    data[65] = 1; // paid_count: decodable only with a nonzero root, so Encoding
    let altered = tx
        .as_advanced_builder()
        .set_outputs_data(vec![Bytes::from(data).pack()])
        .build();
    let err = expect_fail(&mut f.w.context, &altered);
    assert!(
        ["-92", CLAIM_TRANSITION].contains(&code_of(&err).as_str()),
        "unexpected failure: {err}"
    );
}

#[test]
fn transfer_to_a_paid_looking_state_is_an_unauthenticated_redemption() {
    // a decodable, ticket-matching but different state is the redemption shape
    use daowow_core::redemption::{prize_obligation_key, prize_payment_leaf, PrizeRedemptionState};
    let mut f = fixture();
    append(&mut f, &[1]);
    let (_, to) = f.w.always_success();
    let op = f.claims[0].0.clone();
    let ticket = claim_args(&f.w, 0, 0).ticket_id();
    let initial = PrizeRedemptionState::new(ticket);
    let mut tree = SmtHost::new();
    let key = prize_obligation_key(&ticket, &[9; 32]);
    let proof = tree.absence_proof(&[key]).unwrap();
    let paid = initial.record_verified_prize(&[9; 32], 5, &proof).unwrap();
    tree.insert(&key, &prize_payment_leaf(&ticket, &[9; 32], 5))
        .unwrap();
    let tx = transfer_tx(&mut f, &[op], &to)
        .as_advanced_builder()
        .set_outputs_data(vec![Bytes::from(paid.encode().to_vec()).pack()])
        .build();
    // a changed paid set is the redemption shape; with no funding input in
    // the transaction the claim script refuses it as an unauthenticated redeem
    expect_code(&mut f, &tx, CLAIM_REDEEM);
}

#[test]
fn transfer_with_two_successors_is_rejected() {
    let mut f = fixture();
    append(&mut f, &[1]);
    let (_, to) = f.w.always_success();
    let op = f.claims[0].0.clone();
    let (cell, data) = f.w.cell(&op);
    let tx = transfer_tx(&mut f, &[op], &to)
        .as_advanced_builder()
        .output(cell.as_builder().lock(to).build())
        .output_data(data.pack())
        .build();
    expect_code(&mut f, &tx, CLAIM_GROUP);
}

#[test]
fn burning_a_claim_is_rejected() {
    let mut f = fixture();
    append(&mut f, &[1]);
    let (funding, plain) = f.w.funding_cell(1_000 * SHANNONS);
    let op = f.claims[0].0.clone();
    let (cell, _) = f.w.cell(&op);
    let tx = TransactionBuilder::default()
        .input(CellInput::new(op, 0))
        .input(CellInput::new(funding, 0))
        .output(
            CellOutputBuilder::default()
                .capacity(cell.capacity())
                .lock(plain)
                .build(),
        )
        .output_data(Bytes::new().pack())
        .build();
    // No entropy record or round config is offered as evidence, so retirement
    // now fails at the sealed-round authentication step rather than the old
    // unconditional refusal.
    expect_code(&mut f, &tx, CLAIM_UNIVERSE);
}
