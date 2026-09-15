//! Claim mode of the shard binary: args `[5] || commitment || shard_id || position`.
//!
//! Mint delegates counting to the OPEN shard transition of the same identity,
//! which must be present as input and output. Transfer keeps data identical.
//! Any data change (redemption) or burn (retirement) is rejected until the
//! sub-projects that authenticate them exist.

use ckb_std::ckb_constants::Source;
use ckb_std::ckb_types::packed::Script;
use ckb_std::high_level::{load_cell, load_cell_data};
use daowow_core::claim::{initial_state_bytes, validate_transfer, ClaimArgs};
use daowow_core::encoding::SHARD_DATA_SIZE;
use daowow_core::error::codes::*;
use daowow_core::CoreError;

fn err(e: i8) -> Result<i8, i8> {
    ckb_std::debug!("claim error {}", e);
    Err(e)
}

/// Data length without allocating the whole cell data.
fn data_len(index: usize, source: Source) -> Option<usize> {
    let mut probe = [0u8; 1];
    match ckb_std::syscalls::load_cell_data(&mut probe, 0, index, source) {
        Ok(size) | Err(ckb_std::error::SysError::LengthNotEnough(size)) => Some(size),
        Err(_) => None,
    }
}

/// True when `source` holds an OPEN/FROZEN shard cell of this binary whose
/// args are exactly `commitment || shard_id`.
fn shard_present(script: &Script, args: &ClaimArgs, source: Source) -> bool {
    let mut expect = [0u8; 36];
    expect[..32].copy_from_slice(&args.commitment);
    expect[32..].copy_from_slice(&args.shard_id.to_le_bytes());
    let mut i = 0;
    while let Ok(cell) = load_cell(i, source) {
        if let Some(t) = cell.type_().to_opt() {
            if t.code_hash() == script.code_hash()
                && t.hash_type() == script.hash_type()
                && t.args().raw_data().as_ref() == expect
                && data_len(i, source) == Some(SHARD_DATA_SIZE)
            {
                return true;
            }
        }
        i += 1;
    }
    false
}

pub fn run(script: &Script) -> Result<i8, i8> {
    let args = match ClaimArgs::decode(script.args().raw_data().as_ref()) {
        Ok(a) => a,
        Err(_) => return err(CLAIM_ERROR_ARGS),
    };
    if load_cell(1, Source::GroupInput).is_ok() || load_cell(1, Source::GroupOutput).is_ok() {
        return err(CLAIM_ERROR_GROUP);
    }
    let has_input = load_cell(0, Source::GroupInput).is_ok();
    let output = load_cell_data(0, Source::GroupOutput).ok();
    match (has_input, output) {
        (false, Some(data)) => {
            if !shard_present(script, &args, Source::Input)
                || !shard_present(script, &args, Source::Output)
            {
                return err(CLAIM_ERROR_MINT);
            }
            if data.as_ref() != initial_state_bytes(&args) {
                return err(CLAIM_ERROR_DATA);
            }
            Ok(0)
        }
        (true, Some(data)) => {
            let input = match load_cell_data(0, Source::GroupInput) {
                Ok(d) => d,
                Err(_) => return err(CLAIM_ERROR_DATA),
            };
            match validate_transfer(&args, &input, &data) {
                Ok(()) => Ok(0),
                Err(CoreError::StateTransition) => err(CLAIM_ERROR_TRANSITION),
                Err(_) => err(CLAIM_ERROR_DATA),
            }
        }
        (true, None) => err(CLAIM_ERROR_RETIRE),
        (false, None) => err(CLAIM_ERROR_GROUP),
    }
}
