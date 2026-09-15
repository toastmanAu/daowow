//! Initial funding authorization shared by the DAO lock and settlement type.
//! All authorities are loaded from exact configured scripts; witness evidence
//! only supplies the preimages/proofs used by the pure entitlement constructor.
use alloc::vec;
use ckb_std::{
    ckb_constants::Source,
    ckb_types::{packed::WitnessArgsReader, prelude::*},
    high_level::{load_cell, load_cell_capacity, load_cell_data, load_cell_type_hash, load_header},
};
use daowow_core::{
    encoding::RoundConfigV1,
    entitlement_witness::{EntitlementWitness, MAX_ENTITLEMENT_BYTES},
    entitlements::{EntitlementInput, InitialEntitlements},
    hash::Hash32,
    lifecycle::BatchCommitment,
    seal::EntropyRecord,
};

/// DAO phase2 delegation guard: the exact configured settlement type must run
/// its creation branch. Its full validator below authenticates the withdrawal
/// and entitlements. A matching input would instead select its update branch.
pub fn require_initial_funding_type(
    cfg: &RoundConfigV1,
    batch_id: u64,
    digest: &Hash32,
) -> Option<()> {
    let mut i = 0;
    loop {
        let cell = match load_cell(i, Source::Input) {
            Ok(cell) => cell,
            Err(ckb_std::error::SysError::IndexOutOfBound) => break,
            Err(_) => return None,
        };
        if cell
            .type_()
            .to_opt()
            .is_some_and(|t| funding_type_matches(&t, cfg, batch_id, digest))
        {
            return None;
        }
        i += 1;
    }
    let mut found = false;
    let mut i = 0;
    loop {
        let cell = match load_cell(i, Source::Output) {
            Ok(cell) => cell,
            Err(ckb_std::error::SysError::IndexOutOfBound) => break,
            Err(_) => return None,
        };
        if let Some(t) = cell.type_().to_opt() {
            if funding_type_matches(&t, cfg, batch_id, digest) {
                if found || !crate::is_public_settlement_lock(&cell.lock(), &t) {
                    return None;
                }
                found = true;
            }
        }
        i += 1;
    }
    found.then_some(())
}

