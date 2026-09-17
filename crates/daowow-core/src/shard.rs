//! Pure EntryShard state-transition logic shared by the on-chain script and
//! host-side builders. The contract applies these checks against live cells;
//! the same functions run in tests and in the independent verifier.

use crate::encoding::{
    EntryDataV1, EntryShardDataV1, RoundConfigV1, SHARD_STATE_FROZEN, SHARD_STATE_OPEN,
};
use crate::error::CoreError;

/// Validate one new entry against the round config and the shard state
/// before the transaction (`shard_before == None` on shard creation).
///
/// `first_nonce_in_tx` is the accumulator index of the first entry created in
/// this transaction (== shard.entry_count before the tx, or 0 on creation);
/// entries in one transaction must be contiguous from there.
pub fn validate_new_entry(
    config: &RoundConfigV1,
    shard_before: Option<&EntryShardDataV1>,
    entry: &EntryDataV1,
    nonce_index_in_tx: u64,
    running_position_base: u64,
) -> Result<(), CoreError> {
    config.validate()?;
    if entry.round_id != config.round_id {
        return Err(CoreError::StateTransition);
    }
    if let Some(s) = shard_before {
        if entry.round_id != s.round_id || entry.shard_id != s.shard_id {
            return Err(CoreError::StateTransition);
        }
        if s.state != SHARD_STATE_OPEN {
            return Err(CoreError::StateTransition);
        }
    }
    if entry.ticket_count == 0 {
        return Err(CoreError::InvalidArgument);
    }
    let principal = entry
        .ticket_count
        .checked_mul(config.ticket_price)
        .ok_or(CoreError::Overflow)?;
    if entry.principal != principal {
        return Err(CoreError::InvalidArgument);
    }
    let first_nonce_in_tx = shard_before.map(|s| s.entry_count).unwrap_or(0);
    if entry.entry_nonce != first_nonce_in_tx + nonce_index_in_tx {
        return Err(CoreError::InvalidArgument);
    }
    if entry.position_base != running_position_base {
        return Err(CoreError::InvalidArgument);
    }
    Ok(())
}

/// Compute the shard state after appending `entries` (accumulator root must
/// be set by the caller after applying the chosen accumulator transition).
pub fn apply_entry_batch(
    shard_before: Option<&EntryShardDataV1>,
    config: &RoundConfigV1,
    entries: &[EntryDataV1],
) -> Result<EntryShardDataV1, CoreError> {
    config.validate()?;
    let mut n_ticket_delta: u64 = 0;
    let mut n_principal_delta: u64 = 0;
    let mut running_position_base: u64 = shard_before.map(|s| s.ticket_count).unwrap_or(0);

    for (i, e) in entries.iter().enumerate() {
        validate_new_entry(config, shard_before, e, i as u64, running_position_base)?;
        running_position_base = running_position_base
            .checked_add(e.ticket_count)
            .ok_or(CoreError::Overflow)?;
        n_ticket_delta = n_ticket_delta
            .checked_add(e.ticket_count)
            .ok_or(CoreError::Overflow)?;
        n_principal_delta = n_principal_delta
            .checked_add(e.principal)
            .ok_or(CoreError::Overflow)?;
    }

    // Cap check.
    if config.maximum_tickets != 0 {
        let base = shard_before.map(|s| s.ticket_count).unwrap_or(0);
        let total = base
            .checked_add(n_ticket_delta)
            .ok_or(CoreError::Overflow)?;
        if total > config.maximum_tickets {
            return Err(CoreError::StateTransition);
        }
    }

    let (sequence, entry_count, ticket_count, principal_total, round_id, shard_id) =
        match shard_before {
            None => (
                entries.len() as u64,
                entries.len() as u64,
                n_ticket_delta,
                n_principal_delta,
                entries.first().map(|e| e.round_id).unwrap_or([0; 32]),
                entries.first().map(|e| e.shard_id).unwrap_or(0),
            ),
            Some(s) => (
                s.sequence
                    .checked_add(entries.len() as u64)
                    .ok_or(CoreError::Overflow)?,
                s.entry_count
                    .checked_add(entries.len() as u64)
                    .ok_or(CoreError::Overflow)?,
                s.ticket_count
                    .checked_add(n_ticket_delta)
                    .ok_or(CoreError::Overflow)?,
                s.principal_total
                    .checked_add(n_principal_delta)
                    .ok_or(CoreError::Overflow)?,
                s.round_id,
                s.shard_id,
            ),
        };

    Ok(EntryShardDataV1 {
        round_id,
        shard_id,
        state: SHARD_STATE_OPEN,
        sequence,
        entry_count,
        ticket_count,
        principal_total,
        accumulator_root: [0; 32], // caller sets after applying accumulator
    })
}

