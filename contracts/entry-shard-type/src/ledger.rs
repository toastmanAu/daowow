//! Ledger lifecycle, kept separate from accumulator append verification.
use ckb_std::{
    ckb_constants::Source,
    ckb_types::packed::Script,
    high_level::{load_cell, load_cell_data, load_input_since},
};
use daowow_contracts_common::{
    config_by_commitment,
    ledger::{is_public_lock, no_entry_inputs, validate_aggregation},
    script_matches,
};
use daowow_core::{
    encoding::{EntryShardDataV1, RoundConfigV1},
    error::codes::*,
    lifecycle::AggregationState,
};

fn config(
    script: &Script,
    commitment: &[u8; 32],
    round_id: &[u8; 32],
) -> Result<RoundConfigV1, i8> {
    let cfg = config_by_commitment(commitment, round_id, Source::CellDep)
        .ok_or(SHARD_ERROR_CONFIG_DEP)?;
    if !script_matches(script, &cfg.entry_shard_type) {
        return Err(SHARD_ERROR_CONFIG_DEP);
    }
    Ok(cfg)
}

pub fn transition(script: &Script) -> Result<i8, i8> {
    let args = script.args().raw_data();
    if args.len() != 36
        || load_cell(1, Source::GroupInput).is_ok()
        || load_cell(1, Source::GroupOutput).is_ok()
    {
        return Err(SHARD_ERROR_GROUP);
    }
    let input = load_cell(0, Source::GroupInput).map_err(|_| SHARD_ERROR_GROUP)?;
    let output = load_cell(0, Source::GroupOutput).map_err(|_| SHARD_ERROR_GROUP)?;
    let data = load_cell_data(0, Source::GroupOutput).map_err(|_| SHARD_ERROR_DATA)?;
    // Read only the embedded frozen round identity before authenticating config.
    let round: [u8; 32] = data.get(1..33).ok_or(SHARD_ERROR_DATA)?.try_into().unwrap();
    let commitment = args[..32].try_into().unwrap();
    let cfg = config(script, &commitment, &round)?;
    let after = AggregationState::decode(&data, &cfg).map_err(|_| SHARD_ERROR_DATA)?;
    if args[32..] != after.frozen().shard_id.to_le_bytes() {
        return Err(SHARD_ERROR_DATA);
    }
    let in_cap: u64 = input.capacity().into();
    let out_cap: u64 = output.capacity().into();
    if !is_public_lock(&input.lock(), &cfg)
        || !is_public_lock(&output.lock(), &cfg)
        || out_cap < in_cap
    {
        return Err(SHARD_ERROR_GROUP);
    }
    let data = load_cell_data(0, Source::GroupInput).map_err(|_| SHARD_ERROR_DATA)?;
    if let Ok(frozen) = EntryShardDataV1::decode(&data) {
        let expected = AggregationState::new(&cfg, &frozen).map_err(|_| SHARD_ERROR_STATE)?;
        if after != expected || !no_entry_inputs(&cfg) {
            return Err(SHARD_ERROR_STATE);
        }
    } else {
        let before = AggregationState::decode(&data, &cfg).map_err(|_| SHARD_ERROR_DATA)?;
        if before.is_closed() {
            if before != after || !no_entry_inputs(&cfg) {
                return Err(SHARD_ERROR_STATE);
            }
        } else if after.is_closed() {
            let since = load_input_since(0, Source::GroupInput).map_err(|_| SHARD_ERROR_STATE)?;
            if before.close(&cfg, since).map_err(|_| SHARD_ERROR_STATE)? != after
                || !no_entry_inputs(&cfg)
            {
                return Err(SHARD_ERROR_STATE);
            }
        } else {
            validate_aggregation(&cfg, before.frozen().shard_id)?;
        }
    }
    Ok(0)
}

pub fn receipt(script: &Script) -> Result<i8, i8> {
    let args = script.args().raw_data();
    if args.len() != 77
        || args[0] != 2
        || load_cell(0, Source::GroupInput).is_ok()
        || load_cell(1, Source::GroupOutput).is_ok()
        || load_cell(0, Source::GroupOutput).is_err()
    {
        return Err(SHARD_ERROR_GROUP);
    }
    let commitment: [u8; 32] = args[1..33].try_into().unwrap();
    let shard_id = u32::from_le_bytes(args[33..37].try_into().unwrap());
    let mut i = 0;
    while let Ok(cell) = load_cell(i, Source::Input) {
        if let Some(ty) = cell.type_().to_opt() {
            let ta = ty.args().raw_data();
            if ty.code_hash() == script.code_hash()
                && ty.hash_type() == script.hash_type()
                && ta.len() == 36
                && ta[..32] == commitment
                && ta[32..] == shard_id.to_le_bytes()
            {
                let data = load_cell_data(i, Source::Input).map_err(|_| SHARD_ERROR_DATA)?;
                let round = data.get(1..33).ok_or(SHARD_ERROR_DATA)?.try_into().unwrap();
                let cfg = config(script, &commitment, &round)?;
                let result = validate_aggregation(&cfg, shard_id)?;
                if args[37..45] != result.batch_id.to_le_bytes()
                    || args[45..] != result.batch.digest
                {
                    return Err(SHARD_ERROR_DATA);
                }
                return Ok(0);
            }
        }
        i += 1;
    }
    Err(SHARD_ERROR_GROUP)
}
