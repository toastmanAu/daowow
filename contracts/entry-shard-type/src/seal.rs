//! One-time conversion of canonical shard zero into a closed-universe seal.
use ckb_std::{
    ckb_constants::Source,
    ckb_types::packed::Script,
    high_level::{load_cell, load_cell_data},
};
use daowow_contracts_common::{
    config_by_commitment,
    ledger::{is_public_lock, no_entry_inputs},
    script_matches,
};
use daowow_core::{error::codes::*, lifecycle::AggregationState, seal::RoundSeal};

pub fn create(script: &Script) -> Result<i8, i8> {
    let args = script.args().raw_data();
    if args.len() != 36
        || args[32..] != 0u32.to_le_bytes()
        || load_cell(1, Source::GroupInput).is_ok()
        || load_cell(1, Source::GroupOutput).is_ok()
    {
        return Err(SHARD_ERROR_GROUP);
    }
    let input = load_cell(0, Source::GroupInput).map_err(|_| SHARD_ERROR_GROUP)?;
    let output = load_cell(0, Source::GroupOutput).map_err(|_| SHARD_ERROR_GROUP)?;
    let before = load_cell_data(0, Source::GroupInput).map_err(|_| SHARD_ERROR_DATA)?;
    // A seal cannot serve as its own creation authority. Spending a seal is
    // forbidden until a separately authenticated draw successor is implemented.
    if before.len() != daowow_core::lifecycle::AGGREGATION_STATE_SIZE {
        return Err(SHARD_ERROR_STATE);
    }
    let round = before[1..33].try_into().unwrap();
    let commitment = args[..32].try_into().unwrap();
    let cfg =
        config_by_commitment(&commitment, &round, Source::CellDep).ok_or(SHARD_ERROR_CONFIG_DEP)?;
    if !script_matches(script, &cfg.entry_shard_type)
        || !no_entry_inputs(&cfg)
        || !is_public_lock(&input.lock(), &cfg)
        || !is_public_lock(&output.lock(), &cfg)
        || u64::from(output.capacity()) < u64::from(input.capacity())
    {
        return Err(SHARD_ERROR_GROUP);
    }
    let first = AggregationState::decode(&before, &cfg).map_err(|_| SHARD_ERROR_DATA)?;
    let seal = RoundSeal::decode(
        &load_cell_data(0, Source::GroupOutput).map_err(|_| SHARD_ERROR_DATA)?,
        &cfg,
    )
    .map_err(|_| SHARD_ERROR_DATA)?;
    if seal.ledger(0) != Some(&first) {
        return Err(SHARD_ERROR_STATE);
    }
    let mut seen = [false; 256];
    seen[0] = true;
    let mut index = 0;
    while let Ok(cell) = load_cell(index, Source::CellDep) {
        if let Some(ty) = cell.type_().to_opt() {
            let ta = ty.args().raw_data();
            if script_matches(&ty, &cfg.entry_shard_type)
                && ta.len() == 36
                && ta[..32] == commitment
            {
                let id = u32::from_le_bytes(ta[32..].try_into().unwrap());
                if id >= cfg.entry_shard_count
                    || seen[id as usize]
                    || !is_public_lock(&cell.lock(), &cfg)
                {
                    return Err(SHARD_ERROR_GROUP);
                }
                let state = AggregationState::decode(
                    &load_cell_data(index, Source::CellDep).map_err(|_| SHARD_ERROR_DATA)?,
                    &cfg,
                )
                .map_err(|_| SHARD_ERROR_DATA)?;
                if seal.ledger(id) != Some(&state) {
                    return Err(SHARD_ERROR_STATE);
                }
                seen[id as usize] = true;
            }
        }
        index += 1;
    }
    if seen[..cfg.entry_shard_count as usize]
        .iter()
        .any(|present| !present)
    {
        return Err(SHARD_ERROR_GROUP);
    }
    Ok(0)
}
