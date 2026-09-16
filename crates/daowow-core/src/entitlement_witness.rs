//! Bounded phase-2 payload. Small payloads may occupy WitnessArgs.output_type;
//! large payloads use a separate raw witness referenced there by tag0 + an
//! absolute u32 LE index beyond all inputs. Native DAO's header index remains
//! in input_type. Transport/reference validation belongs to contract callers.
//!
//! Version 2 carries the schedule and the batch entries with their actual
//! capacities only. Winner ownership proofs are gone: prizes are credited to
//! ticket ids derived from the sealed ledgers and the draw, never to owners.
use crate::{encoding::EntryDataV1, schedule::PrizeSchedule, CoreError};
use alloc::vec::Vec;

pub const MAX_ENTITLEMENT_BYTES: usize = 160 * 1024;
const WIRE_VERSION: u8 = 2;

/// Structurally decoded evidence, not authenticated entitlements. Config,
/// receipt, entropy and DAO values come from chain context, not this payload.
pub struct EntitlementWitness {
    schedule: PrizeSchedule,
    entries: Vec<EntryDataV1>,
    capacities: Vec<u64>,
}

impl EntitlementWitness {
    /// Decode version 2's exact length-prefixed fields. Reject invalid lengths,
    /// excessive counts and trailing data. Entry validity, membership and
    /// schedule/config binding are checked later by the pure derivation.
    pub fn decode(data: &[u8]) -> Result<Self, CoreError> {
        use crate::{
            encoding::ENTRY_DATA_SIZE, lifecycle::MAX_BATCH_ENTRIES, schedule::MAX_SCHEDULE_PRIZES,
        };
        if data.len() > MAX_ENTITLEMENT_BYTES {
            return Err(CoreError::Encoding);
        }
        let mut rest = data;
        if take(&mut rest, 1)? != [WIRE_VERSION] {
            return Err(CoreError::Encoding);
        }
        let schedule_len = count(&mut rest)?;
        if schedule_len > 5 + MAX_SCHEDULE_PRIZES * 8 {
            return Err(CoreError::Encoding);
        }
        let schedule = PrizeSchedule::decode(take(&mut rest, schedule_len)?)?;
        let n = count(&mut rest)?;
        if n == 0 || n > MAX_BATCH_ENTRIES || rest.len() < n * (ENTRY_DATA_SIZE + 8) {
            return Err(CoreError::Encoding);
        }
        let mut entries = Vec::with_capacity(n);
        let mut capacities = Vec::with_capacity(n);
        for _ in 0..n {
            entries.push(EntryDataV1::decode(take(&mut rest, ENTRY_DATA_SIZE)?)?);
            capacities.push(u64::from_le_bytes(
                take(&mut rest, 8)?
                    .try_into()
                    .map_err(|_| CoreError::Encoding)?,
            ));
        }
        if !rest.is_empty() {
            return Err(CoreError::Encoding);
        }
        Ok(Self {
            schedule,
            entries,
            capacities,
        })
    }

    /// Encode the same bounded wire as [`Self::decode`], rejecting arity and
    /// count violations before allocating the output. Does not assert that
    /// entries or capacities are authentic.
    pub fn encode(
        schedule: &PrizeSchedule,
        entries: &[EntryDataV1],
        capacities: &[u64],
    ) -> Result<Vec<u8>, CoreError> {
        use crate::{encoding::ENTRY_DATA_SIZE, lifecycle::MAX_BATCH_ENTRIES};
        if entries.is_empty()
            || entries.len() > MAX_BATCH_ENTRIES
            || capacities.len() != entries.len()
        {
            return Err(CoreError::Encoding);
        }
        let schedule = schedule.encode();
        let size = 1 + 4 + schedule.len() + 4 + entries.len() * (ENTRY_DATA_SIZE + 8);
        if size > MAX_ENTITLEMENT_BYTES {
            return Err(CoreError::Encoding);
        }
        let mut out = Vec::with_capacity(size);
        out.push(WIRE_VERSION);
        out.extend_from_slice(&(schedule.len() as u32).to_le_bytes());
        out.extend_from_slice(&schedule);
        out.extend_from_slice(&(entries.len() as u32).to_le_bytes());
        for (entry, capacity) in entries.iter().zip(capacities) {
            out.extend_from_slice(&entry.encode());
            out.extend_from_slice(&capacity.to_le_bytes());
        }
        Ok(out)
    }
    /// Schedule must still match the authenticated config commitment.
    pub fn schedule(&self) -> &PrizeSchedule {
        &self.schedule
    }
    /// Declared batch entries; the receipt digest replay authenticates them.
    pub fn entries(&self) -> &[EntryDataV1] {
        &self.entries
    }
    /// Declared full entry capacities, one per entry.
    pub fn capacities(&self) -> &[u64] {
        &self.capacities
    }
}

fn take<'a>(rest: &mut &'a [u8], length: usize) -> Result<&'a [u8], CoreError> {
    let (head, tail) = rest.split_at_checked(length).ok_or(CoreError::Encoding)?;
    *rest = tail;
    Ok(head)
}

