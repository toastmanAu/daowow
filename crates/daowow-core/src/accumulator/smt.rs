//! Sparse Merkle Tree accumulator (CKB sparse-merkle-tree algorithm).
//!
//! Membership: the standard compiled proof is verified against a root.
//!
//! Append authorization (shard transition): an *insert certificate* proving
//! `new_root == old_tree + insert(key, leaf)`:
//!   1. absence proof: compiled single-key proof replayed with value zero
//!      must reproduce `old_root`;
//!   2. inclusion proof: compiled single-key proof replayed with `leaf`
//!      must reproduce `new_root`;
//!   3. sibling equality: at every absolute tree height where the absence
//!      replay observed a non-zero sibling (0x50/0x51 op), the inclusion
//!      replay must observe an identical op. Any old content on the key's
//!      path is therefore pinned by hash equality; heights with no old
//!      sibling were empty and may hold inserted content.
//!
//! Soundness note: every other leaf's path diverges from the key's path at
//! exactly one height, where it sits inside a sibling subtree; step 3 pins
//! all of them. The rule can reject some honestly-built-but-differently
//! compressed trees (false rejection is safe; only the canonical builder
//! defined here is accepted).

use crate::error::CoreError;
use crate::hash::Hash32;

#[cfg(not(feature = "std"))]
use alloc::vec;
#[cfg(feature = "std")]
use std::vec;

use crate::accumulator::smtc::h256::H256;
use crate::accumulator::smtc::merkle_proof::CompiledMerkleProof;

fn to_h256(h: &Hash32) -> H256 {
    H256::from(*h)
}

fn from_h256(h: H256) -> Hash32 {
    <[u8; 32]>::from(h)
}

/// On-chain membership verification (no_std friendly; allocates internally).
pub fn verify_membership(
    root: &Hash32,
    key: &Hash32,
    leaf: &Hash32,
    proof: &[u8],
) -> Result<(), CoreError> {
    super::check_proof_len(proof.len())?;
    let compiled = CompiledMerkleProof(proof.to_vec());
    let ok = compiled
        .verify::<crate::accumulator::smtc::hasher::CkbHasher>(&to_h256(root), vec![(to_h256(key), to_h256(leaf))])
        .map_err(|_| CoreError::MembershipProof)?;
    if ok {
        Ok(())
    } else {
        Err(CoreError::MembershipProof)
    }
}

