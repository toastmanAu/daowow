//! Shannon-exact accounting helpers. All values are u64 shannons; every
//! operation is overflow-checked. These functions are the single source of
//! truth for the conservation rules (protocol v0.2 section 11).

use crate::error::CoreError;

#[cfg(not(feature = "std"))]
use alloc::vec::Vec;
#[cfg(feature = "std")]
use std::vec::Vec;

/// entry principal for a ticket count at a fixed ticket price
pub fn entry_principal(ticket_price: u64, ticket_count: u64) -> Result<u64, CoreError> {
    ticket_price
        .checked_mul(ticket_count)
        .ok_or(CoreError::Overflow)
}

pub fn checked_sum(values: &[u64]) -> Result<u64, CoreError> {
    let mut acc: u64 = 0;
    for v in values {
        acc = acc.checked_add(*v).ok_or(CoreError::Overflow)?;
    }
    Ok(acc)
}

/// gross_yield = gross_withdrawal - total_principal  (must not go negative)
pub fn gross_yield(gross_withdrawal: u64, total_principal: u64) -> Result<u64, CoreError> {
    gross_withdrawal
        .checked_sub(total_principal)
        .ok_or(CoreError::Conservation)
}

/// Settlement conservation:
///   inputs == principal payouts + prize payouts + authorised costs + fee + residual
pub fn settlement_conservation(
    inputs: u64,
    principal_payouts: u64,
    prize_payouts: u64,
    authorised_costs: u64,
    tx_fee: u64,
    residual_capacity: u64,
) -> Result<(), CoreError> {
    let outputs = checked_sum(&[
        principal_payouts,
        prize_payouts,
        authorised_costs,
        tx_fee,
        residual_capacity,
    ])?;
    if outputs != inputs {
        return Err(CoreError::Conservation);
    }
    Ok(())
}

/// Prize allocation by weight with shannon-exact rounding.
///
/// Each prize i receives floor(pool * w_i / W); the remainder (dust) is NOT
/// distributable as prize money and must be surfaced explicitly (it stays in
/// the residual capacity, never to an operator).
pub fn allocate_prizes(weights: &[u64], pool: u64) -> Result<(Vec<u64>, u64), CoreError> {
    let total_w = checked_sum(weights)?;
    if total_w == 0 {
        return Err(CoreError::InvalidArgument);
    }
    let mut out = Vec::with_capacity(weights.len());
    for w in weights {
        let amount = ((pool as u128) * (*w as u128) / (total_w as u128)) as u64;
        out.push(amount);
    }
    let allocated = checked_sum(&out)?;
    let dust = pool.checked_sub(allocated).ok_or(CoreError::Conservation)?;
    Ok((out, dust))
}

/// Complete allocation for the approved authenticated-entitlement policy.
/// All prize weights must be positive. Every rounding Shannon goes to prize
/// index zero; no unowned residual remains. Callers must authenticate the
/// schedule and derive the pool from realised growth, not participant capacity.
pub fn allocate_prizes_complete(weights: &[u64], pool: u64) -> Result<Vec<u64>, CoreError> {
    if weights.is_empty() || weights.contains(&0) {
        return Err(CoreError::InvalidArgument);
    }
    let (mut amounts, dust) = allocate_prizes(weights, pool)?;
    amounts[0] = amounts[0].checked_add(dust).ok_or(CoreError::Overflow)?;
    Ok(amounts)
}

/// Validate tiling within a single position space (normally one shard).
/// Entry position_base is shard-local. Use validate_frozen_positions before
/// mapping a multi-shard round to its global draw universe.
pub fn validate_position_tiling(
    entries: &[(u64, u64)], // (position_base, ticket_count)
) -> Result<(), CoreError> {
    let mut expected: u64 = 0;
    // sort by position_base (insertion sort; entry counts are bounded)
    let mut sorted: Vec<(u64, u64)> = entries.to_vec();
    sorted.sort_unstable();
    for (base, count) in &sorted {
        if *base != expected {
            return Err(CoreError::Conservation);
        }
        expected = expected.checked_add(*count).ok_or(CoreError::Overflow)?;
    }
    Ok(())
}

