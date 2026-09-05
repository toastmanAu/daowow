//! Merkle Mountain Range accumulator with explicit peak list.
//!
//! Hash domains (frozen):
//!   data leaf:   H(0x00 || H(0x00 || raw))  (leaf_hash)
//!   inner node:  H(0x01 || left || right)
//!   bagged root: H(0x02 || peak_count u32 LE || peak[0] || ... || peak[k-1])
//!
//! The peak list is ordered left-to-right by DESCENDING height, i.e. the
//! set bits of the leaf count from high to low. Appends merge the trailing
//! peaks pairwise (existing peak is the left child).
//!
//! Append authorization is native and sound: the witness carries the old
//! peak list; the verifier checks `bag(old_peaks) == old_root`, derives the
//! new peak list deterministically, and checks it equals the output peak
//! list and bags to the new root. Membership proofs carry the in-subtree
//! path plus the full peak list; the verifier splices the computed subtree
//! root into the peak list and re-bags.

use crate::error::CoreError;
use crate::hash::{ckb_hash256, ckb_hash256_one, Hash32};

pub const MAX_PEAKS: usize = 64; // supports 2^64 leaves
pub const MMR_PROOF_MAX: usize = 4 + MAX_PEAKS * 32 + MAX_PEAKS * 32 + 2;

pub fn leaf_hash(data: &[u8]) -> Hash32 {
    let inner = ckb_hash256_one(data);
    ckb_hash256(&[&[0x00], &inner])
}

pub fn node_hash(left: &Hash32, right: &Hash32) -> Hash32 {
    ckb_hash256(&[&[0x01], left, right])
}

pub fn bag_peaks(peaks: &[Hash32]) -> Result<Hash32, CoreError> {
    if peaks.len() > MAX_PEAKS {
        return Err(CoreError::Overflow);
    }
    let mut buf = [0u8; 4 + MAX_PEAKS * 32];
    buf[0..4].copy_from_slice(&(peaks.len() as u32).to_le_bytes());
    let mut n = 4;
    for p in peaks {
        buf[n..n + 32].copy_from_slice(p);
        n += 32;
    }
    Ok(ckb_hash256(&[&buf[..n]]))
}

/// Canonical peak list (descending height) for a leaf count.
pub fn peaks_shape(count: u64) -> Result<usize, CoreError> {
    Ok(count.count_ones() as usize)
}

/// Pure append over a peak list. Mirrored on-chain; also used by the host.
pub fn append_peaks(
    peaks: &[Hash32],
    count: u64,
    leaf: &Hash32,
) -> Result<[Hash32; MAX_PEAKS], CoreError> {
    if peaks.len() != peaks_shape(count)? || peaks.len() >= MAX_PEAKS {
        return Err(CoreError::InvalidArgument);
    }
    let mut new_peaks = [[0u8; 32]; MAX_PEAKS];
    new_peaks[..peaks.len()].copy_from_slice(peaks);
    let mut i = peaks.len(); // merges consume from the END (lowest height first)
    let mut cur = *leaf;
    let mut h: u32 = 0;
    while count >> h & 1 == 1 {
        if i == 0 {
            return Err(CoreError::InvalidArgument);
        }
        i -= 1;
        cur = node_hash(&new_peaks[i], &cur);
        h += 1;
    }
    new_peaks[i] = cur;
    Ok(new_peaks)
}

// ---------------------------------------------------------------------------
// Host (std)
// ---------------------------------------------------------------------------

#[cfg(feature = "std")]
pub mod host {
    use super::*;
    use std::vec::Vec;

    #[derive(Debug, Clone)]
    pub struct MmrHost {
        leaves: Vec<Hash32>,
        peaks: Vec<Hash32>,
        count: u64,
    }

    impl MmrHost {
        pub fn new() -> Self {
            Self { leaves: Vec::new(), peaks: Vec::new(), count: 0 }
        }

        pub fn count(&self) -> u64 {
            self.count
        }

        pub fn peaks(&self) -> &[Hash32] {
            &self.peaks
        }

        pub fn root(&self) -> Result<Hash32, CoreError> {
            bag_peaks(&self.peaks)
        }

        pub fn append(&mut self, leaf: &Hash32) -> Result<(), CoreError> {
            let merged = append_peaks(&self.peaks, self.count, leaf)?;
            let n = peaks_shape(self.count + 1)?;
            self.peaks = merged[..n].to_vec();
            self.leaves.push(*leaf);
            self.count += 1;
            Ok(())
        }

