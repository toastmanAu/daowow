//! DAOWOWDAOLock — keeps pooled round funds non-custodial across the native
//! Nervos DAO lifecycle. The native DAO type script validates DAO mechanics;
//! this lock validates DAOWOW custody rules (see RFC-0023 and dao.c).
//!
//! args: round_id (32) || batch_id (8)
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
use daowow_contracts_common::daowow_alloc;
use ckb_std::entry;
use ckb_std::high_level::{
    load_cell, load_cell_capacity, load_cell_data, load_cell_type_hash, load_header, load_script,
};
use daowow_core::encoding::{
    RoundConfigV1, SettlementFundingDataV1, SETTLEMENT_FUNDING_SIZE,
};
use daowow_core::error::codes::*;

entry!(main);

fn err(e: i8) -> i8 {
    ckb_std::debug!("dao-lock error {}", e);
    e
}

fn config_for(round_id: &[u8; 32]) -> Option<RoundConfigV1> {
    let mut i = 0usize;
    loop {
        let cell = load_cell(i, Source::CellDep).ok()?;
        if let Some(t) = cell.type_().to_opt() {
            if t.args().raw_data().len() == 8 {
                if let Ok(data) = load_cell_data(i, Source::CellDep) {
                    if data.len() == daowow_core::encoding::ROUND_CONFIG_SIZE {
                        if let Ok(cfg) = RoundConfigV1::decode(&data) {
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

fn main() -> i8 {
    let script = match load_script() {
        Ok(s) => s,
        Err(_) => return err(DAO_ERROR_ARGS),
    };
    let args = script.args().raw_data();
    if args.len() != 40 {
        return err(DAO_ERROR_ARGS);
    }
    let round_id: [u8; 32] = args[..32].try_into().unwrap();
    let _batch_id: [u8; 8] = args[32..].try_into().unwrap();

    let cfg = match config_for(&round_id) {
        Some(c) => c,
        None => return err(DAO_ERROR_ARGS),
    };

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

fn phase_one(cfg: &RoundConfigV1, group_abs: &[usize]) -> i8 {
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
    for &ai in group_abs {
        // input must be a withdrawing cell (nonzero block number, DAO type)
        match load_cell_type_hash(ai, Source::Input) {
            Ok(Some(h)) => {
                if h != cfg.dao_type.code_hash {
                    return err(DAO_ERROR_PHASE2_DESTINATION);
                }
            }
            _ => return err(DAO_ERROR_PHASE2_DESTINATION),
        }
        let data = load_cell_data(ai, Source::Input).unwrap_or_default();
        if data.len() != 8 || data == [0u8; 8] {
            return err(DAO_ERROR_PHASE2_DESTINATION);
        }
    }

    // every DAO-typed output in the tx must be a settlement funding cell of
    // this round (protocol v0.2 section 14: realised capacity flows only to
    // authorised settlement state)
    let mut i = 0usize;
    loop {
        match load_cell_type_hash(i, Source::Output) {
            Ok(Some(h)) => {
                if h == cfg.dao_type.code_hash {
                    // DAO output that is not consumed from our group is only
                    // allowed if it is the same-index withdrawing cell of a
                    // group input (handled in phase 1); in phase 2 any DAO
                    // output is invalid.
                    return err(DAO_ERROR_PHASE2_DESTINATION);
                }
            }
            Ok(None) => {}
            Err(_) => break,
        }
        i += 1;
    }

    // at least one settlement funding cell bound to this round must exist
    let mut found_settlement = false;
    let mut i = 0usize;
    loop {
        let cell = match load_cell(i, Source::Output) {
            Ok(c) => c,
            Err(_) => break,
        };
        if let Some(t) = cell.type_().to_opt() {
            let code: [u8; 32] = t.code_hash().into();
            if code == cfg.settlement_type.code_hash && u8::from(t.hash_type()) == cfg.settlement_type.hash_type
            {
                let data = load_cell_data(i, Source::Output).unwrap_or_default();
                if data.len() == SETTLEMENT_FUNDING_SIZE {
                    if let Ok(f) = SettlementFundingDataV1::decode(&data) {
                        if f.round_id == cfg.round_id {
                            found_settlement = true;
                        }
                    }
                }
            }
        }
        i += 1;
    }
    if !found_settlement {
        return err(DAO_ERROR_PHASE2_DESTINATION);
    }
    0
}

daowow_alloc!();
