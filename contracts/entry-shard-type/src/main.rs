//! DAOWOWEntryShardType — serializes entry creation per shard and commits
//! every accepted Entry into the shard accumulator.
//!
//! args: config commitment (32 bytes) || shard ID (LE u32)
//! Public lock mode: args = [0], requiring the enforcing 36-byte shard type.
//! data: EntryShardDataV1 (fixed 101 bytes)
//!
//! Transitions:
//!   create            -> OPEN          (round config dep must bind round_id)
//!   OPEN -> OPEN      (append witness: entries + accumulator certificate)
//!   OPEN -> FROZEN    (freeze; counters/root immutable from OPEN state)
//!   FROZEN -> FROZEN  (no-op pass-through only)

#![no_std]
#![no_main]

mod claim;
mod entropy;
mod ledger;
mod seal;

use ckb_std::ckb_constants::Source;
use ckb_std::entry;
use ckb_std::high_level::{load_cell, load_cell_data, load_witness};
use daowow_contracts_common::daowow_alloc;
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
    let script = ckb_std::high_level::load_script().ok()?;
    let args = script.args().raw_data();
    let commitment: [u8; 32] = args.get(0..32)?.try_into().ok()?;
    daowow_contracts_common::config_by_commitment(&commitment, round_id, Source::CellDep)
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
    let script = match ckb_std::high_level::load_script() {
        Ok(s) => s,
        Err(_) => return err(SHARD_ERROR_DATA),
    };
    if script.args().raw_data().as_ref() == [0] {
        return public_lock(&script);
    }
    {
        let args = script.args().raw_data();
        if args.len() == daowow_core::claim::CLAIM_ARGS_SIZE
            && args[0] == daowow_core::claim::CLAIM_TAG
        {
            return claim::run(&script).unwrap_or_else(err);
        }
    }
    if script.args().raw_data().len() == 77 {
        return ledger::receipt(&script).unwrap_or_else(err);
    }
    let versions = [
        large_state_version(Source::GroupInput),
        large_state_version(Source::GroupOutput),
    ];
    if versions.contains(&Some(4)) {
        return entropy::finalize(&script).unwrap_or_else(err);
    }
    if versions.contains(&Some(3)) {
        return seal::create(&script).unwrap_or_else(err);
    }
    if load_cell_data(0, Source::GroupOutput)
        .is_ok_and(|d| d.len() == daowow_core::lifecycle::AGGREGATION_STATE_SIZE)
        || load_cell_data(0, Source::GroupInput)
            .is_ok_and(|d| d.len() == daowow_core::lifecycle::AGGREGATION_STATE_SIZE)
    {
        return ledger::transition(&script).unwrap_or_else(err);
    }
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

    let args = script.args().raw_data();
    if args.len() != 36 || args[32..36] != after.shard_id.to_le_bytes() {
        return err(SHARD_ERROR_DATA);
    }
    let output = match load_cell(0, Source::GroupOutput) {
        Ok(cell) => cell,
        Err(_) => return err(SHARD_ERROR_GROUP),
    };
    if !is_public_lock(&output.lock(), &script) {
        return err(SHARD_ERROR_GROUP);
    }
    let commitment: [u8; 32] = args[..32].try_into().unwrap();
    let config = if is_creation {
        daowow_contracts_common::config_by_commitment(&commitment, &after.round_id, Source::Output)
    } else {
        config_for(&after.round_id)
    };
    let cfg = match config {
        Some(c) => c,
        None => return err(SHARD_ERROR_CONFIG_DEP),
    };
    if !daowow_contracts_common::script_matches(&script, &cfg.entry_shard_type) {
        return err(SHARD_ERROR_CONFIG_DEP);
    }
    if cfg.entry_shard_count <= after.shard_id {
        return err(SHARD_ERROR_DATA);
    }
    let claims = match collect_claims(&script, &commitment, after.shard_id) {
        Ok(c) => c,
        Err(e) => return err(e),
    };

    if is_creation {
        if !claims.is_empty() {
            return err(SHARD_ERROR_CLAIM_CELL);
        }
        let mut index = 0;
        let mut anchored = false;
        while let Ok(data) = load_cell_data(index, Source::Output) {
            if data.as_slice() == cfg.encode()
                && daowow_contracts_common::creation_round_id(index) == Some(cfg.round_id)
            {
                anchored = true;
                break;
            }
            index += 1;
        }
        if !anchored {
            return err(SHARD_ERROR_CREATE);
        }
        if daowow_contracts_common::creation_schedule(&cfg, index).is_none() {
            return err(SHARD_ERROR_CREATE);
        }
        // Config bytes and the creation anchor do not authenticate a round-type
        // script. Each shard creation group must enforce the complete set itself.
        let mut seen = [false; 256];
        let mut count = 0u32;
        let mut output_index = 0;
        while let Ok(cell) = load_cell(output_index, Source::Output) {
            if let Some(shard_type) = cell.type_().to_opt() {
                let args = shard_type.args().raw_data();
                if daowow_contracts_common::script_matches(&shard_type, &cfg.entry_shard_type)
                    && args.len() == 36
                    && args[..32] == commitment
                {
                    let shard_id = u32::from_le_bytes(args[32..].try_into().unwrap());
                    if shard_id >= cfg.entry_shard_count || seen[shard_id as usize] {
                        return err(SHARD_ERROR_CREATE);
                    }
                    seen[shard_id as usize] = true;
                    count += 1;
                }
            }
            output_index += 1;
        }
        if count != cfg.entry_shard_count {
            return err(SHARD_ERROR_CREATE);
        }
        return create(&cfg, &after);
    }

    if load_cell(1, Source::GroupInput).is_ok() {
        return err(SHARD_ERROR_GROUP);
    }
    let input = match load_cell(0, Source::GroupInput) {
        Ok(cell) => cell,
        Err(_) => return err(SHARD_ERROR_GROUP),
    };
    let input_capacity: u64 = input.capacity().into();
    let output_capacity: u64 = output.capacity().into();
    if !is_public_lock(&input.lock(), &script) || output_capacity < input_capacity {
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
        (SHARD_STATE_OPEN, SHARD_STATE_OPEN) => append(&cfg, &before, &after, &claims),
        (SHARD_STATE_OPEN, SHARD_STATE_FROZEN) => {
            if !claims.is_empty() {
                return err(SHARD_ERROR_CLAIM_CELL);
            }
            let since = match ckb_std::high_level::load_input_since(0, Source::GroupInput) {
                Ok(s) => s,
                Err(_) => return err(SHARD_ERROR_FROZEN),
            };
            if daowow_core::epoch::absolute_epoch_at_least(since, cfg.entry_end).is_err() {
                return err(SHARD_ERROR_FROZEN);
            }
            if validate_freeze(&before, &after).is_err() {
                return err(SHARD_ERROR_FROZEN);
            }
            0
        }
        (SHARD_STATE_FROZEN, SHARD_STATE_FROZEN) => {
            if !claims.is_empty() {
                return err(SHARD_ERROR_CLAIM_CELL);
            }
            if validate_frozen_noop(&before, &after).is_err() {
                return err(SHARD_ERROR_FROZEN);
            }
            0
        }
        _ => err(SHARD_ERROR_STATE),
    }
}

