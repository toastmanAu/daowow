//! Bounded phase-2 payload. Small payloads may occupy WitnessArgs.output_type;
//! large payloads use a separate raw witness referenced there by tag0 + an
//! absolute u32 LE index beyond all inputs. Native DAO's header index remains
//! in input_type. Transport/reference validation belongs to contract callers.
use crate::{
    computed_draw::WinnerProof, encoding::EntryDataV1, schedule::PrizeSchedule, CoreError,
};
use alloc::vec::Vec;

pub const MAX_ENTITLEMENT_BYTES: usize = 160 * 1024;
pub const MAX_WINNER_PROOF_BYTES: usize = 8192;

/// Structurally decoded evidence, not authenticated entitlements. Config,
/// receipt, entropy and DAO values come from chain context, not this payload.
pub struct EntitlementWitness<'a> {
    schedule: PrizeSchedule,
    entries: Vec<EntryDataV1>,
    capacities: Vec<u64>,
    winners: Vec<EntryDataV1>,
    proofs: Vec<&'a [u8]>,
}

impl<'a> EntitlementWitness<'a> {
    /// Decode version1's exact length-prefixed fields. Reject invalid lengths,
    /// excessive counts/proofs and trailing data. Proofs borrow from `data`;
    /// entry validity, membership and schedule/config binding are checked later.
    pub fn decode(data: &'a [u8]) -> Result<Self, CoreError> {
        use crate::{
            encoding::ENTRY_DATA_SIZE, lifecycle::MAX_BATCH_ENTRIES, schedule::MAX_SCHEDULE_PRIZES,
        };
        if data.len() > MAX_ENTITLEMENT_BYTES {
            return Err(CoreError::Encoding);
        }
        let mut rest = data;
        if take(&mut rest, 1)? != [1] {
            return Err(CoreError::Encoding);
        }
        let schedule_len = count(&mut rest)?;
        if schedule_len > 5 + MAX_SCHEDULE_PRIZES * 8 {
            return Err(CoreError::Encoding);
        }
        let schedule = PrizeSchedule::decode(take(&mut rest, schedule_len)?)?;
        let n = count(&mut rest)?;
        if n == 0 || n > MAX_BATCH_ENTRIES || rest.len() < n * (ENTRY_DATA_SIZE + 8) + 4 {
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
        let n = count(&mut rest)?;
        if n > MAX_SCHEDULE_PRIZES || rest.len() < n * (ENTRY_DATA_SIZE + 4) {
            return Err(CoreError::Encoding);
        }
        let mut winners = Vec::with_capacity(n);
        let mut proofs = Vec::with_capacity(n);
        for _ in 0..n {
            winners.push(EntryDataV1::decode(take(&mut rest, ENTRY_DATA_SIZE)?)?);
            let length = count(&mut rest)?;
            if length > MAX_WINNER_PROOF_BYTES {
                return Err(CoreError::Encoding);
            }
            proofs.push(take(&mut rest, length)?);
        }
        if !rest.is_empty() {
            return Err(CoreError::Encoding);
        }
        Ok(Self {
            schedule,
            entries,
            capacities,
            winners,
            proofs,
        })
    }

    /// Encode the same bounded wire as [`Self::decode`], rejecting arity,
    /// count and proof/total-length violations before allocating the output.
    /// Does not assert that entries, capacities or winner proofs are authentic.
    pub fn encode(
        schedule: &PrizeSchedule,
        entries: &[EntryDataV1],
        capacities: &[u64],
        winners: &[(EntryDataV1, &[u8])],
    ) -> Result<Vec<u8>, CoreError> {
        use crate::{
            encoding::ENTRY_DATA_SIZE, lifecycle::MAX_BATCH_ENTRIES, schedule::MAX_SCHEDULE_PRIZES,
        };
        if entries.is_empty()
            || entries.len() > MAX_BATCH_ENTRIES
            || capacities.len() != entries.len()
            || winners.len() > MAX_SCHEDULE_PRIZES
        {
            return Err(CoreError::Encoding);
        }
        let schedule = schedule.encode();
        let mut size = 1 + 4 + schedule.len() + 4 + entries.len() * (ENTRY_DATA_SIZE + 8) + 4;
        for (_, proof) in winners {
            if proof.len() > MAX_WINNER_PROOF_BYTES {
                return Err(CoreError::Encoding);
            }
            size = size
                .checked_add(ENTRY_DATA_SIZE + 4 + proof.len())
                .ok_or(CoreError::Overflow)?;
        }
        if size > MAX_ENTITLEMENT_BYTES {
            return Err(CoreError::Encoding);
        }
        let mut out = Vec::with_capacity(size);
        out.push(1);
        out.extend_from_slice(&(schedule.len() as u32).to_le_bytes());
        out.extend_from_slice(&schedule);
        out.extend_from_slice(&(entries.len() as u32).to_le_bytes());
        for (entry, capacity) in entries.iter().zip(capacities) {
            out.extend_from_slice(&entry.encode());
            out.extend_from_slice(&capacity.to_le_bytes());
        }
        out.extend_from_slice(&(winners.len() as u32).to_le_bytes());
        for (entry, proof) in winners {
            out.extend_from_slice(&entry.encode());
            out.extend_from_slice(&(proof.len() as u32).to_le_bytes());
            out.extend_from_slice(proof);
        }
        Ok(out)
    }
    /// Schedule must still match the authenticated config commitment.
    pub fn schedule(&self) -> &PrizeSchedule {
        &self.schedule
    }
    /// Complete ordered batch entries for receipt replay.
    pub fn entries(&self) -> &[EntryDataV1] {
        &self.entries
    }
    /// Declared full deposited capacities, authenticated by receipt replay.
    pub fn capacities(&self) -> &[u64] {
        &self.capacities
    }
    /// Borrowed entry/proof views in declared prize order; verify against the
    /// computed positions before deriving amounts. No proof bytes are cloned.
    pub fn winner_proofs(&self) -> Vec<WinnerProof<'_>> {
        self.winners
            .iter()
            .zip(&self.proofs)
            .map(|(entry, proof)| WinnerProof { entry, proof })
            .collect()
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
    fn exact_payload_roundtrip_borrows_proofs_without_claimed_roots() {
        let s = PrizeSchedule::new(&[1]).unwrap();
        let e = entry();
        let wire = EntitlementWitness::encode(&s, &[e], &[500], &[(e, &[0xaa, 0xbb])]).unwrap();
        assert_eq!(&wire[..5], &[1, 13, 0, 0, 0]);
        assert_eq!(&wire[5..18], &[1, 1, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0]);
        assert_eq!(&wire[18..22], &[1, 0, 0, 0]);
        assert_eq!(&wire[154..162], &[244, 1, 0, 0, 0, 0, 0, 0]);
        assert_eq!(&wire[162..166], &[1, 0, 0, 0]);
        assert_eq!(&wire[298..], &[2, 0, 0, 0, 0xaa, 0xbb]);
        let d = EntitlementWitness::decode(&wire).unwrap();
        assert_eq!(d.schedule(), &s);
        assert_eq!(d.entries(), &[e]);
        assert_eq!(d.capacities(), &[500]);
        let views = d.winner_proofs();
        assert_eq!(views[0].entry, &e);
        assert_eq!(views[0].proof, &[0xaa, 0xbb]);
        assert_eq!(views[0].proof.as_ptr(), wire[302..].as_ptr());
    }

    #[test]
    fn rejects_all_truncations_trailing_bytes_and_bad_lengths() {
        let wire = EntitlementWitness::encode(
            &PrizeSchedule::new(&[1]).unwrap(),
            &[entry()],
            &[500],
            &[(entry(), &[1, 2])],
        )
        .unwrap();
        for end in 0..wire.len() {
            assert!(EntitlementWitness::decode(&wire[..end]).is_err(), "{end}");
        }
        let mut extra = wire.clone();
        extra.push(0);
        assert!(EntitlementWitness::decode(&extra).is_err());
        for (offset, value) in [
            (1, u32::MAX),
            (18, 0),
            (18, 33),
            (162, 33),
            (298, u32::MAX),
            (298, 8193),
        ] {
            let mut bad = wire.clone();
            bad[offset..offset + 4].copy_from_slice(&value.to_le_bytes());
            assert!(EntitlementWitness::decode(&bad).is_err());
        }
        let mut bad = wire;
        bad[0] = 2;
        assert!(EntitlementWitness::decode(&bad).is_err());
        assert!(EntitlementWitness::decode(&vec![0; MAX_ENTITLEMENT_BYTES + 1]).is_err());
    }

    #[test]
    fn supports_failed_round_and_enforces_encoding_bounds() {
        let s = PrizeSchedule::new(&[1; 32]).unwrap();
        let e = entry();
        let wire = EntitlementWitness::encode(&s, &[e; 32], &[500; 32], &[]).unwrap();
        let d = EntitlementWitness::decode(&wire).unwrap();
        assert_eq!(d.entries().len(), 32);
        assert!(d.winner_proofs().is_empty());
        assert!(EntitlementWitness::encode(&s, &[], &[], &[]).is_err());
        assert!(EntitlementWitness::encode(&s, &[e; 33], &[500; 33], &[]).is_err());
        assert!(EntitlementWitness::encode(&s, &[e], &[], &[]).is_err());
        assert!(EntitlementWitness::encode(&s, &[e], &[500], &[(e, &[][..]); 33]).is_err());
        let max = vec![1; MAX_WINNER_PROOF_BYTES];
        let wire = EntitlementWitness::encode(&s, &[e], &[500], &[(e, &max)]).unwrap();
        assert_eq!(
            EntitlementWitness::decode(&wire).unwrap().winner_proofs()[0].proof,
            max
        );
        assert!(EntitlementWitness::encode(
            &s,
            &[e],
            &[500],
            &[(e, &vec![1; MAX_WINNER_PROOF_BYTES + 1])]
        )
        .is_err());
        assert!(EntitlementWitness::encode(&s, &[e], &[500], &[(e, max.as_slice()); 32]).is_err());
    }

    #[test]
    fn whole_payload_limit_accepts_exact_boundary_and_rejects_valid_oversize() {
        let s = PrizeSchedule::new(&[1]).unwrap();
        let e = entry();
        let proof = vec![1; MAX_WINNER_PROOF_BYTES];
        let tail = vec![2; 5306];
        let mut winners = vec![(e, proof.as_slice()); 19];
        winners.push((e, tail.as_slice()));
        let wire = EntitlementWitness::encode(&s, &[e], &[500], &winners).unwrap();
        assert_eq!(wire.len(), MAX_ENTITLEMENT_BYTES);
        assert_eq!(
            EntitlementWitness::decode(&wire)
                .unwrap()
                .winner_proofs()
                .len(),
            20
        );
        // Otherwise valid wire: enlarge the final proof and its length field.
        let mut oversize = wire;
        let length_offset = oversize.len() - tail.len() - 4;
        oversize[length_offset..length_offset + 4].copy_from_slice(&5307u32.to_le_bytes());
        oversize.push(2);
        assert!(EntitlementWitness::decode(&oversize).is_err());
        let tail = vec![2; 5307];
        winners[19].1 = tail.as_slice();
        assert!(EntitlementWitness::encode(&s, &[e], &[500], &winners).is_err());
        let wire =
            EntitlementWitness::encode(&s, &[e; 32], &[500; 32], &[(e, &[1][..]); 32]).unwrap();
        let decoded = EntitlementWitness::decode(&wire).unwrap();
        assert_eq!(decoded.entries().len(), 32);
        assert_eq!(decoded.winner_proofs().len(), 32);
    }

    #[test]
    fn decoded_evidence_derives_entitlements_and_rejects_altered_capacity() {
        use crate::{
            computed_draw::{
                tests::{fixture, winners},
                ComputedDraw,
            },
            encoding::PayoutItem,
            entitlements::{EntitlementInput, InitialEntitlements},
            lifecycle::AggregationState,
        };
        let f = fixture(1, true);
        let draw = ComputedDraw::new(&f.cfg, &f.record, &f.schedule).unwrap();
        let declarations = winners(&f, &draw);
        let records: Vec<_> = declarations.iter().map(|p| (*p.entry, p.proof)).collect();
        let receipt = AggregationState::new(&f.cfg, f.record.seal().ledger(0).unwrap().frozen())
            .unwrap()
            .accept(&f.cfg, &f.entries[0][..1], &[250], &[&f.proofs[0][0]])
            .unwrap()
            .1;
        let wire =
            EntitlementWitness::encode(&f.schedule, &f.entries[0][..1], &[250], &records).unwrap();
        let decoded = EntitlementWitness::decode(&wire).unwrap();
        let owners = decoded.winner_proofs();
        let input = EntitlementInput {
            batch_id: 0,
            receipt: &receipt,
            entries: decoded.entries(),
            capacities: decoded.capacities(),
            realized_total: 350,
            winners: &owners,
        };
        let derived =
            InitialEntitlements::derive(&f.cfg, &f.record, decoded.schedule(), &input).unwrap();
        assert_eq!(
            derived.liabilities(),
            &[
                PayoutItem {
                    participant_lock_hash: [10; 32],
                    principal: 250,
                    prize: 30
                },
                PayoutItem {
                    participant_lock_hash: [12; 32],
                    principal: 0,
                    prize: 70
                }
            ]
        );
        // Well-formed encoding is not evidence that a claimed capacity is real.
        let wrong_wire =
            EntitlementWitness::encode(&f.schedule, &f.entries[0][..1], &[251], &records).unwrap();
        let wrong = EntitlementWitness::decode(&wrong_wire).unwrap();
        let owners = wrong.winner_proofs();
        let input = EntitlementInput {
            batch_id: 0,
            receipt: &receipt,
            entries: wrong.entries(),
            capacities: wrong.capacities(),
            realized_total: 350,
            winners: &owners,
        };
        assert!(InitialEntitlements::derive(&f.cfg, &f.record, wrong.schedule(), &input).is_err());
    }
}
