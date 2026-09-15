//! Canonical Entry leaf and liabilities leaf hashing.
//!
//! The entry leaf is the value committed by shard accumulators. All fields
//! that aggregation, draw or settlement later depend on are bound inside the
//! leaf so that on-chain membership proofs authenticate them.

use crate::encoding::EntryDataV1;
use crate::hash::{ckb_hash256, Hash32};

/// Participant entropy commitment (first stage of the v0.2 randomness design).
///
/// commitment = H("DAOWOW_ENTRY_COMMIT_V1" || secret || round_id || participant_lock_hash)
pub fn entropy_commitment(
    secret: &[u8],
    round_id: &Hash32,
    participant_lock_hash: &Hash32,
) -> Hash32 {
    ckb_hash256(&[
        b"DAOWOW_ENTRY_COMMIT_V1".as_slice(),
        secret,
        round_id.as_slice(),
        participant_lock_hash.as_slice(),
    ])
}

/// Missing-reveal fallback for the entropy scheme.
pub fn missing_reveal_fallback(commitment: &Hash32) -> Hash32 {
    ckb_hash256(&[
        b"DAOWOW_MISSING_REVEAL_V1".as_slice(),
        commitment.as_slice(),
    ])
}

/// Canonical accumulator leaf for an accepted Entry.
///
/// leaf = H("DAOWOW_ENTRY_LEAF_V1" || EntryDataV1 canonical bytes)
///
/// Encoding the whole entry struct keeps the leaf definition trivially in sync
/// with the canonical encoding (single source of truth).
pub fn entry_leaf(entry: &EntryDataV1) -> Hash32 {
    ckb_hash256(&[b"DAOWOW_ENTRY_LEAF_V1".as_slice(), &entry.encode()])
}

/// Liabilities leaf for settlement (value committed in settlement funding).
///
/// leaf = H("DAOWOW_LIABILITY_LEAF_V1" || participant_lock_hash || principal || prize)
pub fn liability_leaf(participant_lock_hash: &Hash32, principal: u64, prize: u64) -> Hash32 {
    let mut buf = [0u8; 48];
    buf[0..32].copy_from_slice(participant_lock_hash);
    buf[32..40].copy_from_slice(&principal.to_le_bytes());
    buf[40..48].copy_from_slice(&prize.to_le_bytes());
    ckb_hash256(&[b"DAOWOW_LIABILITY_LEAF_V1".as_slice(), &buf])
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn commitment_deterministic() {
        let rid = [1u8; 32];
        let p = [2u8; 32];
        let c1 = entropy_commitment(b"secret", &rid, &p);
        let c2 = entropy_commitment(b"secret", &rid, &p);
        assert_eq!(c1, c2);
        assert_ne!(c1, entropy_commitment(b"secret2", &rid, &p));
        assert_ne!(c1, entropy_commitment(b"secret", &rid, &[3u8; 32]));
    }

    #[test]
    fn leaf_binds_all_entry_fields() {
        let mut e = EntryDataV1 {
            round_id: [1; 32],
            shard_id: 0,
            participant_lock_hash: [2; 32],
            ticket_count: 3,
            principal: 300,
            position_base: 0,
            entry_nonce: 0,
            entropy_commitment: [4; 32],
        };
        let base = entry_leaf(&e);
        // every field mutation changes the leaf
        let mut x = e;
        x.ticket_count = 4;
        assert_ne!(entry_leaf(&x), base);
        let mut x = e;
        x.principal = 301;
        assert_ne!(entry_leaf(&x), base);
        let mut x = e;
        x.position_base = 1;
        assert_ne!(entry_leaf(&x), base);
        let mut x = e;
        x.entry_nonce = 1;
        assert_ne!(entry_leaf(&x), base);
        let mut x = e;
        x.entropy_commitment = [5; 32];
        assert_ne!(entry_leaf(&x), base);
        let mut x = e;
        x.shard_id = 1;
        assert_ne!(entry_leaf(&x), base);
        let mut x = e;
        x.round_id = [9; 32];
        assert_ne!(entry_leaf(&x), base);
        let _ = &mut e;
    }

    #[test]
    fn fallback_differs_from_commitment() {
        let c = [9u8; 32];
        assert_ne!(missing_reveal_fallback(&c), c);
    }
}
