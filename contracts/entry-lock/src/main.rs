//! DAOWOWEntryLock — custodial gate for Entry cells.
//!
//! args: participant_lock_hash (32) || config_commitment (32)
//! data: EntryDataV1 (fixed 132 bytes)
//!
//! Exactly two spend paths:
//!   1. aggregation: the transaction consumes the entry into native DAO
//!      deposits locked by DAOWOWDAOLock bound to the same round; a
//!      membership proof pins the entry leaf to a FROZEN shard accumulator.
//!   2. refund: input `since` is an absolute epoch >= aggregation_deadline
//!      and the full capacity returns to the committed participant lock.
//!
//! No other destination is valid; there is no operator path.

#![no_std]
#![no_main]

use ckb_std::ckb_constants::Source;
use ckb_std::entry;
use ckb_std::high_level::{load_cell, load_cell_data, load_input_since, load_witness};
use daowow_contracts_common::daowow_alloc;
use daowow_core::accumulator::{nonce_key, smt};
use daowow_core::encoding::{EntryDataV1, ENTRY_DATA_SIZE};
use daowow_core::error::codes::*;
use daowow_core::leaf::entry_leaf;

entry!(main);

fn err(e: i8) -> i8 {
    ckb_std::debug!("entry-lock error {}", e);
    e
}

/// group input count
fn group_size() -> usize {
    let mut n = 0usize;
    while load_cell(n, Source::GroupInput).is_ok() {
        n += 1;
    }
    n
}

/// absolute input indices of this lock group
fn group_absolute_indices() -> alloc::vec::Vec<usize> {
    let my_hash = match ckb_std::high_level::load_script_hash() {
        Ok(h) => h,
        Err(_) => return alloc::vec::Vec::new(),
    };
    let mut out = alloc::vec::Vec::new();
    let mut i = 0usize;
    while let Ok(h) = ckb_std::high_level::load_cell_lock_hash(i, Source::Input) {
        if h == my_hash {
            out.push(i);
        }
        i += 1;
    }
    out
}

fn entry_data_at(index: usize) -> Option<EntryDataV1> {
    let d = load_cell_data(index, Source::Input).ok()?;
    if d.len() != ENTRY_DATA_SIZE {
        return None;
    }
    EntryDataV1::decode(&d).ok()
}

fn main() -> i8 {
    let script = match ckb_std::high_level::load_script() {
        Ok(s) => s,
        Err(_) => return err(ENTRY_ERROR_LOCK_ARGS),
    };
    let args = script.args().raw_data();
    if args.len() != 64 {
        return err(ENTRY_ERROR_LOCK_ARGS);
    }
    let participant_lock_hash: [u8; 32] = args[..32].try_into().unwrap();

    let n = group_size();
    if n == 0 {
        return err(ENTRY_ERROR_LOCK_ARGS);
    }

    // decode all group entries and validate against args
    let abs_idx = group_absolute_indices();
    if abs_idx.len() != n {
        return err(ENTRY_ERROR_LOCK_ARGS);
    }
    let mut entries = alloc::vec::Vec::with_capacity(n);
    for &ai in &abs_idx {
        let e = match entry_data_at(ai) {
            Some(e) => e,
            None => return err(ENTRY_ERROR_DATA),
        };
        if e.participant_lock_hash != participant_lock_hash {
            return err(ENTRY_ERROR_LOCK_ARGS);
        }
        entries.push(e);
    }

    // detect the aggregation path: presence of a DAO deposit output under the
    // round's dao-lock
    // determine by scanning outputs for our dao-lock script hash: obtain it
    // from the round config
    let cfg = match find_round_config_from_entries(&entries) {
        Some(c) => c,
        None => return err(ENTRY_ERROR_ROUND_MISMATCH),
    };
    if !daowow_contracts_common::script_matches(&script, &cfg.entry_lock) {
        return err(ENTRY_ERROR_ROUND_MISMATCH);
    }
    for e in &entries {
        if e.round_id != cfg.round_id {
            return err(ENTRY_ERROR_ROUND_MISMATCH);
        }
    }
    // dao lock script hash from config ref: build the expected script hash by
    // scanning outputs for a lock whose code hash/hash type/args prefix match
    let mut dao_outputs = alloc::vec::Vec::new();
    {
        let mut i = 0usize;
        loop {
            let cell = match load_cell(i, Source::Output) {
                Ok(c) => c,
                Err(_) => break,
            };
            let lock = cell.lock();
            let code_hash: [u8; 32] = lock.code_hash().into();
            let ht = u8::from(lock.hash_type());
            let largs = lock.args().raw_data();
            if code_hash == cfg.dao_lock.code_hash
                && ht == cfg.dao_lock.hash_type
                && largs.len() == 104
                && largs[..32] == cfg.round_id
                && largs[40..72] == cfg.commitment()
            {
                dao_outputs.push(i);
            }
            i += 1;
        }
    }
    if !dao_outputs.is_empty()
        || canonical_ledger(cfg.commitment(), &cfg, entries[0].shard_id, Source::Input).is_some()
    {
        return aggregate(&cfg, &entries);
    }

    // refund path
    refund(&cfg, &entries, &abs_idx)
}

