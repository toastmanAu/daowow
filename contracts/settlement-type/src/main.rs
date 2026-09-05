//! DAOWOWSettlementType — pays participants directly in bounded batches.
//!
//! args: type_id (8 bytes)
//! data: SettlementFundingDataV1 (fixed 128 bytes)
//!
//! Creation (from dao-lock phase 2): initial funding cell; cursor = zero
//! hash. Update: the witness carries a strictly cursor-ordered payout batch;
//! each payout is authorized by a membership proof of the liability leaf
//! against the funding cell's liabilities root, and the output must be an
//! ordinary cell (no type, empty data) locked by the participant's own
//! script with capacity = principal + prize + occupied capacity of the
//! output. Conservation: inputs = payouts + remaining funding + nothing else.

#![no_std]
#![no_main]

use ckb_std::ckb_constants::Source;
use daowow_contracts_common::daowow_alloc;
use ckb_std::entry;
use ckb_std::high_level::{load_cell, load_cell_capacity, load_cell_data, load_witness};
use daowow_core::accumulator::smt;
use daowow_core::encoding::{
    PayoutItem, SettlementFundingDataV1, SETTLEMENT_FUNDING_SIZE,
};
use daowow_core::error::codes::*;
use daowow_core::leaf::liability_leaf;

entry!(main);

fn err(e: i8) -> i8 {
    ckb_std::debug!("settlement-type error {}", e);
    e
}

