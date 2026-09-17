//! Claim mode of the shard binary: args `[5] || commitment || shard_id || position`.
//!
//! Mint delegates counting to the OPEN shard transition of the same identity,
//! which must be present as input and output. Transfer keeps data identical.
//! A data change is a redemption: one settlement funding cell of this round
//! transitions in the same transaction and names this claim in its redemption
//! witness; the output state is exactly the input with that source recorded.
//! Burn (retirement) is authenticated against the sealed round: nothing may
//! still be owed.

use alloc::vec::Vec;

use ckb_std::ckb_constants::Source;
use ckb_std::ckb_types::packed::Script;
use ckb_std::ckb_types::prelude::*;
use ckb_std::high_level::{load_cell, load_cell_data};
use daowow_core::claim::{initial_state_bytes, validate_transfer, ClaimArgs};
use daowow_core::encoding::{SettlementFundingDataV3, SETTLEMENT_FUNDING_SIZE, SHARD_DATA_SIZE};
use daowow_core::error::codes::*;
use daowow_core::redemption::{prize_source, PrizeRedemptionState};
use daowow_core::CoreError;

fn err(e: i8) -> Result<i8, i8> {
    ckb_std::debug!("claim error {}", e);
    Err(e)
}

/// Data length without allocating the whole cell data.
fn data_len(index: usize, source: Source) -> Option<usize> {
    let mut probe = [0u8; 1];
    match ckb_std::syscalls::load_cell_data(&mut probe, 0, index, source) {
        Ok(size) | Err(ckb_std::error::SysError::LengthNotEnough(size)) => Some(size),
        Err(_) => None,
    }
}

/// True when `source` holds an OPEN/FROZEN shard cell of this binary whose
/// args are exactly `commitment || shard_id`.
fn shard_present(script: &Script, args: &ClaimArgs, source: Source) -> bool {
    let mut expect = [0u8; 36];
    expect[..32].copy_from_slice(&args.commitment);
    expect[32..].copy_from_slice(&args.shard_id.to_le_bytes());
    let mut i = 0;
    while let Ok(cell) = load_cell(i, source) {
        if let Some(t) = cell.type_().to_opt() {
            if t.code_hash() == script.code_hash()
                && t.hash_type() == script.hash_type()
                && t.args().raw_data().as_ref() == expect
                && data_len(i, source) == Some(SHARD_DATA_SIZE)
            {
                return true;
            }
        }
        i += 1;
    }
    false
}

pub fn run(script: &Script) -> Result<i8, i8> {
    let args = match ClaimArgs::decode(script.args().raw_data().as_ref()) {
        Ok(a) => a,
        Err(_) => return err(CLAIM_ERROR_ARGS),
    };
    if load_cell(1, Source::GroupInput).is_ok() || load_cell(1, Source::GroupOutput).is_ok() {
        return err(CLAIM_ERROR_GROUP);
    }
    let has_input = load_cell(0, Source::GroupInput).is_ok();
    let output = load_cell_data(0, Source::GroupOutput).ok();
    match (has_input, output) {
        (false, Some(data)) => {
            if !shard_present(script, &args, Source::Input)
                || !shard_present(script, &args, Source::Output)
            {
                return err(CLAIM_ERROR_MINT);
            }
            if data.as_ref() != initial_state_bytes(&args) {
                return err(CLAIM_ERROR_DATA);
            }
            Ok(0)
        }
        (true, Some(data)) => {
            let input = match load_cell_data(0, Source::GroupInput) {
                Ok(d) => d,
                Err(_) => return err(CLAIM_ERROR_DATA),
            };
            match validate_transfer(&args, &input, &data) {
                Ok(()) => Ok(0),
                Err(CoreError::StateTransition) => redeem(script, &args, &input, &data),
                Err(_) => err(CLAIM_ERROR_DATA),
            }
        }
        (true, None) => {
            let input = match load_cell_data(0, Source::GroupInput) {
                Ok(d) => d,
                Err(_) => return err(CLAIM_ERROR_DATA),
            };
            retire(script, &args, &input)
        }
        (false, None) => err(CLAIM_ERROR_GROUP),
    }
}

