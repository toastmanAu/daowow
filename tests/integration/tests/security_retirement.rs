//! Adversarial suite for claim retirement and the winner memento: proving the
//! on-chain guards (contracts/entry-shard-type/src/claim.rs's `retire` /
//! `check_memento_outputs` and .../memento.rs's `run`) actually refuse what
//! they must.
//!
//! Every test below is built so that exactly one script group can possibly
//! reject the transaction: the other participating group (if any) is kept
//! well-formed on its own terms, so the asserted exact `i8` identifies the
//! guard under test rather than an artifact of CKB's script-hash execution
//! order. See the file-level `NOTE` near the bottom for the one row of the
//! task-9 brief table that could not be isolated this way and was left out.

mod common;

use ckb_testtool::ckb_types::{
    bytes::Bytes,
    core::{DepType, TransactionBuilder, TransactionView},
    packed::*,
    prelude::*,
};
use ckb_testtool::context::Context;
use common::*;
use daowow_core::claim::ClaimArgs;
use daowow_core::error::codes::*;
use daowow_core::memento::{MementoData, MEMENTO_RENDERER_V1};
use daowow_core::schedule::PrizeSchedule;

fn code_of(err: &ckb_testtool::ckb_error::Error) -> i8 {
    let text = format!("{err}");
    text.split("error code ")
        .nth(1)
        .and_then(|rest| rest.split(' ').next())
        .and_then(|s| s.parse::<i8>().ok())
        .unwrap_or_else(|| panic!("could not parse an exact error code from: {err}"))
}

/// Assert the transaction fails with exactly `expected` — never a broad
/// match. Every call site in this file is built so only one script group can
/// reject; this asserts that group's code precisely.
fn expect_code(context: &mut Context, tx: &TransactionView, expected: i8) {
    let err = expect_fail(context, tx);
    let code = code_of(&err);
    assert_eq!(code, expected, "unexpected failure: {err}");
}

/// A plain capacity-recovery output (no type script): the shape `retire()`
/// expects beside the consumed claim when no memento is minted.
fn plain_output(lock: &Script) -> (CellOutput, ckb_testtool::ckb_types::packed::Bytes) {
    (
        CellOutputBuilder::default()
            .capacity(pack_u64(claim_cell_capacity(lock)))
            .lock(lock.clone())
            .build(),
        Bytes::new().pack(),
    )
}

fn well_formed_memento_data(round: &SealedRound) -> [u8; 54] {
    MementoData {
        renderer_version: MEMENTO_RENDERER_V1,
        prize_index: round.prize_index,
        paid_count: 1,
        paid_total: SHANNONS,
    }
    .encode()
}

// --- Step 1: the worked example --------------------------------------------

#[test]
fn a_winner_one_source_short_is_refused() {
    let mut w = World::new(ACC_MMR);
    let round = sealed_round_with_entropy(&mut w, 4, 8);
    let (_, lock) = w.always_success();

    // Every batch discharged but one: the claim still owes a source.
    let (claim_op, _args) = seed_claim_with_paid_count(&mut w, &lock, &round, round.universe - 1);
    let (out, out_data) = plain_output(&lock);

    let tx = TransactionBuilder::default()
        .input(CellInput::new_builder().previous_output(claim_op).build())
        .output(out)
        .output_data(out_data)
        .cell_dep(round.config_dep.clone())
        .cell_dep(round.entropy_dep.clone())
        .witness(schedule_witness(&round.schedule))
        .build();
    expect_code(&mut w.context, &tx, CLAIM_ERROR_INCOMPLETE);
}

// --- Step 2: variants --------------------------------------------------------

/// Isolated to the claim group: the entropy dep is simply absent, so
/// `entropy_record_dep` fails before the retire decision (winner/non-winner,
/// paid count) is ever evaluated. No memento cell exists in this transaction.
#[test]
fn retiring_before_the_entropy_record_exists_is_refused() {
    let mut w = World::new(ACC_MMR);
    let round = sealed_round_with_entropy(&mut w, 4, 8);
    let (_, lock) = w.always_success();
    let (claim_op, _args) = seed_claim_with_paid_count(&mut w, &lock, &round, round.universe - 1);
    let (out, out_data) = plain_output(&lock);

    let tx = TransactionBuilder::default()
        .input(CellInput::new_builder().previous_output(claim_op).build())
        .output(out)
        .output_data(out_data)
        .cell_dep(round.config_dep.clone())
        // entropy_dep omitted
        .witness(schedule_witness(&round.schedule))
        .build();
    expect_code(&mut w.context, &tx, CLAIM_ERROR_UNIVERSE);
}