fn main() -> i8 {
    let is_creation = load_cell(0, Source::GroupInput).is_err();
    if load_cell(1, Source::GroupOutput).is_ok() {
        return err(SETTLE_ERROR_CONSERVATION);
    }
    let out_data = match load_cell_data(0, Source::GroupOutput) {
        Ok(d) => d,
        Err(_) => return err(SETTLE_ERROR_DATA),
    };
    if out_data.len() != SETTLEMENT_FUNDING_SIZE {
        return err(SETTLE_ERROR_DATA);
    }
    let after = match SettlementFundingDataV1::decode(&out_data) {
        Ok(f) => f,
        Err(_) => return err(SETTLE_ERROR_DATA),
    };

    if is_creation {
        if after.payout_cursor != [0u8; 32] {
            return err(SETTLE_ERROR_CURSOR);
        }
        return 0;
    }

    if load_cell(1, Source::GroupInput).is_ok() {
        return err(SETTLE_ERROR_CONSERVATION);
    }
    let in_data = match load_cell_data(0, Source::GroupInput) {
        Ok(d) => d,
        Err(_) => return err(SETTLE_ERROR_DATA),
    };
    if in_data.len() != SETTLEMENT_FUNDING_SIZE {
        return err(SETTLE_ERROR_DATA);
    }
    let before = match SettlementFundingDataV1::decode(&in_data) {
        Ok(f) => f,
        Err(_) => return err(SETTLE_ERROR_DATA),
    };

    // immutable identity fields
    if before.round_id != after.round_id
        || before.batch_id != after.batch_id
        || before.realized_total != after.realized_total
        || before.principal_liability != after.principal_liability
        || before.prize_pool != after.prize_pool
        || before.liabilities_root != after.liabilities_root
    {
        return err(SETTLE_ERROR_ROUND_MISMATCH);
    }

    let witness_raw = match load_witness(0, Source::GroupInput) {
        Ok(w) => w,
        Err(_) => return err(SETTLE_ERROR_DATA),
    };
    let payouts = match daowow_core::witness::decode_settlement_witness(&witness_raw) {
        Ok(p) => p,
        Err(_) => return err(SETTLE_ERROR_DATA),
    };
    if payouts.is_empty() {
        return err(SETTLE_ERROR_DATA);
    }

    // in_cap = payout outputs + new funding capacity
    let in_cap = match load_cell_capacity(0, Source::GroupInput) {
        Ok(c) => c,
        Err(_) => return err(SETTLE_ERROR_CONSERVATION),
    };
    let new_funding_cap = match load_cell_capacity(0, Source::GroupOutput) {
        Ok(c) => c,
        Err(_) => return err(SETTLE_ERROR_CONSERVATION),
    };

    // find the group output base: outputs of this group are appended after
    // all other outputs? No: payout outputs are ordinary cells and thus NOT
    // in this type group; they must be located by lock script equality in
    // the full output list, in witness order after the funding cell. The
    // funding cell itself stays in place (same absolute output index as the
    // input funding cell). Payout outputs may be anywhere; we identify them
    // by exact script hash match, in ascending order.
    let mut cursor = before.payout_cursor;
    let mut sum_payouts: u64 = 0;
    let mut prev_key: Option<[u8; 32]> = Some(cursor);
    for p in &payouts {
        let item = &p.item;
        // strict ordering by participant_lock_hash (no repeats)
        if item.participant_lock_hash <= prev_key.unwrap_or([0xff; 32]) {
            return err(SETTLE_ERROR_DUPLICATE);
        }
        prev_key = Some(item.participant_lock_hash);

        // liability proof against the funding root
        let leaf = liability_leaf(&item.participant_lock_hash, item.principal, item.prize);
        let key = item.participant_lock_hash;
        if smt::verify_membership(&before.liabilities_root, &key, &leaf, p.proof).is_err() {
            return err(SETTLE_ERROR_PROOF);
        }

        // locate the participant output: exact lock script match
        let mut found_cap: Option<u64> = None;
        let mut i = 0usize;
        loop {
            let cell = match load_cell(i, Source::Output) {
                Ok(c) => c,
                Err(_) => break,
            };
            let lock = cell.lock();
            let script_hash: [u8; 32] = lock.calc_script_hash().into();
            if script_hash == item.participant_lock_hash {
                // verify the script bytes match the witness declaration
                let code: [u8; 32] = lock.code_hash().into();
                if code != p.lock_code_hash
                    || u8::from(lock.hash_type()) != p.lock_hash_type
                    || lock.args().raw_data().as_ref() != p.lock_args
                {
                    return err(SETTLE_ERROR_PROOF);
                }
                // ordinary cell: no type, empty data
                if cell.type_().to_opt().is_none() {
                    let cap = match load_cell_capacity(i, Source::Output) {
                        Ok(c) => c,
                        Err(_) => return err(SETTLE_ERROR_CONSERVATION),
                    };
                    // occupied capacity = 8 (capacity) + 0 (data) + (33 + args)
                    let occupied = 8 + 33 + lock.args().raw_data().len() as u64;
                    let expected = item
                        .principal
                        .checked_add(item.prize)
                        .and_then(|v| v.checked_add(occupied))
                        .ok_or(SETTLE_ERROR_CONSERVATION);
                    match expected {
                        Ok(v) if cap == v => found_cap = Some(cap),
                        _ => return err(SETTLE_ERROR_CONSERVATION),
                    }
                } else {
                    return err(SETTLE_ERROR_CONSERVATION);
                }
                break;
            }
            i += 1;
        }
        match found_cap {
            Some(cap) => {
                sum_payouts = match sum_payouts.checked_add(cap) {
                    Some(s) => s,
                    None => return err(SETTLE_ERROR_CONSERVATION),
                };
            }
            None => return err(SETTLE_ERROR_PROOF),
        }
        cursor = item.participant_lock_hash;
    }

    // conservation: funding capacity must exactly cover payouts + remainder
    let expected_in = match sum_payouts.checked_add(new_funding_cap) {
        Some(v) => v,
        None => return err(SETTLE_ERROR_CONSERVATION),
    };
    if expected_in != in_cap {
        return err(SETTLE_ERROR_CONSERVATION);
    }
    let _ = cursor;
    let _ = PayoutItem { participant_lock_hash: [0; 32], principal: 0, prize: 0 };
    0
}

daowow_alloc!();
