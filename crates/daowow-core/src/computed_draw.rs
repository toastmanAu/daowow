//! Pure computed draw; callers must authenticate the config and entropy cells.
use crate::{
    encoding::RoundConfigV1, hash::Hash32, schedule::PrizeSchedule, seal::EntropyRecord, CoreError,
};
use alloc::{vec, vec::Vec};

/// A round draws only if its committed schedule can pay every drawn position a
/// positive amount out of a pool this small. `min_viable_pool` is the exact
/// zero-free threshold for a schedule, so capping it caps how wide the weight
/// spread may be relative to what any batch will realistically yield.
///
/// 0.01 CKB. The smallest batch a round can produce is one ticket
/// (`AggregationState::accept` rejects an empty batch), and a realistic ticket
/// funds at least its own 220 CKB claim cell, whose DAO compensation over a full
/// term runs to roughly 5.4e7 shannons — about fifty times this bound.
///
/// The term cannot be short: `dao_term_periods` counts 180-epoch DAO cycles
/// (`epoch.rs::absolute_epoch_after_dao_term` targets `deposit + periods * 180`,
/// enforced on chain by dao-lock), and `validate()` requires it to be at least
/// one. So the minimum enforceable term IS a full cycle, and the margin above
/// holds for every legal config rather than only for long ones.
///
/// Deliberately an absolute constant rather than a fraction of
/// `cfg.ticket_price`: `ticket_price` sits at offset 36 of
/// `RoundConfigV1::encode()`, so it is inside `commitment()` and therefore inside
/// the draw seed. Deriving the allowance from it would make the viability of a
/// round depend on a value that also decides which tickets win.
pub const MAX_POOL_BAR: u64 = 1_000_000;