        /// Wire proof:
        ///   u8 path_len; path_len*32B siblings (bottom-up);
        ///   u8 peak_slot; u8 peaks_len; peaks_len*32B peak list.
        pub fn membership_proof(&self, pos: u64) -> Result<Vec<u8>, CoreError> {
            if pos >= self.count {
                return Err(CoreError::InvalidArgument);
            }
            // locate the subtree containing pos (bits of count, high->low)
            let mut remaining = self.count;
            let mut base = 0u64;
            let mut slot = 0u8;
            let mut height: u32 = 0;
            for b in (0..64).rev() {
                if remaining >> b & 1 == 1 {
                    let size = 1u64 << b;
                    if pos < base + size {
                        height = b;
                        break;
                    }
                    base += size;
                    slot += 1;
                }
            }
            let local = pos - base;
            // build subtree leaves and collect sibling path bottom-up
            let leaves = &self.leaves[base as usize..(base + (1u64 << height)) as usize];
            let mut level = leaves.to_vec();
            let mut idx = local as usize;
            let mut path: Vec<Hash32> = Vec::new();
            while level.len() > 1 {
                let sib = if idx & 1 == 0 { level[idx + 1] } else { level[idx - 1] };
                path.push(sib);
                let mut next = Vec::with_capacity(level.len() / 2);
                for pair in level.chunks(2) {
                    next.push(node_hash(&pair[0], &pair[1]));
                }
                level = next;
                idx >>= 1;
            }
            let mut proof = Vec::new();
            proof.push(path.len() as u8);
            for p in &path {
                proof.extend_from_slice(p);
            }
            proof.push(slot);
            proof.push(self.peaks.len() as u8);
            for p in &self.peaks {
                proof.extend_from_slice(p);
            }
            Ok(proof)
        }
    }
}

// ---------------------------------------------------------------------------
// On-chain verification (no_std)
// ---------------------------------------------------------------------------

/// Verify membership of `leaf` at `pos` for a tree with `count` leaves and
/// `root`. `proof` is the host wire proof.
pub fn verify_membership(
    root: &Hash32,
    count: u64,
    pos: u64,
    leaf: &Hash32,
    proof: &[u8],
) -> Result<(), CoreError> {
    if proof.is_empty() || proof.len() > MMR_PROOF_MAX || pos >= count {
        return Err(CoreError::MembershipProof);
    }
    let path_len = proof[0] as usize;
    let mut off = 1;
    if proof.len() < off + path_len * 32 + 2 {
        return Err(CoreError::MembershipProof);
    }
    // climb: sibling direction from bit of pos
    let mut cur = *leaf;
    for i in 0..path_len {
        let mut sib = [0u8; 32];
        sib.copy_from_slice(&proof[off..off + 32]);
        off += 32;
        cur = if pos >> i & 1 == 1 {
            node_hash(&sib, &cur)
        } else {
            node_hash(&cur, &sib)
        };
    }
    let slot = proof[off] as usize;
    let peaks_len = proof[off + 1] as usize;
    off += 2;
    if peaks_len > MAX_PEAKS || slot >= peaks_len || proof.len() < off + peaks_len * 32 {
        return Err(CoreError::MembershipProof);
    }
    if peaks_len as u32 != count.count_ones() {
        return Err(CoreError::MembershipProof);
    }
    let mut peaks = [[0u8; 32]; MAX_PEAKS];
    for i in 0..peaks_len {
        peaks[i].copy_from_slice(&proof[off..off + 32]);
        off += 32;
    }
    peaks[slot] = cur;
    let bagged = bag_peaks(&peaks[..peaks_len])?;
    if &bagged == root {
        Ok(())
    } else {
        Err(CoreError::MembershipProof)
    }
}

/// Verify an append: `old_root -> new_root` inserting one leaf.
/// `old_peaks_wire` = u8 len + len*32B peaks (shape of old count).
/// `new_peaks_wire` = same for the new count.
pub fn verify_append(
    old_root: &Hash32,
    new_root: &Hash32,
    old_count: u64,
    leaf: &Hash32,
    old_peaks_wire: &[u8],
    new_peaks_wire: &[u8],
) -> Result<(), CoreError> {
    let (old_peaks, old_len) = decode_peaks(old_peaks_wire)?;
    let (new_peaks, new_len) = decode_peaks(new_peaks_wire)?;
    if old_len != peaks_shape(old_count)? || new_len != peaks_shape(old_count + 1)? {
        return Err(CoreError::AppendProof);
    }
    if &bag_peaks(&old_peaks[..old_len])? != old_root {
        return Err(CoreError::AppendProof);
    }
    let derived = append_peaks(&old_peaks[..old_len], old_count, leaf)?;
    if new_peaks[..new_len] != derived[..new_len] {
        return Err(CoreError::AppendProof);
    }
    if &bag_peaks(&new_peaks[..new_len])? != new_root {
        return Err(CoreError::AppendProof);
    }
    Ok(())
}

