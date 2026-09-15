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
