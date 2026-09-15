//! Deterministic entropy and positional draw (protocol v0.2 section 12-13).
//!
//! Everything here is pure and integer-only. Endianness: little-endian for
//! all integers. Domain separators are frozen strings.

use crate::error::CoreError;
use crate::hash::{ckb_hash256, Blake2b256, Hash32};

/// Final draw seed derivation.
///
/// seed = H("DAOWOW_DRAW_SEED_V1" ||
///          round_id || entry_universe_root || total_tickets u64 ||
///          participant_entropy_root || chain_entropy_root)
pub fn draw_seed(
    round_id: &Hash32,
    entry_universe_root: &Hash32,
    total_tickets: u64,
    participant_entropy_root: &Hash32,
    chain_entropy_root: &Hash32,
) -> Hash32 {
    ckb_hash256(&[
        b"DAOWOW_DRAW_SEED_V1".as_slice(),
        round_id,
        entry_universe_root,
        &total_tickets.to_le_bytes(),
        participant_entropy_root,
        chain_entropy_root,
    ])
}

/// Chain entropy from predetermined block hashes.
///
/// chain_entropy_root = H("DAOWOW_CHAIN_ENTROPY_V1" || h1 || h2 || ... )
pub fn chain_entropy_root(block_hashes: &[Hash32]) -> Hash32 {
    let mut h = Blake2b256::new();
    h.update(b"DAOWOW_CHAIN_ENTROPY_V1");
    for b in block_hashes {
        h.update(b);
    }
    h.finalize()
}

/// Participant entropy root (reveals plus missing-reveal fallbacks).
pub fn participant_entropy_root(reveals: &[Hash32]) -> Hash32 {
    let mut h = Blake2b256::new();
    h.update(b"DAOWOW_PARTICIPANT_ENTROPY_V1");
    for r in reveals {
        h.update(r);
    }
    h.finalize()
}

/// Candidate hash for prize `prize_index` and retry counter.
pub fn candidate(seed: &Hash32, prize_index: u64, retry: u32) -> Hash32 {
    ckb_hash256(&[
        b"DAOWOW_DRAW_CANDIDATE_V1".as_slice(),
        seed,
        &prize_index.to_le_bytes(),
        &retry.to_le_bytes(),
    ])
}

/// Rejection sampling without modulo bias.
///
/// position = candidate mod N, where candidates >= floor(2^256 / N) * N are
/// rejected (retry counter increments deterministically).
pub fn rejection_sample(
    seed: &Hash32,
    prize_index: u64,
    n_tickets: u64,
) -> Result<(u64, u32), CoreError> {
    if n_tickets == 0 {
        return Err(CoreError::InvalidArgument);
    }
    let mut retry: u32 = 0;
    loop {
        let c = candidate(seed, prize_index, retry);
        let position = unbiased_mod(&c, n_tickets);
        if let Some(p) = position {
            return Ok((p, retry));
        }
        retry = next_retry(retry)?;
    }
}

/// Interpret a 256-bit candidate as u256 and reduce mod n if unbiased.
/// Returns None when the candidate must be rejected.
///
/// Exact rule: reject iff candidate >= limit where limit = floor(2^256 / n) * n.
fn unbiased_mod(candidate: &Hash32, n: u64) -> Option<u64> {
    if n == 0 {
        return None;
    }
    // The mathematical limit is 2^256 itself when the remainder is zero;
    // it cannot be represented in Hash32 and every candidate is valid.
    if two256_mod(n) == 0 {
        return Some(mod_u256_u64(candidate, n));
    }
    let limit = limit_bytes(n);
    if cmp_u256(candidate, &limit) != core::cmp::Ordering::Less {
        return None;
    }
    Some(mod_u256_u64(candidate, n))
}

fn cmp_u256(a: &Hash32, b: &Hash32) -> core::cmp::Ordering {
    // big-endian comparison
    for i in 0..32 {
        match a[i].cmp(&b[i]) {
            core::cmp::Ordering::Equal => continue,
            o => return o,
        }
    }
    core::cmp::Ordering::Equal
}

/// limit = floor(2^256 / n) * n as 256-bit big-endian bytes
fn limit_bytes(n: u64) -> Hash32 {
    // 2^256 = n*q + r  =>  limit = 2^256 - r. Compute r = 2^256 mod n,
    // then subtract from 0 (mod 2^256): limit = -r mod 2^256.
    let r = two256_mod(n);
    let mut out = [0u8; 32];
    // -r mod 2^256 as big-endian bytes
    let r_bytes = r.to_be_bytes();
    // subtract r from 2^256 (which is 1 followed by 256 zero bits) =>
    // limit = (2^256 - r) represented as bytes
    borrow_sub_from_power2(&r_bytes, &mut out);
    out
}

