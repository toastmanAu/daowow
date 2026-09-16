//! Closed-universe encoding. Authentication comes from canonical input/dep
//! types, not from successfully decoding these bytes.
use crate::hash::Hash32;
use crate::{
    encoding::RoundConfigV1,
    lifecycle::{AggregationState, AGGREGATION_STATE_SIZE},
    CoreError,
};
use alloc::vec::Vec;

/// Structurally decoded entropy is trusted only from the enforcing canonical
/// shard-zero type. Constructor arguments are not header authentication.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EntropyRecord {
    seal: RoundSeal,
    inclusion_height: u64,
    inclusion_hash: Hash32,
    entropy_hashes: [Hash32; 3],
}

impl EntropyRecord {
    pub fn new(
        seal: RoundSeal,
        inclusion_height: u64,
        inclusion_hash: Hash32,
        entropy_hashes: [Hash32; 3],
    ) -> Result<Self, CoreError> {
        RoundSeal::entropy_heights(inclusion_height)?;
        Ok(Self {
            seal,
            inclusion_height,
            inclusion_hash,
            entropy_hashes,
        })
    }

    pub fn encode(&self) -> Vec<u8> {
        let seal = self.seal.encode();
        let mut out = Vec::with_capacity(seal.len() + 137);
        out.push(4);
        out.extend_from_slice(&seal);
        out.extend_from_slice(&self.inclusion_height.to_le_bytes());
        out.extend_from_slice(&self.inclusion_hash);
        for hash in &self.entropy_hashes {
            out.extend_from_slice(hash);
        }
        out
    }

    pub fn decode(data: &[u8], cfg: &RoundConfigV1) -> Result<Self, CoreError> {
        cfg.validate()?;
        let seal_len = 5 + cfg.entry_shard_count as usize * AGGREGATION_STATE_SIZE;
        if data.len() != seal_len + 137 || data[0] != 4 {
            return Err(CoreError::Encoding);
        }
        let seal = RoundSeal::decode(&data[1..1 + seal_len], cfg)?;
        let start = seal_len + 1;
        let height = u64::from_le_bytes(
            data[start..start + 8]
                .try_into()
                .map_err(|_| CoreError::Encoding)?,
        );
        let hash = data[start + 8..start + 40]
            .try_into()
            .map_err(|_| CoreError::Encoding)?;
        let hashes = data[start + 40..]
            .as_chunks::<32>()
            .0
            .try_into()
            .map_err(|_| CoreError::Encoding)?;
        Self::new(seal, height, hash, hashes)
    }

