//! DAOWOWDAOLock — keeps pooled round funds non-custodial across the native
//! Nervos DAO lifecycle. The native DAO type script validates DAO mechanics;
//! this lock validates DAOWOW custody rules (see RFC-0023 and dao.c).
//!
//! args: round_id (32) || batch_id (8) || config commitment (32) || digest (32)
//! data: phase 1 input = 8 zero bytes (deposit); phase 2 input = 8-byte LE
//!       deposit block number (withdrawing cell).
//!
//! Phase 1 (deposit -> withdrawing):
//!   for the input at absolute index i, the output at index i must keep the
//!   same capacity, the native DAO type, the same DAOWOW lock (no lock
//!   substitution), and carry the deposit inclusion block number.
//!
//! Phase 2 (withdrawing -> settlement):
//!   every input of this lock in the tx must be a withdrawing cell; all
//!   outputs that replace DAO cells must be settlement-type funding cells
//!   bound to the same round. The DAO type computes compensation and enforces
//!   capacity conservation; this lock constrains the destination.

#![no_std]
#![no_main]

use ckb_std::ckb_constants::Source;
use ckb_std::ckb_types::prelude::*;
use ckb_std::entry;
use ckb_std::high_level::{
    load_cell, load_cell_capacity, load_cell_data, load_cell_type_hash, load_header, load_script,
};
use daowow_contracts_common::daowow_alloc;
use daowow_core::encoding::RoundConfigV1;
use daowow_core::error::codes::*;

entry!(main);

fn err(e: i8) -> i8 {
    ckb_std::debug!("dao-lock error {}", e);
    e
}

fn config_for(round_id: &[u8; 32]) -> Option<daowow_core::encoding::RoundConfigV1> {
    let script = ckb_std::high_level::load_script().ok()?;
    let args = script.args().raw_data();
    let commitment: [u8; 32] = args.get(40..72)?.try_into().ok()?;
    daowow_contracts_common::config_by_commitment(&commitment, round_id, Source::CellDep)
}

fn main() -> i8 {
    let script = match load_script() {
        Ok(s) => s,
        Err(_) => return err(DAO_ERROR_ARGS),
    };
    let args = script.args().raw_data();
    if args.len() != 104 {
        return err(DAO_ERROR_ARGS);
    }
    let round_id: [u8; 32] = args[..32].try_into().unwrap();
    let _batch_id: [u8; 8] = args[32..40].try_into().unwrap();

    let cfg = match config_for(&round_id) {
        Some(c) => c,
        None => return err(DAO_ERROR_ARGS),
    };
    if !daowow_contracts_common::script_matches(&script, &cfg.dao_lock) {
        return err(DAO_ERROR_ARGS);
    }

    // gather this group's absolute input indices
    let my_hash = match ckb_std::high_level::load_script_hash() {
        Ok(h) => h,
        Err(_) => return err(DAO_ERROR_GROUP),
    };
    let mut group_abs = alloc::vec::Vec::new();
    {
        let mut i = 0usize;
        while let Ok(h) = ckb_std::high_level::load_cell_lock_hash(i, Source::Input) {
            if h == my_hash {
                group_abs.push(i);
            }
            i += 1;
        }
    }
    if group_abs.is_empty() {
        return err(DAO_ERROR_GROUP);
    }

    // phase detection from the first group input's data
    let d0 = match load_cell_data(group_abs[0], Source::Input) {
        Ok(d) => d,
        Err(_) => return err(DAO_ERROR_GROUP),
    };
    if d0.len() == 8 && d0 == [0u8; 8] {
        phase_one(&cfg, &group_abs)
    } else {
        phase_two(&cfg, &group_abs)
    }
}

/// Only explicit, nonduplicate code deps are supported here, so raw dep order
/// and resolved CellDep syscall order agree. Builders must expand dep groups.
/// This binds the receipt and the DAO input to the same creation transaction,
/// not merely identical lock args on a separately created deposit.
fn authenticated_deposit_receipt(cfg: &RoundConfigV1, input_index: usize) -> bool {
    use daowow_core::lifecycle::BatchCommitment;
    let Ok(tx) = ckb_std::high_level::load_transaction() else {
        return false;
    };
    let deps = tx.raw().cell_deps();
    for (index, dep) in deps.clone().into_iter().enumerate() {
        if u8::from(dep.dep_type()) != 0
            || deps
                .clone()
                .into_iter()
                .take(index)
                .any(|prior| prior.out_point() == dep.out_point())
        {
            return false;
        }
    }
    let Ok(script) = load_script() else {
        return false;
    };
    let own = script.args().raw_data();
    let batch_id = u64::from_le_bytes(own[32..40].try_into().unwrap());
    let shard_id = (batch_id >> 56) as u32;
    if shard_id >= cfg.entry_shard_count {
        return false;
    }
    let Ok(input) = ckb_std::high_level::load_input_out_point(input_index, Source::Input) else {
        return false;
    };
    let mut found = false;
    for (index, dep) in deps.into_iter().enumerate() {
        let Ok(cell) = load_cell(index, Source::CellDep) else {
            return false;
        };
        let Some(receipt_type) = cell.type_().to_opt() else {
            continue;
        };
        let args = receipt_type.args().raw_data();
        if !daowow_contracts_common::script_matches(&receipt_type, &cfg.entry_shard_type)
            || args.len() != 77
            || args[0] != 2
            || args[1..33] != cfg.commitment()
            || args[33..37] != shard_id.to_le_bytes()
            || args[37..45] != batch_id.to_le_bytes()
            || args[45..77] != own[72..104]
        {
            continue;
        }
        let Ok(data) = load_cell_data(index, Source::CellDep) else {
            return false;
        };
        let Ok(batch) = BatchCommitment::decode(&data) else {
            return false;
        };
        if found
            || batch.digest != own[72..104]
            || dep.out_point().tx_hash() != input.tx_hash()
            || load_cell_capacity(input_index, Source::Input).ok() != Some(batch.input_capacity)
            || !daowow_contracts_common::is_public_settlement_lock(&cell.lock(), &receipt_type)
        {
            return false;
        }
        found = true;
    }
    found
}

