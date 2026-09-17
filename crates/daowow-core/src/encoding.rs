//! Canonical DAOWOW fixed-width binary encodings.
//!
//! Conventions (frozen for prototype v0.2, see tests/vectors/):
//! - every integer is little-endian;
//! - every structure is fixed-width (no molecule tables in the prototype —
//!   documented deviation from the skeleton `schemas/daowow.mol`, whose own
//!   header says layouts must not be frozen before benchmarking);
//! - decoders are strict: exact total length required, no trailing bytes.

use crate::error::CoreError;
use crate::hash::Hash32;

pub const fn read_u16(b: &[u8], off: usize) -> u16 {
    u16::from_le_bytes([b[off], b[off + 1]])
}

pub const fn read_u32(b: &[u8], off: usize) -> u32 {
    u32::from_le_bytes([b[off], b[off + 1], b[off + 2], b[off + 3]])
}

pub const fn read_u64(b: &[u8], off: usize) -> u64 {
    u64::from_le_bytes([
        b[off],
        b[off + 1],
        b[off + 2],
        b[off + 3],
        b[off + 4],
        b[off + 5],
        b[off + 6],
        b[off + 7],
    ])
}

pub fn write_u16(out: &mut [u8], off: usize, v: u16) {
    out[off..off + 2].copy_from_slice(&v.to_le_bytes());
}

pub fn write_u32(out: &mut [u8], off: usize, v: u32) {
    out[off..off + 4].copy_from_slice(&v.to_le_bytes());
}

pub fn write_u64(out: &mut [u8], off: usize, v: u64) {
    out[off..off + 8].copy_from_slice(&v.to_le_bytes());
}

fn read_hash(b: &[u8], off: usize) -> Hash32 {
    let mut h = [0u8; 32];
    h.copy_from_slice(&b[off..off + 32]);
    h
}

// ---------------------------------------------------------------------------
// RoundConfigV1
// ---------------------------------------------------------------------------

pub const ROUND_CONFIG_SIZE: usize = 358;