fn find_round_config_from_entries(
    entries: &[EntryDataV1],
) -> Option<daowow_core::encoding::RoundConfigV1> {
    // find the config dep binding any of our round ids; entries of one group
    // share one round (validated after)
    entries
        .first()
        .and_then(|e| find_round_config_in_deps(&e.round_id))
}

fn find_round_config_in_deps(round_id: &[u8; 32]) -> Option<daowow_core::encoding::RoundConfigV1> {
    let script = ckb_std::high_level::load_script().ok()?;
    let args = script.args().raw_data();
    let commitment: [u8; 32] = args.get(32..64)?.try_into().ok()?;
    daowow_contracts_common::config_by_commitment(&commitment, round_id, Source::CellDep)
}

fn aggregate(cfg: &daowow_core::encoding::RoundConfigV1, entries: &[EntryDataV1]) -> i8 {
    if entries.iter().any(|e| e.shard_id != entries[0].shard_id) {
        return err(ENTRY_ERROR_SHARD_MISMATCH);
    }
    // Requiring the exact enforcing type on an actual input makes its script
    // mandatory for this transaction. That shard group validates every actual
    // entry input, indexed proof, successor, DAO output and receipt. Its other
    // transitions forbid entry inputs. Do not replace this with a dep/output
    // check: neither would force the canonical ledger spending validation.
    if canonical_ledger(cfg.commitment(), cfg, entries[0].shard_id, Source::Input)
        .is_some_and(|state| !state.is_closed())
    {
        0
    } else {
        err(ENTRY_ERROR_NOT_AGGREGATION)
    }
}

/// Authenticate a canonical ledger by its configured type and exact identity.
fn canonical_ledger(
    commitment: [u8; 32],
    cfg: &daowow_core::encoding::RoundConfigV1,
    shard_id: u32,
    source: Source,
) -> Option<daowow_core::lifecycle::AggregationState> {
    let mut i = 0;
    let mut found = None;
    while let Ok(cell) = load_cell(i, source) {
        if let Some(type_script) = cell.type_().to_opt() {
            let args = type_script.args().raw_data();
            if daowow_contracts_common::script_matches(&type_script, &cfg.entry_shard_type)
                && args.len() == 36
                && args[..32] == commitment
                && args[32..] == shard_id.to_le_bytes()
            {
                if found.is_some() {
                    return None;
                }
                let data = load_cell_data(i, source).ok()?;
                let state = if shard_id == 0 && data.first() == Some(&3) && data.len() > 207 {
                    *daowow_core::seal::RoundSeal::decode(&data, cfg)
                        .ok()?
                        .ledger(0)?
                } else if shard_id == 0 && data.first() == Some(&4) && data.len() > 207 {
                    *daowow_core::seal::EntropyRecord::decode(&data, cfg)
                        .ok()?
                        .seal()
                        .ledger(0)?
                } else {
                    daowow_core::lifecycle::AggregationState::decode(&data, cfg).ok()?
                };
                if state.frozen().shard_id != shard_id {
                    return None;
                }
                found = Some(state);
            }
        }
        i += 1;
    }
    found
}

