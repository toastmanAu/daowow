//! Pure ticket primitives. These functions do not establish chain provenance.

use crate::hash::{ckb_hash256, Hash32};
use crate::CoreError;

/// Stable identity, independent of holder and redemption progress.
/// Callers must authenticate the config and validate shard/position bounds.
pub fn ticket_id(config: &Hash32, shard_id: u32, position: u64) -> Hash32 {
    ckb_hash256(&[
        b"DAOWOW_TICKET_ID_V1",
        config,
        &shard_id.to_le_bytes(),
        &position.to_le_bytes(),
    ])
}

/// One ticket's share of full pooled entry capacity, in Shannons.
///
/// `index` is zero-based within the original entry. Equal principal and overhead
/// shares are assigned in immutable ticket order, with remainder Shannons going
/// to the earliest indices. Separate NFT cell capacity must not be included.
/// Callers must authenticate the entry and its actual capacity.
pub fn ticket_capacity(
    price: u64,
    capacity: u64,
    count: u64,
    index: u64,
) -> Result<u64, CoreError> {
    if price == 0 || count == 0 || index >= count {
        return Err(CoreError::InvalidArgument);
    }
    let principal = price.checked_mul(count).ok_or(CoreError::Overflow)?;
    let overhead = capacity
        .checked_sub(principal)
        .ok_or(CoreError::Conservation)?;
    price
        .checked_add(overhead / count)
        .and_then(|value| value.checked_add(u64::from(index < overhead % count)))
        .ok_or(CoreError::Overflow)
}

#[cfg(test)]
mod tests;