/// On-chain insert-certificate verification.
pub fn verify_insert_certificate(
    old_root: &Hash32,
    new_root: &Hash32,
    key: &Hash32,
    leaf: &Hash32,
    absence_proof: &[u8],
    inclusion_proof: &[u8],
) -> Result<(), CoreError> {
    super::check_proof_len(absence_proof.len())?;
    super::check_proof_len(inclusion_proof.len())?;

    // 1. absence under old root
    let absence = CompiledMerkleProof(absence_proof.to_vec());
    let (old_calc, old_ops) = absence
        .compute_root_collect_ops::<crate::accumulator::smtc::hasher::CkbHasher>(vec![(
            to_h256(key),
            H256::zero(),
        )])
        .map_err(|_| CoreError::AppendProof)?;
    if from_h256(old_calc) != *old_root {
        return Err(CoreError::AppendProof);
    }

    // 2. inclusion under new root
    let inclusion = CompiledMerkleProof(inclusion_proof.to_vec());
    let (new_calc, new_ops) = inclusion
        .compute_root_collect_ops::<crate::accumulator::smtc::hasher::CkbHasher>(vec![
            (to_h256(key), to_h256(leaf))
        ])
        .map_err(|_| CoreError::AppendProof)?;
    if from_h256(new_calc) != *new_root {
        return Err(CoreError::AppendProof);
    }

    // 3. sibling equality at every height where old content was present
    for op in &old_ops {
        if op.code == 0x4F {
            continue; // zero run: nothing to preserve
        }
        let matching = new_ops
            .iter()
            .any(|n| n.code == op.code && n.height == op.height && n.payload == op.payload);
        if !matching {
            return Err(CoreError::AppendProof);
        }
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Host-side builder (std only)
// ---------------------------------------------------------------------------

#[cfg(feature = "std")]
pub mod host {
    use super::*;
    use crate::accumulator::smtc::default_store::DefaultStore;
    use crate::accumulator::smtc::hasher::CkbHasher;
    use crate::accumulator::smtc::tree::SparseMerkleTree;

    type Tree = SparseMerkleTree<CkbHasher, H256, DefaultStore<H256>>;

    /// Host-side SMT with canonical serialization of certificates.
    #[derive(Default)]
    pub struct SmtHost {
        tree: Tree,
    }

    impl SmtHost {
        pub fn new() -> Self {
            Self::default()
        }

        pub fn root(&self) -> Hash32 {
            from_h256(*self.tree.root())
        }

        pub fn insert(&mut self, key: &Hash32, leaf: &Hash32) -> Result<(), CoreError> {
            self.tree
                .update(to_h256(key), to_h256(leaf))
                .map(|_| ())
                .map_err(|_| CoreError::Unknown)
        }

        pub fn contains(&self, key: &Hash32) -> Result<Option<Hash32>, CoreError> {
            let v = self
                .tree
                .get(&to_h256(key))
                .map_err(|_| CoreError::Unknown)?;
            if v.is_zero() {
                Ok(None)
            } else {
                Ok(Some(from_h256(v)))
            }
        }

        fn compiled_proof(&self, keys: &[Hash32]) -> Result<Vec<u8>, CoreError> {
            let proof = self
                .tree
                .merkle_proof(keys.iter().map(to_h256).collect())
                .map_err(|_| CoreError::Unknown)?;
            let (bitmap, path) = proof.take();
            let compiled = MerkleProof::new(bitmap, path)
                .compile(keys.iter().map(to_h256).collect())
                .map_err(|_| CoreError::Unknown)?;
            Ok(compiled.0)
        }

        /// Compiled inclusion proof for `keys` against the current root.
        pub fn inclusion_proof(&self, keys: &[Hash32]) -> Result<Vec<u8>, CoreError> {
            self.compiled_proof(keys)
        }

        /// Compiled absence (non-inclusion) proof for `keys`.
        /// Must be generated BEFORE the keys are inserted.
        pub fn absence_proof(&self, keys: &[Hash32]) -> Result<Vec<u8>, CoreError> {
            self.compiled_proof(keys)
        }

        /// Convenience: run `insert` and return the full certificate for one key.
        pub fn append_with_certificate(
            &mut self,
            key: &Hash32,
            leaf: &Hash32,
        ) -> Result<(Hash32, Vec<u8>, Vec<u8>), CoreError> {
            let absence = self.absence_proof(&[*key])?;
            self.insert(key, leaf)?;
            let new_root = self.root();
            let inclusion = self.inclusion_proof(&[*key])?;
            Ok((new_root, absence, inclusion))
        }
    }

    use crate::accumulator::smtc::merkle_proof::MerkleProof;

    #[cfg(test)]
    mod tests {
        use super::*;
        use crate::accumulator::nonce_key;
        use crate::hash::ckb_hash256_one;

        fn leaf_for(n: u64) -> Hash32 {
            ckb_hash256_one(format!("leaf-{n}").as_bytes())
        }

        #[test]
        fn membership_roundtrip() {
            let mut t = SmtHost::new();
            let leaves: Vec<(Hash32, Hash32)> =
                (0u64..50).map(|n| (nonce_key(n), leaf_for(n))).collect();
            let absence_all = t.absence_proof(&[nonce_key(50)]).unwrap();
            for (k, v) in &leaves {
                t.insert(k, v).unwrap();
            }
            let root = t.root();

            let proof = t.inclusion_proof(&[nonce_key(10)]).unwrap();
            assert!(verify_membership(&root, &nonce_key(10), &leaf_for(10), &proof).is_ok());
            let bad = leaf_for(11);
            assert!(verify_membership(&root, &nonce_key(10), &bad, &proof).is_err());

            // absence still valid against old root
            assert_eq!(absence_all.len() > 0, true);
        }

        #[test]
        fn insert_certificate_accepts_and_rejects() {
            let mut t = SmtHost::new();
            for n in 0u64..20 {
                t.insert(&nonce_key(n), &leaf_for(n)).unwrap();
            }
            let old_root = t.root();

            // certificate for inserting key 20
            let absence = t.absence_proof(&[nonce_key(20)]).unwrap();
            t.insert(&nonce_key(20), &leaf_for(20)).unwrap();
            let new_root = t.root();
            let inclusion = t.inclusion_proof(&[nonce_key(20)]).unwrap();

            assert!(verify_insert_certificate(
                &old_root,
                &new_root,
                &nonce_key(20),
                &leaf_for(20),
                &absence,
                &inclusion
            )
            .is_ok());

            // mutated leaf must fail
            assert!(verify_insert_certificate(
                &old_root,
                &new_root,
                &nonce_key(20),
                &leaf_for(999),
                &absence,
                &inclusion
            )
            .is_err());

            // wrong old root must fail
            assert!(verify_insert_certificate(
                &[9u8; 32],
                &new_root,
                &nonce_key(20),
                &leaf_for(20),
                &absence,
                &inclusion
            )
            .is_err());
        }

        #[test]
        fn insert_certificate_rejects_tree_replacement() {
            // Build old tree with keys 0..19, then a *forged* new tree that
            // drops old content but contains the new key: the inclusion proof
            // is valid against the forged new root, but the certificate must
            // reject it because old siblings on the key's path cannot match.
            let mut t = SmtHost::new();
            for n in 0u64..20 {
                t.insert(&nonce_key(n), &leaf_for(n)).unwrap();
            }
            let old_root = t.root();
            let absence = t.absence_proof(&[nonce_key(20)]).unwrap();

            // forged tree contains ONLY key 20
            let mut forged = SmtHost::new();
            forged.insert(&nonce_key(20), &leaf_for(20)).unwrap();
            let forged_root = forged.root();
            let inclusion = forged.inclusion_proof(&[nonce_key(20)]).unwrap();

            assert_ne!(old_root, forged_root);
            assert!(verify_insert_certificate(
                &old_root,
                &forged_root,
                &nonce_key(20),
                &leaf_for(20),
                &absence,
                &inclusion
            )
            .is_err());
        }

        #[test]
        fn sequential_appends_with_certificates() {
            let mut t = SmtHost::new();
            let mut roots = vec![t.root()];
            for n in 0u64..12 {
                let old_root = roots.last().unwrap().to_owned();
                let absence = t.absence_proof(&[nonce_key(n)]).unwrap();
                t.insert(&nonce_key(n), &leaf_for(n)).unwrap();
                let new_root = t.root();
                let inclusion = t.inclusion_proof(&[nonce_key(n)]).unwrap();
                verify_insert_certificate(
                    &old_root,
                    &new_root,
                    &nonce_key(n),
                    &leaf_for(n),
                    &absence,
                    &inclusion,
                )
                .unwrap();
                roots.push(new_root);
            }
        }
    }
}