/// Isolated to the claim group: a fully paid winner retires with no memento
/// output at all, so `check_memento_outputs` finds zero matches where it
/// requires exactly one.
#[test]
fn a_winner_retiring_with_no_memento_is_refused() {
    let mut w = World::new(ACC_MMR);
    let round = sealed_round_with_entropy(&mut w, 4, 8);
    let (_, lock) = w.always_success();
    let (claim_op, _args) = seed_paid_claim(&mut w, &lock, &round);
    let (out, out_data) = plain_output(&lock);

    let tx = TransactionBuilder::default()
        .input(CellInput::new_builder().previous_output(claim_op).build())
        .output(out)
        .output_data(out_data)
        .cell_dep(round.config_dep.clone())
        .cell_dep(round.entropy_dep.clone())
        .witness(schedule_witness(&round.schedule))
        .build();
    expect_code(&mut w.context, &tx, CLAIM_ERROR_RETIRE);
}

/// Isolated to the claim group: the memento is well-formed and of the exact
/// identity being retired, so the memento's own group is satisfied (its
/// mint check only wants one matching claim consumed and none produced,
/// which holds here). Only the claim's retire logic objects, because a
/// non-winner (paid_count == 0) must retire with no memento at all.
#[test]
fn a_non_winner_issuing_a_memento_is_refused() {
    let mut w = World::new(ACC_MMR);
    let round = sealed_round_with_entropy(&mut w, 4, 8);
    let (_, lock) = w.always_success();
    let (claim_op, args) = seed_claim(
        &mut w,
        &lock,
        round.non_winning_shard,
        round.non_winning_position,
    );
    let memento_type = w.memento_type_script(args.shard_id, args.position);
    let memento_data = well_formed_memento_data(&round);
    let (out, out_data) = plain_output(&lock);

    let tx = TransactionBuilder::default()
        .input(CellInput::new_builder().previous_output(claim_op).build())
        .output(out)
        .output_data(out_data)
        .output(
            CellOutputBuilder::default()
                .capacity(pack_u64(memento_cell_capacity(&lock)))
                .lock(lock.clone())
                .type_(Some(memento_type).pack())
                .build(),
        )
        .output_data(pack_pbytes(&memento_data))
        .cell_dep(round.config_dep.clone())
        .cell_dep(round.entropy_dep.clone())
        .witness(schedule_witness(&round.schedule))
        .build();
    expect_code(&mut w.context, &tx, CLAIM_ERROR_RETIRE);
}

/// Isolated to the memento group: no claim cell exists anywhere in this
/// transaction, so the memento's own mint check (exactly one claim of this
/// ticket consumed) fails on its own account, before any claim script runs.
#[test]
fn a_memento_minted_with_no_retiring_claim_is_refused() {
    let mut w = World::new(ACC_MMR);
    let round = sealed_round_with_entropy(&mut w, 4, 8);
    let (_, lock) = w.always_success();
    let (funding, _) = w.funding_cell(1_000 * SHANNONS);
    let memento_type = w.memento_type_script(round.winning_shard, round.winning_position);
    let memento_data = well_formed_memento_data(&round);

    let tx = TransactionBuilder::default()
        .input(CellInput::new_builder().previous_output(funding).build())
        .output(
            CellOutputBuilder::default()
                .capacity(pack_u64(memento_cell_capacity(&lock)))
                .lock(lock.clone())
                .type_(Some(memento_type).pack())
                .build(),
        )
        .output_data(pack_pbytes(&memento_data))
        .build();
    expect_code(&mut w.context, &tx, MEMENTO_ERROR_MINT);
}

/// Isolated to the memento group: the claim of this identity transfers
/// (input and an identical output), which the claim script accepts on its
/// own terms without ever looking at mementos. The memento's own mint check
/// sees the named claim still present in the outputs and refuses.
#[test]
fn a_memento_minted_beside_a_transferring_claim_is_refused() {
    let mut w = World::new(ACC_MMR);
    let round = sealed_round_with_entropy(&mut w, 4, 8);
    let (_, lock) = w.always_success();
    let (claim_op, args) = seed_claim(
        &mut w,
        &lock,
        round.non_winning_shard,
        round.non_winning_position,
    );
    let (cell, data) = w.cell(&claim_op);
    let memento_type = w.memento_type_script(args.shard_id, args.position);
    let memento_data = well_formed_memento_data(&round);

    let tx = TransactionBuilder::default()
        .input(CellInput::new_builder().previous_output(claim_op).build())
        .output(cell)
        .output_data(data.pack())
        .output(
            CellOutputBuilder::default()
                .capacity(pack_u64(memento_cell_capacity(&lock)))
                .lock(lock.clone())
                .type_(Some(memento_type).pack())
                .build(),
        )
        .output_data(pack_pbytes(&memento_data))
        .build();
    expect_code(&mut w.context, &tx, MEMENTO_ERROR_MINT);
}