    pub fn seal(&self) -> &RoundSeal {
        &self.seal
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RoundSeal {
    ledgers: Vec<AggregationState>,
}

impl RoundSeal {
    pub fn new(cfg: &RoundConfigV1, ledgers: &[AggregationState]) -> Result<Self, CoreError> {
        cfg.validate()?;
        if ledgers.len() != cfg.entry_shard_count as usize {
            return Err(CoreError::StateTransition);
        }
        let commitment = cfg.commitment();
        for (id, ledger) in ledgers.iter().enumerate() {
            if !ledger.is_bound_to(&commitment)
                || !ledger.is_closed()
                || ledger.frozen().shard_id as usize != id
            {
                return Err(CoreError::StateTransition);
            }
        }
        Ok(Self {
            ledgers: ledgers.to_vec(),
        })
    }

    pub fn encode(&self) -> Vec<u8> {
        let mut out = Vec::with_capacity(5 + self.ledgers.len() * AGGREGATION_STATE_SIZE);
        out.push(3);
        out.extend_from_slice(&(self.ledgers.len() as u32).to_le_bytes());
        for ledger in &self.ledgers {
            out.extend_from_slice(&ledger.encode());
        }
        out
    }

    pub fn decode(data: &[u8], cfg: &RoundConfigV1) -> Result<Self, CoreError> {
        cfg.validate()?;
        if data.len() != 5 + cfg.entry_shard_count as usize * AGGREGATION_STATE_SIZE
            || data[0] != 3
            || data[1..5] != cfg.entry_shard_count.to_le_bytes()
        {
            return Err(CoreError::Encoding);
        }
        let commitment = cfg.commitment();
        let ledgers: Result<Vec<_>, _> = data[5..]
            .as_chunks::<AGGREGATION_STATE_SIZE>()
            .0
            .iter()
            .map(|bytes| AggregationState::decode_bound(bytes, cfg, &commitment))
            .collect();
        Self::new(cfg, &ledgers?)
    }

    pub fn ledger(&self, shard_id: u32) -> Option<&AggregationState> {
        self.ledgers.get(shard_id as usize)
    }

    /// The complete prize-obligation universe for any winning ticket of this
    /// round: every batch of every shard owes every winner a positive amount,
    /// so a winner's discharged-source count equals this when nothing is left.
    /// Only meaningful for a sealed round; `RoundSeal::new` guarantees closure.
    pub fn total_accepted_batches(&self) -> Result<u64, CoreError> {
        let mut total = 0u64;
        for ledger in &self.ledgers {
            total = total
                .checked_add(ledger.accepted_batches())
                .ok_or(CoreError::Overflow)?;
        }
        Ok(total)
    }

    /// Three entropy heights followed by earliest finalization height.
    /// The caller must authenticate actual seal inclusion and each header;
    /// arithmetic alone proves neither chain membership nor maturity.
    pub fn entropy_heights(seal_inclusion: u64) -> Result<[u64; 4], CoreError> {
        let mut heights = [0; 4];
        for (slot, offset) in heights.iter_mut().zip([64, 128, 192, 256]) {
            *slot = seal_inclusion
                .checked_add(offset)
                .ok_or(CoreError::Overflow)?;
        }
        Ok(heights)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::accumulator::mmr::host::MmrHost;
    use crate::encoding::{EntryDataV1, EntryShardDataV1, ScriptRef, ACC_MMR, SHARD_STATE_FROZEN};
    use crate::epoch::ABSOLUTE_EPOCH_FLAG;
    use crate::leaf::entry_leaf;

    /// Build one closed `AggregationState` per entry of `counts`, each with
    /// exactly that many accepted batches (one entry per batch, one ticket
    /// per entry) against a frozen shard sized to match. A `0` entry yields a
    /// closed, never-accepted shard rather than being skipped, matching
    /// `AggregationState::decode`'s `(accepted_entries == 0) !=
    /// (accepted_batches == 0)` invariant at both ends.
    fn closed_ledgers_with_batches(counts: &[u64]) -> (RoundConfigV1, Vec<AggregationState>) {
        let script = ScriptRef {
            code_hash: [1; 32],
            hash_type: 2,
        };
        let cfg = RoundConfigV1 {
            version: 1,
            round_id: [7; 32],
            ticket_price: 100,
            minimum_tickets: 1,
            maximum_tickets: 0,
            entry_start: 0,
            entry_end: 10,
            aggregation_deadline: 20,
            dao_term_periods: 1,
            entry_shard_count: counts.len() as u32,
            prize_schedule_hash: [2; 32],
            fee_policy_hash: [0; 32],
            keeper_policy_hash: [0; 32],
            flags: 0,
            accumulator_id: ACC_MMR,
            entry_lock: script,
            dao_lock: script,
            settlement_type: script,
            entry_shard_type: script,
            dao_type: script,
        };
        let mut ledgers = Vec::new();
        for (shard_id, &count) in counts.iter().enumerate() {
            let shard_id = shard_id as u32;
            let entries: Vec<_> = (0..count)
                .map(|nonce| EntryDataV1 {
                    round_id: cfg.round_id,
                    shard_id,
                    participant_lock_hash: [9; 32],
                    ticket_count: 1,
                    principal: cfg.ticket_price,
                    position_base: nonce,
                    entry_nonce: nonce,
                    entropy_commitment: [nonce as u8; 32],
                })
                .collect();
            let mut tree = MmrHost::new();
            for entry in &entries {
                tree.append(&entry_leaf(entry)).unwrap();
            }
            let frozen = EntryShardDataV1 {
                round_id: cfg.round_id,
                shard_id,
                state: SHARD_STATE_FROZEN,
                sequence: count,
                entry_count: count,
                ticket_count: count,
                principal_total: count * cfg.ticket_price,
                accumulator_root: tree.root().unwrap(),
            };
            let mut ledger = AggregationState::new(&cfg, &frozen).unwrap();
            for (nonce, entry) in entries.iter().enumerate() {
                let proof = tree.membership_proof(nonce as u64).unwrap();
                ledger = ledger
                    .accept(&cfg, core::slice::from_ref(entry), &[150], &[&proof])
                    .unwrap()
                    .0;
            }
            assert_eq!(ledger.accepted_batches(), count);
            ledgers.push(ledger.close(&cfg, ABSOLUTE_EPOCH_FLAG | 10).unwrap());
        }
        (cfg, ledgers)
    }

    #[test]
    fn total_accepted_batches_sums_every_shard() {
        let (cfg, ledgers) = closed_ledgers_with_batches(&[3, 0, 5, 1]);
        let seal = RoundSeal::new(&cfg, &ledgers).unwrap();
        assert_eq!(seal.total_accepted_batches(), Ok(9));
    }

    #[test]
    fn total_accepted_batches_is_zero_for_an_empty_round() {
        let (cfg, ledgers) = closed_ledgers_with_batches(&[0, 0, 0, 0]);
        let seal = RoundSeal::new(&cfg, &ledgers).unwrap();
        assert_eq!(seal.total_accepted_batches(), Ok(0));
    }
}