/// Data changed: this must be an authenticated redemption. The funding cell
/// of one batch transitions in this transaction, its redemption witness names
/// this claim, and the output state is exactly the input state with that
/// source's prize recorded. Lock must not change.
fn redeem(script: &Script, args: &ClaimArgs, input: &[u8], output: &[u8]) -> Result<i8, i8> {
    let in_lock = load_cell(0, Source::GroupInput)
        .map_err(|_| CLAIM_ERROR_DATA)?
        .lock();
    let out_lock = load_cell(0, Source::GroupOutput)
        .map_err(|_| CLAIM_ERROR_DATA)?
        .lock();
    if in_lock.as_slice() != out_lock.as_slice() {
        return err(CLAIM_ERROR_TRANSITION);
    }
    // exactly one settlement funding input of this commitment, and our own index
    let mut funding: Option<(usize, [u8; 72])> = None;
    let mut own_index: Option<usize> = None;
    let mut i = 0usize;
    while let Ok(cell) = load_cell(i, Source::Input) {
        if let Some(t) = cell.type_().to_opt() {
            let a = t.args().raw_data();
            if t.as_slice() == script.as_slice() {
                if own_index.replace(i).is_some() {
                    return err(CLAIM_ERROR_GROUP);
                }
            } else if a.len() == 72 && a[..32] == args.commitment {
                if funding.is_some() {
                    return err(CLAIM_ERROR_REDEEM);
                }
                let mut fixed = [0u8; 72];
                fixed.copy_from_slice(&a);
                funding = Some((i, fixed));
            }
        }
        i += 1;
    }
    let (Some((funding_index, funding_args)), Some(own_index)) = (funding, own_index) else {
        return err(CLAIM_ERROR_REDEEM);
    };
    let funding_data =
        load_cell_data(funding_index, Source::Input).map_err(|_| CLAIM_ERROR_REDEEM)?;
    if funding_data.len() != SETTLEMENT_FUNDING_SIZE {
        return err(CLAIM_ERROR_REDEEM);
    }
    let funding_state =
        SettlementFundingDataV3::decode(&funding_data).map_err(|_| CLAIM_ERROR_REDEEM)?;
    let Some(cfg) = daowow_contracts_common::config_by_commitment(
        &args.commitment,
        &funding_state.round_id,
        Source::CellDep,
    ) else {
        return err(CLAIM_ERROR_REDEEM);
    };
    let funding_type = load_cell(funding_index, Source::Input)
        .map_err(|_| CLAIM_ERROR_REDEEM)?
        .type_()
        .to_opt()
        .ok_or(CLAIM_ERROR_REDEEM)?;
    if !daowow_contracts_common::script_matches(&funding_type, &cfg.settlement_type)
        || !daowow_contracts_common::script_matches(script, &cfg.entry_shard_type)
    {
        return err(CLAIM_ERROR_REDEEM);
    }
    let witness = ckb_std::high_level::load_witness(funding_index, Source::Input)
        .map_err(|_| CLAIM_ERROR_REDEEM)?;
    let items = daowow_core::witness::decode_redemption_witness(&witness)
        .map_err(|_| CLAIM_ERROR_REDEEM)?;
    let mut mine = None;
    for item in &items {
        if item.claim_input_index as usize == own_index {
            if mine.is_some() {
                return err(CLAIM_ERROR_REDEEM);
            }
            mine = Some(*item);
        }
    }
    let Some(item) = mine else {
        return err(CLAIM_ERROR_REDEEM);
    };
    let batch_id = u64::from_le_bytes(funding_args[32..40].try_into().unwrap());
    let digest: [u8; 32] = funding_args[40..72].try_into().unwrap();
    let source = prize_source(&args.commitment, batch_id, &digest);
    let before = PrizeRedemptionState::decode(input).map_err(|_| CLAIM_ERROR_DATA)?;
    let expected = before
        .record_verified_prize(&source, item.amount, item.absence_proof)
        .map_err(|_| CLAIM_ERROR_REDEEM)?;
    if output != expected.encode() {
        return err(CLAIM_ERROR_REDEEM);
    }
    Ok(0)
}

/// Locate the canonical entropy record of this round among the cell deps: a
/// cell of this binary with args `commitment || 0u32` whose data is a version-4
/// record. Returns its bytes and the round id the seal's first frozen snapshot
/// carries at bytes 7..39 (the seal puts it at 6..38; the record's tag shifts
/// it by one).
fn entropy_record_dep(script: &Script, args: &ClaimArgs) -> Result<(Vec<u8>, [u8; 32]), i8> {
    let mut expect = [0u8; 36];
    expect[..32].copy_from_slice(&args.commitment);
    let mut i = 0usize;
    while let Ok(cell) = load_cell(i, Source::CellDep) {
        if let Some(t) = cell.type_().to_opt() {
            if t.code_hash() == script.code_hash()
                && t.hash_type() == script.hash_type()
                && t.args().raw_data().as_ref() == expect
            {
                if let Ok(data) = load_cell_data(i, Source::CellDep) {
                    if data.first() == Some(&4) && data.len() > 39 {
                        let round: [u8; 32] =
                            data[7..39].try_into().map_err(|_| CLAIM_ERROR_UNIVERSE)?;
                        return Ok((data, round));
                    }
                }
            }
        }
        i += 1;
    }
    Err(CLAIM_ERROR_UNIVERSE)
}