/// Every output that is a claim of this binary for `commitment || shard_id`.
/// Malformed claim data for this shard is an error here so a later branch
/// cannot silently ignore it.
fn collect_claims(
    script: &ckb_std::ckb_types::packed::Script,
    commitment: &[u8; 32],
    shard_id: u32,
) -> Result<alloc::vec::Vec<daowow_core::claim::MintedClaim>, i8> {
    use daowow_core::claim::{CLAIM_ARGS_SIZE, CLAIM_DATA_SIZE, CLAIM_TAG};
    let mut out = alloc::vec::Vec::new();
    let mut i = 0usize;
    while let Ok(cell) = load_cell(i, Source::Output) {
        if let Some(t) = cell.type_().to_opt() {
            let args = t.args().raw_data();
            if t.code_hash() == script.code_hash()
                && t.hash_type() == script.hash_type()
                && args.len() == CLAIM_ARGS_SIZE
                && args[0] == CLAIM_TAG
                && args[1..33] == commitment[..]
                && args[33..37] == shard_id.to_le_bytes()
            {
                let position = u64::from_le_bytes(args[37..45].try_into().unwrap());
                let lock_hash = ckb_std::high_level::load_cell_lock_hash(i, Source::Output)
                    .map_err(|_| SHARD_ERROR_CLAIM_CELL)?;
                let data = load_cell_data(i, Source::Output).map_err(|_| SHARD_ERROR_CLAIM_CELL)?;
                if data.len() != CLAIM_DATA_SIZE {
                    return Err(SHARD_ERROR_CLAIM_CELL);
                }
                let mut fixed = [0u8; CLAIM_DATA_SIZE];
                fixed.copy_from_slice(&data);
                out.push(daowow_core::claim::MintedClaim {
                    position,
                    lock_hash,
                    data: fixed,
                });
            }
        }
        i += 1;
    }
    Ok(out)
}

