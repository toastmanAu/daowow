//! DAOWOWEntryShardType — serializes entry creation per shard and commits
//! every accepted Entry into the shard accumulator.
//!
//! args: type_id (8 bytes)
//! data: EntryShardDataV1 (fixed 101 bytes)
//!
//! Transitions:
//!   create            -> OPEN          (round config dep must bind round_id)
//!   OPEN -> OPEN      (append witness: entries + accumulator certificate)
//!   OPEN -> FROZEN    (freeze; counters/root immutable from OPEN state)
//!   FROZEN -> FROZEN  (no-op pass-through only)

#![no_std]
#![no_main]

use ckb_std::ckb_constants::Source;
use daowow_contracts_common::daowow_alloc;
use ckb_std::entry;
use ckb_std::high_level::{load_cell, load_cell_data, load_witness};
use daowow_contracts_common::find_round_config;
use daowow_core::accumulator::{imt, mmr, nonce_key, smt};
use daowow_core::encoding::{
    EntryShardDataV1, SHARD_DATA_SIZE, SHARD_STATE_FROZEN, SHARD_STATE_OPEN,
};
use daowow_core::error::codes::*;
use daowow_core::leaf::entry_leaf;
use daowow_core::shard::{apply_entry_batch, validate_freeze, validate_frozen_noop};

entry!(main);

fn err(e: i8) -> i8 {
    ckb_std::debug!("entry-shard-type error {}", e);
    e
}