/// Validate exactly one withdrawal input and newly-created funding output for
/// this config/batch/digest. Called by the mandatory settlement creation type.
pub fn validate_initial_funding(cfg: &RoundConfigV1, batch_id: u64, digest: &Hash32) -> Option<()> {
    cfg.validate().ok()?;
    let commitment = cfg.commitment();
    let shard = (batch_id >> 56) as u32;
    if shard >= cfg.entry_shard_count {
        return None;
    }
    let mut input_index = None;
    let mut i = 0;
    while let Ok(cell) = load_cell(i, Source::Input) {
        if let Some(t) = cell.type_().to_opt() {
            if funding_type_matches(&t, cfg, batch_id, digest) {
                return None;
            }
        }
        let lock = cell.lock();
        let args = lock.args().raw_data();
        if crate::script_matches(&lock, &cfg.dao_lock)
            && args.len() == 104
            && args[..32] == cfg.round_id
            && args[32..40] == batch_id.to_le_bytes()
            && args[40..72] == commitment
            && args[72..104] == *digest
            && (input_index.replace(i).is_some()
                || load_cell_type_hash(i, Source::Input).ok()? != Some(cfg.dao_type.code_hash))
        {
            return None;
        }
        i += 1;
    }
    let input_count = i;
    let input_index = input_index?;
    let data = load_cell_data(input_index, Source::Input).ok()?;
    if data.len() != 8 || data == [0; 8] {
        return None;
    }

    let mut receipt = None;
    let mut entropy = None;
    let mut i = 0;
    while let Ok(cell) = load_cell(i, Source::CellDep) {
        if let Some(t) = cell.type_().to_opt() {
            if crate::script_matches(&t, &cfg.entry_shard_type) {
                let args = t.args().raw_data();
                if args.len() == 77
                    && args[0] == 2
                    && args[1..33] == commitment
                    && args[33..37] == shard.to_le_bytes()
                    && args[37..45] == batch_id.to_le_bytes()
                    && args[45..77] == *digest
                {
                    if receipt.is_some() || !crate::is_public_settlement_lock(&cell.lock(), &t) {
                        return None;
                    }
                    let r =
                        BatchCommitment::decode(&load_cell_data(i, Source::CellDep).ok()?).ok()?;
                    if r.digest != *digest
                        || r.input_capacity
                            != load_cell_capacity(input_index, Source::Input).ok()?
                    {
                        return None;
                    }
                    receipt = Some(r);
                }
                if args.len() == 36 && args[..32] == commitment && args[32..] == [0; 4] {
                    if entropy.is_some() || !crate::is_public_settlement_lock(&cell.lock(), &t) {
                        return None;
                    }
                    entropy = Some(
                        EntropyRecord::decode(&load_cell_data(i, Source::CellDep).ok()?, cfg)
                            .ok()?,
                    );
                }
            }
        }
        i += 1;
    }
    let receipt = receipt?;
    let entropy = entropy?;
    // One allocation for the complete witness; borrow its Molecule fields and
    // proof bytes instead of cloning a potentially large payload several times.
    let size = match ckb_std::syscalls::load_witness(&mut [], 0, input_index, Source::Input) {
        Err(ckb_std::error::SysError::LengthNotEnough(size)) => size,
        _ => return None,
    };
    if size > MAX_ENTITLEMENT_BYTES + 1024 {
        return None;
    }
    let mut bytes = vec![0u8; size];
    if ckb_std::syscalls::load_witness(&mut bytes, 0, input_index, Source::Input).ok()? != size {
        return None;
    }
    let witness = WitnessArgsReader::from_slice(&bytes).ok()?;
    let input_type = witness.input_type().to_opt()?;
    let header_index =
        usize::try_from(u64::from_le_bytes(input_type.raw_data().try_into().ok()?)).ok()?;
    let output_type = witness.output_type().to_opt()?;
    // Large proof sets cannot inhabit the native DAO input witness. Tag0
    // references an extra raw witness; version1 inline payloads remain valid.
    // Neither transport carries trusted claims: all evidence is derived below.
    let reference = output_type.raw_data();
    let detached;
    let payload = if reference.first() == Some(&0) {
        if reference.len() != 5 {
            return None;
        }
        let index = u32::from_le_bytes(reference[1..].try_into().ok()?) as usize;
        if index < input_count {
            return None;
        }
        let size = match ckb_std::syscalls::load_witness(&mut [], 0, index, Source::Input) {
            Err(ckb_std::error::SysError::LengthNotEnough(size)) => size,
            _ => return None,
        };
        if size > MAX_ENTITLEMENT_BYTES {
            return None;
        }
        detached = {
            let mut buffer = vec![0u8; size];
            if ckb_std::syscalls::load_witness(&mut buffer, 0, index, Source::Input).ok()? != size {
                return None;
            }
            buffer
        };
        detached.as_slice()
    } else {
        reference
    };
    let evidence = EntitlementWitness::decode(payload).ok()?;
    let realized = realized_capacity(input_index, &data, header_index)?;
    let winners = evidence.winner_proofs();
    let input = EntitlementInput {
        batch_id,
        receipt: &receipt,
        entries: evidence.entries(),
        capacities: evidence.capacities(),
        realized_total: realized,
        winners: &winners,
    };
    let expected = InitialEntitlements::derive(cfg, &entropy, evidence.schedule(), &input).ok()?;

    let mut found = false;
    let mut i = 0;
    while let Ok(cell) = load_cell(i, Source::Output) {
        if load_cell_type_hash(i, Source::Output).ok()? == Some(cfg.dao_type.code_hash) {
            return None;
        }
        if let Some(t) = cell.type_().to_opt() {
            if funding_type_matches(&t, cfg, batch_id, digest) {
                if found
                    || !crate::is_public_settlement_lock(&cell.lock(), &t)
                    || load_cell_capacity(i, Source::Output).ok()? != realized
                    || load_cell_data(i, Source::Output).ok()?.as_slice()
                        != expected.funding().encode()
                {
                    return None;
                }
                found = true;
            }
        }
        i += 1;
    }
    found.then_some(())
}

fn funding_type_matches(
    script: &ckb_std::ckb_types::packed::Script,
    cfg: &RoundConfigV1,
    batch_id: u64,
    digest: &Hash32,
) -> bool {
    let args = script.args().raw_data();
    crate::script_matches(script, &cfg.settlement_type)
        && args.len() == 72
        && args[..32] == cfg.commitment()
        && args[32..40] == batch_id.to_le_bytes()
        && args[40..72] == *digest
}

/// Native DAO's per-cell floor division over unoccupied capacity. Its input
/// type also executes and enforces native maturity/withdrawal rules.
fn realized_capacity(index: usize, data: &[u8], header_index: usize) -> Option<u64> {
    let deposit = load_header(header_index, Source::HeaderDep).ok()?;
    let deposit_number: u64 = deposit.raw().number().unpack();
    if data != deposit_number.to_le_bytes() {
        return None;
    }
    let withdrawal = load_header(index, Source::Input).ok()?;
    let deposit_dao = deposit.raw().dao().raw_data();
    let withdrawal_dao = withdrawal.raw().dao().raw_data();
    let deposit_ar = u64::from_le_bytes(deposit_dao[8..16].try_into().ok()?);
    let withdrawal_ar = u64::from_le_bytes(withdrawal_dao[8..16].try_into().ok()?);
    if deposit_ar == 0 || withdrawal_ar < deposit_ar {
        return None;
    }
    let capacity = load_cell_capacity(index, Source::Input).ok()?;
    let occupied = ckb_std::high_level::load_cell_occupied_capacity(index, Source::Input).ok()?;
    let counted = capacity.checked_sub(occupied)?;
    let compensated =
        u128::from(counted).checked_mul(u128::from(withdrawal_ar))? / u128::from(deposit_ar);
    occupied.checked_add(u64::try_from(compensated).ok()?)
}