/// Read only the tag during dispatch: full 256-shard snapshots are large,
/// and the VM bump allocator cannot reclaim repeated probe allocations.
fn large_state_version(source: Source) -> Option<u8> {
    let mut tag = [0u8; 1];
    let size = match ckb_std::syscalls::load_cell_data(&mut tag, 0, 0, source) {
        Ok(size) | Err(ckb_std::error::SysError::LengthNotEnough(size)) => size,
        Err(_) => return None,
    };
    (size > 207).then_some(tag[0])
}

fn is_public_lock(
    lock: &ckb_std::ckb_types::packed::Script,
    shard_type: &ckb_std::ckb_types::packed::Script,
) -> bool {
    lock.code_hash() == shard_type.code_hash()
        && lock.hash_type() == shard_type.hash_type()
        && lock.args().raw_data().as_ref() == [0]
}

fn public_lock(script: &ckb_std::ckb_types::packed::Script) -> i8 {
    let mut index = 0;
    loop {
        let cell = match load_cell(index, Source::GroupInput) {
            Ok(cell) => cell,
            Err(ckb_std::error::SysError::IndexOutOfBound) if index > 0 => return 0,
            Err(_) => return err(SHARD_ERROR_GROUP),
        };
        // Only the canonical shard mode enforces transitions today. Unknown
        // modes (including future receipts) and public mode as a type fail closed.
        match cell.type_().to_opt() {
            Some(ty)
                if ty.code_hash() == script.code_hash()
                    && ty.hash_type() == script.hash_type()
                    && (ty.args().raw_data().len() == 36
                        || (ty.args().raw_data().len() == 77 && ty.args().raw_data()[0] == 2)) => {}
            _ => return err(SHARD_ERROR_GROUP),
        }
        index += 1;
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
    claims: &[daowow_core::claim::MintedClaim],
) -> i8 {
    let witness_raw = match load_witness(0, Source::GroupInput) {
        Ok(w) => w,
        Err(_) => return err(SHARD_ERROR_DATA),
    };
    let wit =
        match daowow_core::witness::decode_shard_append_witness(&witness_raw, cfg.accumulator_id) {
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
            if code == cfg.entry_lock.code_hash
                && u8::from(lock.hash_type()) == cfg.entry_lock.hash_type
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
                let args = lock.args().raw_data();
                if args.len() != 64
                    || args[..32] != e.participant_lock_hash
                    || args[32..] != cfg.commitment()
                    || cell.type_().to_opt().is_some()
                {
                    return err(SHARD_ERROR_ENTRY_CELL);
                }
                let cap = match ckb_std::high_level::load_cell_capacity(i, Source::Output) {
                    Ok(c) => c,
                    Err(_) => return err(SHARD_ERROR_ENTRY_CELL),
                };
                let occupied =
                    match ckb_std::high_level::load_cell_occupied_capacity(i, Source::Output) {
                        Ok(c) => c,
                        Err(_) => return err(SHARD_ERROR_ENTRY_CELL),
                    };
                if e.principal
                    .checked_add(occupied)
                    .is_none_or(|minimum| cap < minimum)
                {
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

    // one claim NFT per new ticket, locked to its entrant, carrying fresh state
    if daowow_core::claim::validate_mint(
        before.ticket_count,
        after.ticket_count,
        &cfg.commitment(),
        after.shard_id,
        &wit.entries,
        claims,
    )
    .is_err()
    {
        return err(SHARD_ERROR_CLAIM_CELL);
    }

    let old_root = before.accumulator_root;
    let new_root = after.accumulator_root;
    match cfg.accumulator_id {
        daowow_core::encoding::ACC_SMT => {
            let mut current_root = old_root;
            for (i, e) in wit.entries.iter().enumerate() {
                let absence = wit.blobs[i * 2];
                let inclusion = wit.blobs[i * 2 + 1];
                let key = nonce_key(e.entry_nonce);
                let leaf = entry_leaf(e);
                current_root = match smt::inserted_root(&current_root, &key, &leaf, absence) {
                    Ok(root) => root,
                    Err(_) => return err(SHARD_ERROR_ENTRY_CELL),
                };
                if smt::verify_membership(&current_root, &key, &leaf, inclusion).is_err() {
                    return err(SHARD_ERROR_ENTRY_CELL);
                }
            }
            if current_root != new_root {
                return err(SHARD_ERROR_ENTRY_CELL);
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
