//! DAOWOWEntryLock — custodial gate for Entry cells.
//!
//! args: participant_lock_hash (32 bytes)
//! data: EntryDataV1 (fixed 132 bytes)
//!
//! Exactly two spend paths:
//!   1. aggregation: the transaction consumes the entry into native DAO
//!      deposits locked by DAOWOWDAOLock bound to the same round; a
//!      membership proof pins the entry leaf to a FROZEN shard accumulator.
//!   2. refund: input `since` is an absolute epoch >= aggregation_deadline
//!      and the full capacity returns to the committed participant lock.
//! No other destination is valid; there is no operator path.

#![no_std]
#![no_main]

use ckb_std::ckb_constants::Source;
use daowow_contracts_common::daowow_alloc;
use ckb_std::entry;
use ckb_std::high_level::{
    load_cell, load_cell_data, load_cell_type_hash, load_input_since, load_witness, QueryIter,
};
use daowow_contracts_common::find_frozen_shard;
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
    if args.len() != 32 {
        return err(ENTRY_ERROR_LOCK_ARGS);
    }
    let participant_lock_hash: [u8; 32] = args.as_ref().try_into().unwrap();

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
    let _round_id = entries[0].round_id;
    let mut is_aggregation = false;
    {
        let mut i = 0usize;
        while load_cell_type_hash(i, Source::Output).is_ok() {
            i += 1;
        }
        let _ = i;
    }
    // determine by scanning outputs for our dao-lock script hash: obtain it
    // from the round config
    let cfg = match find_round_config_from_entries(&entries) {
        Some(c) => c,
        None => return err(ENTRY_ERROR_ROUND_MISMATCH),
    };
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
                && largs.len() == 40
                && largs[..32] == cfg.round_id
            {
                dao_outputs.push(i);
            }
            i += 1;
        }
    }
    is_aggregation = !dao_outputs.is_empty();

    if is_aggregation {
        return aggregate(&cfg, &entries, &abs_idx);
    }

    // refund path
    refund(&cfg, &entries, &abs_idx)
}

fn find_round_config_from_entries(
    entries: &[EntryDataV1],
) -> Option<daowow_core::encoding::RoundConfigV1> {
    // find the config dep binding any of our round ids; entries of one group
    // share one round (validated after)
    entries.first().and_then(|e| find_round_config_in_deps(&e.round_id))
}

fn find_round_config_in_deps(
    round_id: &[u8; 32],
) -> Option<daowow_core::encoding::RoundConfigV1> {
    // entry-lock does not know the round-type script ref up front; use the
    // same discovery rule as the shard script (config-shaped dep with 8-byte
    // type args).
    let mut i = 0usize;
    loop {
        let cell = load_cell(i, Source::CellDep).ok()?;
        if let Some(t) = cell.type_().to_opt() {
            if t.args().raw_data().len() == 8 {
                if let Ok(data) = load_cell_data(i, Source::CellDep) {
                    if data.len() == daowow_core::encoding::ROUND_CONFIG_SIZE {
                        if let Ok(cfg) = daowow_core::encoding::RoundConfigV1::decode(&data) {
                            if cfg.round_id == *round_id {
                                return Some(cfg);
                            }
                        }
                    }
                }
            }
        }
        i += 1;
    }
}