/// Validate FROZEN transition: OPEN -> FROZEN with identical counters/root.
pub fn validate_freeze(
    before: &EntryShardDataV1,
    after: &EntryShardDataV1,
) -> Result<(), CoreError> {
    if before.state != SHARD_STATE_OPEN || after.state != SHARD_STATE_FROZEN {
        return Err(CoreError::StateTransition);
    }
    let same = before.round_id == after.round_id
        && before.shard_id == after.shard_id
        && before.sequence == after.sequence
        && before.entry_count == after.entry_count
        && before.ticket_count == after.ticket_count
        && before.principal_total == after.principal_total
        && before.accumulator_root == after.accumulator_root;
    if !same {
        return Err(CoreError::StateTransition);
    }
    Ok(())
}

/// Validate FROZEN no-op (frozen shards may only be passed through unchanged).
pub fn validate_frozen_noop(
    before: &EntryShardDataV1,
    after: &EntryShardDataV1,
) -> Result<(), CoreError> {
    if before.state != SHARD_STATE_FROZEN {
        return Err(CoreError::StateTransition);
    }
    if before != after {
        return Err(CoreError::StateTransition);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::encoding::{ScriptRef, ACC_SMT};

    fn config() -> RoundConfigV1 {
        RoundConfigV1 {
            version: 1,
            round_id: [1; 32],
            ticket_price: 100,
            minimum_tickets: 1,
            maximum_tickets: 0,
            entry_start: 0,
            entry_end: 10,
            aggregation_deadline: 20,
            dao_term_periods: 1,
            entry_shard_count: 4,
            prize_schedule_hash: [0; 32],
            fee_policy_hash: [0; 32],
            keeper_policy_hash: [0; 32],
            flags: 0,
            accumulator_id: ACC_SMT,
            entry_lock: ScriptRef {
                code_hash: [0; 32],
                hash_type: 1,
            },
            dao_lock: ScriptRef {
                code_hash: [0; 32],
                hash_type: 1,
            },
            settlement_type: ScriptRef {
                code_hash: [0; 32],
                hash_type: 1,
            },
            entry_shard_type: ScriptRef {
                code_hash: [0; 32],
                hash_type: 1,
            },
            dao_type: ScriptRef {
                code_hash: [0; 32],
                hash_type: 1,
            },
        }
    }

    fn entry(nonce: u64, pos: u64, tickets: u64) -> EntryDataV1 {
        EntryDataV1 {
            round_id: [1; 32],
            shard_id: 2,
            participant_lock_hash: [3; 32],
            ticket_count: tickets,
            principal: tickets * 100,
            position_base: pos,
            entry_nonce: nonce,
            entropy_commitment: [4; 32],
        }
    }

    #[test]
    fn first_batch_positions_and_counters() {
        let c = config();
        let entries = vec![entry(0, 0, 3), entry(1, 3, 5)];
        let after = apply_entry_batch(None, &c, &entries).unwrap();
        assert_eq!(after.entry_count, 2);
        assert_eq!(after.ticket_count, 8);
        assert_eq!(after.principal_total, 800);
        assert_eq!(after.sequence, 2);
        assert_eq!(after.state, SHARD_STATE_OPEN);
    }

    #[test]
    fn second_batch_extends_positions() {
        let c = config();
        let first = vec![entry(0, 0, 3)];
        let s1 = apply_entry_batch(None, &c, &first).unwrap();
        let second = vec![entry(1, 3, 5)];
        let s2 = apply_entry_batch(Some(&s1), &c, &second).unwrap();
        assert_eq!(s2.ticket_count, 8);
        assert_eq!(s2.entry_count, 2);
        assert_eq!(s2.sequence, 2);
    }

    #[test]
    fn wrong_principal_rejected() {
        let c = config();
        let mut e = entry(0, 0, 3);
        e.principal = 299;
        assert!(apply_entry_batch(None, &c, &[e]).is_err());
    }

    #[test]
    fn nonce_gap_rejected() {
        let c = config();
        let e = entry(1, 0, 3);
        assert!(apply_entry_batch(None, &c, &[e]).is_err());
    }

    #[test]
    fn position_gap_rejected() {
        let c = config();
        let e = entry(0, 5, 3);
        assert!(apply_entry_batch(None, &c, &[e]).is_err());
    }

    #[test]
    fn cap_enforced() {
        let mut c = config();
        c.entry_shard_count = 1;
        c.maximum_tickets = 10;
        let e = entry(0, 0, 11);
        assert!(apply_entry_batch(None, &c, &[e]).is_err());
        let e = entry(0, 0, 10);
        assert!(apply_entry_batch(None, &c, &[e]).is_ok());
    }

    #[test]
    fn frozen_rules() {
        let c = config();
        let s = apply_entry_batch(None, &c, &[entry(0, 0, 3)]).unwrap();
        let mut f = s;
        f.state = SHARD_STATE_FROZEN;
        assert!(validate_freeze(&s, &f).is_ok());
        let mut bad = f;
        bad.ticket_count = 999;
        assert!(validate_freeze(&s, &bad).is_err());
        assert!(validate_frozen_noop(&f, &f).is_ok());
        let mut bad2 = f;
        bad2.sequence = 42;
        assert!(validate_frozen_noop(&f, &bad2).is_err());
        let mut reopen = f;
        reopen.state = SHARD_STATE_OPEN;
        assert!(validate_frozen_noop(&f, &reopen).is_err());
    }
}