/// Consume the claim with no successor. Authenticates the sealed round from
/// cell deps, derives the draw, and requires the paid-source count to equal the
/// obligation universe for a winner or zero for a non-winner. A winner must
/// issue exactly one memento of this identity; a non-winner none.
fn retire(script: &Script, args: &ClaimArgs, input: &[u8]) -> Result<i8, i8> {
    let state = PrizeRedemptionState::decode(input).map_err(|_| CLAIM_ERROR_DATA)?;
    let (record_bytes, round_id) = entropy_record_dep(script, args)?;
    let cfg =
        daowow_contracts_common::config_by_commitment(&args.commitment, &round_id, Source::CellDep)
            .ok_or(CLAIM_ERROR_UNIVERSE)?;
    let record = daowow_core::seal::EntropyRecord::decode(&record_bytes, &cfg)
        .map_err(|_| CLAIM_ERROR_UNIVERSE)?;
    let witness = ckb_std::high_level::load_witness(0, Source::GroupInput)
        .map_err(|_| CLAIM_ERROR_UNIVERSE)?;
    // Deliberately redundant with `ComputedDraw::new`'s own
    // `schedule.commitment() != cfg.prize_schedule_hash` check a few lines
    // below: the schedule is the one input the retiring holder supplies
    // directly (via this witness), so this call asserts the contract's own
    // precondition on it rather than depending on `ComputedDraw::new`
    // continuing to re-derive and check that same commitment internally. No
    // test can distinguish this call from a plain `decode` at this call
    // site, because `ComputedDraw::new` already refuses a mismatched
    // schedule on its own — that is expected, not a gap.
    let schedule =
        daowow_core::schedule::PrizeSchedule::decode_committed(&witness, &cfg.prize_schedule_hash)
            .map_err(|_| CLAIM_ERROR_UNIVERSE)?;
    let draw = daowow_core::computed_draw::ComputedDraw::new(&cfg, &record, &schedule)
        .map_err(|_| CLAIM_ERROR_UNIVERSE)?;
    let universe = record
        .seal()
        .total_accepted_batches()
        .map_err(|_| CLAIM_ERROR_UNIVERSE)?;
    let decision = match daowow_core::claim::retire_decision(args, &state, &draw, universe) {
        Ok(d) => d,
        Err(daowow_core::CoreError::StateTransition) => return err(CLAIM_ERROR_INCOMPLETE),
        Err(_) => return err(CLAIM_ERROR_DATA),
    };
    let expected_index = match decision {
        daowow_core::claim::RetireDecision::NonWinner => None,
        daowow_core::claim::RetireDecision::Winner { prize_index } => Some(prize_index),
    };
    check_memento_outputs(script, args, &state, expected_index)
}

/// Exactly one memento output of this identity for a winner, none otherwise.
/// The memento script only asserts that it stands beside a retiring claim; all
/// of its content is authenticated here, where the draw is already in hand.
fn check_memento_outputs(
    script: &Script,
    args: &ClaimArgs,
    state: &PrizeRedemptionState,
    expected_index: Option<u32>,
) -> Result<i8, i8> {
    let expect_args = daowow_core::memento::MementoArgs {
        commitment: args.commitment,
        shard_id: args.shard_id,
        position: args.position,
    }
    .encode();
    let in_lock = load_cell(0, Source::GroupInput)
        .map_err(|_| CLAIM_ERROR_DATA)?
        .lock();
    let mut found = 0usize;
    let mut i = 0usize;
    while let Ok(cell) = load_cell(i, Source::Output) {
        if let Some(t) = cell.type_().to_opt() {
            if t.code_hash() == script.code_hash()
                && t.hash_type() == script.hash_type()
                && t.args().raw_data().as_ref() == expect_args
            {
                found += 1;
                if found > 1 {
                    return err(CLAIM_ERROR_RETIRE);
                }
                let Some(prize_index) = expected_index else {
                    return err(CLAIM_ERROR_RETIRE);
                };
                if cell.lock().as_slice() != in_lock.as_slice() {
                    return err(CLAIM_ERROR_RETIRE);
                }
                let expected = daowow_core::memento::MementoData {
                    renderer_version: daowow_core::memento::MEMENTO_RENDERER_V1,
                    prize_index,
                    paid_count: state.paid_count(),
                    paid_total: state.paid_total(),
                }
                .encode();
                let data = load_cell_data(i, Source::Output).map_err(|_| CLAIM_ERROR_RETIRE)?;
                if data.as_ref() != expected {
                    return err(CLAIM_ERROR_RETIRE);
                }
            }
        }
        i += 1;
    }
    if expected_index.is_some() && found != 1 {
        return err(CLAIM_ERROR_RETIRE);
    }
    Ok(0)
}
