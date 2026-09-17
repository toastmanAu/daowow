//! Canonical committed prize schedules for authenticated entitlements.
use crate::{
    hash::{ckb_hash256, Hash32},
    CoreError,
};
use alloc::vec::Vec;

/// Initial authenticated on-chain schedule bound, not the legacy draw limit.
pub const MAX_SCHEDULE_PRIZES: usize = 32;

/// Validation is preserved by private weights. A valid schedule becomes
/// authoritative only after checking its commitment against an authenticated
/// round config; decoding alone does not establish that provenance.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PrizeSchedule {
    weights: Vec<u64>,
}

impl PrizeSchedule {
    /// Validate 1–32 strictly positive weights. Returns `InvalidArgument`
    /// for an invalid count/zero weight, or `Overflow` if their sum exceeds u64.
    pub fn new(weights: &[u64]) -> Result<Self, CoreError> {
        validate_weights(weights)?;
        Ok(Self {
            weights: weights.to_vec(),
        })
    }

    /// Canonical wire: version 1, count u32 LE, then ordered weights u64 LE.
    pub fn encode(&self) -> Vec<u8> {
        let mut out = Vec::with_capacity(5 + self.weights.len() * 8);
        out.push(1);
        out.extend_from_slice(&(self.weights.len() as u32).to_le_bytes());
        for weight in &self.weights {
            out.extend_from_slice(&weight.to_le_bytes());
        }
        out
    }

    /// Decode exact canonical wire. Returns `Encoding` for an unsupported
    /// version, invalid count, truncated or trailing bytes; weight validation
    /// has the same errors as [`Self::new`]. No cell provenance is established.
    pub fn decode(data: &[u8]) -> Result<Self, CoreError> {
        if data.len() < 5 || data[0] != 1 {
            return Err(CoreError::Encoding);
        }
        let count = u32::from_le_bytes(data[1..5].try_into().map_err(|_| CoreError::Encoding)?);
        // Bound the untrusted count before arithmetic, allocation or iteration.
        if count == 0 || count > MAX_SCHEDULE_PRIZES as u32 || data.len() != 5 + count as usize * 8
        {
            return Err(CoreError::Encoding);
        }
        let weights: Vec<_> = data[5..]
            .as_chunks::<8>()
            .0
            .iter()
            .map(|bytes| u64::from_le_bytes(*bytes))
            .collect();
        validate_weights(&weights)?;
        Ok(Self { weights })
    }

    /// CKB-personalized Blake2b-256 of `DAOWOW_PRIZE_SCHEDULE_V1 || encoding`.
    pub fn commitment(&self) -> Hash32 {
        ckb_hash256(&[b"DAOWOW_PRIZE_SCHEDULE_V1", &self.encode()])
    }

    /// `expected` must come from the authenticated config, not the witness.
    pub fn decode_committed(data: &[u8], expected: &Hash32) -> Result<Self, CoreError> {
        let schedule = Self::decode(data)?;
        if schedule.commitment() != *expected {
            return Err(CoreError::StateTransition);
        }
        Ok(schedule)
    }

    /// Only successful nonempty rounds draw. Failure eligibility is decided
    /// separately using the authenticated accepted total and minimum tickets.
    pub fn weights_for(&self, tickets: u64) -> Result<&[u64], CoreError> {
        if tickets == 0 {
            return Err(CoreError::InvalidArgument);
        }
        let count = tickets.min(self.weights.len() as u64) as usize;
        Ok(&self.weights[..count])
    }

    /// The caller derives this batch's yield from actual native DAO growth.
    /// No batch-specific value influences which global prize indices exist.
    pub fn allocate(&self, tickets: u64, batch_yield: u64) -> Result<Vec<u64>, CoreError> {
        crate::accounting::allocate_prizes_complete(self.weights_for(tickets)?, batch_yield)
    }

    /// Smallest batch prize pool for which no drawn position allocates zero.
    ///
    /// `allocate_prizes` gives position `i` exactly `floor(pool * w_i / W)`, so
    /// that value is positive iff `pool * w_i >= W`. The binding position is the
    /// smallest weight, giving `ceil(W / w_min)`. Index zero also receives the
    /// dust, so it is never the binding case.
    ///
    /// This is conservative, not exact: when the smallest weight happens to sit
    /// at index 0, that position receives the dust and can never be the binding
    /// one, so the true zero-free threshold is lower than `ceil(W / w_min)` in
    /// that case (e.g. weights `[3, 7]` at pool 3 already allocates `[1, 2]`,
    /// no zero, below this function's reported bar of `ceil(10/3) = 4`). The
    /// formula therefore can void a round that would in fact have paid every
    /// prize, but it can never admit one that would not.
    pub fn min_viable_pool(&self, tickets: u64) -> Result<u64, CoreError> {
        let weights = self.weights_for(tickets)?;
        let sum = crate::accounting::checked_sum(weights)?;
        // validate_weights rejects zero weights, so min is positive.
        let min = *weights.iter().min().ok_or(CoreError::InvalidArgument)?;
        Ok(sum.div_ceil(min))
    }
}

