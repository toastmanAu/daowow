//! Transaction-wide authentication shared by shard, receipt, and entry scripts.
use crate::script_matches;
use alloc::vec::Vec;
use ckb_std::{
    ckb_constants::Source,
    high_level::{load_cell, load_cell_data, load_cell_type_hash, load_witness},
};
use daowow_core::{
    encoding::{EntryDataV1, RoundConfigV1},
    error::codes::*,
    lifecycle::{AggregationState, BatchCommitment},
    witness::decode_ledger_witness,
};

pub struct ValidatedAggregation {
    pub input_indices: Vec<usize>,
    pub next: AggregationState,
    pub batch: BatchCommitment,
    pub batch_id: u64,
}

pub fn is_public_lock(lock: &ckb_std::ckb_types::packed::Script, cfg: &RoundConfigV1) -> bool {
    script_matches(lock, &cfg.entry_shard_type) && lock.args().raw_data().as_ref() == [0]
}

pub fn no_entry_inputs(cfg: &RoundConfigV1) -> bool {
    let mut i = 0;
    while let Ok(cell) = load_cell(i, Source::Input) {
        if script_matches(&cell.lock(), &cfg.entry_lock) {
            return false;
        }
        i += 1;
    }
    true
}

pub fn validate_aggregation(
    cfg: &RoundConfigV1,
    shard_id: u32,
) -> Result<ValidatedAggregation, i8> {
    let commitment = cfg.commitment();
    let mut shard_indices = [None, None];
    for (slot, source) in [Source::Input, Source::Output].into_iter().enumerate() {
        let mut i = 0;
        while let Ok(cell) = load_cell(i, source) {
            if let Some(ty) = cell.type_().to_opt() {
                let args = ty.args().raw_data();
                if script_matches(&ty, &cfg.entry_shard_type) && args.len() == 36 {
                    if args[..32] != commitment
                        || args[32..] != shard_id.to_le_bytes()
                        || shard_indices[slot].is_some()
                        || !is_public_lock(&cell.lock(), cfg)
                    {
                        return Err(SHARD_ERROR_GROUP);
                    }
                    shard_indices[slot] = Some(i);
                }
            }
            i += 1;
        }
    }
    let input = shard_indices[0].ok_or(SHARD_ERROR_GROUP)?;
    let output = shard_indices[1].ok_or(SHARD_ERROR_GROUP)?;
    let before = AggregationState::decode(
        &load_cell_data(input, Source::Input).map_err(|_| SHARD_ERROR_DATA)?,
        cfg,
    )
    .map_err(|_| SHARD_ERROR_DATA)?;
    if before.frozen().shard_id != shard_id {
        return Err(SHARD_ERROR_DATA);
    }
    let in_cap: u64 = load_cell(input, Source::Input)
        .map_err(|_| SHARD_ERROR_GROUP)?
        .capacity()
        .into();
    let out_cap: u64 = load_cell(output, Source::Output)
        .map_err(|_| SHARD_ERROR_GROUP)?
        .capacity()
        .into();
    if out_cap < in_cap {
        return Err(SHARD_ERROR_GROUP);
    }
    let witness = load_witness(input, Source::Input).map_err(|_| SHARD_ERROR_DATA)?;
    let records = decode_ledger_witness(&witness).map_err(|_| SHARD_ERROR_DATA)?;
    let mut actual = Vec::new();
    let mut i = 0;
    while let Ok(cell) = load_cell(i, Source::Input) {
        if script_matches(&cell.lock(), &cfg.entry_lock) {
            actual.push(i);
        }
        i += 1;
    }
    if actual.len() != records.len() {
        return Err(SHARD_ERROR_GROUP);
    }
    let mut entries = Vec::new();
    let mut capacities = Vec::new();
    let mut proofs = Vec::new();
    let mut input_indices = Vec::new();
    for record in &records {
        let index = record.input_index as usize;
        if !actual.contains(&index) || input_indices.contains(&index) {
            return Err(SHARD_ERROR_GROUP);
        }
        let cell = load_cell(index, Source::Input).map_err(|_| SHARD_ERROR_GROUP)?;
        let entry = EntryDataV1::decode(
            &load_cell_data(index, Source::Input).map_err(|_| SHARD_ERROR_DATA)?,
        )
        .map_err(|_| SHARD_ERROR_DATA)?;
        let lock = cell.lock();
        let args = lock.args().raw_data();
        if args.len() != 64
            || args[32..] != commitment
            || args[..32] != entry.participant_lock_hash
            || cell.type_().to_opt().is_some()
            || entry.round_id != cfg.round_id
            || entry.shard_id != shard_id
        {
            return Err(SHARD_ERROR_DATA);
        }
        input_indices.push(index);
        entries.push(entry);
        capacities.push(cell.capacity().into());
        proofs.push(record.proof);
    }
    let batch_id = before.next_batch_id().map_err(|_| SHARD_ERROR_STATE)?;
    let (next, batch) = before
        .accept(cfg, &entries, &capacities, &proofs)
        .map_err(|_| SHARD_ERROR_STATE)?;
    if load_cell_data(output, Source::Output)
        .map_err(|_| SHARD_ERROR_DATA)?
        .as_slice()
        != next.encode()
    {
        return Err(SHARD_ERROR_STATE);
    }
    let mut dao_args = Vec::new();
    dao_args.extend_from_slice(&cfg.round_id);
    dao_args.extend_from_slice(&batch_id.to_le_bytes());
    dao_args.extend_from_slice(&commitment);
    dao_args.extend_from_slice(&batch.digest);
    let mut receipt_args = Vec::new();
    receipt_args.push(2);
    receipt_args.extend_from_slice(&commitment);
    receipt_args.extend_from_slice(&shard_id.to_le_bytes());
    receipt_args.extend_from_slice(&batch_id.to_le_bytes());
    receipt_args.extend_from_slice(&batch.digest);
    let mut dao_count = 0;
    let mut receipt_count = 0;
    let mut i = 0;
    while let Ok(cell) = load_cell(i, Source::Output) {
        let lock = cell.lock();
        if script_matches(&lock, &cfg.dao_lock)
            && lock.args().raw_data().as_ref() == dao_args.as_slice()
        {
            dao_count += 1;
            let cap: u64 = cell.capacity().into();
            if cap != batch.input_capacity
                || load_cell_type_hash(i, Source::Output).ok() != Some(Some(cfg.dao_type.code_hash))
                || load_cell_data(i, Source::Output)
                    .map_err(|_| SHARD_ERROR_DATA)?
                    .as_slice()
                    != [0; 8]
            {
                return Err(SHARD_ERROR_DATA);
            }
        }
        if let Some(ty) = cell.type_().to_opt() {
            if script_matches(&ty, &cfg.entry_shard_type)
                && ty.args().raw_data().as_ref() == receipt_args.as_slice()
            {
                receipt_count += 1;
                if !is_public_lock(&lock, cfg)
                    || load_cell_data(i, Source::Output)
                        .map_err(|_| SHARD_ERROR_DATA)?
                        .as_slice()
                        != batch.encode()
                {
                    return Err(SHARD_ERROR_DATA);
                }
            }
        }
        i += 1;
    }
    if dao_count != 1 || receipt_count != 1 {
        return Err(SHARD_ERROR_GROUP);
    }
    Ok(ValidatedAggregation {
        input_indices,
        next,
        batch,
        batch_id,
    })
}