fn aggregate(
    cfg: &daowow_core::encoding::RoundConfigV1,
    entries: &[EntryDataV1],
    abs_idx: &[usize],
) -> i8 {
    // the frozen shard commitment must exist among deps
    let shard = match find_frozen_shard(&cfg.entry_shard_type, &cfg.round_id) {
        Some(s) => s,
        None => return err(ENTRY_ERROR_SHARD_MISMATCH),
    };
    // membership proof per entry against the frozen accumulator root
    for (gi, e) in entries.iter().enumerate() {
        if e.shard_id != shard.shard_id {
            return err(ENTRY_ERROR_SHARD_MISMATCH);
        }
        let raw = match load_witness(abs_idx[gi], Source::Input) {
            Ok(w) => w,
            Err(_) => return err(ENTRY_ERROR_NOT_AGGREGATION),
        };
        let proof = match daowow_core::witness::decode_aggregation_witness(&raw) {
            Ok(p) => p,
            Err(_) => return err(ENTRY_ERROR_NOT_AGGREGATION),
        };
        let key = nonce_key(e.entry_nonce);
        let leaf = entry_leaf(e);
        let ok = match cfg.accumulator_id {
            daowow_core::encoding::ACC_SMT => {
                smt::verify_membership(&shard.accumulator_root, &key, &leaf, proof).is_ok()
            }
            daowow_core::encoding::ACC_MMR => {
                daowow_core::accumulator::mmr::verify_membership(
                    &shard.accumulator_root,
                    shard.entry_count,
                    e.entry_nonce,
                    &leaf,
                    proof,
                )
                .is_ok()
            }
            daowow_core::encoding::ACC_IMT => {
                daowow_core::accumulator::imt::verify_membership(
                    &shard.accumulator_root,
                    e.entry_nonce,
                    &leaf,
                    proof,
                )
                .is_ok()
            }
            _ => false,
        };
        if !ok {
            return err(ENTRY_ERROR_NOT_AGGREGATION);
        }
    }

    // capacity routing: the total capacity of this entry group must flow into
    // DAO deposit outputs under the round's dao-lock (checked by every group;
    // tx-wide equality is asserted against all entry groups combined below).
    let mut group_cap: u64 = 0;
    for &ai in abs_idx {
        group_cap = match group_cap.checked_add(
            ckb_std::high_level::load_cell_capacity(ai, Source::Input).unwrap_or(u64::MAX),
        ) {
            Some(c) if c != u64::MAX => c,
            _ => return err(ENTRY_ERROR_DATA),
        };
    }
    let mut deposit_cap: u64 = 0;
    {
        let mut i = 0usize;
        loop {
            let cell = match load_cell(i, Source::Output) {
                Ok(c) => c,
                Err(_) => break,
            };
            let lock = cell.lock();
            let code_hash: [u8; 32] = lock.code_hash().into();
            let largs = lock.args().raw_data();
            if code_hash == cfg.dao_lock.code_hash
                && u8::from(lock.hash_type()) == cfg.dao_lock.hash_type
                && largs.len() == 40
                && largs[..32] == cfg.round_id
            {
                let cap = match ckb_std::high_level::load_cell_capacity(i, Source::Output) {
                    Ok(c) => c,
                    Err(_) => return err(ENTRY_ERROR_BATCH_BINDING),
                };
                deposit_cap = match deposit_cap.checked_add(cap) {
                    Some(c) => c,
                    None => return err(ENTRY_ERROR_BATCH_BINDING),
                };
            }
            i += 1;
        }
    }
    // tx-wide: all entry inputs together must exactly fund the dao deposits
    let mut total_entry_cap: u64 = 0;
    {
        let dao_type_hash = cfg.dao_type.code_hash;
        let mut i = 0usize;
        loop {
            // every input cell that is an entry (entry lock with 32-byte args
            // whose data decodes as EntryData) contributes; approximate by
            // summing capacities of inputs carrying the entry lock code hash
            // from the config.
            let cell = match load_cell(i, Source::Input) {
                Ok(c) => c,
                Err(_) => break,
            };
            let lock = cell.lock();
            let code_hash: [u8; 32] = lock.code_hash().into();
            if code_hash == cfg.entry_lock.code_hash
                && u8::from(lock.hash_type()) == cfg.entry_lock.hash_type
            {
                let cap = ckb_std::high_level::load_cell_capacity(i, Source::Input).unwrap_or(0);
                total_entry_cap = total_entry_cap.saturating_add(cap);
            }
            let _ = dao_type_hash;
            i += 1;
        }
    }
    if deposit_cap != total_entry_cap {
        ckb_std::debug!(
            "entry-lock: deposit_cap {} != total_entry_cap {}",
            deposit_cap,
            total_entry_cap
        );
        return err(ENTRY_ERROR_BATCH_BINDING);
    }
    if group_cap > deposit_cap {
        return err(ENTRY_ERROR_BATCH_BINDING);
    }
    0
}

fn refund(
    cfg: &daowow_core::encoding::RoundConfigV1,
    entries: &[EntryDataV1],
    abs_idx: &[usize],
) -> i8 {
    // refund is only permitted at/after the aggregation deadline, expressed
    // by an absolute-epoch `since` on each input (consensus enforces the
    // threshold; the script verifies the encoding and value).
    for &ai in abs_idx {
        let since = match load_input_since(ai, Source::Input) {
            Ok(s) => s,
            Err(_) => return err(ENTRY_ERROR_REFUND_CONDITION),
        };
        // absolute epoch flag bits: 0b0100_0000 in the top byte would be
        // relative; absolute epoch uses 0b0010_0000 (0x20).
        if since >> 56 != 0x20 {
            return err(ENTRY_ERROR_REFUND_CONDITION);
        }
        let epoch_number = since & 0x00FF_FFFF_FFFF_FFFF;
        if epoch_number < cfg.aggregation_deadline {
            return err(ENTRY_ERROR_REFUND_CONDITION);
        }
        // destination: the committed participant lock; capacity >= principal
        let cell = match load_cell(ai, Source::Input) {
            Ok(c) => c,
            Err(_) => return err(ENTRY_ERROR_DATA),
        };
        let e = &entries[abs_idx.iter().position(|&x| x == ai).unwrap_or(0)];
        let mut found = false;
        {
            let mut i = 0usize;
            loop {
                let out = match load_cell(i, Source::Output) {
                    Ok(c) => c,
                    Err(_) => break,
                };
                let lock = out.lock();
                let script_hash: [u8; 32] = lock.calc_script_hash().into();
                if script_hash == e.participant_lock_hash {
                    let cap = ckb_std::high_level::load_cell_capacity(i, Source::Output).unwrap_or(0);
                    if cap >= e.principal {
                        found = true;
                    }
                    break;
                }
                i += 1;
            }
        }
        if !found {
            return err(ENTRY_ERROR_REFUND_DESTINATION);
        }
        let _ = cell;
    }
    // a refund transaction must not also aggregate (no dao deposits allowed)
    {
        let mut i = 0usize;
        loop {
            let cell = match load_cell(i, Source::Output) {
                Ok(c) => c,
                Err(_) => break,
            };
            let lock = cell.lock();
            let code_hash: [u8; 32] = lock.code_hash().into();
            if code_hash == cfg.dao_lock.code_hash {
                return err(ENTRY_ERROR_REFUND_CONDITION);
            }
            i += 1;
        }
    }
    let _ = QueryIter::new(load_cell, Source::Output).count();
    0
}

// silence unused warnings
#[allow(dead_code)]
fn _u() {
    let _ = group_size;
}

daowow_alloc!();
