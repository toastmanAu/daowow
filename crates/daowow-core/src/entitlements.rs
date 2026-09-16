//! Pure initial liabilities. Chain provenance and actual DAO realization must
//! be authenticated by the contract caller, not inferred from these structs.
use crate::{
    computed_draw::WinnerProof,
    encoding::{EntryDataV1, PayoutItem, RoundConfigV1, SettlementFundingDataV3},
    lifecycle::BatchCommitment,
    schedule::PrizeSchedule,
    seal::EntropyRecord,
    CoreError,
};
use alloc::{collections::BTreeMap, vec::Vec};

/// Complete evidence for one batch. The receipt must be loaded from its
/// enforcing canonical type and realized_total calculated from native DAO
/// inputs/headers by the caller. Witness-provided values alone are not trusted.
pub struct EntitlementInput<'a> {
    /// Must match the batch identity in the canonical receipt's type args and
    /// actual DAO input lock args; the receipt payload alone does not bind it.
    pub batch_id: u64,
    pub receipt: &'a BatchCommitment,
    pub entries: &'a [EntryDataV1],
    pub capacities: &'a [u64],
    pub realized_total: u64,
    pub winners: &'a [WinnerProof<'a>],
}

#[derive(Debug, PartialEq, Eq)]
/// Deterministically derived immutable initial funding and sorted liabilities.
pub struct InitialEntitlements {
    funding: SettlementFundingDataV3,
    liabilities: Vec<PayoutItem>,
}

impl InitialEntitlements {
    /// Replay the entire batch, authenticate winner ownership, allocate actual
    /// growth, and rebuild the liability MMR. Never accepts a claimed root/count.
    /// Provenance of the config, entropy, receipt and DAO amount is a separate
    /// mandatory contract boundary. Rejects malformed evidence and overflow.
    pub fn derive(
        cfg: &RoundConfigV1,
        record: &EntropyRecord,
        schedule: &PrizeSchedule,
        input: &EntitlementInput<'_>,
    ) -> Result<Self, CoreError> {
        use crate::{accumulator::mmr, computed_draw::ComputedDraw, leaf::liability_leaf};
        let draw = ComputedDraw::new(cfg, record, schedule)?;
        validate_batch(cfg, record, input)?;
        let principal_total = input.receipt.input_capacity;
        let prize_pool = input
            .realized_total
            .checked_sub(principal_total)
            .ok_or(CoreError::Conservation)?;
        let owners = draw.verify_winners(input.winners)?;
        let mut amounts: BTreeMap<crate::hash::Hash32, (u64, u64)> = BTreeMap::new();
        for (e, capacity) in input.entries.iter().zip(input.capacities) {
            let item = amounts.entry(e.participant_lock_hash).or_default();
            item.0 = item.0.checked_add(*capacity).ok_or(CoreError::Overflow)?;
        }
        if draw.is_success() {
            for (owner, prize) in owners
                .into_iter()
                .zip(schedule.allocate(draw.total_tickets(), prize_pool)?)
            {
                if prize != 0 {
                    let item = amounts.entry(owner).or_default();
                    item.1 = item.1.checked_add(prize).ok_or(CoreError::Overflow)?;
                }
            }
        } else {
            // Consolidate BEFORE division so entry splitting cannot bias dust.
            let mut assigned = 0u64;
            for (principal, prize) in amounts.values_mut() {
                *prize = (u128::from(prize_pool) * u128::from(*principal)
                    / u128::from(principal_total)) as u64;
                assigned = assigned.checked_add(*prize).ok_or(CoreError::Overflow)?;
            }
            let residual = prize_pool
                .checked_sub(assigned)
                .ok_or(CoreError::Conservation)?;
            if residual >= amounts.len() as u64 {
                return Err(CoreError::Conservation);
            }
            for (_, prize) in amounts.values_mut().take(residual as usize) {
                *prize = prize.checked_add(1).ok_or(CoreError::Overflow)?;
            }
        }
        let mut liabilities = Vec::with_capacity(amounts.len());
        let mut peaks = [[0u8; 32]; mmr::MAX_PEAKS];
        let mut sum = 0u64;
        for (hash, (principal, prize)) in amounts {
            let owed = principal.checked_add(prize).ok_or(CoreError::Overflow)?;
            if owed == 0 {
                return Err(CoreError::Conservation);
            }
            sum = sum.checked_add(owed).ok_or(CoreError::Overflow)?;
            let count = liabilities.len() as u64;
            peaks = mmr::append_peaks(
                &peaks[..mmr::peaks_shape(count)?],
                count,
                &liability_leaf(&hash, principal, prize),
            )?;
            liabilities.push(PayoutItem {
                participant_lock_hash: hash,
                principal,
                prize,
            });
        }
        if sum != input.realized_total || liabilities.is_empty() {
            return Err(CoreError::Conservation);
        }
        let count = liabilities.len() as u64;
        let root = mmr::bag_peaks(&peaks[..mmr::peaks_shape(count)?])?;
        Ok(Self {
            funding: SettlementFundingDataV3 {
                round_id: cfg.round_id,
                batch_id: input.batch_id,
                realized_total: input.realized_total,
                principal_liability: principal_total,
                prize_pool,
                payout_cursor: 0,
                liability_count: count,
                liabilities_root: root,
                prize_count: 0,
                prize_root: [0; 32],
                prize_paid: 0,
            },
            liabilities,
        })
    }
    /// Immutable initial state to compare byte-for-byte with the funding cell.
    pub fn funding(&self) -> &SettlementFundingDataV3 {
        &self.funding
    }
    /// Unique participant hashes in ascending order, each with full principal
    /// capacity and its consolidated prize or failed-round yield allocation.
    pub fn liabilities(&self) -> &[PayoutItem] {
        &self.liabilities
    }
}