fn borrow_sub_from_power2(r_be: &[u8; 8], out: &mut Hash32) {
    // out = 2^256 - r computed as (2^256 - 1) - (r - 1) = !(r-1) over 256 bits,
    // with r placed big-endian in the low 64 bits.
    let r_minus_1 = u64::from_be_bytes(*r_be).wrapping_sub(1);
    let rb = r_minus_1.to_be_bytes();
    let mut tmp = [0xFFu8; 32];
    for i in 0..8 {
        tmp[24 + i] = !rb[i];
    }
    *out = tmp;
}

/// 2^256 mod n via repeated doubling of (1 mod n).
fn two256_mod(n: u64) -> u64 {
    let mut r: u128 = 1 % n as u128;
    for _ in 0..256 {
        r = (r << 1) % n as u128;
    }
    r as u64
}

/// candidate (256-bit BE bytes) mod n via Horner in u128.
fn mod_u256_u64(candidate: &Hash32, n: u64) -> u64 {
    let n128 = n as u128;
    let mut r: u128 = 0;
    for &b in candidate.iter() {
        r = ((r << 8) | b as u128) % n128;
    }
    r as u64
}

/// Draw `prize_count` distinct winning positions for `n_tickets`.
///
/// Duplicate positions retry deterministically (one position wins at most
/// once per round; a participant owning multiple distinct positions may win
/// multiple prizes).
pub const MAX_PRIZES: usize = 4096;

pub fn draw_positions(
    seed: &Hash32,
    n_tickets: u64,
    prize_count: u64,
    prizes: &mut [(u64, u64)], // (prize_index, winning_position)
) -> Result<(), CoreError> {
    draw_positions_using(n_tickets, prize_count, prizes, |prize, retry| {
        candidate(seed, prize, retry)
    })
}

fn next_retry(retry: u32) -> Result<u32, CoreError> {
    retry.checked_add(1).ok_or(CoreError::Overflow)
}

fn draw_positions_using(
    n_tickets: u64,
    prize_count: u64,
    prizes: &mut [(u64, u64)],
    mut candidate_at: impl FnMut(u64, u32) -> Hash32,
) -> Result<(), CoreError> {
    if n_tickets == 0
        || prize_count > n_tickets
        || prize_count > MAX_PRIZES as u64
        || prizes.len() < prize_count as usize
    {
        return Err(CoreError::InvalidArgument);
    }
    let mut used = [0u64; MAX_PRIZES];
    for (i, slot) in prizes.iter_mut().enumerate().take(prize_count as usize) {
        let mut retry = 0;
        let pos = loop {
            if let Some(pos) = unbiased_mod(&candidate_at(i as u64, retry), n_tickets) {
                if !used[..i].contains(&pos) {
                    break pos;
                }
            }
            retry = next_retry(retry)?;
        };
        used[i] = pos;
        slot.0 = i as u64;
        slot.1 = pos;
    }
    Ok(())
}

#[cfg(feature = "std")]
pub use stdext::*;

#[cfg(feature = "std")]
mod stdext {
    use super::*;

