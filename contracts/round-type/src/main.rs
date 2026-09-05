//! DAOWOWRoundType — establishes a unique, immutable Round configuration.
//!
//! Creation: validates the canonical config (via daowow-core rules).
//! Update: the config data must be byte-identical (immutable during the
//! round; live state lives in shard/batch/settlement cells instead).
//! args: type_id (8 bytes, created by the round builder).

#![no_std]
#![no_main]

use daowow_contracts_common::daowow_alloc;
use ckb_std::entry;
use ckb_std::high_level::{load_cell, load_cell_data};
use ckb_std::ckb_constants::Source;
use daowow_core::error::codes::*;
use daowow_core::encoding::{RoundConfigV1, ROUND_CONFIG_SIZE};

entry!(main);

fn err(e: i8) -> i8 {
    ckb_std::debug!("round-type error {}", e);
    e
}

fn main() -> i8 {
    ckb_std::syscalls::debug(alloc::format!("MARK-X"));
    let h = ckb_std::high_level::load_script_hash();
    if h.is_err() {
        return -31;
    }
    let hh: [u8; 32] = h.unwrap();
    if hh[0] == 0xFE {
        return -32;
    }
    return 0; // BISECT raw syscalls only
    let mut buf = [0u8; 8];
    let r = ckb_std::syscalls::load_cell_data(&mut buf, 0, 0, Source::GroupOutput);
    ckb_std::debug!("MARK-2");
    let d = match r {
        Ok(len) => buf[..len].to_vec(),
        Err(_) => return -9,
    };
    if d.len() != daowow_core::encoding::ROUND_CONFIG_SIZE {
        return -3;
    }
    return 0; // BISECT A only
    // BISECT step B: load_cell (molecule parse)
    let _c = match load_cell(0, Source::GroupOutput) {
        Ok(c) => c,
        Err(_) => return -19,
    };
    return 0;
    // creation iff this type's group has no input counterpart
    let is_creation = load_cell(0, Source::GroupInput).is_err();
    let data = match load_cell_data(0, Source::GroupOutput) {
        Ok(d) => d,
        Err(_) => return err(ROUND_ERROR_CONFIG),
    };
    if data.len() != ROUND_CONFIG_SIZE {
        return err(ROUND_ERROR_CONFIG);
    }
    let config = match RoundConfigV1::decode(&data) {
        Ok(c) => c,
        Err(_) => return err(ROUND_ERROR_CONFIG),
    };
    if config.validate().is_err() {
        return err(ROUND_ERROR_CONFIG);
    }

    if is_creation {
        // Creation: exactly one output cell of this type.
        if load_cell(1, Source::Output).is_ok() {
            return err(ROUND_ERROR_UPDATE);
        }
        0
    } else {
        // Update: immutability of data; exactly one input/output in the group.
        if load_cell(1, Source::GroupOutput).is_ok() || load_cell(1, Source::GroupInput).is_ok() {
            return err(ROUND_ERROR_UPDATE);
        }
        let in_data = match load_cell_data(0, Source::GroupInput) {
            Ok(d) => d,
            Err(_) => return err(ROUND_ERROR_UPDATE),
        };
        if in_data != data {
            return err(ROUND_ERROR_UPDATE);
        }
        0
    }
}

daowow_alloc!();