/// Accumulator primitive selector (one per round; chosen after the bakeoff).
pub const ACC_SMT: u8 = 0;
pub const ACC_MMR: u8 = 1;
pub const ACC_IMT: u8 = 2;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ScriptRef {
    pub code_hash: Hash32,
    pub hash_type: u8, // 0 = data, 1 = type, 2 = data1, 4 = data2
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RoundConfigV1 {
    pub version: u32,
    pub round_id: Hash32,
    pub ticket_price: u64,
    pub minimum_tickets: u64,
    /// 0 = uncapped
    pub maximum_tickets: u64,
    /// absolute epoch number
    pub entry_start: u64,
    /// absolute epoch number
    pub entry_end: u64,
    /// absolute epoch number
    pub aggregation_deadline: u64,
    pub dao_term_periods: u32,
    pub entry_shard_count: u32,
    pub prize_schedule_hash: Hash32,
    pub fee_policy_hash: Hash32,
    pub keeper_policy_hash: Hash32,
    pub flags: u32,
    pub accumulator_id: u8,
    pub entry_lock: ScriptRef,
    pub dao_lock: ScriptRef,
    pub settlement_type: ScriptRef,
    /// entry-shard-type script reference (pins valid shard dep cells)
    pub entry_shard_type: ScriptRef,
    /// native Nervos DAO type script reference
    pub dao_type: ScriptRef,
}

impl RoundConfigV1 {
    /// A content commitment carried in every protocol script's args. Copies
    /// of these bytes are equivalent; a matching round_id alone is not proof.
    pub fn commitment(&self) -> Hash32 {
        crate::hash::ckb_hash256(&[b"DAOWOW_CONFIG_V2", &self.encode()])
    }

    pub fn encode(&self) -> [u8; ROUND_CONFIG_SIZE] {
        let mut out = [0u8; ROUND_CONFIG_SIZE];
        write_u32(&mut out, 0, self.version);
        out[4..36].copy_from_slice(&self.round_id);
        write_u64(&mut out, 36, self.ticket_price);
        write_u64(&mut out, 44, self.minimum_tickets);
        write_u64(&mut out, 52, self.maximum_tickets);
        write_u64(&mut out, 60, self.entry_start);
        write_u64(&mut out, 68, self.entry_end);
        write_u64(&mut out, 76, self.aggregation_deadline);
        write_u32(&mut out, 84, self.dao_term_periods);
        write_u32(&mut out, 88, self.entry_shard_count);
        self.prize_schedule_hash
            .iter()
            .enumerate()
            .for_each(|(i, b)| out[92 + i] = *b);
        self.fee_policy_hash
            .iter()
            .enumerate()
            .for_each(|(i, b)| out[124 + i] = *b);
        self.keeper_policy_hash
            .iter()
            .enumerate()
            .for_each(|(i, b)| out[156 + i] = *b);
        write_u32(&mut out, 188, self.flags);
        out[192] = self.accumulator_id;
        let mut w = 193;
        for s in [
            &self.entry_lock,
            &self.dao_lock,
            &self.settlement_type,
            &self.entry_shard_type,
            &self.dao_type,
        ] {
            out[w..w + 32].copy_from_slice(&s.code_hash);
            out[w + 32] = s.hash_type;
            w += 33;
        }
        debug_assert_eq!(w, ROUND_CONFIG_SIZE);
        out
    }

    pub fn decode(data: &[u8]) -> Result<Self, CoreError> {
        if data.len() != ROUND_CONFIG_SIZE {
            return Err(CoreError::Encoding);
        }
        let mut hashes = [[0u8; 32]; 3];
        for (i, hash) in hashes.iter_mut().enumerate() {
            *hash = read_hash(data, 92 + i * 32);
        }
        let mut scripts = [ScriptRef {
            code_hash: [0u8; 32],
            hash_type: 0,
        }; 5];
        for (i, script) in scripts.iter_mut().enumerate() {
            let w = 193 + i * 33;
            *script = ScriptRef {
                code_hash: read_hash(data, w),
                hash_type: data[w + 32],
            };
        }
        Ok(Self {
            version: read_u32(data, 0),
            round_id: read_hash(data, 4),
            ticket_price: read_u64(data, 36),
            minimum_tickets: read_u64(data, 44),
            maximum_tickets: read_u64(data, 52),
            entry_start: read_u64(data, 60),
            entry_end: read_u64(data, 68),
            aggregation_deadline: read_u64(data, 76),
            dao_term_periods: read_u32(data, 84),
            entry_shard_count: read_u32(data, 88),
            prize_schedule_hash: hashes[0],
            fee_policy_hash: hashes[1],
            keeper_policy_hash: hashes[2],
            flags: read_u32(data, 188),
            accumulator_id: data[192],
            entry_lock: scripts[0],
            dao_lock: scripts[1],
            settlement_type: scripts[2],
            entry_shard_type: scripts[3],
            dao_type: scripts[4],
        })
    }

    /// Configuration sanity checks shared by round-type script and hosts.
    pub fn validate(&self) -> Result<(), CoreError> {
        if self.version != 1 {
            return Err(CoreError::StateTransition);
        }
        if self.ticket_price == 0 {
            return Err(CoreError::InvalidArgument);
        }
        if self.entry_shard_count == 0 || self.entry_shard_count > 256 {
            return Err(CoreError::InvalidArgument);
        }
        // A cap is only round-wide at one shard: shard.rs compares a single
        // shard's ticket count against maximum_tickets, so a multi-shard round
        // would accept up to entry_shard_count times the advertised cap.
        // Refuse the configuration rather than let the advertised number be
        // wrong. Uncapped rounds (maximum_tickets == 0) may shard freely.
        if self.maximum_tickets != 0 && self.entry_shard_count > 1 {
            return Err(CoreError::InvalidArgument);
        }
        // A round that cannot reach its own minimum is unsatisfiable.
        if self.maximum_tickets != 0 && self.minimum_tickets > self.maximum_tickets {
            return Err(CoreError::InvalidArgument);
        }
        if self.entry_start > self.entry_end || self.entry_end > self.aggregation_deadline {
            return Err(CoreError::InvalidArgument);
        }
        if self.aggregation_deadline > crate::epoch::MAX_EPOCH_NUMBER {
            return Err(CoreError::InvalidArgument);
        }
        if self.dao_term_periods == 0 {
            return Err(CoreError::InvalidArgument);
        }
        if self.accumulator_id > ACC_IMT {
            return Err(CoreError::InvalidArgument);
        }
        Ok(())
    }
}

// ---------------------------------------------------------------------------
// EntryShardDataV1
// ---------------------------------------------------------------------------

pub const SHARD_DATA_SIZE: usize = 101;

pub const SHARD_STATE_OPEN: u8 = 0;
pub const SHARD_STATE_FROZEN: u8 = 1;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct EntryShardDataV1 {
    pub round_id: Hash32,
    pub shard_id: u32,
    pub state: u8,
    /// Number of shard mutations so far. Advances by the number of entries
    /// created in the transaction (spec v0.2 said "exactly one"; prototype
    /// allows bounded batched appends — documented spec delta).
    pub sequence: u64,
    pub entry_count: u64,
    pub ticket_count: u64,
    pub principal_total: u64,
    pub accumulator_root: Hash32,
}

impl EntryShardDataV1 {
    pub fn encode(&self) -> [u8; SHARD_DATA_SIZE] {
        let mut out = [0u8; SHARD_DATA_SIZE];
        out[0..32].copy_from_slice(&self.round_id);
        write_u32(&mut out, 32, self.shard_id);
        out[36] = self.state;
        write_u64(&mut out, 37, self.sequence);
        write_u64(&mut out, 45, self.entry_count);
        write_u64(&mut out, 53, self.ticket_count);
        write_u64(&mut out, 61, self.principal_total);
        out[69..101].copy_from_slice(&self.accumulator_root);
        out
    }

    pub fn decode(data: &[u8]) -> Result<Self, CoreError> {
        if data.len() != SHARD_DATA_SIZE {
            return Err(CoreError::Encoding);
        }
        Ok(Self {
            round_id: read_hash(data, 0),
            shard_id: read_u32(data, 32),
            state: data[36],
            sequence: read_u64(data, 37),
            entry_count: read_u64(data, 45),
            ticket_count: read_u64(data, 53),
            principal_total: read_u64(data, 61),
            accumulator_root: read_hash(data, 69),
        })
    }
}

// ---------------------------------------------------------------------------
// EntryDataV1
// ---------------------------------------------------------------------------

pub const ENTRY_DATA_SIZE: usize = 132;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct EntryDataV1 {
    pub round_id: Hash32,
    pub shard_id: u32,
    /// type-script hash (32 bytes) of the participant's own lock
    pub participant_lock_hash: Hash32,
    pub ticket_count: u64,
    /// exactly ticket_count * ticket_price
    pub principal: u64,
    /// first positional ticket owned by this entry
    pub position_base: u64,
    /// shard-local monotonic index; doubles as the accumulator key/position
    pub entry_nonce: u64,
    pub entropy_commitment: Hash32,
}

impl EntryDataV1 {
    pub fn encode(&self) -> [u8; ENTRY_DATA_SIZE] {
        let mut out = [0u8; ENTRY_DATA_SIZE];
        out[0..32].copy_from_slice(&self.round_id);
        write_u32(&mut out, 32, self.shard_id);
        out[36..68].copy_from_slice(&self.participant_lock_hash);
        write_u64(&mut out, 68, self.ticket_count);
        write_u64(&mut out, 76, self.principal);
        write_u64(&mut out, 84, self.position_base);
        write_u64(&mut out, 92, self.entry_nonce);
        out[100..132].copy_from_slice(&self.entropy_commitment);
        out
    }

    pub fn decode(data: &[u8]) -> Result<Self, CoreError> {
        if data.len() != ENTRY_DATA_SIZE {
            return Err(CoreError::Encoding);
        }
        Ok(Self {
            round_id: read_hash(data, 0),
            shard_id: read_u32(data, 32),
            participant_lock_hash: read_hash(data, 36),
            ticket_count: read_u64(data, 68),
            principal: read_u64(data, 76),
            position_base: read_u64(data, 84),
            entry_nonce: read_u64(data, 92),
            entropy_commitment: read_hash(data, 100),
        })
    }
}

// ---------------------------------------------------------------------------
// BatchDataV1
// ---------------------------------------------------------------------------

pub const BATCH_DATA_SIZE: usize = 96;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct BatchDataV1 {
    pub round_id: Hash32,
    pub batch_id: u64,
    pub entry_count: u64,
    pub ticket_count: u64,
    pub principal: u64,
    pub entries_subroot: Hash32,
}

impl BatchDataV1 {
    pub fn encode(&self) -> [u8; BATCH_DATA_SIZE] {
        let mut out = [0u8; BATCH_DATA_SIZE];
        out[0..32].copy_from_slice(&self.round_id);
        write_u64(&mut out, 32, self.batch_id);
        write_u64(&mut out, 40, self.entry_count);
        write_u64(&mut out, 48, self.ticket_count);
        write_u64(&mut out, 56, self.principal);
        out[64..96].copy_from_slice(&self.entries_subroot);
        out
    }

    pub fn decode(data: &[u8]) -> Result<Self, CoreError> {
        if data.len() != BATCH_DATA_SIZE {
            return Err(CoreError::Encoding);
        }
        Ok(Self {
            round_id: read_hash(data, 0),
            batch_id: read_u64(data, 32),
            entry_count: read_u64(data, 40),
            ticket_count: read_u64(data, 48),
            principal: read_u64(data, 56),
            entries_subroot: read_hash(data, 64),
        })
    }
}

// ---------------------------------------------------------------------------
// SettlementFundingDataV3
// ---------------------------------------------------------------------------

pub const SETTLEMENT_FUNDING_SIZE: usize = 160;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SettlementFundingDataV3 {
    pub round_id: Hash32,
    pub batch_id: u64,
    /// gross realised capacity from the DAO (principal surplus + compensation)
    pub realized_total: u64,
    /// total principal that must be returned to participants
    pub principal_liability: u64,
    /// authorised prize pool; on a successful round the sum of prize leaves
    pub prize_pool: u64,
    /// Index of the next liability to pay in the immutable tree.
    pub payout_cursor: u64,
    /// Immutable number of leaves in the liabilities tree; must be nonzero.
    pub liability_count: u64,
    /// Immutable accumulator root over liability leaves.
    pub liabilities_root: Hash32,
    /// Immutable number of prize leaves (zero on failed rounds).
    pub prize_count: u64,
    /// Immutable MMR root over `prize_leaf(ticket, amount)` sorted by ticket.
    pub prize_root: Hash32,
    /// Sum of prizes redeemed so far; never exceeds `prize_pool`.
    pub prize_paid: u64,
}

impl SettlementFundingDataV3 {
    pub fn encode(&self) -> [u8; SETTLEMENT_FUNDING_SIZE] {
        let mut out = [0u8; SETTLEMENT_FUNDING_SIZE];
        out[0..32].copy_from_slice(&self.round_id);
        write_u64(&mut out, 32, self.batch_id);
        write_u64(&mut out, 40, self.realized_total);
        write_u64(&mut out, 48, self.principal_liability);
        write_u64(&mut out, 56, self.prize_pool);
        write_u64(&mut out, 64, self.payout_cursor);
        write_u64(&mut out, 72, self.liability_count);
        out[80..112].copy_from_slice(&self.liabilities_root);
        write_u64(&mut out, 112, self.prize_count);
        out[120..152].copy_from_slice(&self.prize_root);
        write_u64(&mut out, 152, self.prize_paid);
        out
    }

    pub fn decode(data: &[u8]) -> Result<Self, CoreError> {
        if data.len() != SETTLEMENT_FUNDING_SIZE {
            return Err(CoreError::Encoding);
        }
        let payout_cursor = read_u64(data, 64);
        let liability_count = read_u64(data, 72);
        let prize_pool = read_u64(data, 56);
        let prize_count = read_u64(data, 112);
        let prize_root = read_hash(data, 120);
        let prize_paid = read_u64(data, 152);
        if liability_count == 0
            || payout_cursor > liability_count
            || prize_paid > prize_pool
            || (prize_count == 0) != (prize_root == [0; 32])
            || (prize_count == 0 && prize_paid != 0)
        {
            return Err(CoreError::Encoding);
        }
        Ok(Self {
            round_id: read_hash(data, 0),
            batch_id: read_u64(data, 32),
            realized_total: read_u64(data, 40),
            principal_liability: read_u64(data, 48),
            prize_pool,
            payout_cursor,
            liability_count,
            liabilities_root: read_hash(data, 80),
            prize_count,
            prize_root,
            prize_paid,
        })
    }
}

/// Settlement payout item carried in the settlement witness.
pub const PAYOUT_ITEM_SIZE: usize = 48;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PayoutItem {
    pub participant_lock_hash: Hash32,
    pub principal: u64,
    pub prize: u64,
}

impl PayoutItem {
    pub fn encode(&self) -> [u8; PAYOUT_ITEM_SIZE] {
        let mut out = [0u8; PAYOUT_ITEM_SIZE];
        out[0..32].copy_from_slice(&self.participant_lock_hash);
        write_u64(&mut out, 32, self.principal);
        write_u64(&mut out, 40, self.prize);
        out
    }

    pub fn decode(data: &[u8]) -> Result<Self, CoreError> {
        if data.len() != PAYOUT_ITEM_SIZE {
            return Err(CoreError::Encoding);
        }
        Ok(Self {
            participant_lock_hash: read_hash(data, 0),
            principal: read_u64(data, 32),
            prize: read_u64(data, 40),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn settlement_funding_v3_layout_and_consistency() {
        let base = SettlementFundingDataV3 {
            round_id: [1; 32],
            batch_id: 2,
            realized_total: 110,
            principal_liability: 100,
            prize_pool: 10,
            payout_cursor: 0,
            liability_count: 1,
            liabilities_root: [3; 32],
            prize_count: 2,
            prize_root: [4; 32],
            prize_paid: 5,
        };
        let wire = base.encode();
        assert_eq!(wire.len(), SETTLEMENT_FUNDING_SIZE);
        assert_eq!(&wire[112..120], &2u64.to_le_bytes());
        assert_eq!(&wire[120..152], &[4; 32]);
        assert_eq!(&wire[152..160], &5u64.to_le_bytes());
        assert_eq!(SettlementFundingDataV3::decode(&wire), Ok(base));
        assert!(SettlementFundingDataV3::decode(&wire[..112]).is_err());
        let mut over = wire;
        over[152..160].copy_from_slice(&11u64.to_le_bytes()); // paid > pool
        assert!(SettlementFundingDataV3::decode(&over).is_err());
        let mut zero_root = wire;
        zero_root[120..152].fill(0); // count 2 with zero root
        assert!(SettlementFundingDataV3::decode(&zero_root).is_err());
        let mut no_prizes = wire;
        no_prizes[112..120].fill(0);
        no_prizes[120..152].fill(0);
        assert!(SettlementFundingDataV3::decode(&no_prizes).is_err()); // paid 5, no prizes
        no_prizes[152..160].fill(0);
        assert!(SettlementFundingDataV3::decode(&no_prizes).is_ok());
    }

    fn sample_config() -> RoundConfigV1 {
        RoundConfigV1 {
            version: 1,
            round_id: [7u8; 32],
            ticket_price: 200 * 100_000_000,
            minimum_tickets: 10,
            maximum_tickets: 0,
            entry_start: 100,
            entry_end: 200,
            aggregation_deadline: 300,
            dao_term_periods: 2,
            entry_shard_count: 32,
            prize_schedule_hash: [1; 32],
            fee_policy_hash: [2; 32],
            keeper_policy_hash: [3; 32],
            flags: 0,
            accumulator_id: ACC_SMT,
            entry_lock: ScriptRef {
                code_hash: [4; 32],
                hash_type: 1,
            },
            dao_lock: ScriptRef {
                code_hash: [5; 32],
                hash_type: 1,
            },
            settlement_type: ScriptRef {
                code_hash: [6; 32],
                hash_type: 1,
            },
            entry_shard_type: ScriptRef {
                code_hash: [7; 32],
                hash_type: 1,
            },
            dao_type: ScriptRef {
                code_hash: [8; 32],
                hash_type: 1,
            },
        }
    }

    #[test]
    fn round_config_roundtrip() {
        let c = sample_config();
        let enc = c.encode();
        assert_eq!(enc.len(), ROUND_CONFIG_SIZE);
        assert_eq!(RoundConfigV1::decode(&enc).unwrap(), c);
        assert!(RoundConfigV1::decode(&enc[..357]).is_err());
    }

    #[test]
    fn shard_roundtrip() {
        let s = EntryShardDataV1 {
            round_id: [9; 32],
            shard_id: 3,
            state: SHARD_STATE_OPEN,
            sequence: 5,
            entry_count: 4,
            ticket_count: 40,
            principal_total: 800,
            accumulator_root: [8; 32],
        };
        let enc = s.encode();
        assert_eq!(enc.len(), SHARD_DATA_SIZE);
        assert_eq!(EntryShardDataV1::decode(&enc).unwrap(), s);
    }

    #[test]
    fn entry_roundtrip() {
        let e = EntryDataV1 {
            round_id: [9; 32],
            shard_id: 3,
            participant_lock_hash: [11; 32],
            ticket_count: 7,
            principal: 77,
            position_base: 33,
            entry_nonce: 4,
            entropy_commitment: [12; 32],
        };
        let enc = e.encode();
        assert_eq!(enc.len(), ENTRY_DATA_SIZE);
        assert_eq!(EntryDataV1::decode(&enc).unwrap(), e);
    }

    #[test]
    fn batch_and_funding_roundtrip() {
        let b = BatchDataV1 {
            round_id: [9; 32],
            batch_id: 1,
            entry_count: 10,
            ticket_count: 100,
            principal: 1000,
            entries_subroot: [13; 32],
        };
        assert_eq!(BatchDataV1::decode(&b.encode()).unwrap(), b);

        let f = SettlementFundingDataV3 {
            round_id: [9; 32],
            batch_id: 1,
            realized_total: 1100,
            principal_liability: 1000,
            prize_pool: 90,
            payout_cursor: 2,
            liability_count: 3,
            liabilities_root: [14; 32],
            prize_count: 0,
            prize_root: [0; 32],
            prize_paid: 0,
        };
        assert_eq!(SettlementFundingDataV3::decode(&f.encode()).unwrap(), f);

        let p = PayoutItem {
            participant_lock_hash: [15; 32],
            principal: 100,
            prize: 9,
        };
        assert_eq!(PayoutItem::decode(&p.encode()).unwrap(), p);
    }

    #[test]
    fn funding_v3_wire_layout_and_cursor_boundaries() {
        let funding = SettlementFundingDataV3 {
            round_id: [9; 32],
            batch_id: 0x0102,
            realized_total: 0x0304,
            principal_liability: 0x0506,
            prize_pool: 0x0708,
            payout_cursor: 0x090a,
            liability_count: 0x0b0c,
            liabilities_root: [14; 32],
            prize_count: 0,
            prize_root: [0; 32],
            prize_paid: 0,
        };
        let encoded = funding.encode();
        assert_eq!(encoded.len(), 160);
        assert_eq!(&encoded[..32], &[9; 32]);
        assert_eq!(
            &encoded[32..80],
            &[
                2, 1, 0, 0, 0, 0, 0, 0, 4, 3, 0, 0, 0, 0, 0, 0, 6, 5, 0, 0, 0, 0, 0, 0, 8, 7, 0, 0,
                0, 0, 0, 0, 10, 9, 0, 0, 0, 0, 0, 0, 12, 11, 0, 0, 0, 0, 0, 0,
            ]
        );
        assert_eq!(&encoded[80..112], &[14; 32]);
        assert_eq!(&encoded[112..], &[0; 48]);
        assert_eq!(SettlementFundingDataV3::decode(&encoded).unwrap(), funding);
        for cursor in [0, 1, u64::MAX] {
            let mut bytes = encoded;
            bytes[64..72].copy_from_slice(&cursor.to_le_bytes());
            bytes[72..80].copy_from_slice(&u64::MAX.to_le_bytes());
            let decoded = SettlementFundingDataV3::decode(&bytes).unwrap();
            assert_eq!(decoded.payout_cursor, cursor);
            assert_eq!(decoded.liability_count, u64::MAX);
        }
    }

    #[test]
    fn funding_v3_rejects_bad_lengths_empty_tree_and_cursor_past_end() {
        let mut bytes = [0u8; 160];
        bytes[72] = 1;
        assert!(SettlementFundingDataV3::decode(&bytes).is_ok());
        assert_eq!(
            SettlementFundingDataV3::decode(&bytes[..159]),
            Err(CoreError::Encoding)
        );
        assert_eq!(
            SettlementFundingDataV3::decode(&[0; 161]),
            Err(CoreError::Encoding)
        );
        assert_eq!(
            SettlementFundingDataV3::decode(&[0; 128]),
            Err(CoreError::Encoding)
        );
        bytes[72] = 0;
        assert_eq!(
            SettlementFundingDataV3::decode(&bytes),
            Err(CoreError::Encoding)
        );
        bytes[72] = 1;
        bytes[64] = 2;
        assert_eq!(
            SettlementFundingDataV3::decode(&bytes),
            Err(CoreError::Encoding)
        );
    }

    #[test]
    fn config_validation_rules() {
        let mut c = sample_config();
        assert!(c.validate().is_ok());
        c.ticket_price = 0;
        assert!(c.validate().is_err());
        let mut c = sample_config();
        c.entry_end = c.entry_start - 1;
        assert!(c.validate().is_err());
        let mut c = sample_config();
        c.entry_shard_count = 0;
        assert!(c.validate().is_err());
        let mut c = sample_config();
        c.accumulator_id = 9;
        assert!(c.validate().is_err());
    }

    #[test]
    fn a_capped_round_must_be_single_shard() {
        // The cap check in shard.rs compares ONE shard's ticket count against
        // maximum_tickets. That is an exact round-wide cap at one shard and a
        // per-shard cap above it, so a multi-shard round would silently accept
        // up to shard_count times the advertised number. Refuse the config
        // rather than let the advertised cap become wrong.
        let mut cfg = sample_config();
        cfg.maximum_tickets = 200;
        cfg.entry_shard_count = 1;
        assert!(cfg.validate().is_ok());
        cfg.entry_shard_count = 2;
        assert_eq!(cfg.validate(), Err(CoreError::InvalidArgument));
    }

    #[test]
    fn an_uncapped_round_may_have_many_shards() {
        // maximum_tickets == 0 is the uncapped path; there is no advertised
        // number to get wrong, so sharding stays available.
        let mut cfg = sample_config();
        cfg.maximum_tickets = 0;
        cfg.entry_shard_count = 4;
        assert!(cfg.validate().is_ok());
    }

    #[test]
    fn a_round_cannot_require_more_tickets_than_it_allows() {
        // A round whose minimum exceeds its cap can never succeed and would
        // strand every entrant's principal until the failed-round path runs.
        let mut cfg = sample_config();
        cfg.entry_shard_count = 1;
        cfg.maximum_tickets = 200;
        cfg.minimum_tickets = 50;
        assert!(cfg.validate().is_ok());
        cfg.minimum_tickets = 201;
        assert_eq!(cfg.validate(), Err(CoreError::InvalidArgument));
        // exactly equal is legal: a must-fill round is a valid configuration
        cfg.minimum_tickets = 200;
        assert!(cfg.validate().is_ok());
    }
}
