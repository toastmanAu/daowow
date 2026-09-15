//! Claim cell primitives: args identity, initial state and pure transition
//! rules. Chain provenance, lock authorization and shard delegation are the
//! contract's job (contracts/entry-shard-type/src/claim.rs).

use crate::encoding::{read_u32, read_u64, write_u32, write_u64, EntryDataV1};
use crate::hash::Hash32;
use crate::redemption::PrizeRedemptionState;
use crate::ticket::ticket_id;
use crate::CoreError;

/// First args byte; distinct from 0 (public lock), 2 (receipt), 3 (seal), 4 (entropy).
pub const CLAIM_TAG: u8 = 5;
/// `[tag] || commitment(32) || shard_id(u32 LE) || position(u64 LE)`.
pub const CLAIM_ARGS_SIZE: usize = 45;
/// `PrizeRedemptionState::encode()` length.
pub const CLAIM_DATA_SIZE: usize = 81;
const SHANNONS_PER_CKB: u64 = 100_000_000;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ClaimArgs {
    pub commitment: Hash32,
    pub shard_id: u32,
    pub position: u64,
}

impl ClaimArgs {
    pub fn encode(&self) -> [u8; CLAIM_ARGS_SIZE] {
        let mut out = [0u8; CLAIM_ARGS_SIZE];
        out[0] = CLAIM_TAG;
        out[1..33].copy_from_slice(&self.commitment);
        write_u32(&mut out, 33, self.shard_id);
        write_u64(&mut out, 37, self.position);
        out
    }

    pub fn decode(data: &[u8]) -> Result<Self, CoreError> {
        if data.len() != CLAIM_ARGS_SIZE || data[0] != CLAIM_TAG {
            return Err(CoreError::Encoding);
        }
        let mut commitment = [0u8; 32];
        commitment.copy_from_slice(&data[1..33]);
        Ok(Self {
            commitment,
            shard_id: read_u32(data, 33),
            position: read_u64(data, 37),
        })
    }

    pub fn ticket_id(&self) -> Hash32 {
        ticket_id(&self.commitment, self.shard_id, self.position)
    }
}

/// The only data a freshly minted claim may carry.
pub fn initial_state_bytes(args: &ClaimArgs) -> [u8; CLAIM_DATA_SIZE] {
    PrizeRedemptionState::new(args.ticket_id()).encode()
}

/// Transfer keeps data byte-identical. Both sides must decode with the ticket
/// the args name; any decodable difference is the (not yet defined) redemption
/// shape and is a state-transition error.
pub fn validate_transfer(args: &ClaimArgs, input: &[u8], output: &[u8]) -> Result<(), CoreError> {
    let ticket = args.ticket_id();
    for side in [input, output] {
        let state = PrizeRedemptionState::decode(side)?;
        if state.ticket() != ticket {
            return Err(CoreError::Encoding);
        }
    }
    if input != output {
        return Err(CoreError::StateTransition);
    }
    Ok(())
}

/// Occupied capacity in shannons: capacity field, holder lock, claim type, data.
pub fn claim_occupied_capacity(lock_script_size: u64) -> u64 {
    (8 + lock_script_size + (32 + 1 + CLAIM_ARGS_SIZE as u64) + CLAIM_DATA_SIZE as u64)
        * SHANNONS_PER_CKB
}

/// One claim output as observed by the shard script.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct MintedClaim {
    pub position: u64,
    pub lock_hash: Hash32,
    pub data: [u8; CLAIM_DATA_SIZE],
}

/// Exactly one claim per new ticket `[before_tickets, after_tickets)`, each
/// locked to the entrant that owns the position and carrying the initial
/// state for its identity. `entries` are the append's witness entries, already
/// validated contiguous by `shard::apply_entry_batch`.
pub fn validate_mint(
    before_tickets: u64,
    after_tickets: u64,
    commitment: &Hash32,
    shard_id: u32,
    entries: &[EntryDataV1],
    claims: &[MintedClaim],
) -> Result<(), CoreError> {
    let new = after_tickets
        .checked_sub(before_tickets)
        .ok_or(CoreError::InvalidArgument)?;
    if claims.len() as u64 != new {
        return Err(CoreError::InvalidArgument);
    }
    // bounded by the transaction's own output count (claims.len() == new)
    let mut seen = alloc::vec![false; claims.len()];
    for c in claims {
        if c.position < before_tickets || c.position >= after_tickets {
            return Err(CoreError::StateTransition);
        }
        let idx = (c.position - before_tickets) as usize;
        if seen[idx] {
            return Err(CoreError::StateTransition);
        }
        seen[idx] = true;
        let owner = entries
            .iter()
            .find(|e| {
                c.position >= e.position_base
                    && e.position_base
                        .checked_add(e.ticket_count)
                        .is_some_and(|end| c.position < end)
            })
            .ok_or(CoreError::StateTransition)?;
        if c.lock_hash != owner.participant_lock_hash {
            return Err(CoreError::StateTransition);
        }
        let args = ClaimArgs {
            commitment: *commitment,
            shard_id,
            position: c.position,
        };
        if c.data != initial_state_bytes(&args) {
            return Err(CoreError::Encoding);
        }
    }
    Ok(())
}

#[cfg(all(test, feature = "std"))]
mod tests;