/// Any dep cell that is a well-formed RoundConfig binding this round_id is
/// THE config (round-type guarantees configs are immutable and unique).
fn config_for(round_id: &[u8; 32]) -> Option<daowow_core::encoding::RoundConfigV1> {
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

fn mmr_decode_peaks(wire: &[u8]) -> Option<([[u8; 32]; mmr::MAX_PEAKS], usize)> {
    if wire.is_empty() {
        return None;
    }
    let len = wire[0] as usize;
    if len > mmr::MAX_PEAKS || wire.len() != 1 + len * 32 {
        return None;
    }
    let mut peaks = [[0u8; 32]; mmr::MAX_PEAKS];
    for i in 0..len {
        peaks[i].copy_from_slice(&wire[1 + i * 32..1 + (i + 1) * 32]);
    }
    Some((peaks, len))
}

fn main() -> i8 {
    let is_creation = load_cell(0, Source::GroupInput).is_err();

    if load_cell(1, Source::GroupOutput).is_ok() {
        return err(SHARD_ERROR_GROUP);
    }
    let out_data = match load_cell_data(0, Source::GroupOutput) {
        Ok(d) => d,
        Err(_) => return err(SHARD_ERROR_DATA),
    };
    if out_data.len() != SHARD_DATA_SIZE {
        return err(SHARD_ERROR_DATA);
    }
    let after = match EntryShardDataV1::decode(&out_data) {
        Ok(s) => s,
        Err(_) => return err(SHARD_ERROR_DATA),
    };

    let cfg = match config_for(&after.round_id) {
        Some(c) => c,
        None => return err(SHARD_ERROR_CONFIG_DEP),
    };
    if cfg.entry_shard_count <= after.shard_id {
        return err(SHARD_ERROR_DATA);
    }

    if is_creation {
        return create(&cfg, &after);
    }

    if load_cell(1, Source::GroupInput).is_ok() {
        return err(SHARD_ERROR_GROUP);
    }
    let in_data = match load_cell_data(0, Source::GroupInput) {
        Ok(d) => d,
        Err(_) => return err(SHARD_ERROR_DATA),
    };
    if in_data.len() != SHARD_DATA_SIZE {
        return err(SHARD_ERROR_DATA);
    }
    let before = match EntryShardDataV1::decode(&in_data) {
        Ok(s) => s,
        Err(_) => return err(SHARD_ERROR_DATA),
    };

    match (before.state, after.state) {
        (SHARD_STATE_OPEN, SHARD_STATE_OPEN) => append(&cfg, &before, &after),
        (SHARD_STATE_OPEN, SHARD_STATE_FROZEN) => {
            if validate_freeze(&before, &after).is_err() {
                return err(SHARD_ERROR_FROZEN);
            }
            0
        }
        (SHARD_STATE_FROZEN, SHARD_STATE_FROZEN) => {
            if validate_frozen_noop(&before, &after).is_err() {
                return err(SHARD_ERROR_FROZEN);
            }
            0
        }
        _ => err(SHARD_ERROR_STATE),
    }
}

fn create(cfg: &daowow_core::encoding::RoundConfigV1, after: &EntryShardDataV1) -> i8 {
    if after.state != SHARD_STATE_OPEN
        || after.sequence != 0
        || after.entry_count != 0
        || after.ticket_count != 0
        || after.principal_total != 0
    {
        return err(SHARD_ERROR_CREATE);
    }
    let empty_root = match cfg.accumulator_id {
        daowow_core::encoding::ACC_SMT => [0u8; 32],
        daowow_core::encoding::ACC_MMR => mmr::bag_peaks(&[]).unwrap_or([0u8; 32]),
        daowow_core::encoding::ACC_IMT => imt::zero_at(imt::IMT_DEPTH),
        _ => return err(SHARD_ERROR_DATA),
    };
    if after.accumulator_root != empty_root {
        return err(SHARD_ERROR_CREATE);
    }
    0
}

fn append(
    cfg: &daowow_core::encoding::RoundConfigV1,
    before: &EntryShardDataV1,
    after: &EntryShardDataV1,
) -> i8 {
    let witness_raw = match load_witness(0, Source::GroupInput) {
        Ok(w) => w,
        Err(_) => return err(SHARD_ERROR_DATA),
    };
    let wit = match daowow_core::witness::decode_shard_append_witness(&witness_raw, cfg.accumulator_id)
    {
        Ok(w) => w,
        Err(_) => return err(SHARD_ERROR_DATA),
    };

    let expected = match apply_entry_batch(Some(before), cfg, &wit.entries) {
        Ok(s) => s,
        Err(_) => return err(SHARD_ERROR_COUNTERS),
    };
    if after.round_id != expected.round_id
        || after.shard_id != expected.shard_id
        || after.sequence != expected.sequence
        || after.entry_count != expected.entry_count
        || after.ticket_count != expected.ticket_count
        || after.principal_total != expected.principal_total
    {
        return err(SHARD_ERROR_COUNTERS);
    }

    // every newly created Entry cell (lock = configured entry-lock, same
    // round+shard) must correspond one-to-one with a witness entry, so that
    // consumed leaves are exactly the entries paid for in this transaction
    let mut claimed: alloc::vec::Vec<bool> = alloc::vec![false; wit.entries.len()];
    {
        let mut i = 0usize;
        loop {
            let cell = match load_cell(i, Source::Output) {
                Ok(c) => c,
                Err(_) => break,
            };
            let lock = cell.lock();
            let code: [u8; 32] = lock.code_hash().into();
            if code == cfg.entry_lock.code_hash && u8::from(lock.hash_type()) == cfg.entry_lock.hash_type
            {
                let data = match load_cell_data(i, Source::Output) {
                    Ok(d) => d,
                    Err(_) => return err(SHARD_ERROR_ENTRY_CELL),
                };
                let e = match daowow_core::encoding::EntryDataV1::decode(&data) {
                    Ok(e) => e,
                    Err(_) => return err(SHARD_ERROR_ENTRY_CELL),
                };
                if e.round_id != after.round_id || e.shard_id != after.shard_id {
                    return err(SHARD_ERROR_ENTRY_CELL);
                }
                let mut hit = false;
                for (j, w) in wit.entries.iter().enumerate() {
                    if !claimed[j] && *w == e {
                        claimed[j] = true;
                        hit = true;
                        break;
                    }
                }
                if !hit {
                    return err(SHARD_ERROR_ENTRY_CELL);
                }
            }
            i += 1;
        }
    }
    if claimed.iter().any(|c| !c) {
        return err(SHARD_ERROR_ENTRY_CELL);
    }

    let old_root = before.accumulator_root;
    let new_root = after.accumulator_root;
    match cfg.accumulator_id {
        daowow_core::encoding::ACC_SMT => {
            for (i, e) in wit.entries.iter().enumerate() {
                let absence = wit.blobs[i * 2];
                let inclusion = wit.blobs[i * 2 + 1];
                let key = nonce_key(e.entry_nonce);
                let leaf = entry_leaf(e);
                if smt::verify_insert_certificate(&old_root, &new_root, &key, &leaf, absence, inclusion)
                    .is_err()
                {
                    return err(SHARD_ERROR_ENTRY_CELL);
                }
            }
        }
        daowow_core::encoding::ACC_MMR => {
            if wit.blobs.len() != 2 {
                return err(SHARD_ERROR_DATA);
            }
            let (old_peaks, old_len) = match mmr_decode_peaks(wit.blobs[0]) {
                Some(p) => p,
                None => return err(SHARD_ERROR_ENTRY_CELL),
            };
            if old_len != before.entry_count.count_ones() as usize
                || mmr::bag_peaks(&old_peaks[..old_len]).unwrap_or([2u8; 32]) != old_root
            {
                return err(SHARD_ERROR_ENTRY_CELL);
            }
            // chain the appends over derived peaks
            let mut cur = old_peaks;
            let mut cur_len = old_len;
            let mut count = before.entry_count;
            for e in &wit.entries {
                let merged = match mmr::append_peaks(&cur[..cur_len], count, &entry_leaf(e)) {
                    Ok(m) => m,
                    Err(_) => return err(SHARD_ERROR_ENTRY_CELL),
                };
                count += 1;
                cur_len = count.count_ones() as usize;
                cur = merged;
            }
            let (wire_peaks, wire_len) = match mmr_decode_peaks(wit.blobs[1]) {
                Some(p) => p,
                None => return err(SHARD_ERROR_ENTRY_CELL),
            };
            if wire_len != cur_len || wire_peaks[..wire_len] != cur[..cur_len] {
                return err(SHARD_ERROR_ENTRY_CELL);
            }
            if mmr::bag_peaks(&wire_peaks[..wire_len]).unwrap_or([1u8; 32]) != new_root {
                return err(SHARD_ERROR_ENTRY_CELL);
            }
        }
        daowow_core::encoding::ACC_IMT => {
            if wit.blobs.len() != 1 {
                return err(SHARD_ERROR_DATA);
            }
            let branch = wit.blobs[0];
            let mut frontier = [[0u8; 32]; imt::IMT_DEPTH as usize];
            for j in 0..imt::IMT_DEPTH as u64 {
                if before.entry_count >> j & 1 == 1 {
                    let off = (j as usize) * 32;
                    if off + 32 > branch.len() {
                        return err(SHARD_ERROR_DATA);
                    }
                    frontier[j as usize].copy_from_slice(&branch[off..off + 32]);
                }
            }
            if imt::root_from_frontier(&frontier, before.entry_count) != old_root {
                return err(SHARD_ERROR_ENTRY_CELL);
            }
            let mut count = before.entry_count;
            for e in &wit.entries {
                frontier = imt::frontier_append(&frontier, count, &entry_leaf(e));
                count += 1;
            }
            if imt::root_from_frontier(&frontier, count) != new_root {
                return err(SHARD_ERROR_ENTRY_CELL);
            }
        }
        _ => return err(SHARD_ERROR_DATA),
    }
    0
}

// keep the shared helper referenced (used by other contracts via common)
#[allow(dead_code)]
fn _use_common() {
    let _ = find_round_config;
}

daowow_alloc!();
