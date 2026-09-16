//! DAOWOWSettlementType — pays participants directly in bounded batches.
//!
//! args: config commitment (32 bytes) || batch_id (8 bytes) || batch digest (32)
//! Public lock mode: args = [0]; authorises spending only when the matching
//! seventy-two-byte-args settlement type executes and enforces the payout rules.
//! data: SettlementFundingDataV3 (fixed 160 bytes)
//!
//! Redemption (witness tagged 0xFF): claim cells of this round redeem their
//! committed prizes; each amount is proven in the immutable prize tree, paid
//! to the claim's current lock, and the claim's successor must exist. The
//! cell may be drained only once principal and prizes are both complete.
//!
//! Creation (from dao-lock phase 2): cursor = zero, positive liability count.
//! Update: each MMR proof authenticates the next unpaid ordinal against the
//! immutable liability root/count. The numeric cursor advances exactly once
//! per paid item. Final consumption requires every index paid. The output is an
//! ordinary cell (no type, empty data) locked by the participant's own
//! script with capacity >= principal + prize and >= occupied capacity.
//! Principal already includes full deposited capacity. Sponsors may gift extra
//! output capacity and pay fees; funding pays exactly the authenticated amount
//! owed, with no sponsor repayment or funding top-ups.

#![no_std]
#![no_main]

use ckb_std::ckb_constants::Source;
use ckb_std::ckb_types::prelude::*;
use ckb_std::entry;
use ckb_std::high_level::{load_cell, load_cell_capacity, load_cell_data, load_witness};
use daowow_contracts_common::daowow_alloc;
use daowow_core::accumulator::mmr;
use daowow_core::encoding::{PayoutItem, SettlementFundingDataV3, SETTLEMENT_FUNDING_SIZE};
use daowow_core::error::codes::*;
use daowow_core::leaf::liability_leaf;

entry!(main);

fn err(e: i8) -> i8 {
    ckb_std::debug!("settlement-type error {}", e);
    e
}

