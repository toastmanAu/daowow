//! Pure computed draw; callers must authenticate the config and entropy cells.
use crate::{
    encoding::{EntryDataV1, RoundConfigV1},
    hash::Hash32,
    schedule::PrizeSchedule,
    seal::EntropyRecord,
    CoreError,
};
use alloc::{vec, vec::Vec};

/// One owner declaration per computed prize, in prize order. The entry's full
/// canonical leaf and accepted interval are checked, not only the lock hash.
pub struct WinnerProof<'a> {
    pub entry: &'a EntryDataV1,
    pub proof: &'a [u8],
}

/// A pure derivation over a structurally validated snapshot. Neither this
/// constructor nor its membership proofs establish chain/header provenance.
pub struct ComputedDraw<'a> {
    cfg: &'a RoundConfigV1,
    record: &'a EntropyRecord,
    offsets: Vec<u64>,
    total: u64,
    seed: Hash32,
    positions: Vec<(u64, u64)>,
}

impl<'a> ComputedDraw<'a> {
    /// Validate schedule/config compatibility and closed ledgers, then derive
    /// accepted offsets and distinct positions. All counts use checked sums.
    /// The contract caller must load `cfg` and `record` from canonical cells.
    pub fn new(
        cfg: &'a RoundConfigV1,
        record: &'a EntropyRecord,
        schedule: &PrizeSchedule,
    ) -> Result<Self, CoreError> {
        cfg.validate()?;
        if schedule.commitment() != cfg.prize_schedule_hash
            || record.seal().ledger(cfg.entry_shard_count).is_some()
        {
            return Err(CoreError::StateTransition);
        }
        let mut offsets = Vec::with_capacity(cfg.entry_shard_count as usize);
        let mut total = 0u64;
        let commitment = cfg.commitment();
        for id in 0..cfg.entry_shard_count {
            let ledger = record.seal().ledger(id).ok_or(CoreError::StateTransition)?;
            // Bind the private snapshot's stored commitment to THIS config,
            // including on failed rounds. Avoid cloning the whole seal.
            if !ledger.is_bound_to(&commitment)
                || !ledger.is_closed()
                || ledger.frozen().shard_id != id
            {
                return Err(CoreError::StateTransition);
            }
            offsets.push(total);
            total = total
                .checked_add(ledger.accepted_tickets())
                .ok_or(CoreError::Overflow)?;
        }
        let seed = crate::hash::ckb_hash256(&[
            b"DAOWOW_AUTHENTICATED_DRAW_V1",
            &commitment,
            &record.encode(),
        ]);
        let mut positions = Vec::new();
        if total != 0 && total >= cfg.minimum_tickets {
            positions = vec![(0, 0); schedule.weights_for(total)?.len()];
            crate::draw::draw_positions(&seed, total, positions.len() as u64, &mut positions)?;
        }
        Ok(Self {
            cfg,
            record,
            offsets,
            total,
            seed,
            positions,
        })
    }
    /// Total accepted tickets, excluding every unaggregated suffix.
    pub fn total_tickets(&self) -> u64 {
        self.total
    }
    /// Exact approved domain-separated seed; no batch yield or timing input.
    pub fn seed(&self) -> Hash32 {
        self.seed
    }
    /// Ordered (prize index, global ticket position) pairs; empty on failure.
    pub fn positions(&self) -> &[(u64, u64)] {
        &self.positions
    }
    /// The validated nonempty schedule ensures success produces positions.
    pub fn is_success(&self) -> bool {
        !self.positions.is_empty()
    }
    /// Return participant lock hashes in prize order, or reject any missing,
    /// extra, excluded, out-of-range or unauthenticated owner declaration.
    pub fn verify_winners(&self, proofs: &[WinnerProof<'_>]) -> Result<Vec<Hash32>, CoreError> {
        use crate::accumulator::{imt, mmr, nonce_key, smt};
        use crate::encoding::{ACC_IMT, ACC_MMR, ACC_SMT};
        if proofs.len() != self.positions.len() {
            return Err(CoreError::MembershipProof);
        }
        let mut owners = Vec::with_capacity(proofs.len());
        for (p, (_, position)) in proofs.iter().zip(&self.positions) {
            let e = p.entry;
            let ledger = self
                .record
                .seal()
                .ledger(e.shard_id)
                .ok_or(CoreError::MembershipProof)?;
            let offset = *self
                .offsets
                .get(e.shard_id as usize)
                .ok_or(CoreError::MembershipProof)?;
            let end = e
                .position_base
                .checked_add(e.ticket_count)
                .ok_or(CoreError::Overflow)?;
            let global_start = offset
                .checked_add(e.position_base)
                .ok_or(CoreError::Overflow)?;
            let global_end = offset.checked_add(end).ok_or(CoreError::Overflow)?;
            if e.round_id != self.cfg.round_id
                || e.ticket_count == 0
                || e.ticket_count.checked_mul(self.cfg.ticket_price) != Some(e.principal)
                || e.entry_nonce >= ledger.accepted_entries()
                || end > ledger.accepted_tickets()
                || *position < global_start
                || *position >= global_end
            {
                return Err(CoreError::MembershipProof);
            }
            let leaf = crate::leaf::entry_leaf(e);
            let frozen = ledger.frozen();
            match self.cfg.accumulator_id {
                ACC_MMR => mmr::verify_membership(
                    &frozen.accumulator_root,
                    frozen.entry_count,
                    e.entry_nonce,
                    &leaf,
                    p.proof,
                )?,
                ACC_SMT => smt::verify_membership(
                    &frozen.accumulator_root,
                    &nonce_key(e.entry_nonce),
                    &leaf,
                    p.proof,
                )?,
                ACC_IMT => {
                    imt::verify_membership(&frozen.accumulator_root, e.entry_nonce, &leaf, p.proof)?
                }
                _ => return Err(CoreError::InvalidArgument),
            }
            owners.push(e.participant_lock_hash);
        }
        Ok(owners)
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use crate::{
        accumulator::mmr::host::MmrHost,
        encoding::{EntryShardDataV1, ScriptRef, ACC_MMR, SHARD_STATE_FROZEN},
        epoch::ABSOLUTE_EPOCH_FLAG,
        leaf::entry_leaf,
        lifecycle::AggregationState,
        seal::RoundSeal,
    };
    use alloc::vec;

    pub(crate) struct Fixture {
        pub(crate) cfg: RoundConfigV1,
        pub(crate) record: EntropyRecord,
        pub(crate) schedule: PrizeSchedule,
        pub(crate) entries: Vec<Vec<EntryDataV1>>,
        pub(crate) proofs: Vec<Vec<Vec<u8>>>,
    }

    pub(crate) fn fixture(minimum: u64, accept: bool) -> Fixture {
        fixture_with_accumulator(minimum, accept, ACC_MMR)
    }

    fn fixture_with_accumulator(minimum: u64, accept: bool, accumulator: u8) -> Fixture {
        let schedule = PrizeSchedule::new(&[4, 3, 2, 1]).unwrap();
        let script = ScriptRef {
            code_hash: [1; 32],
            hash_type: 2,
        };
        let cfg = RoundConfigV1 {
            version: 1,
            round_id: [7; 32],
            ticket_price: 100,
            minimum_tickets: minimum,
            maximum_tickets: 0,
            entry_start: 0,
            entry_end: 10,
            aggregation_deadline: 20,
            dao_term_periods: 1,
            entry_shard_count: 4,
            prize_schedule_hash: schedule.commitment(),
            fee_policy_hash: [0; 32],
            keeper_policy_hash: [0; 32],
            flags: 0,
            accumulator_id: accumulator,
            entry_lock: script,
            dao_lock: script,
            settlement_type: script,
            entry_shard_type: script,
            dao_type: script,
        };
        let mut entries = Vec::new();
        let mut proofs = Vec::new();
        let mut ledgers = Vec::new();
        for id in 0..4 {
            let es: Vec<_> = (0..if id % 2 == 0 { 3 } else { 0 })
                .map(|nonce| EntryDataV1 {
                    round_id: cfg.round_id,
                    shard_id: id,
                    participant_lock_hash: [10 + id as u8 + nonce as u8; 32],
                    ticket_count: 2,
                    principal: 200,
                    position_base: nonce * 2,
                    entry_nonce: nonce,
                    entropy_commitment: [nonce as u8; 32],
                })
                .collect();
            let (root, ps): (_, Vec<Vec<u8>>) = match accumulator {
                ACC_MMR => {
                    let mut tree = MmrHost::new();
                    for e in &es {
                        tree.append(&entry_leaf(e)).unwrap();
                    }
                    (
                        tree.root().unwrap(),
                        (0..es.len())
                            .map(|i| tree.membership_proof(i as u64).unwrap())
                            .collect(),
                    )
                }
                crate::encoding::ACC_SMT => {
                    use crate::accumulator::{nonce_key, smt::host::SmtHost};
                    let mut tree = SmtHost::new();
                    for e in &es {
                        tree.insert(&nonce_key(e.entry_nonce), &entry_leaf(e))
                            .unwrap();
                    }
                    (
                        tree.root(),
                        (0..es.len())
                            .map(|i| tree.inclusion_proof(&[nonce_key(i as u64)]).unwrap())
                            .collect(),
                    )
                }
                crate::encoding::ACC_IMT => {
                    let mut tree = crate::accumulator::imt::host::ImtHost::new();
                    for e in &es {
                        tree.append(&entry_leaf(e));
                    }
                    (
                        tree.root(),
                        (0..es.len())
                            .map(|i| tree.membership_proof(i as u64).unwrap())
                            .collect(),
                    )
                }
                _ => unreachable!(),
            };
            let shard = EntryShardDataV1 {
                round_id: cfg.round_id,
                shard_id: id,
                state: SHARD_STATE_FROZEN,
                sequence: es.len() as u64,
                entry_count: es.len() as u64,
                ticket_count: es.len() as u64 * 2,
                principal_total: es.len() as u64 * 200,
                accumulator_root: root,
            };
            let mut ledger = AggregationState::new(&cfg, &shard).unwrap();
            if accept && !es.is_empty() {
                ledger = ledger.accept(&cfg, &es[..1], &[250], &[&ps[0]]).unwrap().0;
            }
            ledgers.push(ledger.close(&cfg, ABSOLUTE_EPOCH_FLAG | 20).unwrap());
            entries.push(es);
            proofs.push(ps);
        }
        let record = EntropyRecord::new(
            RoundSeal::new(&cfg, &ledgers).unwrap(),
            100,
            [1; 32],
            [[2; 32], [3; 32], [4; 32]],
        )
        .unwrap();
        Fixture {
            cfg,
            record,
            schedule,
            entries,
            proofs,
        }
    }

    pub(crate) fn winners<'a>(f: &'a Fixture, d: &ComputedDraw<'_>) -> Vec<WinnerProof<'a>> {
        d.positions()
            .iter()
            .map(|(_, p)| {
                let shard = if *p < 2 { 0 } else { 2 };
                WinnerProof {
                    entry: &f.entries[shard][0],
                    proof: &f.proofs[shard][0],
                }
            })
            .collect()
    }

    #[test]
    fn draws_only_accepted_prefixes_across_empty_shards() {
        let f = fixture(4, true);
        let d = ComputedDraw::new(&f.cfg, &f.record, &f.schedule).unwrap();
        assert_eq!(d.total_tickets(), 4);
        assert!(d.is_success());
        let mut positions: Vec<_> = d.positions().iter().map(|(_, p)| *p).collect();
        positions.sort_unstable();
        assert_eq!(positions, vec![0, 1, 2, 3]);
        assert_eq!(
            d.positions().iter().map(|(i, _)| *i).collect::<Vec<_>>(),
            vec![0, 1, 2, 3]
        );
        let mut owners = d.verify_winners(&winners(&f, &d)).unwrap();
        owners.sort_unstable();
        assert_eq!(owners, vec![[10; 32], [10; 32], [12; 32], [12; 32]]);
    }

    #[test]
    fn genuine_frozen_proofs_do_not_authorize_excluded_entries() {
        let f = fixture(1, true);
        let d = ComputedDraw::new(&f.cfg, &f.record, &f.schedule).unwrap();
        for slot in 0..4 {
            let mut proofs = winners(&f, &d);
            let shard = proofs[slot].entry.shard_id as usize;
            proofs[slot] = WinnerProof {
                entry: &f.entries[shard][1],
                proof: &f.proofs[shard][1],
            };
            assert!(d.verify_winners(&proofs).is_err());
        }
    }

    #[test]
    fn rejects_missing_extra_wrong_owner_and_tampered_proofs() {
        let f = fixture(1, true);
        let d = ComputedDraw::new(&f.cfg, &f.record, &f.schedule).unwrap();
        let mut proofs = winners(&f, &d);
        assert!(d.verify_winners(&proofs[..3]).is_err());
        proofs.push(WinnerProof {
            entry: &f.entries[0][0],
            proof: &f.proofs[0][0],
        });
        assert!(d.verify_winners(&proofs).is_err());
        let other = winners(&f, &d)
            .iter()
            .position(|p| p.entry.shard_id != proofs[0].entry.shard_id)
            .unwrap();
        let mut proofs = winners(&f, &d);
        proofs.swap(0, other);
        assert!(d.verify_winners(&proofs).is_err());
        let mut proofs = winners(&f, &d);
        let mut entry = *proofs[0].entry;
        entry.participant_lock_hash = [99; 32];
        proofs[0].entry = &entry;
        assert!(d.verify_winners(&proofs).is_err());
        let mut proofs = winners(&f, &d);
        proofs[0].proof = &[];
        assert!(d.verify_winners(&proofs).is_err());
    }

    #[test]
    fn failed_and_empty_rounds_require_no_winner_proofs() {
        for (minimum, accept, total) in [(5, true, 4), (1, false, 0)] {
            let f = fixture(minimum, accept);
            let d = ComputedDraw::new(&f.cfg, &f.record, &f.schedule).unwrap();
            assert_eq!(d.total_tickets(), total);
            assert!(!d.is_success());
            assert_eq!(d.positions(), &[]);
            assert_eq!(d.verify_winners(&[]), Ok(vec![]));
            assert!(d
                .verify_winners(&[WinnerProof {
                    entry: &f.entries[0][0],
                    proof: &f.proofs[0][0]
                }])
                .is_err());
        }
    }

    #[test]
    fn rejects_config_and_schedule_substitution() {
        let f = fixture(1, true);
        let mut cfg = f.cfg.clone();
        cfg.minimum_tickets = 2;
        assert!(ComputedDraw::new(&cfg, &f.record, &f.schedule).is_err());
        let wrong = PrizeSchedule::new(&[1]).unwrap();
        assert!(ComputedDraw::new(&f.cfg, &f.record, &wrong).is_err());
        cfg.prize_schedule_hash = wrong.commitment();
        assert!(ComputedDraw::new(&cfg, &f.record, &wrong).is_err());
    }

    #[test]
    fn seed_binds_actual_inclusion_and_each_entropy_hash() {
        let f = fixture(1, true);
        let d = ComputedDraw::new(&f.cfg, &f.record, &f.schedule).unwrap();
        // Independent Python hashlib.blake2b over the fixture's config
        // commitment and canonical record bytes, with CKB personalization.
        assert_eq!(
            d.seed(),
            [
                0x80, 0xcb, 0x64, 0x6f, 0xe9, 0xb0, 0xc0, 0x07, 0xf0, 0xb6, 0xc1, 0x29, 0xa8, 0x04,
                0xdf, 0x5b, 0x7f, 0xf1, 0xb3, 0x22, 0x9e, 0x71, 0x51, 0xc1, 0x74, 0xac, 0x5a, 0x41,
                0x8f, 0x91, 0x7a, 0x43,
            ]
        );
        let again = ComputedDraw::new(&f.cfg, &f.record, &f.schedule).unwrap();
        assert_eq!(d.positions(), again.positions());
        for offset in [
            1 + 5 + 4 * 207,
            1 + 5 + 4 * 207 + 8,
            1 + 5 + 4 * 207 + 40,
            1 + 5 + 4 * 207 + 72,
            1 + 5 + 4 * 207 + 104,
        ] {
            let mut wire = f.record.encode();
            wire[offset] ^= 1;
            let altered = EntropyRecord::decode(&wire, &f.cfg).unwrap();
            assert_ne!(
                d.seed(),
                ComputedDraw::new(&f.cfg, &altered, &f.schedule)
                    .unwrap()
                    .seed()
            );
        }
    }

    #[test]
    fn owner_verification_supports_each_configured_accumulator() {
        for acc in [ACC_MMR, crate::encoding::ACC_SMT, crate::encoding::ACC_IMT] {
            let f = fixture_with_accumulator(1, true, acc);
            let d = ComputedDraw::new(&f.cfg, &f.record, &f.schedule).unwrap();
            let mut ps = winners(&f, &d);
            assert_eq!(d.verify_winners(&ps).unwrap().len(), 4);
            let shard = ps[0].entry.shard_id as usize;
            ps[0] = WinnerProof {
                entry: &f.entries[shard][1],
                proof: &f.proofs[shard][1],
            };
            assert!(d.verify_winners(&ps).is_err());
            let mut ps = winners(&f, &d);
            let mut corrupted = ps[0].proof.to_vec();
            corrupted[0] ^= 1;
            ps[0].proof = &corrupted;
            assert!(d.verify_winners(&ps).is_err());
        }
    }

    #[test]
    fn forged_owner_ranges_fail_without_overflow_or_index_panics() {
        let f = fixture(1, true);
        let d = ComputedDraw::new(&f.cfg, &f.record, &f.schedule).unwrap();
        for mutation in 0..6 {
            let mut ps = winners(&f, &d);
            let mut e = *ps[0].entry;
            match mutation {
                0 => e.position_base = u64::MAX,
                1 => e.ticket_count = 0,
                2 => e.shard_id = u32::MAX,
                3 => e.entry_nonce = u64::MAX,
                4 => e.principal = 0,
                _ => e.round_id = [0; 32],
            }
            ps[0].entry = &e;
            assert!(d.verify_winners(&ps).is_err());
        }
    }

    #[test]
    fn accepted_total_overflow_rejects_before_drawing() {
        // Structurally valid synthetic snapshots exercise arithmetic limits;
        // this intentionally does not claim canonical chain provenance.
        let f = fixture(1, true);
        let mut cfg = f.cfg.clone();
        cfg.ticket_price = 1;
        let mut ledgers = Vec::new();
        for id in 0..4 {
            let frozen = EntryShardDataV1 {
                round_id: cfg.round_id,
                shard_id: id,
                state: SHARD_STATE_FROZEN,
                sequence: 1,
                entry_count: 1,
                ticket_count: u64::MAX,
                principal_total: u64::MAX,
                accumulator_root: [9; 32],
            };
            let mut wire = AggregationState::new(&cfg, &frozen).unwrap().encode();
            for (offset, value) in [
                (134, 1u64),
                (142, u64::MAX),
                (150, u64::MAX),
                (158, u64::MAX),
                (166, 1),
            ] {
                wire[offset..offset + 8].copy_from_slice(&value.to_le_bytes());
            }
            wire[174..206].fill(9);
            wire[206] = 1;
            ledgers.push(AggregationState::decode(&wire, &cfg).unwrap());
        }
        let record = EntropyRecord::new(
            RoundSeal::new(&cfg, &ledgers).unwrap(),
            100,
            [1; 32],
            [[2; 32]; 3],
        )
        .unwrap();
        assert!(matches!(
            ComputedDraw::new(&cfg, &record, &f.schedule),
            Err(CoreError::Overflow)
        ));
    }
}