fn validate_weights(weights: &[u64]) -> Result<(), CoreError> {
    if weights.is_empty() || weights.len() > MAX_SCHEDULE_PRIZES || weights.contains(&0) {
        return Err(CoreError::InvalidArgument);
    }
    crate::accounting::checked_sum(weights)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use alloc::vec;

    const WIRE: [u8; 45] = [
        1, 5, 0, 0, 0, 40, 0, 0, 0, 0, 0, 0, 0, 25, 0, 0, 0, 0, 0, 0, 0, 20, 0, 0, 0, 0, 0, 0, 0,
        10, 0, 0, 0, 0, 0, 0, 0, 5, 0, 0, 0, 0, 0, 0, 0,
    ];
    // Independently computed with Python hashlib.blake2b, digest_size=32,
    // person=b"ckb-default-hash", over the specified domain and literal wire.
    const COMMITMENT: Hash32 = [
        0x80, 0xd3, 0x6a, 0xe2, 0x91, 0x36, 0xe1, 0x69, 0x4e, 0x7c, 0xce, 0x5b, 0xa3, 0x75, 0xac,
        0xdd, 0x7e, 0x97, 0x7c, 0xc9, 0x5b, 0x07, 0xd6, 0xd3, 0xf8, 0x02, 0x8e, 0x4b, 0x7a, 0x4d,
        0x49, 0x73,
    ];

    #[test]
    fn canonical_wire_and_independent_commitment_vector() {
        let s = PrizeSchedule::new(&[40, 25, 20, 10, 5]).unwrap();
        assert_eq!(s.encode(), WIRE);
        assert_eq!(s.commitment(), COMMITMENT);
        assert_eq!(PrizeSchedule::decode_committed(&WIRE, &COMMITMENT), Ok(s));
    }

    #[test]
    fn rejects_empty_zero_overflowing_and_oversized_weights() {
        assert_eq!(PrizeSchedule::new(&[]), Err(CoreError::InvalidArgument));
        assert_eq!(PrizeSchedule::new(&[1, 0]), Err(CoreError::InvalidArgument));
        assert_eq!(PrizeSchedule::new(&[u64::MAX, 1]), Err(CoreError::Overflow));
        assert_eq!(
            PrizeSchedule::new(&[1; 33]),
            Err(CoreError::InvalidArgument)
        );
        let max = PrizeSchedule::new(&[1; 32]).unwrap();
        assert_eq!(PrizeSchedule::decode(&max.encode()), Ok(max.clone()));
        let mut expected = vec![1; 32];
        expected[0] = 2;
        assert_eq!(max.allocate(u64::MAX, 33), Ok(expected));
        assert_eq!(
            PrizeSchedule::new(&[u64::MAX])
                .unwrap()
                .allocate(1, u64::MAX),
            Ok(vec![u64::MAX])
        );
    }

    #[test]
    fn decoder_rejects_malleable_and_unbounded_wire() {
        for length in 0..WIRE.len() {
            assert_eq!(
                PrizeSchedule::decode(&WIRE[..length]),
                Err(CoreError::Encoding)
            );
        }
        let mut trailing = WIRE.to_vec();
        trailing.push(0);
        assert_eq!(PrizeSchedule::decode(&trailing), Err(CoreError::Encoding));
        let mut bad = WIRE;
        bad[0] = 2;
        assert_eq!(PrizeSchedule::decode(&bad), Err(CoreError::Encoding));
        for count in [0u32, 4, 6, 33, u32::MAX] {
            let mut bad = WIRE;
            bad[1..5].copy_from_slice(&count.to_le_bytes());
            assert_eq!(PrizeSchedule::decode(&bad), Err(CoreError::Encoding));
        }
        let mut zero = WIRE;
        zero[5..13].fill(0);
        assert_eq!(
            PrizeSchedule::decode(&zero),
            Err(CoreError::InvalidArgument)
        );
        let mut overflow = WIRE;
        overflow[5..13].fill(255);
        assert_eq!(PrizeSchedule::decode(&overflow), Err(CoreError::Overflow));
    }

    #[test]
    fn commitment_rejects_substitution_and_weight_reordering() {
        assert_eq!(
            PrizeSchedule::decode_committed(&WIRE, &[0; 32]),
            Err(CoreError::StateTransition)
        );
        let mut changed = WIRE;
        changed[5] = 41;
        assert_eq!(
            PrizeSchedule::decode_committed(&changed, &COMMITMENT),
            Err(CoreError::StateTransition)
        );
        let mut reordered = WIRE;
        reordered[5] = 25;
        reordered[13] = 40;
        assert_eq!(
            PrizeSchedule::decode_committed(&reordered, &COMMITMENT),
            Err(CoreError::StateTransition)
        );
    }

    #[test]
    fn truncates_before_normalizing_and_assigns_dust_to_first_prize() {
        let s = PrizeSchedule::decode(&WIRE).unwrap();
        assert_eq!(s.weights_for(2), Ok(&[40, 25][..]));
        assert_eq!(s.allocate(2, 100), Ok(vec![62, 38]));
        assert_eq!(s.allocate(1, 100), Ok(vec![100]));
        assert_eq!(s.allocate(3, 100), Ok(vec![48, 29, 23]));
        assert_eq!(s.allocate(u64::MAX, 100), Ok(vec![40, 25, 20, 10, 5]));
        assert_eq!(s.allocate(5, 1), Ok(vec![1, 0, 0, 0, 0]));
        assert_eq!(s.allocate(5, 0), Ok(vec![0; 5]));
        assert_eq!(s.allocate(0, 100), Err(CoreError::InvalidArgument));
    }

    #[test]
    fn min_viable_pool_is_ceil_sum_over_min_weight() {
        // [40,25,20,10,5]: sum 100, min 5 -> 20
        let s = PrizeSchedule::new(&[40, 25, 20, 10, 5]).unwrap();
        assert_eq!(s.min_viable_pool(100), Ok(20));
        // [1,1,1000]: sum 1002, min 1 -> 1002
        let wide = PrizeSchedule::new(&[1, 1, 1000]).unwrap();
        assert_eq!(wide.min_viable_pool(100), Ok(1002));
        // exact division does not round up
        let flat = PrizeSchedule::new(&[2, 2]).unwrap();
        assert_eq!(flat.min_viable_pool(100), Ok(2));
    }

    #[test]
    fn min_viable_pool_follows_the_weights_for_truncation() {
        // fewer tickets than prizes truncates the weight list, so the bar moves
        let s = PrizeSchedule::new(&[1, 1, 1000]).unwrap();
        assert_eq!(s.min_viable_pool(2), Ok(2)); // weights [1,1]: sum 2, min 1
        assert_eq!(s.min_viable_pool(1), Ok(1)); // weights [1]:   sum 1, min 1
        assert_eq!(s.min_viable_pool(0), Err(CoreError::InvalidArgument));
    }

    #[test]
    fn the_bar_is_exactly_the_zero_free_threshold() {
        // At the bar no position is zero; one shannon below it, one is.
        let s = PrizeSchedule::new(&[1, 1, 1000]).unwrap();
        let bar = s.min_viable_pool(100).unwrap();
        let at = crate::accounting::allocate_prizes_complete(&[1, 1, 1000], bar).unwrap();
        assert!(at.iter().all(|a| *a > 0), "{at:?}");
        let below = crate::accounting::allocate_prizes_complete(&[1, 1, 1000], bar - 1).unwrap();
        assert!(below.iter().any(|a| *a == 0), "{below:?}");
    }

    #[test]
    fn min_viable_pool_rounds_up_not_down() {
        // [7,3]: W=10, w_min=3. ceil(10/3) = 4; floor division would give 3.
        // Minimum is at index 1 (not the dust-receiving index 0), so this
        // case both distinguishes ceil from floor and brackets the real
        // zero-free threshold end-to-end.
        let s = PrizeSchedule::new(&[7, 3]).unwrap();
        assert_eq!(s.min_viable_pool(100), Ok(4));

        let at = crate::accounting::allocate_prizes_complete(&[7, 3], 4).unwrap();
        assert!(at.iter().all(|a| *a > 0), "{at:?}");

        let below = crate::accounting::allocate_prizes_complete(&[7, 3], 3).unwrap();
        assert!(below.iter().any(|a| *a == 0), "{below:?}");
    }
}