fn decode_peaks(wire: &[u8]) -> Result<([[u8; 32]; MAX_PEAKS], usize), CoreError> {
    if wire.is_empty() {
        return Err(CoreError::AppendProof);
    }
    let len = wire[0] as usize;
    if len > MAX_PEAKS || wire.len() != 1 + len * 32 {
        return Err(CoreError::AppendProof);
    }
    let mut peaks = [[0u8; 32]; MAX_PEAKS];
    for i in 0..len {
        peaks[i].copy_from_slice(&wire[1 + i * 32..1 + (i + 1) * 32]);
    }
    Ok((peaks, len))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::hash::ckb_hash256_one;

    fn leaf(n: u64) -> Hash32 {
        leaf_hash(format!("mmr-leaf-{n}").as_bytes())
    }

    fn build(n: u64) -> host::MmrHost {
        let mut m = host::MmrHost::new();
        for i in 0..n {
            m.append(&leaf(i)).unwrap();
        }
        m
    }

    #[test]
    fn peaks_shape_matches_popcount() {
        for n in 0u64..200 {
            let m = build(n);
            assert_eq!(m.peaks().len(), (n.count_ones()) as usize);
        }
    }

    #[test]
    fn membership_all_positions() {
        for n in [1u64, 2, 3, 7, 8, 15, 16, 33, 64, 100, 127] {
            let m = build(n);
            let root = m.root().unwrap();
            for pos in 0..n {
                let proof = m.membership_proof(pos).unwrap();
                assert!(
                    verify_membership(&root, n, pos, &leaf(pos), &proof).is_ok(),
                    "n={n} pos={pos}"
                );
                assert!(verify_membership(&root, n, pos, &leaf(pos + 1000), &proof).is_err());
                if pos + 1 < n {
                    assert!(verify_membership(&root, n, pos, &leaf(pos + 1), &proof).is_err());
                }
            }
        }
    }

    #[test]
    fn append_certificates_all_lengths() {
        for n in 0u64..70 {
            let m = build(n);
            let old_root = m.root().unwrap();
            let mut wire_old = vec![m.peaks().len() as u8];
            for p in m.peaks() {
                wire_old.extend_from_slice(p);
            }
            let mut m2 = build(n + 1);
            let new_root = m2.root().unwrap();
            let mut wire_new = vec![m2.peaks().len() as u8];
            for p in m2.peaks() {
                wire_new.extend_from_slice(p);
            }
            match verify_append(&old_root, &new_root, n, &leaf(n), &wire_old, &wire_new) {
                Ok(()) => {}
                Err(e) => panic!("append at n={n} failed: {e:?} old_root={old_root:?} new_root={new_root:?} wire_old_len={} wire_new_len={}", wire_old.len(), wire_new.len()),
            }
            // tampered leaf must fail
            assert!(verify_append(
                &old_root,
                &new_root,
                n,
                &leaf(n + 500),
                &wire_old,
                &wire_new
            )
            .is_err());
        }
    }

    #[test]
    fn forged_peaks_rejected() {
        let m = build(5);
        let old_root = m.root().unwrap();
        // drop the last peak -> bag mismatch
        let n = m.peaks().len() - 1;
        let mut wire = vec![n as u8];
        for p in &m.peaks()[..n] {
            wire.extend_from_slice(p);
        }
        let mut m2 = build(6);
        let new_root = m2.root().unwrap();
        let mut wire_new = vec![m2.peaks().len() as u8];
        for p in m2.peaks() {
            wire_new.extend_from_slice(p);
        }
        assert!(verify_append(&old_root, &new_root, 5, &leaf(5), &wire, &wire_new).is_err());
        let _ = ckb_hash256_one(b"x");
    }
}


#[cfg(test)]
mod debug_print {
    use super::*;
    use crate::hash::ckb_hash256_one;

    fn hx(b: &[u8]) -> String {
        b.iter().map(|x| format!("{:02x}", x)).collect()
    }

    #[test]
    fn print_roots() {
        let mut m = host::MmrHost::new();
        for i in 0u64..5 {
            m.append(&ckb_hash256_one(format!("mmr-{i}").as_bytes())).unwrap();
            println!("MMRDEBUG n={} root={} peaks={}", i + 1, hx(&m.root().unwrap()), m.peaks().len());
        }
        let mut im = super::super::imt::host::ImtHost::new();
        for i in 0u64..5 {
            im.append(&ckb_hash256_one(format!("imt-{i}").as_bytes()));
            println!("IMTDEBUG n={} root={}", i + 1, hx(&im.root()));
        }
    }
}