fn main() -> i8 {
    // A payout output must not discharge liabilities in two funding groups.
    // Batches remain parallelizable as separate transactions; within one
    // transaction only one group of this settlement implementation may spend.
    let script = match ckb_std::high_level::load_script() {
        Ok(s) => s,
        Err(_) => return err(SETTLE_ERROR_DATA),
    };
    if script.args().raw_data().as_ref() == [0] {
        return public_lock(&script);
    }
    let args = script.args().raw_data();
    if args.len() != 72 {
        return err(SETTLE_ERROR_DATA);
    }
    let mut index = 0;
    while let Ok(cell) = load_cell(index, Source::Input) {
        if let Some(other) = cell.type_().to_opt() {
            if other.code_hash() == script.code_hash()
                && other.hash_type() == script.hash_type()
                && other != script
            {
                return err(SETTLE_ERROR_CONSERVATION);
            }
        }
        index += 1;
    }
    let is_creation = load_cell(0, Source::GroupInput).is_err();
    if load_cell(1, Source::GroupOutput).is_ok() {
        return err(SETTLE_ERROR_CONSERVATION);
    }
    let is_final = match load_cell(0, Source::GroupOutput) {
        Ok(_) => false,
        Err(ckb_std::error::SysError::IndexOutOfBound) => true,
        Err(_) => return err(SETTLE_ERROR_DATA),
    };
    if is_creation && is_final {
        return err(SETTLE_ERROR_DATA);
    }
    // No remainder is allowed only when conservation below accounts for
    // every input Shannon in authenticated participant payouts.
    let state_source = if is_final {
        Source::GroupInput
    } else {
        Source::GroupOutput
    };
    let out_data = match load_cell_data(0, state_source) {
        Ok(d) => d,
        Err(_) => return err(SETTLE_ERROR_DATA),
    };
    if out_data.len() != SETTLEMENT_FUNDING_SIZE {
        return err(SETTLE_ERROR_DATA);
    }
    let after = match SettlementFundingDataV3::decode(&out_data) {
        Ok(f) => f,
        Err(_) => return err(SETTLE_ERROR_DATA),
    };
    if args[32..40] != after.batch_id.to_le_bytes() {
        return err(SETTLE_ERROR_ROUND_MISMATCH);
    }
    let funding_cell = match load_cell(0, state_source) {
        Ok(cell) => cell,
        Err(_) => return err(SETTLE_ERROR_DATA),
    };
    if !daowow_contracts_common::is_public_settlement_lock(&funding_cell.lock(), &script) {
        return err(SETTLE_ERROR_CONSERVATION);
    }

    if is_creation {
        if after.payout_cursor != 0 {
            return err(SETTLE_ERROR_CURSOR);
        }
        let commitment: [u8; 32] = args[..32].try_into().unwrap();
        let digest: [u8; 32] = args[40..72].try_into().unwrap();
        let Some(cfg) = daowow_contracts_common::config_by_commitment(
            &commitment,
            &after.round_id,
            Source::CellDep,
        ) else {
            return err(SETTLE_ERROR_DATA);
        };
        if !daowow_contracts_common::script_matches(&script, &cfg.settlement_type)
            || daowow_contracts_common::entitlements::validate_initial_funding(
                &cfg,
                after.batch_id,
                &digest,
            )
            .is_none()
        {
            return err(SETTLE_ERROR_CONSERVATION);
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
    let before = match SettlementFundingDataV3::decode(&in_data) {
        Ok(f) => f,
        Err(_) => return err(SETTLE_ERROR_DATA),
    };

    // The immutable count and root authenticate positions; only the next
    // unpaid ordinal advances, so a keeper cannot skip an unpaid liability.
    if before.round_id != after.round_id
        || before.batch_id != after.batch_id
        || before.realized_total != after.realized_total
        || before.principal_liability != after.principal_liability
        || before.prize_pool != after.prize_pool
        || before.liabilities_root != after.liabilities_root
        || before.liability_count != after.liability_count
        || before.prize_count != after.prize_count
        || before.prize_root != after.prize_root
    {
        return err(SETTLE_ERROR_ROUND_MISMATCH);
    }

    let witness_raw = match load_witness(0, Source::GroupInput) {
        Ok(w) => w,
        Err(_) => return err(SETTLE_ERROR_DATA),
    };
    if daowow_core::witness::is_redemption_witness(&witness_raw) {
        let after_ref = if is_final { None } else { Some(&after) };
        return redeem(&script, &args, &before, after_ref, is_final, &witness_raw);
    }
    let payouts = match daowow_core::witness::decode_settlement_witness(&witness_raw) {
        Ok(p) => p,
        Err(_) => return err(SETTLE_ERROR_DATA),
    };
    if payouts.is_empty() {
        return err(SETTLE_ERROR_DATA);
    }

    // in_cap = authenticated amounts owed + new funding capacity
    let in_cap = match load_cell_capacity(0, Source::GroupInput) {
        Ok(c) => c,
        Err(_) => return err(SETTLE_ERROR_CONSERVATION),
    };
    let new_funding_cap = if is_final {
        0
    } else {
        match load_cell_capacity(0, Source::GroupOutput) {
            Ok(c) => c,
            Err(_) => return err(SETTLE_ERROR_CONSERVATION),
        }
    };
    if !is_final
        && load_cell(0, Source::GroupInput).unwrap().lock()
            != load_cell(0, Source::GroupOutput).unwrap().lock()
    {
        return err(SETTLE_ERROR_CONSERVATION);
    }
    if !is_final {
        let occupied =
            match ckb_std::high_level::load_cell_occupied_capacity(0, Source::GroupOutput) {
                Ok(capacity) => capacity,
                Err(_) => return err(SETTLE_ERROR_CONSERVATION),
            };
        if new_funding_cap < occupied {
            return err(SETTLE_ERROR_CONSERVATION);
        }
    }

    // Payout outputs may be anywhere in the transaction. Locate each by exact
    // participant script hash; membership binds its liability to cursor.
    let mut cursor = before.payout_cursor;
    let mut sum_payouts: u64 = 0;
    let mut prev_key: Option<[u8; 32]> = None;
    for p in &payouts {
        let item = &p.item;
        // strict ordering by participant_lock_hash (no repeats)
        if prev_key.is_some_and(|previous| item.participant_lock_hash <= previous) {
            return err(SETTLE_ERROR_DUPLICATE);
        }
        prev_key = Some(item.participant_lock_hash);

        // Proof must authenticate exactly the next unpaid position, not a
        // keeper-selected key. MMR verification binds path/peak to count/index.
        let leaf = liability_leaf(&item.participant_lock_hash, item.principal, item.prize);
        if mmr::verify_membership(
            &before.liabilities_root,
            before.liability_count,
            cursor,
            &leaf,
            p.proof,
        )
        .is_err()
        {
            return err(SETTLE_ERROR_PROOF);
        }

        // locate the participant output: exact lock script match
        let mut found_cap: Option<u64> = None;
        let mut i = 0usize;
        loop {
            // Hash-only scanning is allocation-free. Loading each full output
            // for every liability exhausts the monotonic heap on final tails.
            let script_hash = match ckb_std::high_level::load_cell_lock_hash(i, Source::Output) {
                Ok(hash) => hash,
                Err(ckb_std::error::SysError::IndexOutOfBound) => break,
                Err(_) => return err(SETTLE_ERROR_DATA),
            };
            if script_hash == item.participant_lock_hash {
                let cell = match load_cell(i, Source::Output) {
                    Ok(cell) => cell,
                    Err(_) => return err(SETTLE_ERROR_DATA),
                };
                let lock = cell.lock();
                // verify the script bytes match the witness declaration
                let code: [u8; 32] = lock.code_hash().into();
                if code != p.lock_code_hash
                    || u8::from(lock.hash_type()) != p.lock_hash_type
                    || lock.args().raw_data().as_ref() != p.lock_args
                {
                    return err(SETTLE_ERROR_PROOF);
                }
                // ordinary cell: no type, empty data
                if cell.type_().to_opt().is_none()
                    && matches!(load_cell_data(i, Source::Output), Ok(d) if d.is_empty())
                {
                    let cap = match load_cell_capacity(i, Source::Output) {
                        Ok(c) => c,
                        Err(_) => return err(SETTLE_ERROR_CONSERVATION),
                    };
                    // occupied capacity = 8 (capacity) + 0 (data) + (33 + args)
                    let occupied =
                        match ckb_std::high_level::load_cell_occupied_capacity(i, Source::Output) {
                            Ok(c) => c,
                            Err(_) => return err(SETTLE_ERROR_CONSERVATION),
                        };
                    let expected = item
                        .principal
                        .checked_add(item.prize)
                        .ok_or(SETTLE_ERROR_CONSERVATION);
                    match expected {
                        // Any excess comes from sponsors, never this funding
                        // cell. Track only the authenticated liability below.
                        Ok(v) if cap >= v && cap >= occupied => found_cap = Some(v),
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
        cursor = match cursor.checked_add(1) {
            Some(next) => next,
            None => return err(SETTLE_ERROR_CURSOR),
        };
    }

    // Conservation excludes sponsor gifts: funding covers owed + remainder.
    let expected_in = match sum_payouts.checked_add(new_funding_cap) {
        Some(v) => v,
        None => return err(SETTLE_ERROR_CONSERVATION),
    };
    if expected_in != in_cap {
        return err(SETTLE_ERROR_CONSERVATION);
    }
    if !is_final && (after.payout_cursor != cursor || after.prize_paid != before.prize_paid) {
        return err(SETTLE_ERROR_CURSOR);
    }
    // Prizes are redeemed by claims, not paid here. While any prize is
    // outstanding the cell stays open even after the last principal payout;
    // it may be drained only once principal and prizes are both complete.
    let prizes_outstanding = before.prize_count != 0 && before.prize_paid != before.prize_pool;
    if cursor > before.liability_count {
        return err(SETTLE_ERROR_CURSOR);
    }
    if is_final {
        if cursor != before.liability_count {
            return err(SETTLE_ERROR_CURSOR);
        }
        if prizes_outstanding {
            return err(SETTLE_ERROR_REDEEM);
        }
    } else if cursor == before.liability_count && !prizes_outstanding {
        return err(SETTLE_ERROR_CURSOR);
    }
    let _ = PayoutItem {
        participant_lock_hash: [0; 32],
        principal: 0,
        prize: 0,
    };
    0
}

/// Redemption mode: claims of this round redeem their committed prizes from
/// this batch. Each item is authenticated against the immutable prize tree,
/// paid to the claim's current lock, and requires the claim's successor to
/// exist; the claim script separately proves its paid-set transition.
fn redeem(
    script: &ckb_std::ckb_types::packed::Script,
    args: &[u8],
    before: &SettlementFundingDataV3,
    after: Option<&SettlementFundingDataV3>,
    is_final: bool,
    witness_raw: &[u8],
) -> i8 {
    use daowow_core::claim::{ClaimArgs, CLAIM_ARGS_SIZE, CLAIM_TAG};
    if before.prize_count == 0 {
        return err(SETTLE_ERROR_REDEEM);
    }
    let items = match daowow_core::witness::decode_redemption_witness(witness_raw) {
        Ok(i) => i,
        Err(_) => return err(SETTLE_ERROR_DATA),
    };
    let commitment: [u8; 32] = args[..32].try_into().unwrap();
    let Some(cfg) = daowow_contracts_common::config_by_commitment(
        &commitment,
        &before.round_id,
        Source::CellDep,
    ) else {
        return err(SETTLE_ERROR_DATA);
    };
    if !daowow_contracts_common::script_matches(script, &cfg.settlement_type) {
        return err(SETTLE_ERROR_DATA);
    }
    let in_cap = match load_cell_capacity(0, Source::GroupInput) {
        Ok(c) => c,
        Err(_) => return err(SETTLE_ERROR_CONSERVATION),
    };
    let new_funding_cap = if is_final {
        0
    } else {
        match load_cell_capacity(0, Source::GroupOutput) {
            Ok(c) => c,
            Err(_) => return err(SETTLE_ERROR_CONSERVATION),
        }
    };
    if !is_final {
        if load_cell(0, Source::GroupInput).unwrap().lock()
            != load_cell(0, Source::GroupOutput).unwrap().lock()
        {
            return err(SETTLE_ERROR_CONSERVATION);
        }
        let occupied =
            match ckb_std::high_level::load_cell_occupied_capacity(0, Source::GroupOutput) {
                Ok(c) => c,
                Err(_) => return err(SETTLE_ERROR_CONSERVATION),
            };
        if new_funding_cap < occupied {
            return err(SETTLE_ERROR_CONSERVATION);
        }
    }
    let mut paid: u64 = 0;
    let mut prev_prize: Option<u64> = None;
    let mut used_claims: alloc::vec::Vec<u32> = alloc::vec::Vec::new();
    let mut used_payments: alloc::vec::Vec<u32> = alloc::vec::Vec::new();
    for item in &items {
        if prev_prize.is_some_and(|p| item.prize_index <= p)
            || used_claims.contains(&item.claim_input_index)
            || used_payments.contains(&item.payment_output_index)
            || item.amount == 0
        {
            return err(SETTLE_ERROR_REDEEM);
        }
        prev_prize = Some(item.prize_index);
        used_claims.push(item.claim_input_index);
        used_payments.push(item.payment_output_index);
        // the claim input: canonical claim type of this round
        let claim = match load_cell(item.claim_input_index as usize, Source::Input) {
            Ok(c) => c,
            Err(_) => return err(SETTLE_ERROR_REDEEM),
        };
        let Some(claim_type) = claim.type_().to_opt() else {
            return err(SETTLE_ERROR_REDEEM);
        };
        let claim_args = claim_type.args().raw_data();
        if !daowow_contracts_common::script_matches(&claim_type, &cfg.entry_shard_type)
            || claim_args.len() != CLAIM_ARGS_SIZE
            || claim_args[0] != CLAIM_TAG
            || claim_args[1..33] != commitment
        {
            return err(SETTLE_ERROR_REDEEM);
        }
        let ticket = match ClaimArgs::decode(&claim_args) {
            Ok(a) => a.ticket_id(),
            Err(_) => return err(SETTLE_ERROR_REDEEM),
        };
        if mmr::verify_membership(
            &before.prize_root,
            before.prize_count,
            item.prize_index,
            &daowow_core::leaf::prize_leaf(&ticket, item.amount),
            item.mmr_proof,
        )
        .is_err()
        {
            return err(SETTLE_ERROR_PROOF);
        }
        // successor claim with the identical type script must exist
        let mut successor = false;
        let mut i = 0usize;
        while let Ok(cell) = load_cell(i, Source::Output) {
            if cell
                .type_()
                .to_opt()
                .is_some_and(|t| t.as_slice() == claim_type.as_slice())
            {
                successor = true;
                break;
            }
            i += 1;
        }
        if !successor {
            return err(SETTLE_ERROR_REDEEM);
        }
        // payment: ordinary cell under the claim's current lock
        let payment = match load_cell(item.payment_output_index as usize, Source::Output) {
            Ok(c) => c,
            Err(_) => return err(SETTLE_ERROR_REDEEM),
        };
        if payment.lock().as_slice() != claim.lock().as_slice()
            || payment.type_().to_opt().is_some()
            || !matches!(
                load_cell_data(item.payment_output_index as usize, Source::Output),
                Ok(d) if d.is_empty()
            )
        {
            return err(SETTLE_ERROR_REDEEM);
        }
        let cap = match load_cell_capacity(item.payment_output_index as usize, Source::Output) {
            Ok(c) => c,
            Err(_) => return err(SETTLE_ERROR_CONSERVATION),
        };
        let occupied = match ckb_std::high_level::load_cell_occupied_capacity(
            item.payment_output_index as usize,
            Source::Output,
        ) {
            Ok(c) => c,
            Err(_) => return err(SETTLE_ERROR_CONSERVATION),
        };
        if cap < item.amount || cap < occupied {
            return err(SETTLE_ERROR_CONSERVATION);
        }
        paid = match paid.checked_add(item.amount) {
            Some(p) => p,
            None => return err(SETTLE_ERROR_CONSERVATION),
        };
    }
    let prize_paid = match before.prize_paid.checked_add(paid) {
        Some(p) if p <= before.prize_pool => p,
        _ => return err(SETTLE_ERROR_REDEEM),
    };
    match after {
        Some(after) => {
            if after.payout_cursor != before.payout_cursor || after.prize_paid != prize_paid {
                return err(SETTLE_ERROR_REDEEM);
            }
        }
        None => {
            if before.payout_cursor != before.liability_count || prize_paid != before.prize_pool {
                return err(SETTLE_ERROR_REDEEM);
            }
        }
    }
    match paid.checked_add(new_funding_cap) {
        Some(expected) if expected == in_cap => 0,
        _ => err(SETTLE_ERROR_CONSERVATION),
    }
}

fn public_lock(script: &ckb_std::ckb_types::packed::Script) -> i8 {
    let mut count = 0;
    loop {
        let cell = match load_cell(count, Source::GroupInput) {
            Ok(cell) => cell,
            Err(ckb_std::error::SysError::IndexOutOfBound) => break,
            Err(_) => return err(SETTLE_ERROR_CONSERVATION),
        };
        let settlement_type = match cell.type_().to_opt() {
            Some(t) => t,
            None => return err(SETTLE_ERROR_CONSERVATION),
        };
        // This branch cannot be used as a type-script bypass: a type group
        // with args [0] sees its own one-byte type and fails this check.
        if settlement_type.args().raw_data().len() != 72
            || !daowow_contracts_common::is_public_settlement_lock(script, &settlement_type)
        {
            return err(SETTLE_ERROR_CONSERVATION);
        }
        count += 1;
    }
    if count == 0 {
        err(SETTLE_ERROR_CONSERVATION)
    } else {
        0
    }
}

daowow_alloc!();
