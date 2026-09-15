//! Accumulator candidates for the EntryShard commitment.
//!
//! Bakeoff (Phase 1 / Milestone 3) compares:
//! - `smt`: CKB sparse Merkle tree (vendored official implementation),
//!   keys are shard-local entry nonces;
//! - `mmr`: Merkle Mountain Range with explicit peak list;
//! - `imt`: fixed-depth incremental Merkle tree with frontier branch.
//!
//! All three share the same CKB blake2b-256 hash and the same leaf value
//! (see leaf.rs). Wire formats are frozen with test vectors.

pub mod imt;
pub mod mmr;
pub mod smt;
pub mod smtc;

use crate::error::CoreError;
use crate::hash::Hash32;

/// Shard key for a nonce: 32-byte big-endian u256.
/// Dense keys 0..n make the accepted universe enumerable off-chain.
pub fn nonce_key(nonce: u64) -> Hash32 {
    let mut k = [0u8; 32];
    k[24..32].copy_from_slice(&nonce.to_be_bytes());
    k
}

/// Maximum on-chain proof budget (witness must stay far below 32 KB,
/// the NervosDAO witness size limit, because several proofs share one tx).
pub const MAX_PROOF_BYTES: usize = 8192;

/// Validate a proof blob's length before decoding.
pub fn check_proof_len(len: usize) -> Result<(), CoreError> {
    if len == 0 || len > MAX_PROOF_BYTES {
        return Err(CoreError::MembershipProof);
    }
    Ok(())
}

#[cfg(test)]
mod proof_len_tests {
    use super::{check_proof_len, MAX_PROOF_BYTES};
    use crate::CoreError;

    #[test]
    fn proof_length_bound_is_inclusive_and_rejects_empty() {
        assert_eq!(check_proof_len(0), Err(CoreError::MembershipProof));
        assert_eq!(check_proof_len(1), Ok(()));
        assert_eq!(check_proof_len(MAX_PROOF_BYTES), Ok(()));
        assert_eq!(
            check_proof_len(MAX_PROOF_BYTES + 1),
            Err(CoreError::MembershipProof)
        );
    }
}