/// Validate the complete frozen round and return one global prefix per shard
/// ID. Entry ranges and nonces are local; global_base = prefixes[shard_id] +
/// entry.position_base. Reject omitted/duplicate shards, entries or counters.
pub fn validate_frozen_positions(
    round_id: &[u8; 32],
    shard_count: u32,
    shards: &[crate::encoding::EntryShardDataV1],
    entries: &[crate::encoding::EntryDataV1],
) -> Result<Vec<u64>, CoreError> {
    use crate::encoding::SHARD_STATE_FROZEN;
    if shard_count == 0 || shard_count > 256 || shards.len() != shard_count as usize {
        return Err(CoreError::InvalidArgument);
    }
    if entries
        .iter()
        .any(|e| e.round_id != *round_id || e.shard_id >= shard_count || e.ticket_count == 0)
    {
        return Err(CoreError::StateTransition);
    }
    let mut offsets = Vec::with_capacity(shards.len());
    let mut total = 0u64;
    for id in 0..shard_count {
        let mut matches = shards.iter().filter(|s| s.shard_id == id);
        let s = matches.next().ok_or(CoreError::Conservation)?;
        if matches.next().is_some() || s.round_id != *round_id || s.state != SHARD_STATE_FROZEN {
            return Err(CoreError::StateTransition);
        }
        let mut local: Vec<_> = entries.iter().filter(|e| e.shard_id == id).collect();
        local.sort_unstable_by_key(|e| e.entry_nonce);
        if local.len() as u64 != s.entry_count || s.sequence != s.entry_count {
            return Err(CoreError::Conservation);
        }
        let mut tickets = 0u64;
        let mut principal = 0u64;
        for (nonce, e) in local.iter().enumerate() {
            if e.entry_nonce != nonce as u64 || e.position_base != tickets {
                return Err(CoreError::Conservation);
            }
            tickets = tickets
                .checked_add(e.ticket_count)
                .ok_or(CoreError::Overflow)?;
            principal = principal
                .checked_add(e.principal)
                .ok_or(CoreError::Overflow)?;
        }
        if tickets != s.ticket_count || principal != s.principal_total {
            return Err(CoreError::Conservation);
        }
        offsets.push(total);
        total = total.checked_add(tickets).ok_or(CoreError::Overflow)?;
    }
    Ok(offsets)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn complete_prizes_assign_all_rounding_dust_to_first_prize() {
        assert_eq!(
            allocate_prizes_complete(&[1, 1, 1], 100),
            Ok(vec![34, 33, 33])
        );
        assert_eq!(allocate_prizes_complete(&[1, 1, 1], 2), Ok(vec![2, 0, 0]));
        assert_eq!(allocate_prizes_complete(&[1, 3], 1000), Ok(vec![250, 750]));
        assert_eq!(allocate_prizes_complete(&[1], u64::MAX), Ok(vec![u64::MAX]));
        assert_eq!(allocate_prizes_complete(&[1, 2], 0), Ok(vec![0, 0]));
    }

    #[test]
    fn complete_prizes_reject_invalid_schedules() {
        assert!(allocate_prizes_complete(&[], 100).is_err());
        assert!(allocate_prizes_complete(&[0, 0], 100).is_err());
        assert!(allocate_prizes_complete(&[0, 1], 100).is_err());
        assert!(allocate_prizes_complete(&[1, 0], 100).is_err());
        assert!(allocate_prizes_complete(&[u64::MAX, 1], 100).is_err());
    }

    #[test]
    fn shard_major_positions_validate_complete_frozen_universe() {
        use crate::encoding::{EntryDataV1, EntryShardDataV1, SHARD_STATE_FROZEN};
        let entry = |id, tickets| EntryDataV1 {
            round_id: [1; 32],
            shard_id: id,
            participant_lock_hash: [2; 32],
            ticket_count: tickets,
            principal: tickets,
            position_base: 0,
            entry_nonce: 0,
            entropy_commitment: [0; 32],
        };
        let shard = |id, tickets| EntryShardDataV1 {
            round_id: [1; 32],
            shard_id: id,
            state: SHARD_STATE_FROZEN,
            sequence: 1,
            entry_count: 1,
            ticket_count: tickets,
            principal_total: tickets,
            accumulator_root: [3; 32],
        };
        let entries = [entry(1, 5), entry(0, 3)];
        let shards = [shard(1, 5), shard(0, 3)];
        assert_eq!(
            validate_frozen_positions(&[1; 32], 2, &shards, &entries),
            Ok(vec![0, 3])
        );
        assert!(validate_frozen_positions(&[1; 32], 2, &shards[..1], &entries).is_err());
        assert!(validate_frozen_positions(&[1; 32], 2, &[shards[0], shards[0]], &entries).is_err());
        assert!(validate_frozen_positions(&[1; 32], 2, &shards, &entries[..1]).is_err());
        let mut bad = entries;
        bad[0].position_base = 3; // global base must not be stored in an entry
        assert!(validate_frozen_positions(&[1; 32], 2, &shards, &bad).is_err());
        bad = entries;
        bad[0].entry_nonce = 1;
        assert!(validate_frozen_positions(&[1; 32], 2, &shards, &bad).is_err());
        assert_eq!(
            validate_frozen_positions(
                &[1; 32],
                2,
                &[shard(0, u64::MAX), shard(1, 1)],
                &[entry(0, u64::MAX), entry(1, 1)]
            ),
            Err(CoreError::Overflow)
        );
        let mut empty = shard(1, 0);
        empty.entry_count = 0;
        empty.sequence = 0;
        assert_eq!(
            validate_frozen_positions(&[1; 32], 2, &[shard(0, 3), empty], &[entry(0, 3)]),
            Ok(vec![0, 3])
        );
    }

    #[test]
    fn overflow_detection() {
        assert_eq!(entry_principal(2, 5).unwrap(), 10);
        assert_eq!(
            entry_principal(u64::MAX, 2).unwrap_err(),
            CoreError::Overflow
        );
        assert_eq!(
            checked_sum(&[u64::MAX, 1]).unwrap_err(),
            CoreError::Overflow
        );
    }

    #[test]
    fn yield_must_not_touch_principal() {
        assert_eq!(gross_yield(1000, 900).unwrap(), 100);
        assert_eq!(gross_yield(900, 1000).unwrap_err(), CoreError::Conservation);
    }

    #[test]
    fn settlement_balances() {
        assert!(settlement_conservation(1000, 800, 150, 30, 20, 0).is_ok());
        assert!(settlement_conservation(1000, 800, 150, 30, 20, 1).is_err());
    }

    #[test]
    fn prize_allocation_exact_and_dust_surfaced() {
        let (amounts, dust) = allocate_prizes(&[1, 1, 1], 100).unwrap();
        assert_eq!(amounts, vec![33, 33, 33]);
        assert_eq!(dust, 1);
        let (amounts, dust) = allocate_prizes(&[1, 3], 1000).unwrap();
        assert_eq!(amounts, vec![250, 750]);
        assert_eq!(dust, 0);
    }

    #[test]
    fn position_tiling() {
        assert!(validate_position_tiling(&[(0, 3), (3, 5), (8, 1)]).is_ok());
        assert!(validate_position_tiling(&[(0, 3), (4, 5)]).is_err());
        assert!(validate_position_tiling(&[(3, 5), (0, 3)]).is_ok()); // unsorted input ok
        assert!(validate_position_tiling(&[(0, 0)]).is_ok()); // empty round
    }
}