/// A pure derivation over a structurally validated snapshot. Neither this
/// constructor nor its membership proofs establish chain/header provenance.
pub struct ComputedDraw<'a> {
    offsets: Vec<u64>,
    /// Keeps the borrow of the authenticated snapshot for the draw's lifetime.
    _snapshot: core::marker::PhantomData<&'a EntropyRecord>,
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
        // An unviable schedule is a failed round, not an error: the existing
        // failed-round path returns principal and yield to depositors and lets
        // every claim retire as a non-winner. Derived from round-level data
        // only, so every batch and retirement reach the same verdict.
        if total != 0
            && total >= cfg.minimum_tickets
            && schedule.min_viable_pool(total)? <= MAX_POOL_BAR
        {
            positions = vec![(0, 0); schedule.weights_for(total)?.len()];
            crate::draw::draw_positions(&seed, total, positions.len() as u64, &mut positions)?;
        }
        Ok(Self {
            offsets,
            _snapshot: core::marker::PhantomData,
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
    /// Map a drawn global position to `(shard_id, shard-local position)`.
    /// Empty shards share an offset with their successor, so the search runs
    /// from the last shard backwards; a position at or beyond the accepted
    /// total is not a ticket.
    pub fn locate(&self, global_position: u64) -> Result<(u32, u64), CoreError> {
        if global_position >= self.total {
            return Err(CoreError::InvalidArgument);
        }
        for (id, offset) in self.offsets.iter().enumerate().rev() {
            if global_position >= *offset {
                return Ok((id as u32, global_position - offset));
            }
        }
        Err(CoreError::InvalidArgument)
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use crate::{
        accumulator::mmr::host::MmrHost,
        encoding::{EntryDataV1, EntryShardDataV1, ScriptRef, ACC_MMR, SHARD_STATE_FROZEN},
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

    impl Fixture {
        /// Rebuild the `EntropyRecord` for a config whose `prize_schedule_hash`
        /// differs from `self.cfg`'s. `ComputedDraw::new` checks that the
        /// schedule commitment matches `cfg.prize_schedule_hash` and that the
        /// seal is bound to `cfg.commitment()`, so a substituted schedule needs
        /// a record re-sealed against the new config, not the original one.
        pub(crate) fn record_for(&self, cfg: &RoundConfigV1) -> EntropyRecord {
            let mut ledgers = Vec::new();
            for id in 0..4 {
                let es = &self.entries[id as usize];
                let ps = &self.proofs[id as usize];
                // Reproduce this fixture's own acceptance pattern (at most the
                // first entry per shard) rather than assuming `accept`, so
                // `record_for` is correct for both `fixture(_, true)` and
                // `fixture(_, false)` origins.
                let accepted = self
                    .record
                    .seal()
                    .ledger(id)
                    .is_some_and(|l| l.accepted_tickets() > 0);
                let shard = EntryShardDataV1 {
                    round_id: cfg.round_id,
                    shard_id: id,
                    state: SHARD_STATE_FROZEN,
                    sequence: es.len() as u64,
                    entry_count: es.len() as u64,
                    ticket_count: es.len() as u64 * 2,
                    principal_total: es.len() as u64 * 200,
                    accumulator_root: {
                        let mut tree = MmrHost::new();
                        for e in es {
                            tree.append(&entry_leaf(e)).unwrap();
                        }
                        tree.root().unwrap()
                    },
                };
                let mut ledger = AggregationState::new(cfg, &shard).unwrap();
                if accepted {
                    ledger = ledger.accept(cfg, &es[..1], &[250], &[&ps[0]]).unwrap().0;
                }
                ledgers.push(ledger.close(cfg, ABSOLUTE_EPOCH_FLAG | 20).unwrap());
            }
            EntropyRecord::new(
                RoundSeal::new(cfg, &ledgers).unwrap(),
                100,
                [1; 32],
                [[2; 32], [3; 32], [4; 32]],
            )
            .unwrap()
        }

        /// Sum of the fixture's accepted ticket counts, mirroring
        /// `ComputedDraw::new`'s own per-shard `accepted_tickets()` total.
        pub(crate) fn total_tickets(&self) -> u64 {
            (0..self.cfg.entry_shard_count)
                .map(|id| {
                    self.record
                        .seal()
                        .ledger(id)
                        .map_or(0, |l| l.accepted_tickets())
                })
                .sum()
        }

        /// The identity of a claim the draw actually selected, and the prize
        /// index it won. Derived from `draw.positions()`/`draw.locate()`
        /// rather than a hardcoded shard/position pair.
        pub(crate) fn winning_claim_args(
            &self,
            draw: &ComputedDraw<'_>,
        ) -> (crate::claim::ClaimArgs, u32) {
            let (prize_index, global_position) = draw.positions()[0];
            let (shard_id, position) = draw.locate(global_position).unwrap();
            (
                crate::claim::ClaimArgs {
                    commitment: self.cfg.commitment(),
                    shard_id,
                    position,
                },
                prize_index as u32,
            )
        }

        /// A claim identity the draw actually did not select.
        ///
        /// With 4 accepted tickets against this fixture's 4-weight schedule,
        /// `weights_for` keeps all four weights, so every real accepted
        /// position wins something here — there is no accepted-but-unselected
        /// ticket to point at. `locate` only ever returns a shard id in
        /// `0..entry_shard_count`, so a shard id one past the last real shard
        /// can never equal any drawn identity; the `debug_assert` below checks
        /// that directly against this draw's own `locate` outputs rather than
        /// just asserting it by construction.
        pub(crate) fn non_winning_claim_args(
            &self,
            draw: &ComputedDraw<'_>,
        ) -> crate::claim::ClaimArgs {
            let shard_id = self.cfg.entry_shard_count;
            let position = 0;
            assert!(draw
                .positions()
                .iter()
                .all(|(_, gp)| draw.locate(*gp).unwrap() != (shard_id, position)));
            crate::claim::ClaimArgs {
                commitment: self.cfg.commitment(),
                shard_id,
                position,
            }
        }

        /// A claim identity that shares a real winner's shard but not its
        /// position: `shard_id` is read off an actual drawn identity (via
        /// `draw.positions()`/`draw.locate()`, as in `winning_claim_args`),
        /// while `position` is a value far outside the fixture's small
        /// accepted-position range. Pins the position half of
        /// `retire_decision`'s membership test independently of the shard
        /// half: `non_winning_claim_args` only ever varies `shard_id`, so it
        /// cannot catch a broken `position` comparison. The `debug_assert`
        /// checks the constructed identity against every one of this draw's
        /// own `locate` outputs, not just by construction.
        pub(crate) fn same_shard_wrong_position_claim_args(
            &self,
            draw: &ComputedDraw<'_>,
        ) -> crate::claim::ClaimArgs {
            let (_, global_position) = draw.positions()[0];
            let (shard_id, _) = draw.locate(global_position).unwrap();
            let position = u64::MAX / 2;
            assert!(draw
                .positions()
                .iter()
                .all(|(_, gp)| draw.locate(*gp).unwrap() != (shard_id, position)));
            crate::claim::ClaimArgs {
                commitment: self.cfg.commitment(),
                shard_id,
                position,
            }
        }

        /// Any structurally valid claim identity, for a voided round where
        /// every claim is a non-winner regardless of shard/position.
        pub(crate) fn any_claim_args(&self) -> crate::claim::ClaimArgs {
            crate::claim::ClaimArgs {
                commitment: self.cfg.commitment(),
                shard_id: 0,
                position: 0,
            }
        }

        /// A `PrizeRedemptionState` for `args`'s ticket with `count` distinct
        /// synthetic sources recorded, mirroring the `pay` pattern in
        /// `redemption::tests` (host `SmtHost` supplies each absence proof).
        pub(crate) fn state_with_paid_count(
            &self,
            args: &crate::claim::ClaimArgs,
            count: u64,
        ) -> crate::redemption::PrizeRedemptionState {
            use crate::accumulator::smt::host::SmtHost;
            use crate::redemption::{
                prize_obligation_key, prize_payment_leaf, PrizeRedemptionState,
            };
            let mut state = PrizeRedemptionState::new(args.ticket_id());
            let mut tree = SmtHost::new();
            for i in 0..count {
                let source = [i as u8; 32];
                let key = prize_obligation_key(&state.ticket(), &source);
                let proof = tree.absence_proof(&[key]).unwrap();
                state = state.record_verified_prize(&source, 1, &proof).unwrap();
                tree.insert(&key, &prize_payment_leaf(&state.ticket(), &source, 1))
                    .unwrap();
            }
            state
        }
    }

    /// A fixture whose committed schedule bar exceeds `MAX_POOL_BAR`, so the
    /// round must void instead of drawing.
    #[allow(dead_code)]
    pub(crate) fn fixture_unviable(minimum: u64, accept: bool) -> Fixture {
        let f = fixture(minimum, accept);
        let mut wide_weights = [1u64; 32];
        wide_weights[0] = u64::MAX / 64;
        let wide = PrizeSchedule::new(&wide_weights).unwrap();
        let mut cfg = f.cfg;
        cfg.prize_schedule_hash = wide.commitment();
        let record = f.record_for(&cfg);
        Fixture {
            cfg,
            record,
            schedule: wide,
            entries: f.entries,
            proofs: f.proofs,
        }
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
    }

    #[test]
    fn locate_maps_global_positions_through_accepted_offsets() {
        // shards 0 and 2 accept 2 tickets each; 1 and 3 accept none
        let f = fixture(1, true);
        let d = ComputedDraw::new(&f.cfg, &f.record, &f.schedule).unwrap();
        assert_eq!(d.total_tickets(), 4);
        assert_eq!(d.locate(0), Ok((0, 0)));
        assert_eq!(d.locate(1), Ok((0, 1)));
        assert_eq!(d.locate(2), Ok((2, 0)));
        assert_eq!(d.locate(3), Ok((2, 1)));
        assert_eq!(d.locate(4), Err(CoreError::InvalidArgument));
        assert_eq!(d.locate(u64::MAX), Err(CoreError::InvalidArgument));
    }

    #[test]
    fn failed_and_empty_rounds_draw_nothing() {
        for (minimum, accept, total) in [(5, true, 4), (1, false, 0)] {
            let f = fixture(minimum, accept);
            let d = ComputedDraw::new(&f.cfg, &f.record, &f.schedule).unwrap();
            assert_eq!(d.total_tickets(), total);
            assert!(!d.is_success());
            assert_eq!(d.positions(), &[]);
            // locate is independent of success; only an empty universe rejects
            assert_eq!(d.locate(0).is_err(), total == 0);
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

    #[test]
    fn an_unyieldable_schedule_voids_the_round() {
        let f = fixture(1, true);
        // Sane schedule: bar 10, far below MAX_POOL_BAR. This is the shipped
        // fixture's own schedule, so the gate must leave it drawing.
        let sane = PrizeSchedule::new(&[4, 3, 2, 1]).unwrap();
        assert!(sane.min_viable_pool(f.total_tickets()).unwrap() <= MAX_POOL_BAR);

        // Pathological spread: bar exceeds the allowance, so the round must fail.
        let mut wide_weights = [1u64; 32];
        wide_weights[0] = u64::MAX / 64;
        let wide = PrizeSchedule::new(&wide_weights).unwrap();
        let mut wide_cfg = f.cfg;
        wide_cfg.prize_schedule_hash = wide.commitment();
        let record = f.record_for(&wide_cfg);

        let draw = ComputedDraw::new(&wide_cfg, &record, &wide).unwrap();
        assert!(!draw.is_success(), "unyieldable schedule must not draw");
        assert!(draw.positions().is_empty());
        // The void is not an error: totals still derive.
        assert_eq!(draw.total_tickets(), f.total_tickets());
    }

    #[test]
    fn viability_is_round_level_and_not_per_batch() {
        // Same (cfg, record, schedule) must give the same verdict every call,
        // because settlement and retirement both re-derive it independently.
        let f = fixture(1, true);
        let a = ComputedDraw::new(&f.cfg, &f.record, &f.schedule).unwrap();
        let b = ComputedDraw::new(&f.cfg, &f.record, &f.schedule).unwrap();
        assert_eq!(a.is_success(), b.is_success());
        assert_eq!(a.positions(), b.positions());
    }
}
