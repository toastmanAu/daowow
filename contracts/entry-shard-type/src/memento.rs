//! Memento mode of the shard binary: args `[6] || commitment || shard_id ||
//! position`. Non-financial and authorizes nothing.
//!
//! Mint delegates every content check to the retiring claim of the same
//! identity, which has already loaded the sealed round to decide whether it may
//! retire. This mode asserts only the one fact the claim cannot assert on its
//! own behalf: that a claim of this exact ticket is being consumed here.
//! Transfer keeps data identical. Burn is free; there is nothing to discharge.

use ckb_std::ckb_constants::Source;
use ckb_std::ckb_types::packed::Script;
use ckb_std::high_level::{load_cell, load_cell_data};
use daowow_core::claim::ClaimArgs;
use daowow_core::error::codes::*;
use daowow_core::memento::{MementoArgs, MementoData};

fn err(e: i8) -> Result<i8, i8> {
    ckb_std::debug!("memento error {}", e);
    Err(e)
}

/// Count cells of `source` whose type script is this binary carrying `args`.
fn count_with_args(script: &Script, args: &[u8], source: Source) -> usize {
    let mut found = 0;
    let mut i = 0usize;
    while let Ok(cell) = load_cell(i, source) {
        if let Some(t) = cell.type_().to_opt() {
            if t.code_hash() == script.code_hash()
                && t.hash_type() == script.hash_type()
                && t.args().raw_data().as_ref() == args
            {
                found += 1;
            }
        }
        i += 1;
    }
    found
}

pub fn run(script: &Script) -> Result<i8, i8> {
    let args = match MementoArgs::decode(script.args().raw_data().as_ref()) {
        Ok(a) => a,
        Err(_) => return err(MEMENTO_ERROR_ARGS),
    };
    if load_cell(1, Source::GroupInput).is_ok() || load_cell(1, Source::GroupOutput).is_ok() {
        return err(MEMENTO_ERROR_GROUP);
    }
    let has_input = load_cell(0, Source::GroupInput).is_ok();
    let output = load_cell_data(0, Source::GroupOutput).ok();
    match (has_input, output) {
        (false, Some(data)) => {
            if MementoData::decode(&data).is_err() {
                return err(MEMENTO_ERROR_DATA);
            }
            let claim = ClaimArgs {
                commitment: args.commitment,
                shard_id: args.shard_id,
                position: args.position,
            }
            .encode();
            // Exactly one claim of this ticket goes in and none comes out:
            // it is retiring, and its script validates everything about us.
            if count_with_args(script, &claim, Source::Input) != 1
                || count_with_args(script, &claim, Source::Output) != 0
            {
                return err(MEMENTO_ERROR_MINT);
            }
            Ok(0)
        }
        (true, Some(data)) => {
            let input = match load_cell_data(0, Source::GroupInput) {
                Ok(d) => d,
                Err(_) => return err(MEMENTO_ERROR_DATA),
            };
            if input != data || MementoData::decode(&data).is_err() {
                return err(MEMENTO_ERROR_DATA);
            }
            Ok(0)
        }
        // Burn: non-financial, so the holder may always recover the capacity.
        (true, None) => Ok(0),
        (false, None) => err(MEMENTO_ERROR_GROUP),
    }
}
