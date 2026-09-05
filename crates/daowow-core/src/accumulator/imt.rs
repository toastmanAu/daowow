//! Fixed-depth incremental Merkle tree accumulator.
//!
//! Hash domains (frozen):
//!   leaf:         H(0x10 || leaf_data_hash)
//!   inner node:   H(0x11 || left || right)
//!   zero level j: Z_0 = [0u8;32]; Z_{j+1} = H(0x11 || Z_j || Z_j)
//!
//! Depth D = 32 supports 2^32 entries. The tree is append-only; the state is
//! the frontier (filled-subtree root per level, present iff bit j of the
//! leaf count is set).
//!
//! Append authorization: the witness carries the frontier branch for index
//! `n` (the frontier hashes for the set bits of `n`). The verifier recomputes
//! the old root from the branch (fold over set bits, ascending), derives the
//! new frontier and root, and compares with the output data.
//! Membership proofs are standard fixed-depth inclusion proofs (D * 32 B).

use crate::error::CoreError;
use crate::hash::{ckb_hash256, ckb_hash256_one, Hash32};

pub const IMT_DEPTH: u32 = 32;
pub const IMT_BRANCH_BYTES: usize = (IMT_DEPTH as usize) * 32;

pub fn leaf_hash(data: &[u8]) -> Hash32 {
    let inner = ckb_hash256_one(data);
    ckb_hash256(&[&[0x10], &inner])
}

fn node_hash(left: &Hash32, right: &Hash32) -> Hash32 {
    ckb_hash256(&[&[0x11], left, right])
}

pub fn zero_at(level: u32) -> Hash32 {
    let mut z = [0u8; 32];
    for _ in 0..level {
        z = node_hash(&z, &z);
    }
    z
}

/// Root of the zero-padded fixed-depth tree with `n` leaves.
///
/// Convention (frozen): the tree is the complete depth-D tree whose leaf
/// slots >= n are zero. The root therefore always includes the upper zero
/// levels; membership proofs fold exactly D levels.
pub fn root_from_frontier(frontier: &[[u8; 32]; IMT_DEPTH as usize], n: u64) -> Hash32 {
    padded_rec(frontier, n, IMT_DEPTH)
}

fn padded_rec(frontier: &[[u8; 32]; IMT_DEPTH as usize], n: u64, depth: u32) -> Hash32 {
    if depth == 0 {
        // n is 0 or 1 at this level
        return if n >= 1 { frontier[0] } else { zero_at(0) };
    }
    let half = 1u64 << (depth - 1);
    let right = zero_at(depth - 1);
    if n >= half {
        // bit (depth-1) set: full left subtree from the frontier
        node_hash(&frontier[(depth - 1) as usize], &padded_rec(frontier, n - half, depth - 1))
    } else {
        node_hash(&padded_rec(frontier, n, depth - 1), &right)
    }
}

/// Frontier update after appending `leaf` at position `n`.
/// Returns the new frontier.
pub fn frontier_append(
    frontier: &[[u8; 32]; IMT_DEPTH as usize],
    n: u64,
    leaf: &Hash32,
) -> [[u8; 32]; IMT_DEPTH as usize] {
    let mut out = *frontier;
    let mut cur = *leaf;
    let mut j = 0u64;
    while j < IMT_DEPTH as u64 {
        if n >> j & 1 == 1 {
            cur = node_hash(&out[j as usize], &cur);
            out[j as usize] = [0u8; 32]; // cleared at this level
            j += 1;
        } else {
            out[j as usize] = cur;
            break;
        }
    }
    out
}

/// Host-side IMT (std only).
#[cfg(feature = "std")]
pub mod host {
    use super::*;
    use std::vec::Vec;

    #[derive(Debug, Clone)]
    pub struct ImtHost {
        frontier: [[u8; 32]; IMT_DEPTH as usize],
        pub count: u64,
        leaves: Vec<Hash32>,
    }

    impl Default for ImtHost {
        fn default() -> Self {
            Self {
                frontier: [[0u8; 32]; IMT_DEPTH as usize],
                count: 0,
                leaves: Vec::new(),
            }
        }
    }

    impl ImtHost {
        pub fn new() -> Self {
            Self::default()
        }

        pub fn root(&self) -> Hash32 {
            root_from_frontier(&self.frontier, self.count)
        }

        pub fn frontier(&self) -> &[[u8; 32]; IMT_DEPTH as usize] {
            &self.frontier
        }

        pub fn append(&mut self, leaf: &Hash32) {
            self.frontier = frontier_append(&self.frontier, self.count, leaf);
            self.leaves.push(*leaf);
            self.count += 1;
        }

        /// Branch for index `n`: the frontier hashes at the set bits of `n`
        /// (packed D*32 bytes; unset-bit slots are zero-filled).
        pub fn branch_for(&self, n: u64) -> [u8; IMT_BRANCH_BYTES] {
            let mut branch = [0u8; IMT_BRANCH_BYTES];
            for j in 0..IMT_DEPTH as u64 {
                if n >> j & 1 == 1 {
                    branch[(j as usize) * 32..(j as usize + 1) * 32]
                        .copy_from_slice(&self.frontier[j as usize]);
                }
            }
            branch
        }