/// Isolated to the memento group: the retiring claim is a non-winner, so the
/// claim's own check never looks for a memento of a DIFFERENT identity (its
/// `check_memento_outputs` filters by its own args) and returns Ok. The
/// memento, named for a ticket that is not the one being consumed, fails its
/// own "exactly one matching claim input" count.
#[test]
fn a_memento_for_a_different_ticket_is_refused() {
    let mut w = World::new(ACC_MMR);
    let round = sealed_round_with_entropy(&mut w, 4, 8);
    let (_, lock) = w.always_success();
    let (claim_op, _args) = seed_claim(
        &mut w,
        &lock,
        round.non_winning_shard,
        round.non_winning_position,
    );
    let other_position = round.non_winning_position + 1;
    let memento_type = w.memento_type_script(round.non_winning_shard, other_position);
    let memento_data = well_formed_memento_data(&round);
    let (out, out_data) = plain_output(&lock);

    let tx = TransactionBuilder::default()
        .input(CellInput::new_builder().previous_output(claim_op).build())
        .output(out)
        .output_data(out_data)
        .output(
            CellOutputBuilder::default()
                .capacity(pack_u64(memento_cell_capacity(&lock)))
                .lock(lock.clone())
                .type_(Some(memento_type).pack())
                .build(),
        )
        .output_data(pack_pbytes(&memento_data))
        .cell_dep(round.config_dep.clone())
        .cell_dep(round.entropy_dep.clone())
        .witness(schedule_witness(&round.schedule))
        .build();
    expect_code(&mut w.context, &tx, MEMENTO_ERROR_MINT);
}

/// Isolated to the claim group: `MementoData::decode` only checks structural
/// invariants (paid_count > 0, paid_total >= paid_count, prize_index in
/// range), not truth against the actual paid state, so an off-by-one
/// `paid_total` still decodes. Only the claim's byte-exact comparison of the
/// memento's content against what it computed from the real state objects.
#[test]
fn a_memento_with_the_wrong_winnings_is_refused() {
    let mut w = World::new(ACC_MMR);
    let round = sealed_round_with_entropy(&mut w, 4, 8);
    let (_, lock) = w.always_success();
    let (claim_op, args) = seed_paid_claim(&mut w, &lock, &round);
    let tx = retire_with_memento(&mut w, &round, &lock, claim_op, &args);

    let mut data = tx.outputs_data().get(0).unwrap().raw_data().to_vec();
    let paid_total = u64::from_le_bytes(data[46..54].try_into().unwrap());
    data[46..54].copy_from_slice(&(paid_total + 1).to_le_bytes());
    let tx = tx
        .as_advanced_builder()
        .set_outputs_data(vec![Bytes::from(data).pack()])
        .build();
    expect_code(&mut w.context, &tx, CLAIM_ERROR_RETIRE);
}

/// Isolated to the claim group: same reasoning as the winnings case, applied
/// to `prize_index` instead of `paid_total`.
#[test]
fn a_memento_with_the_wrong_rank_is_refused() {
    let mut w = World::new(ACC_MMR);
    let round = sealed_round_with_entropy(&mut w, 4, 8);
    let (_, lock) = w.always_success();
    let (claim_op, args) = seed_paid_claim(&mut w, &lock, &round);
    let tx = retire_with_memento(&mut w, &round, &lock, claim_op, &args);

    let mut data = tx.outputs_data().get(0).unwrap().raw_data().to_vec();
    let prize_index = u32::from_le_bytes(data[34..38].try_into().unwrap());
    data[34..38].copy_from_slice(&(prize_index + 1).to_le_bytes());
    let tx = tx
        .as_advanced_builder()
        .set_outputs_data(vec![Bytes::from(data).pack()])
        .build();
    expect_code(&mut w.context, &tx, CLAIM_ERROR_RETIRE);
}