    pub fn rejection_sample_public(
        seed: &Hash32,
        prize_index: u64,
        n: u64,
    ) -> Result<(u64, u32), CoreError> {
        rejection_sample(seed, prize_index, n)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mod_math_correctness() {
        // brute-force small cases against the 256-bit Horner mod
        for n in [2u64, 3, 7, 10, 65537, 4_294_967_291] {
            // candidate = n*k + r for known r: candidate bytes = BE(k*n + r)
            for r in 0u64..n.min(50) {
                for k in [0u64, 1, 12345, u64::MAX / 2] {
                    let val = match k.checked_mul(n).and_then(|v| v.checked_add(r)) {
                        Some(v) => v,
                        None => continue,
                    };
                    let mut c = [0u8; 32];
                    c[24..].copy_from_slice(&val.to_be_bytes());
                    assert_eq!(mod_u256_u64(&c, n), r, "n={n} k={k} r={r}");
                }
            }
            // limit check: limit must be a multiple of n and <= 2^256
            let limit = limit_bytes(n);
            let limit_low = u64::from_be_bytes(limit[24..].try_into().unwrap());
            // limit mod n == 0
            assert_eq!(mod_u256_u64(&limit, n), 0, "limit mod n == 0 for n={n}");
            // limit + n overflows 2^256: limit > 2^256 - n
            // equivalently: 2^256 - limit < n
            let two256_minus_limit = mod_dist(&limit, n);
            assert!(two256_minus_limit < n, "2^256-limit < n for n={n}");
            let _ = limit_low;
        }
    }

    /// 2^256 - limit (= r = 2^256 mod n) recovered by subtracting in u128
    /// pieces; only used in tests.
    fn mod_dist(limit: &Hash32, n: u64) -> u64 {
        // 2^256 - limit where limit = multiple of n; compute via u256 subtract
        // from 1<<256 using two's complement: -limit mod 2^256
        let mut inv = [0u8; 32];
        for i in 0..32 {
            inv[i] = !limit[i];
        }
        // add 1
        for i in (0..32).rev() {
            if inv[i] == 255 {
                inv[i] = 0;
            } else {
                inv[i] += 1;
                break;
            }
        }
        mod_u256_u64(&inv, n)
    }

    #[test]
    fn rejection_sampling_bounded_and_deterministic() {
        let seed = draw_seed(&[1; 32], &[2; 32], 1_000_000, &[3; 32], &[4; 32]);
        for i in 0..20 {
            let (pos, retry) = rejection_sample(&seed, i, 1_000_000).unwrap();
            assert!(pos < 1_000_000);
            let (pos2, _) = rejection_sample(&seed, i, 1_000_000).unwrap();
            assert_eq!(pos, pos2);
            assert!(retry < 1000);
        }
        // n=1 degenerates to position 0
        let (pos, _) = rejection_sample(&seed, 0, 1).unwrap();
        assert_eq!(pos, 0);
    }

    #[test]
    fn distinct_positions_draw() {
        let seed = draw_seed(&[9; 32], &[8; 32], 1_000, &[7; 32], &[6; 32]);
        let mut slots = [(0u64, 0u64); 50];
        draw_positions(&seed, 1_000, 50, &mut slots).unwrap();
        let mut seen = std::collections::HashSet::new();
        for s in slots.iter() {
            assert!(seen.insert(s.1), "duplicate winning position");
            assert!(s.1 < 1_000);
        }
        // more prizes than tickets must fail
        let mut slots2 = [(0u64, 0u64); 11];
        assert!(draw_positions(&seed, 10, 11, &mut slots2).is_err());

        // The requested output must fit in the caller-provided buffer.
        let mut short = [(0u64, 0u64); 1];
        assert_eq!(
            draw_positions(&seed, 10, 2, &mut short),
            Err(CoreError::InvalidArgument)
        );
    }

    #[test]
    fn forced_rejection_case_vector() {
        // For n=3 the largest u256 value is exactly the finite limit and
        // must be rejected. For n=2, 2^256 is divisible by n, so every
        // representable candidate is below the mathematical limit.
        let c = [0xFFu8; 32];
        assert_eq!(unbiased_mod(&c, 3), None);
        assert_eq!(unbiased_mod(&c, 2), Some(1));
        assert!(unbiased_mod(&c, 7).is_none());
        assert!(unbiased_mod(&c, 5).is_none());
        for n in [1, 2, 4, 256, 1u64 << 63] {
            assert_eq!(unbiased_mod(&c, n), Some(n - 1));
        }
        let mut below = c;
        below[31] = 254;
        assert_eq!(unbiased_mod(&below, 3), Some(2));
    }

    #[test]
    fn rejection_sampling_rejects_empty_universe() {
        assert_eq!(
            rejection_sample(&[0; 32], 0, 0),
            Err(CoreError::InvalidArgument)
        );
    }

    #[test]
    fn retries_are_sequential_across_duplicates_and_rejection() {
        let mut calls = Vec::new();
        let mut prizes = [(99, 99); 2];
        draw_positions_using(3, 2, &mut prizes, |prize, retry| {
            calls.push((prize, retry));
            match (prize, retry) {
                (0, 0) | (1, 0) => [0; 32],
                (1, 1) => [255; 32], // exactly the rejection limit for n=3
                (1, 2) => {
                    let mut value = [0; 32];
                    value[31] = 1;
                    value
                }
                _ => panic!("skipped a candidate or continued after a valid draw"),
            }
        })
        .unwrap();
        assert_eq!(prizes, [(0, 0), (1, 1)]);
        assert_eq!(calls, [(0, 0), (1, 0), (1, 1), (1, 2)]);
        assert_eq!(next_retry(u32::MAX), Err(CoreError::Overflow));
    }
}
