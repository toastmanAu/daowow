//! Shannon-exact accounting helpers. All values are u64 shannons; every
//! operation is overflow-checked. These functions are the single source of
//! truth for the conservation rules (protocol v0.2 section 11).

use crate::error::CoreError;

#[cfg(feature = "std")]
use std::vec::Vec;
#[cfg(not(feature = "std"))]
use alloc::vec::Vec;

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
    let outputs = checked_sum(&[principal_payouts, prize_payouts, authorised_costs, tx_fee, residual_capacity])?;
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

/// Position range of an entry: [position_base, position_base + ticket_count)
/// Exhaustiveness: ranges over all entries must tile [0, total_tickets).
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

#[cfg(test)]
mod tests {
    use super::*;

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