fn phase_one(cfg: &RoundConfigV1, group_abs: &[usize]) -> i8 {
    if group_abs.len() != 1 || !authenticated_deposit_receipt(cfg, group_abs[0]) {
        return err(DAO_ERROR_PHASE1_STRUCTURE);
    }
    for &ai in group_abs {
        // input must be a deposit cell of the native DAO type
        match load_cell_type_hash(ai, Source::Input) {
            Ok(Some(h)) => {
                if h != cfg.dao_type.code_hash {
                    return err(DAO_ERROR_PHASE1_STRUCTURE);
                }
            }
            _ => return err(DAO_ERROR_PHASE1_STRUCTURE),
        }
        let in_cap = match load_cell_capacity(ai, Source::Input) {
            Ok(c) => c,
            Err(_) => return err(DAO_ERROR_PHASE1_STRUCTURE),
        };
        // output at the same absolute index
        let out_cell = match load_cell(ai, Source::Output) {
            Ok(c) => c,
            Err(_) => return err(DAO_ERROR_PHASE1_STRUCTURE),
        };
        let out_cap = match load_cell_capacity(ai, Source::Output) {
            Ok(c) => c,
            Err(_) => return err(DAO_ERROR_PHASE1_STRUCTURE),
        };
        if in_cap != out_cap {
            return err(DAO_ERROR_PHASE1_STRUCTURE);
        }
        // type must remain the native DAO type
        match load_cell_type_hash(ai, Source::Output) {
            Ok(Some(h)) => {
                if h != cfg.dao_type.code_hash {
                    return err(DAO_ERROR_PHASE1_STRUCTURE);
                }
            }
            _ => return err(DAO_ERROR_PHASE1_STRUCTURE),
        }
        // lock substitution prohibited: same code hash, hash type and args
        let my_script = load_script().unwrap();
        let out_lock = out_cell.lock();
        let out_code: [u8; 32] = out_lock.code_hash().into();
        let my_code: [u8; 32] = my_script.code_hash().into();
        if out_code != my_code
            || u8::from(out_lock.hash_type()) != u8::from(my_script.hash_type())
            || out_lock.args().raw_data() != my_script.args().raw_data()
        {
            return err(DAO_ERROR_PHASE1_LOCK_SUBSTITUTION);
        }
        // data must become the deposit inclusion block number (LE64)
        let header = match load_header(ai, Source::Input) {
            Ok(h) => h,
            Err(_) => return err(DAO_ERROR_PHASE1_STRUCTURE),
        };
        let deposit_epoch: u64 = header.raw().epoch().unpack();
        let since = match ckb_std::high_level::load_input_since(ai, Source::Input) {
            Ok(s) => s,
            Err(_) => return err(DAO_ERROR_PHASE1_STRUCTURE),
        };
        if daowow_core::epoch::absolute_epoch_after_dao_term(
            since,
            deposit_epoch,
            cfg.dao_term_periods,
        )
        .is_err()
        {
            return err(DAO_ERROR_PHASE1_STRUCTURE);
        }
        let block_number: u64 = header.raw().number().unpack();
        let out_data = match load_cell_data(ai, Source::Output) {
            Ok(d) => d,
            Err(_) => return err(DAO_ERROR_PHASE1_STRUCTURE),
        };
        if out_data.len() != 8 || out_data != block_number.to_le_bytes() {
            return err(DAO_ERROR_PHASE1_STRUCTURE);
        }
    }
    0
}

fn phase_two(cfg: &RoundConfigV1, group_abs: &[usize]) -> i8 {
    if group_abs.len() != 1 {
        return err(DAO_ERROR_GROUP);
    }
    let script = match load_script() {
        Ok(s) => s,
        Err(_) => return err(DAO_ERROR_ARGS),
    };
    let args = script.args().raw_data();
    let batch_id = u64::from_le_bytes(args[32..40].try_into().unwrap());
    let digest: [u8; 32] = args[72..104].try_into().unwrap();
    if daowow_contracts_common::entitlements::require_initial_funding_type(cfg, batch_id, &digest)
        .is_none()
    {
        return err(DAO_ERROR_PHASE2_DESTINATION);
    }
    0
}

daowow_alloc!();
