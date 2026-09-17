//! Winner memento: a non-financial keepsake cell, args tag 6 of the shard
//! binary. It carries no prize rights and authorizes nothing. Every field is
//! validated by the retiring claim's script (contracts/entry-shard-type);
//! this module is codec and arithmetic only.

use crate::encoding::{read_u32, read_u64, write_u32, write_u64};
use crate::hash::Hash32;
use crate::ticket::ticket_id;
use crate::CoreError;

/// First args byte; distinct from 5 (claim) and every earlier shard mode.
pub const MEMENTO_TAG: u8 = 6;
/// `[tag] || commitment(32) || shard_id(u32 LE) || position(u64 LE)`.
pub const MEMENTO_ARGS_SIZE: usize = 45;
/// `MementoData::encode()` length.
pub const MEMENTO_DATA_SIZE: usize = 54;
/// The only renderer this layout describes.
pub const MEMENTO_RENDERER_V1: u8 = 1;
const SHANNONS_PER_CKB: u64 = 100_000_000;

/// `sha256(ticketWinner.png)`, the redeemed-winner template committed by the
/// prize-only claim amendment. Stored in full so a memento is verifiable
/// against the artwork with no off-chain registry.
pub const WINNER_TEMPLATE_SHA256: Hash32 = [
    0xde, 0x98, 0x83, 0x76, 0x59, 0xf7, 0xb6, 0xa7, 0xab, 0xc1, 0x12, 0x5a, 0x12, 0xec, 0x0d, 0xd6,
    0x4d, 0xc0, 0xcc, 0x05, 0x3d, 0x93, 0xf4, 0x80, 0x07, 0xb1, 0x45, 0x9e, 0x6f, 0x5c, 0xb4, 0x6d,
];

/// Identity, mirroring `ClaimArgs` under a different tag so the two are
/// distinct type scripts and therefore distinct cell types and script groups.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct MementoArgs {
    pub commitment: Hash32,
    pub shard_id: u32,
    pub position: u64,
}

impl MementoArgs {
    pub fn encode(&self) -> [u8; MEMENTO_ARGS_SIZE] {
        let mut out = [0u8; MEMENTO_ARGS_SIZE];
        out[0] = MEMENTO_TAG;
        out[1..33].copy_from_slice(&self.commitment);
        write_u32(&mut out, 33, self.shard_id);
        write_u64(&mut out, 37, self.position);
        out
    }

    pub fn decode(data: &[u8]) -> Result<Self, CoreError> {
        if data.len() != MEMENTO_ARGS_SIZE || data[0] != MEMENTO_TAG {
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

    /// The same ticket the claim of this identity names.
    pub fn ticket_id(&self) -> Hash32 {
        ticket_id(&self.commitment, self.shard_id, self.position)
    }
}

/// Commemorative payload. Decoding proves nothing about provenance: only the
/// retiring claim's script authenticates these values against the draw.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct MementoData {
    pub renderer_version: u8,
    pub prize_index: u32,
    pub paid_count: u64,
    pub paid_total: u64,
}

impl MementoData {
    pub fn encode(&self) -> [u8; MEMENTO_DATA_SIZE] {
        let mut out = [0u8; MEMENTO_DATA_SIZE];
        out[0] = 1;
        out[1] = self.renderer_version;
        out[2..34].copy_from_slice(&WINNER_TEMPLATE_SHA256);
        write_u32(&mut out, 34, self.prize_index);
        write_u64(&mut out, 38, self.paid_count);
        write_u64(&mut out, 46, self.paid_total);
        out
    }

    /// Strict structural decoding. The template and renderer are protocol
    /// constants, so a substituted value is a malformed memento, not a variant.
    pub fn decode(data: &[u8]) -> Result<Self, CoreError> {
        if data.len() != MEMENTO_DATA_SIZE
            || data[0] != 1
            || data[1] != MEMENTO_RENDERER_V1
            || data[2..34] != WINNER_TEMPLATE_SHA256
        {
            return Err(CoreError::Encoding);
        }
        let out = Self {
            renderer_version: data[1],
            prize_index: read_u32(data, 34),
            paid_count: read_u64(data, 38),
            paid_total: read_u64(data, 46),
        };
        // A memento exists only for a winner, who discharged at least one
        // source, each of a positive amount, at a rank the schedule can hold.
        if out.paid_count == 0
            || out.paid_total < out.paid_count
            || out.prize_index as usize >= crate::schedule::MAX_SCHEDULE_PRIZES
        {
            return Err(CoreError::Encoding);
        }
        Ok(out)
    }
}

/// Occupied capacity in shannons: capacity field, holder lock, memento type, data.
pub fn memento_occupied_capacity(lock_script_size: u64) -> u64 {
    (8 + lock_script_size + (32 + 1 + MEMENTO_ARGS_SIZE as u64) + MEMENTO_DATA_SIZE as u64)
        * SHANNONS_PER_CKB
}

#[cfg(all(test, feature = "std"))]
mod tests;