        /// Standard inclusion proof for position `pos`: D*32 bytes of
        /// sibling hashes (bottom-up; direction from the bits of `pos`).
        pub fn membership_proof(&self, pos: u64) -> Result<Vec<u8>, CoreError> {
            if pos >= self.count {
                return Err(CoreError::InvalidArgument);
            }
            let mut proof = vec![0u8; IMT_BRANCH_BYTES];
            // rebuild level-by-level from leaves
            let mut idx = pos as usize;
            let mut level: Vec<Hash32> = self.leaves.clone();
            let mut depth = 0usize;
            while depth < IMT_DEPTH as usize {
                let sib = if idx & 1 == 0 {
                    level.get(idx + 1).copied().unwrap_or_else(|| zero_at(depth as u32))
                } else {
                    level[idx - 1]
                };
                proof[depth * 32..(depth + 1) * 32].copy_from_slice(&sib);
                let mut next = Vec::with_capacity((level.len() + 1) / 2);
                for i in (0..level.len()).step_by(2) {
                    let l = level[i];
                    let r = level.get(i + 1).copied().unwrap_or_else(|| zero_at(depth as u32));
                    next.push(node_hash(&l, &r));
                }
                level = next;
                idx >>= 1;
                depth += 1;
            }
            Ok(proof)
        }
    }
}

// ---------------------------------------------------------------------------
// On-chain verification (no_std)
// ---------------------------------------------------------------------------

/// Verify membership of `leaf` at `pos` under `root`.
pub fn verify_membership(
    root: &Hash32,
    pos: u64,
    leaf: &Hash32,
    proof: &[u8],
) -> Result<(), CoreError> {
    if proof.len() != IMT_BRANCH_BYTES {
        return Err(CoreError::MembershipProof);
    }
    let mut cur = *leaf;
    for d in 0..IMT_DEPTH as u64 {
        let mut sib = [0u8; 32];
        sib.copy_from_slice(&proof[(d as usize) * 32..(d as usize + 1) * 32]);
        cur = if pos >> d & 1 == 1 {
            node_hash(&sib, &cur)
        } else {
            node_hash(&cur, &sib)
        };
    }
    // after D levels the current node must equal the root (right side filled
    // with zeros implicitly — only if pos is within the half-open tree; the
    // final merge must land exactly at the root)
    if &cur == root {
        Ok(())
    } else {
        Err(CoreError::MembershipProof)
    }
}

/// Verify an append at position `n`: branch authorizes `old_root` and
/// deterministically yields `new_root` after inserting `leaf`.
pub fn verify_append(
    old_root: &Hash32,
    new_root: &Hash32,
    n: u64,
    leaf: &Hash32,
    branch: &[u8],
) -> Result<(), CoreError> {
    if branch.len() != IMT_BRANCH_BYTES {
        return Err(CoreError::AppendProof);
    }
    let mut frontier = [[0u8; 32]; IMT_DEPTH as usize];
    for j in 0..IMT_DEPTH as u64 {
        if n >> j & 1 == 1 {
            frontier[j as usize]
                .copy_from_slice(&branch[(j as usize) * 32..(j as usize + 1) * 32]);
        }
    }
    let old_calc = root_from_frontier(&frontier, n);
    if &old_calc != old_root {
        return Err(CoreError::AppendProof);
    }
    let new_frontier = frontier_append(&frontier, n, leaf);
    let new_calc = root_from_frontier(&new_frontier, n + 1);
    if &new_calc != new_root {
        return Err(CoreError::AppendProof);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn leaf(n: u64) -> Hash32 {
        leaf_hash(format!("imt-leaf-{n}").as_bytes())
    }

    #[test]
    fn empty_root_is_top_zero() {
        let f = [[0u8; 32]; IMT_DEPTH as usize];
        assert_eq!(root_from_frontier(&f, 0), zero_at(IMT_DEPTH));
    }

    #[test]
    fn append_and_membership() {
        use host::ImtHost;
        let mut t = ImtHost::new();
        let mut roots = vec![t.root()];
        for n in 0u64..70u64 {
            t.append(&leaf(n));
            roots.push(t.root());
        }
        // membership for all positions
        let mut t2 = ImtHost::new();
        for n in 0u64..70u64 {
            for pos in 0..t2.count {
                let proof = t2.membership_proof(pos).unwrap();
                assert!(verify_membership(&t2.root(), pos, &leaf(pos), &proof).is_ok());
                assert!(verify_membership(&t2.root(), pos, &leaf(pos + 777), &proof).is_err());
            }
            t2.append(&leaf(n));
        }
        // append certificates
        let mut t3 = ImtHost::new();
        for n in 0u64..70u64 {
            let old_root = t3.root();
            let branch = t3.branch_for(n);
            t3.append(&leaf(n));
            let new_root = t3.root();
            assert!(
                verify_append(&old_root, &new_root, n, &leaf(n), &branch).is_ok(),
                "append at {n}"
            );
            assert!(verify_append(&old_root, &new_root, n, &leaf(n + 1), &branch).is_err());
            assert!(verify_append(&[9u8; 32], &new_root, n, &leaf(n), &branch).is_err());
        }
        let _ = roots;
    }

    #[test]
    fn forged_branch_rejected() {
        use host::ImtHost;
        let mut t = ImtHost::new();
        for n in 0..5u64 {
            t.append(&leaf(n));
        }
        let old_root = t.root();
        let mut branch = t.branch_for(5);
        // corrupt one used slot: bit 0 and 2 of 5 are set (0b101)
        branch[0 * 32] ^= 1;
        let new_root = {
            let mut t2 = t.clone();
            t2.append(&leaf(5));
            t2.root()
        };
        assert!(verify_append(&old_root, &new_root, 5, &leaf(5), &branch).is_err());
    }
}