fn count(rest: &mut &[u8]) -> Result<usize, CoreError> {
    usize::try_from(u32::from_le_bytes(
        take(rest, 4)?.try_into().map_err(|_| CoreError::Encoding)?,
    ))
    .map_err(|_| CoreError::Overflow)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::encoding::ENTRY_DATA_SIZE;
    use alloc::vec;
    fn entry() -> EntryDataV1 {
        EntryDataV1 {
            round_id: [1; 32],
            shard_id: 2,
            participant_lock_hash: [3; 32],
            ticket_count: 4,
            principal: 400,
            position_base: 5,
            entry_nonce: 6,
            entropy_commitment: [7; 32],
        }
    }

    #[test]
    fn exact_payload_roundtrip() {
        let s = PrizeSchedule::new(&[1]).unwrap();
        let e = entry();
        let wire = EntitlementWitness::encode(&s, &[e], &[500]).unwrap();
        assert_eq!(&wire[..5], &[2, 13, 0, 0, 0]);
        assert_eq!(&wire[5..18], &[1, 1, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0]);
        assert_eq!(&wire[18..22], &[1, 0, 0, 0]);
        assert_eq!(&wire[154..162], &[244, 1, 0, 0, 0, 0, 0, 0]);
        assert_eq!(wire.len(), 162);
        let d = EntitlementWitness::decode(&wire).unwrap();
        assert_eq!(d.schedule(), &s);
        assert_eq!(d.entries(), &[e]);
        assert_eq!(d.capacities(), &[500]);
    }

    #[test]
    fn version_two_has_no_winner_section_and_rejects_version_one() {
        let s = PrizeSchedule::new(&[1]).unwrap();
        let wire = EntitlementWitness::encode(&s, &[entry()], &[500]).unwrap();
        assert_eq!(wire[0], 2);
        let expected = 1 + 4 + s.encode().len() + 4 + ENTRY_DATA_SIZE + 8;
        assert_eq!(wire.len(), expected);
        let mut v1 = wire.clone();
        v1[0] = 1;
        assert!(EntitlementWitness::decode(&v1).is_err());
        let mut trailing = wire.clone();
        trailing.extend_from_slice(&0u32.to_le_bytes()); // an old empty winners count
        assert!(EntitlementWitness::decode(&trailing).is_err());
    }

    #[test]
    fn rejects_all_truncations_trailing_bytes_and_bad_lengths() {
        let wire =
            EntitlementWitness::encode(&PrizeSchedule::new(&[1]).unwrap(), &[entry()], &[500])
                .unwrap();
        for end in 0..wire.len() {
            assert!(EntitlementWitness::decode(&wire[..end]).is_err(), "{end}");
        }
        let mut extra = wire.clone();
        extra.push(0);
        assert!(EntitlementWitness::decode(&extra).is_err());
        for (offset, value) in [(1, u32::MAX), (18, 0), (18, 33), (18, u32::MAX)] {
            let mut bad = wire.clone();
            bad[offset..offset + 4].copy_from_slice(&value.to_le_bytes());
            assert!(EntitlementWitness::decode(&bad).is_err());
        }
        let mut bad = wire;
        bad[0] = 3;
        assert!(EntitlementWitness::decode(&bad).is_err());
        assert!(EntitlementWitness::decode(&vec![0; MAX_ENTITLEMENT_BYTES + 1]).is_err());
    }

    #[test]
    fn supports_full_batches_and_enforces_encoding_bounds() {
        let s = PrizeSchedule::new(&[1; 32]).unwrap();
        let e = entry();
        let wire = EntitlementWitness::encode(&s, &[e; 32], &[500; 32]).unwrap();
        let d = EntitlementWitness::decode(&wire).unwrap();
        assert_eq!(d.entries().len(), 32);
        assert!(EntitlementWitness::encode(&s, &[], &[]).is_err());
        assert!(EntitlementWitness::encode(&s, &[e; 33], &[500; 33]).is_err());
        assert!(EntitlementWitness::encode(&s, &[e], &[]).is_err());
    }

    #[test]
    fn decoded_evidence_derives_entitlements_and_rejects_altered_capacity() {
        use crate::{
            computed_draw::tests::fixture,
            encoding::PayoutItem,
            entitlements::{EntitlementInput, InitialEntitlements},
            lifecycle::AggregationState,
        };
        let f = fixture(1, true);
        let receipt = AggregationState::new(&f.cfg, f.record.seal().ledger(0).unwrap().frozen())
            .unwrap()
            .accept(&f.cfg, &f.entries[0][..1], &[250], &[&f.proofs[0][0]])
            .unwrap()
            .1;
        let wire = EntitlementWitness::encode(&f.schedule, &f.entries[0][..1], &[250]).unwrap();
        let decoded = EntitlementWitness::decode(&wire).unwrap();
        let input = EntitlementInput {
            batch_id: 0,
            receipt: &receipt,
            entries: decoded.entries(),
            capacities: decoded.capacities(),
            realized_total: 350,
        };
        let derived =
            InitialEntitlements::derive(&f.cfg, &f.record, decoded.schedule(), &input).unwrap();
        // principal to the depositor; the 100 of yield is owed to four tickets
        assert_eq!(
            derived.liabilities(),
            &[PayoutItem {
                participant_lock_hash: [10; 32],
                principal: 250,
                prize: 0
            }]
        );
        assert_eq!(derived.prizes().iter().map(|p| p.amount).sum::<u64>(), 100);
        // Well-formed encoding is not evidence that a claimed capacity is real.
        let wrong_wire =
            EntitlementWitness::encode(&f.schedule, &f.entries[0][..1], &[251]).unwrap();
        let wrong = EntitlementWitness::decode(&wrong_wire).unwrap();
        let input = EntitlementInput {
            batch_id: 0,
            receipt: &receipt,
            entries: wrong.entries(),
            capacities: wrong.capacities(),
            realized_total: 350,
        };
        assert!(InitialEntitlements::derive(&f.cfg, &f.record, wrong.schedule(), &input).is_err());
    }
}