fn validate_batch(
    cfg: &RoundConfigV1,
    record: &EntropyRecord,
    input: &EntitlementInput<'_>,
) -> Result<(), CoreError> {
    use crate::{hash::Blake2b256, lifecycle::MAX_BATCH_ENTRIES};
    let entries = input.entries;
    if entries.is_empty()
        || entries.len() > MAX_BATCH_ENTRIES
        || entries.len() != input.capacities.len()
    {
        return Err(CoreError::StateTransition);
    }
    let shard = (input.batch_id >> 56) as u32;
    let ordinal = input.batch_id & ((1u64 << 56) - 1);
    let ledger = record
        .seal()
        .ledger(shard)
        .ok_or(CoreError::StateTransition)?;
    let r = input.receipt;
    if ordinal >= ledger.accepted_batches()
        || r.first_nonce < ordinal
        || u128::from(r.first_nonce) > u128::from(ordinal) * MAX_BATCH_ENTRIES as u128
        || r.first_nonce
            .checked_add(entries.len() as u64)
            .ok_or(CoreError::Overflow)?
            > ledger.accepted_entries()
    {
        return Err(CoreError::StateTransition);
    }
    let mut hash = Blake2b256::new();
    hash.update(b"DAOWOW_ENTRY_BATCH_V2");
    hash.update(&cfg.commitment());
    hash.update(&shard.to_le_bytes());
    hash.update(&(entries.len() as u32).to_le_bytes());
    let mut expected = BatchCommitment {
        digest: [0; 32],
        first_nonce: r.first_nonce,
        entry_count: entries.len() as u64,
        ticket_count: 0,
        principal: 0,
        input_capacity: 0,
    };
    let mut position = entries[0].position_base;
    if ordinal == 0 && position != 0 {
        return Err(CoreError::StateTransition);
    }
    for (i, (entry, capacity)) in entries.iter().zip(input.capacities).enumerate() {
        if entry.round_id != cfg.round_id
            || entry.shard_id != shard
            || entry.entry_nonce
                != r.first_nonce
                    .checked_add(i as u64)
                    .ok_or(CoreError::Overflow)?
            || entry.position_base != position
            || entry.ticket_count == 0
            || entry.ticket_count.checked_mul(cfg.ticket_price) != Some(entry.principal)
            || *capacity < entry.principal
        {
            return Err(CoreError::StateTransition);
        }
        position = position
            .checked_add(entry.ticket_count)
            .ok_or(CoreError::Overflow)?;
        if position > ledger.accepted_tickets() {
            return Err(CoreError::StateTransition);
        }
        expected.ticket_count = expected
            .ticket_count
            .checked_add(entry.ticket_count)
            .ok_or(CoreError::Overflow)?;
        expected.principal = expected
            .principal
            .checked_add(entry.principal)
            .ok_or(CoreError::Overflow)?;
        expected.input_capacity = expected
            .input_capacity
            .checked_add(*capacity)
            .ok_or(CoreError::Overflow)?;
        hash.update(&entry.encode());
        hash.update(&capacity.to_le_bytes());
    }
    expected.digest = hash.finalize();
    if expected != *r {
        return Err(CoreError::StateTransition);
    }
    Ok(())
}

#[cfg(test)]
mod tests;