/// Isolated to the memento group: `MementoData::decode` checks the template
/// hash bytes against the protocol constant unconditionally, before any
/// claim identity is even considered, so a substituted byte fails this
/// standalone mint on its own — no claim cell participates in this
/// transaction at all.
#[test]
fn a_memento_with_a_substituted_template_is_refused() {
    let mut w = World::new(ACC_MMR);
    let round = sealed_round_with_entropy(&mut w, 4, 8);
    let (_, lock) = w.always_success();
    let (funding, _) = w.funding_cell(1_000 * SHANNONS);
    let memento_type = w.memento_type_script(round.winning_shard, round.winning_position);
    let mut data = well_formed_memento_data(&round).to_vec();
    data[2] ^= 0xff; // inside the template_hash range [2..34]

    let tx = TransactionBuilder::default()
        .input(CellInput::new_builder().previous_output(funding).build())
        .output(
            CellOutputBuilder::default()
                .capacity(pack_u64(memento_cell_capacity(&lock)))
                .lock(lock.clone())
                .type_(Some(memento_type).pack())
                .build(),
        )
        .output_data(pack_pbytes(&data))
        .build();
    expect_code(&mut w.context, &tx, MEMENTO_ERROR_DATA);
}

/// Isolated to the claim group: the memento's own script never inspects its
/// lock (only content decodability and the claim-consumption count), so a
/// stranger lock leaves the memento group passing. The claim's
/// `check_memento_outputs` explicitly requires the memento's lock to match
/// the retiring claim's own lock.
#[test]
fn a_memento_locked_to_a_stranger_is_refused() {
    let mut w = World::new(ACC_MMR);
    let round = sealed_round_with_entropy(&mut w, 4, 8);
    let (_, lock) = w.always_success();
    let (claim_op, args) = seed_paid_claim(&mut w, &lock, &round);
    let tx = retire_with_memento(&mut w, &round, &lock, claim_op, &args);

    let stranger = lock
        .clone()
        .as_builder()
        .args(pack_pbytes(b"stranger"))
        .build();
    let cell = tx.outputs().get(0).unwrap();
    let tx = tx
        .as_advanced_builder()
        .set_outputs(vec![cell.as_builder().lock(stranger).build()])
        .build();
    expect_code(&mut w.context, &tx, CLAIM_ERROR_RETIRE);
}

/// Isolated to the memento group: a tag-6 (memento) type script whose data is
/// the 81-byte `PrizeRedemptionState` shape fails `MementoData::decode`'s
/// length check immediately. No claim cell participates.
#[test]
fn a_memento_cannot_carry_claim_data() {
    let mut w = World::new(ACC_MMR);
    let round = sealed_round_with_entropy(&mut w, 4, 8);
    let (_, lock) = w.always_success();
    let (funding, _) = w.funding_cell(1_000 * SHANNONS);
    let memento_type = w.memento_type_script(round.winning_shard, round.winning_position);
    let claim_args = ClaimArgs {
        commitment: w.config_hash,
        shard_id: round.winning_shard,
        position: round.winning_position,
    };
    let bad_data = daowow_core::claim::initial_state_bytes(&claim_args);

    let tx = TransactionBuilder::default()
        .input(CellInput::new_builder().previous_output(funding).build())
        .output(
            CellOutputBuilder::default()
                .capacity(pack_u64(memento_cell_capacity(&lock)))
                .lock(lock.clone())
                .type_(Some(memento_type).pack())
                .build(),
        )
        .output_data(pack_pbytes(&bad_data))
        .build();
    expect_code(&mut w.context, &tx, MEMENTO_ERROR_DATA);
}

/// Isolated to the claim group: a live claim (tag-5) transfers to an output
/// of the same identity whose data is the 54-byte `MementoData` shape.
/// `PrizeRedemptionState::decode` requires exactly 81 bytes, so
/// `validate_transfer` fails structurally and the claim reports
/// `CLAIM_ERROR_DATA`. No memento type script appears anywhere in this
/// transaction.
#[test]
fn a_claim_cannot_carry_memento_data() {
    let mut w = World::new(ACC_MMR);
    let round = sealed_round_with_entropy(&mut w, 4, 8);
    let (_, lock) = w.always_success();
    let (claim_op, _args) = seed_claim(
        &mut w,
        &lock,
        round.non_winning_shard,
        round.non_winning_position,
    );
    let (cell, _) = w.cell(&claim_op);
    let bad_data = well_formed_memento_data(&round);

    let tx = TransactionBuilder::default()
        .input(CellInput::new_builder().previous_output(claim_op).build())
        .output(cell)
        .output_data(pack_pbytes(&bad_data))
        .build();
    expect_code(&mut w.context, &tx, CLAIM_ERROR_DATA);
}

