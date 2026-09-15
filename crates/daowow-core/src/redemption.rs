//! Prize-only paid-obligation accounting, not chain or payment authorization.
//!
//! Contract callers must authenticate source identity/amount, current NFT
//! ownership and state continuity, and atomically discharge funding liabilities.
//! This module has no principal/refund kind and cannot authorize retirement.

use crate::{
    accumulator::smt,
    hash::{ckb_hash256, Hash32},
    CoreError,
};

/// Immutable prize obligation identity. The source must be a canonical logical
/// batch identity, not a funding cell's replaceable successor outpoint.
/// The fixed kind byte is prize only; owner and amount do not enter the key.
pub fn prize_obligation_key(ticket: &Hash32, source: &Hash32) -> Hash32 {
    ckb_hash256(&[b"DAOWOW_PRIZE_OBLIGATION_V1", ticket, source, &[1]])
}

/// Payment record for one fully discharged source obligation. This hash alone
/// authenticates neither the supplied amount nor an actual payment.
pub fn prize_payment_leaf(ticket: &Hash32, source: &Hash32, amount: u64) -> Hash32 {
    ckb_hash256(&[
        b"DAOWOW_PRIZE_PAYMENT_V1",
        &prize_obligation_key(ticket, source),
        &amount.to_le_bytes(),
    ])
}

/// Append-only prize accounting carried unchanged through an NFT transfer.
/// Private fields constrain local transitions, not provenance of decoded data.
/// Count/total are accounting counters, never evidence that all prizes are paid.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PrizeRedemptionState {
    ticket: Hash32,
    paid_root: Hash32,
    paid_count: u64,
    paid_total: u64,
}

impl PrizeRedemptionState {
    /// Empty accounting only. The contract must separately authorize minting;
    /// replacing an existing NFT's state with this value must be rejected.
    pub fn new(ticket: Hash32) -> Self {
        Self {
            ticket,
            paid_root: [0; 32],
            paid_count: 0,
            paid_total: 0,
        }
    }

    /// Immutable ticket identity this accounting belongs to.
    pub fn ticket(&self) -> Hash32 {
        self.ticket
    }

    /// Root of the paid-obligation set; zero only while nothing is paid.
    pub fn paid_root(&self) -> Hash32 {
        self.paid_root
    }

    /// Number of paid sources. Not evidence that every source is paid.
    pub fn paid_count(&self) -> u64 {
        self.paid_count
    }

    /// Sum of recorded prize amounts. Not evidence of actual payment.
    pub fn paid_total(&self) -> u64 {
        self.paid_total
    }

    /// Record a positive source obligation that the caller has independently
    /// verified in full. Amount is NOT authenticated by the absence proof.
    /// The caller must pay that amount and update the funding state atomically.
    /// Returns a successor without mutating self; any failure preserves input.
    pub fn record_verified_prize(
        &self,
        source: &Hash32,
        amount: u64,
        absence: &[u8],
    ) -> Result<Self, CoreError> {
        if amount == 0 {
            return Err(CoreError::InvalidArgument);
        }
        let paid_count = self.paid_count.checked_add(1).ok_or(CoreError::Overflow)?;
        let paid_total = self
            .paid_total
            .checked_add(amount)
            .ok_or(CoreError::Overflow)?;
        let paid_root = smt::inserted_root(
            &self.paid_root,
            &prize_obligation_key(&self.ticket, source),
            &prize_payment_leaf(&self.ticket, source, amount),
            absence,
        )?;
        Ok(Self {
            ticket: self.ticket,
            paid_root,
            paid_count,
            paid_total,
        })
    }

    /// Version 1, ticket, root, paid count and total (both u64 little-endian).
    pub fn encode(&self) -> [u8; 81] {
        let mut out = [0; 81];
        out[0] = 1;
        out[1..33].copy_from_slice(&self.ticket);
        out[33..65].copy_from_slice(&self.paid_root);
        out[65..73].copy_from_slice(&self.paid_count.to_le_bytes());
        out[73..81].copy_from_slice(&self.paid_total.to_le_bytes());
        out
    }

    /// Strict structural decoding only. The contract must load this from the
    /// enforcing live claim type; the codec cannot prove counters match a root
    /// or that any source/payment was genuine. Do not accept witness state as
    /// authority or infer complete redemption from these counters.
    pub fn decode(data: &[u8]) -> Result<Self, CoreError> {
        if data.len() != 81 || data[0] != 1 {
            return Err(CoreError::Encoding);
        }
        let state = Self {
            ticket: data[1..33].try_into().map_err(|_| CoreError::Encoding)?,
            paid_root: data[33..65].try_into().map_err(|_| CoreError::Encoding)?,
            paid_count: u64::from_le_bytes(
                data[65..73].try_into().map_err(|_| CoreError::Encoding)?,
            ),
            paid_total: u64::from_le_bytes(
                data[73..81].try_into().map_err(|_| CoreError::Encoding)?,
            ),
        };
        let count_empty = state.paid_count == 0;
        let root_empty = state.paid_root == [0; 32];
        if count_empty != root_empty
            || (count_empty && state.paid_total != 0)
            || state.paid_total < state.paid_count
        {
            return Err(CoreError::Encoding);
        }
        Ok(state)
    }
}

#[cfg(all(test, feature = "std"))]
mod tests;
