//! DAOWOWRoundType — establishes a unique, immutable Round configuration.
//!
//! Creation: validates the canonical config (via daowow-core rules).
//! Update: the config data must be byte-identical (immutable during the
//! round; live state lives in shard/batch/settlement cells instead).
//! args: round_id (32 bytes, derived from first input and config output index).

#![no_std]
#![no_main]

use ckb_std::ckb_constants::Source;
use ckb_std::entry;
use ckb_std::high_level::{load_cell, load_cell_data};
use daowow_contracts_common::daowow_alloc;
use daowow_core::encoding::{RoundConfigV1, ROUND_CONFIG_SIZE};
use daowow_core::error::codes::*;

entry!(main);

fn err(e: i8) -> i8 {
    ckb_std::debug!("round-type error {}", e);
    e
}

fn main() -> i8 {
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
    let script = match ckb_std::high_level::load_script() {
        Ok(s) => s,
        Err(_) => return err(ROUND_ERROR_CONFIG),
    };
    if script.args().raw_data().as_ref() != config.round_id {
        return err(ROUND_ERROR_CONFIG);
    }

    if is_creation {
        // Creation: exactly one output cell of this type.
        if load_cell(1, Source::GroupOutput).is_ok() {
            return err(ROUND_ERROR_UPDATE);
        }
        let my_hash = match ckb_std::high_level::load_script_hash() {
            Ok(h) => h,
            Err(_) => return err(ROUND_ERROR_CONFIG),
        };
        let mut index = 0;
        loop {
            match ckb_std::high_level::load_cell_type_hash(index, Source::Output) {
                Ok(Some(h)) if h == my_hash => break,
                Ok(_) => index += 1,
                Err(_) => return err(ROUND_ERROR_CONFIG),
            }
        }
        if daowow_contracts_common::creation_round_id(index) != Some(config.round_id) {
            return err(ROUND_ERROR_CONFIG);
        }
        if daowow_contracts_common::creation_schedule(&config, index).is_none() {
            return err(ROUND_ERROR_CONFIG);
        }
        // All canonical shards must exist at the unique creation anchor.
        // Otherwise an immutable round can be permanently unfinalisable.
        let commitment = config.commitment();
        let mut seen = [false; 256];
        let mut count = 0u32;
        let mut output_index = 0;
        while let Ok(cell) = load_cell(output_index, Source::Output) {
            if let Some(shard_type) = cell.type_().to_opt() {
                let args = shard_type.args().raw_data();
                if daowow_contracts_common::script_matches(&shard_type, &config.entry_shard_type)
                    && args.len() == 36
                    && args[..32] == commitment
                {
                    let shard_id = u32::from_le_bytes(args[32..].try_into().unwrap());
                    if shard_id >= config.entry_shard_count || seen[shard_id as usize] {
                        return err(ROUND_ERROR_CONFIG);
                    }
                    seen[shard_id as usize] = true;
                    count += 1;
                }
            }
            output_index += 1;
        }
        if count != config.entry_shard_count {
            return err(ROUND_ERROR_CONFIG);
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
