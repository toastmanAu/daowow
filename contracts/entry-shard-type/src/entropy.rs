//! Canonical seal -> scheduled chain-entropy record. No keeper-selected seed.
use ckb_std::{
    ckb_constants::Source,
    ckb_types::packed::Script,
    error::SysError,
    high_level::{load_cell, load_cell_data, load_header, load_input_since},
};
use daowow_contracts_common::{
    config_by_commitment,
    ledger::{is_public_lock, no_entry_inputs},
    script_matches,
};
use daowow_core::{
    error::codes::*,
    seal::{EntropyRecord, RoundSeal},
};

pub fn finalize(script: &Script) -> Result<i8, i8> {
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
    if before.first() != Some(&3) {
        return Err(SHARD_ERROR_STATE);
    }
    // The first snapshot's frozen round identity begins at seal byte 6.
    let round = before
        .get(6..38)
        .ok_or(SHARD_ERROR_DATA)?
        .try_into()
        .unwrap();
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
    let seal = RoundSeal::decode(&before, &cfg).map_err(|_| SHARD_ERROR_DATA)?;
    let since = load_input_since(0, Source::GroupInput).map_err(|_| SHARD_ERROR_STATE)?;
    if since >> 56 != 0x80 || since & 0x00ff_ffff_ffff_ffff < 256 {
        return Err(SHARD_ERROR_STATE);
    }
    let inclusion = load_header(0, Source::GroupInput).map_err(|_| SHARD_ERROR_DATA)?;
    let inclusion_height = u64::from(inclusion.raw().number());
    let inclusion_hash = inclusion.calc_header_hash();
    let schedule = RoundSeal::entropy_heights(inclusion_height).map_err(|_| SHARD_ERROR_STATE)?;
    let anchor = load_header(0, Source::HeaderDep).map_err(|_| SHARD_ERROR_DATA)?;
    if anchor.calc_header_hash() != inclusion_hash {
        return Err(SHARD_ERROR_DATA);
    }
    let mut hashes = [[0; 32]; 3];
    for i in 0..3 {
        let header = load_header(i + 1, Source::HeaderDep).map_err(|_| SHARD_ERROR_DATA)?;
        if u64::from(header.raw().number()) != schedule[i] {
            return Err(SHARD_ERROR_DATA);
        }
        hashes[i] = header.calc_header_hash().into();
    }
    if !matches!(
        load_header(4, Source::HeaderDep),
        Err(SysError::IndexOutOfBound)
    ) {
        return Err(SHARD_ERROR_DATA);
    }
    let expected = EntropyRecord::new(seal, inclusion_height, inclusion_hash.into(), hashes)
        .map_err(|_| SHARD_ERROR_DATA)?
        .encode();
    if load_cell_data(0, Source::GroupOutput).map_err(|_| SHARD_ERROR_DATA)? != expected {
        return Err(SHARD_ERROR_STATE);
    }
    Ok(0)
}