/// Isolated to the claim group: a structurally valid `PrizeSchedule` whose
/// commitment does not match `cfg.prize_schedule_hash` fails
/// `decode_committed` inside `retire()`, before the winner/non-winner
/// decision or any memento check is reached. No memento cell is present.
#[test]
fn a_forged_schedule_witness_is_refused() {
    let mut w = World::new(ACC_MMR);
    let round = sealed_round_with_entropy(&mut w, 4, 8);
    let (_, lock) = w.always_success();
    let (claim_op, _args) = seed_paid_claim(&mut w, &lock, &round);
    let (out, out_data) = plain_output(&lock);

    let forged_schedule = PrizeSchedule::new(&[1, 1]).unwrap();
    assert_ne!(forged_schedule.commitment(), round.schedule.commitment());

    let tx = TransactionBuilder::default()
        .input(CellInput::new_builder().previous_output(claim_op).build())
        .output(out)
        .output_data(out_data)
        .cell_dep(round.config_dep.clone())
        .cell_dep(round.entropy_dep.clone())
        .witness(schedule_witness(&forged_schedule))
        .build();
    expect_code(&mut w.context, &tx, CLAIM_ERROR_UNIVERSE);
}

/// Isolated to the claim group: a genuine `EntropyRecord`, sealed under a
/// completely different round's config, is offered under THIS round's
/// entropy-record identity (matching args, so `entropy_record_dep` locates
/// it) but its own embedded round id belongs to the other round. The
/// resulting `config_by_commitment(this_commitment, other_round_id, ..)`
/// lookup can never succeed, since no cell dep in this transaction carries
/// that combination.
#[test]
fn an_entropy_record_of_another_round_is_refused() {
    let mut w = World::new(ACC_MMR);
    // A second, independent sealed round (different shard count => different
    // round id / config commitment), built and left behind before `round`.
    let other = sealed_round_with_entropy(&mut w, 2, 8);
    let round = sealed_round_with_entropy(&mut w, 4, 8);
    let (_, lock) = w.always_success();
    let (claim_op, _args) = seed_claim(
        &mut w,
        &lock,
        round.non_winning_shard,
        round.non_winning_position,
    );

    let (_, other_entropy_data) = w.cell(&other.entropy_dep.out_point());
    let public_lock = w.shard_public_lock();
    let shard_ref = w.deps.entry_shard_type;
    let mut entropy_args = w.config_hash.to_vec();
    entropy_args.extend_from_slice(&0u32.to_le_bytes());
    let entropy_type = w.script_for(&shard_ref, Bytes::from(entropy_args));
    let forged_op = w.context.create_cell(
        CellOutputBuilder::default()
            .capacity(pack_u64(60_000 * SHANNONS))
            .lock(public_lock)
            .type_(Some(entropy_type).pack())
            .build(),
        other_entropy_data,
    );
    let forged_dep = CellDepBuilder::default()
        .out_point(forged_op)
        .dep_type(pack_byte(DepType::Code as u8))
        .build();
    let (out, out_data) = plain_output(&lock);

    let tx = TransactionBuilder::default()
        .input(CellInput::new_builder().previous_output(claim_op).build())
        .output(out)
        .output_data(out_data)
        .cell_dep(round.config_dep.clone())
        .cell_dep(forged_dep)
        .witness(schedule_witness(&round.schedule))
        .build();
    expect_code(&mut w.context, &tx, CLAIM_ERROR_UNIVERSE);
}

// NOTE on the row left out of this suite:
//
// `two_mementos_for_one_retiring_claim_are_refused` (brief: winner, two
// identical memento outputs -> CLAIM_ERROR_RETIRE) cannot be isolated to one
// script group. Two memento OUTPUTS with byte-identical args are, by
// construction, the SAME type script and therefore ONE script group with two
// members. The memento binary's own group-size guard
// (`load_cell(1, Source::GroupOutput).is_ok()` in
// contracts/entry-shard-type/src/memento.rs::run) rejects any group with a
// second member unconditionally, with MEMENTO_ERROR_GROUP, before any
// content is even inspected. Separately, the claim's own
// `check_memento_outputs` also rejects the duplicate with CLAIM_ERROR_RETIRE
// (`found > 1`). Both rejections are real and independent, and which one CKB
// reports depends on the sort order of the two groups' script hashes — which
// depends on entry-shard-type's own code hash, i.e. on the exact contents of
// the deployed binary. That is exactly the instability this file's tests are
// built to avoid, so this row is intentionally left out rather than widened
// into an or-of-codes assertion.