fn excluded_membership(
    cfg: &daowow_core::encoding::RoundConfigV1,
    e: &EntryDataV1,
    index: usize,
) -> bool {
    let Some(state) = canonical_ledger(cfg.commitment(), cfg, e.shard_id, Source::CellDep) else {
        return false;
    };
    if !state.is_closed() || e.entry_nonce < state.accepted_entries() {
        return false;
    }
    let Ok(raw) = load_witness(index, Source::Input) else {
        return false;
    };
    let Ok(proof) = daowow_core::witness::decode_aggregation_witness(&raw) else {
        return false;
    };
    let shard = state.frozen();
    let leaf = entry_leaf(e);
    match cfg.accumulator_id {
        daowow_core::encoding::ACC_SMT => smt::verify_membership(
            &shard.accumulator_root,
            &nonce_key(e.entry_nonce),
            &leaf,
            proof,
        )
        .is_ok(),
        daowow_core::encoding::ACC_MMR => daowow_core::accumulator::mmr::verify_membership(
            &shard.accumulator_root,
            shard.entry_count,
            e.entry_nonce,
            &leaf,
            proof,
        )
        .is_ok(),
        daowow_core::encoding::ACC_IMT => daowow_core::accumulator::imt::verify_membership(
            &shard.accumulator_root,
            e.entry_nonce,
            &leaf,
            proof,
        )
        .is_ok(),
        _ => false,
    }
}

fn refund(
    cfg: &daowow_core::encoding::RoundConfigV1,
    entries: &[EntryDataV1],
    abs_idx: &[usize],
) -> i8 {
    let mut required = 0u64;
    for (&ai, entry) in abs_idx.iter().zip(entries) {
        if !excluded_membership(cfg, entry, ai) {
            return err(ENTRY_ERROR_REFUND_CONDITION);
        }
        let since = match load_input_since(ai, Source::Input) {
            Ok(s) => s,
            Err(_) => return err(ENTRY_ERROR_REFUND_CONDITION),
        };
        if daowow_core::epoch::absolute_epoch_at_least(since, cfg.aggregation_deadline).is_err() {
            return err(ENTRY_ERROR_REFUND_CONDITION);
        }
        let cap = match ckb_std::high_level::load_cell_capacity(ai, Source::Input) {
            Ok(c) => c,
            Err(_) => return err(ENTRY_ERROR_DATA),
        };
        required = match required.checked_add(cap) {
            Some(c) => c,
            None => return err(ENTRY_ERROR_DATA),
        };
    }
    // Other config commitments form other lock groups. Count their entries
    // for the same participant too, so groups cannot reuse one repayment.
    let mut ai = 0;
    while let Ok(cell) = load_cell(ai, Source::Input) {
        if !abs_idx.contains(&ai)
            && daowow_contracts_common::script_matches(&cell.lock(), &cfg.entry_lock)
        {
            let other_lock = cell.lock();
            let args = other_lock.args().raw_data();
            if args.len() == 64 && args[..32] == entries[0].participant_lock_hash {
                let cap = match ckb_std::high_level::load_cell_capacity(ai, Source::Input) {
                    Ok(c) => c,
                    Err(_) => return err(ENTRY_ERROR_DATA),
                };
                required = match required.checked_add(cap) {
                    Some(c) => c,
                    None => return err(ENTRY_ERROR_DATA),
                };
            }
        }
        ai += 1;
    }
    // A lock group has one participant. Sum its full input capacity once,
    // and sum only ordinary outputs for that participant once.
    let mut returned = 0u64;
    let mut i = 0usize;
    while let Ok(cell) = load_cell(i, Source::Output) {
        let lock = cell.lock();
        let code: [u8; 32] = lock.code_hash().into();
        if code == cfg.dao_lock.code_hash {
            return err(ENTRY_ERROR_REFUND_CONDITION);
        }
        let hash: [u8; 32] = lock.calc_script_hash().into();
        if hash == entries[0].participant_lock_hash {
            if cell.type_().to_opt().is_some()
                || !matches!(load_cell_data(i, Source::Output), Ok(data) if data.is_empty())
            {
                return err(ENTRY_ERROR_REFUND_DESTINATION);
            }
            let cap = match ckb_std::high_level::load_cell_capacity(i, Source::Output) {
                Ok(c) => c,
                Err(_) => return err(ENTRY_ERROR_DATA),
            };
            returned = match returned.checked_add(cap) {
                Some(c) => c,
                None => return err(ENTRY_ERROR_DATA),
            };
        }
        i += 1;
    }
    if returned < required {
        return err(ENTRY_ERROR_REFUND_DESTINATION);
    }
    0
}

// silence unused warnings
#[allow(dead_code)]
fn _u() {
    let _ = group_size;
}

daowow_alloc!();
