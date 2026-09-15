//! Accepted-prefix ledger primitives for the new lifecycle path.
//!
//! These pure rules are NOT yet connected to spending scripts. The eventual
//! contract must load the config, frozen shard and input capacities from
//! authenticated cells, and persist each resulting state in a unique cell.

use crate::accumulator::{imt, mmr, nonce_key, smt};
use crate::encoding::{EntryDataV1, EntryShardDataV1, RoundConfigV1, SHARD_STATE_FROZEN};
use crate::hash::{ckb_hash256, Blake2b256, Hash32};
use crate::{leaf::entry_leaf, CoreError};

/// A conservative witness bound for the new path, not a change to existing
/// prototype transaction limits. VM cycle limits must also be measured.
pub const MAX_BATCH_ENTRIES: usize = 32;
pub const BATCH_RECEIPT_SIZE: usize = 73;
pub const AGGREGATION_STATE_SIZE: usize = 207;

/// Disjoint u64 IDs for the 256 supported shards and their batch ordinals.
pub fn batch_id(shard_id: u32, ordinal: u64) -> Result<u64, CoreError> {
    if shard_id >= 256 || ordinal >= (1u64 << 56) {
        return Err(CoreError::Overflow);
    }
    Ok((u64::from(shard_id) << 56) | ordinal)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct BatchCommitment {
    pub digest: Hash32,
    pub first_nonce: u64,
    pub entry_count: u64,
    pub ticket_count: u64,
    pub principal: u64,
    pub input_capacity: u64,
}

impl BatchCommitment {
    pub fn encode(&self) -> [u8; BATCH_RECEIPT_SIZE] {
        let mut out = [0; BATCH_RECEIPT_SIZE];
        out[0] = 2;
        out[1..33].copy_from_slice(&self.digest);
        for (chunk, value) in out[33..].as_chunks_mut::<8>().0.iter_mut().zip([
            self.first_nonce,
            self.entry_count,
            self.ticket_count,
            self.principal,
            self.input_capacity,
        ]) {
            chunk.copy_from_slice(&value.to_le_bytes());
        }
        out
    }

    /// Structural decoding is not authentication. Receipt creation must compare
    /// every decoded field with the batch computed from actual entry inputs.
    pub fn decode(data: &[u8]) -> Result<Self, CoreError> {
        if data.len() != BATCH_RECEIPT_SIZE || data[0] != 2 {
            return Err(CoreError::Encoding);
        }
        Ok(Self {
            digest: data[1..33].try_into().map_err(|_| CoreError::Encoding)?,
            first_nonce: decode_u64(&data[33..41])?,
            entry_count: decode_u64(&data[41..49])?,
            ticket_count: decode_u64(&data[49..57])?,
            principal: decode_u64(&data[57..65])?,
            input_capacity: decode_u64(&data[65..73])?,
        })
    }
}

fn decode_u64(data: &[u8]) -> Result<u64, CoreError> {
    Ok(u64::from_le_bytes(
        data.try_into().map_err(|_| CoreError::Encoding)?,
    ))
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct AggregationState {
    config_commitment: Hash32,
    frozen: EntryShardDataV1,
    accepted_entries: u64,
    accepted_tickets: u64,
    accepted_principal: u64,
    accepted_capacity: u64,
    accepted_batches: u64,
    batches_root: Hash32,
    closed: bool,
}

impl AggregationState {
    pub fn new(cfg: &RoundConfigV1, frozen: &EntryShardDataV1) -> Result<Self, CoreError> {
        cfg.validate()?;
        Self::new_bound(cfg, frozen, cfg.commitment())
    }

    fn new_bound(
        cfg: &RoundConfigV1,
        frozen: &EntryShardDataV1,
        config_commitment: Hash32,
    ) -> Result<Self, CoreError> {
        if frozen.round_id != cfg.round_id
            || frozen.shard_id >= cfg.entry_shard_count
            || frozen.state != SHARD_STATE_FROZEN
            || frozen.sequence != frozen.entry_count
            || frozen.ticket_count.checked_mul(cfg.ticket_price) != Some(frozen.principal_total)
            || (frozen.entry_count == 0) != (frozen.ticket_count == 0)
            || frozen.ticket_count < frozen.entry_count
        {
            return Err(CoreError::StateTransition);
        }
        Ok(Self {
            config_commitment,
            frozen: *frozen,
            accepted_entries: 0,
            accepted_tickets: 0,
            accepted_principal: 0,
            accepted_capacity: 0,
            accepted_batches: 0,
            batches_root: ckb_hash256(&[
                b"DAOWOW_BATCH_LEDGER_EMPTY_V2",
                &config_commitment,
                &frozen.shard_id.to_le_bytes(),
            ]),
            closed: false,
        })
    }

    pub fn accepted_entries(&self) -> u64 {
        self.accepted_entries
    }

    /// Internal fast binding for already-validated private state. All public
    /// constructors/decoders enforce structural invariants before returning it.
    pub(crate) fn is_bound_to(&self, commitment: &Hash32) -> bool {
        &self.config_commitment == commitment
    }
    pub fn accepted_tickets(&self) -> u64 {
        self.accepted_tickets
    }

    pub fn frozen(&self) -> &EntryShardDataV1 {
        &self.frozen
    }
    pub fn accepted_batches(&self) -> u64 {
        self.accepted_batches
    }
    pub fn is_closed(&self) -> bool {
        self.closed
    }
    pub fn next_batch_id(&self) -> Result<u64, CoreError> {
        batch_id(self.frozen.shard_id, self.accepted_batches)
    }

    pub fn encode(&self) -> [u8; AGGREGATION_STATE_SIZE] {
        let mut out = [0; AGGREGATION_STATE_SIZE];
        out[0] = 2;
        out[1..102].copy_from_slice(&self.frozen.encode());
        out[102..134].copy_from_slice(&self.config_commitment);
        for (chunk, value) in out[134..174].as_chunks_mut::<8>().0.iter_mut().zip([
            self.accepted_entries,
            self.accepted_tickets,
            self.accepted_principal,
            self.accepted_capacity,
            self.accepted_batches,
        ]) {
            chunk.copy_from_slice(&value.to_le_bytes());
        }
        out[174..206].copy_from_slice(&self.batches_root);
        out[206] = u8::from(self.closed);
        out
    }

    /// Validate the wire structure and counter invariants against `cfg`.
    /// Frozen membership roots and nonempty batch roots cannot be authenticated
    /// from their bytes. Contract callers must load this state from a canonical
    /// typed cell, never trust arbitrary witness bytes. Structural decoding also
    /// cannot establish whether the time required for closure has elapsed.
    pub fn decode(data: &[u8], cfg: &RoundConfigV1) -> Result<Self, CoreError> {
        cfg.validate()?;
        Self::decode_bound(data, cfg, &cfg.commitment())
    }

    /// Internal batch decoder: caller validates cfg and computes its commitment
    /// once. Every ledger still receives the complete wire/counter checks.
    pub(crate) fn decode_bound(
        data: &[u8],
        cfg: &RoundConfigV1,
        commitment: &Hash32,
    ) -> Result<Self, CoreError> {
        if data.len() != AGGREGATION_STATE_SIZE || data[0] != 2 || data[206] > 1 {
            return Err(CoreError::Encoding);
        }
        let frozen = EntryShardDataV1::decode(&data[1..102])?;
        let initial = Self::new_bound(cfg, &frozen, *commitment)?;
        let state = Self {
            config_commitment: data[102..134].try_into().map_err(|_| CoreError::Encoding)?,
            frozen,
            accepted_entries: decode_u64(&data[134..142])?,
            accepted_tickets: decode_u64(&data[142..150])?,
            accepted_principal: decode_u64(&data[150..158])?,
            accepted_capacity: decode_u64(&data[158..166])?,
            accepted_batches: decode_u64(&data[166..174])?,
            batches_root: data[174..206].try_into().map_err(|_| CoreError::Encoding)?,
            closed: data[206] == 1,
        };
        if state.config_commitment != initial.config_commitment
            || state.accepted_entries > frozen.entry_count
            || state.accepted_tickets > frozen.ticket_count
            || state.accepted_tickets < state.accepted_entries
            || state.accepted_tickets.checked_mul(cfg.ticket_price)
                != Some(state.accepted_principal)
            || state.accepted_capacity < state.accepted_principal
            || (state.accepted_entries == 0) != (state.accepted_tickets == 0)
            || (state.accepted_entries == 0) != (state.accepted_batches == 0)
            || state.accepted_batches > state.accepted_entries
            || u128::from(state.accepted_entries)
                > u128::from(state.accepted_batches) * MAX_BATCH_ENTRIES as u128
            || state.accepted_batches > (1u64 << 56)
            || (state.accepted_entries == 0
                && (state.accepted_capacity != 0 || state.batches_root != initial.batches_root))
        {
            return Err(CoreError::StateTransition);
        }
        Ok(state)
    }

    /// Consume a contiguous prefix with membership proofs against the frozen
    /// tree. The caller must verify that these are the actual transaction
    /// inputs and that their full capacities flow into this batch's DAO cell.
    pub fn accept(
        &self,
        cfg: &RoundConfigV1,
        entries: &[EntryDataV1],
        capacities: &[u64],
        proofs: &[&[u8]],
    ) -> Result<(Self, BatchCommitment), CoreError> {
        if self.closed
            || cfg.commitment() != self.config_commitment
            || entries.is_empty()
            || entries.len() > MAX_BATCH_ENTRIES
            || entries.len() != capacities.len()
            || entries.len() != proofs.len()
        {
            return Err(CoreError::StateTransition);
        }
        self.next_batch_id()?;
        let mut next = *self;
        next.accepted_batches = next
            .accepted_batches
            .checked_add(1)
            .ok_or(CoreError::Overflow)?;
        let mut hash = Blake2b256::new();
        hash.update(b"DAOWOW_ENTRY_BATCH_V2");
        hash.update(&self.config_commitment);
        hash.update(&self.frozen.shard_id.to_le_bytes());
        hash.update(&(entries.len() as u32).to_le_bytes());
        let mut batch = BatchCommitment {
            digest: [0; 32],
            first_nonce: self.accepted_entries,
            entry_count: entries.len() as u64,
            ticket_count: 0,
            principal: 0,
            input_capacity: 0,
        };
        for ((entry, capacity), proof) in entries.iter().zip(capacities).zip(proofs) {
            if entry.round_id != cfg.round_id
                || entry.shard_id != self.frozen.shard_id
                || entry.entry_nonce != next.accepted_entries
                || entry.position_base != next.accepted_tickets
                || entry.ticket_count == 0
                || entry.ticket_count.checked_mul(cfg.ticket_price) != Some(entry.principal)
                || *capacity < entry.principal
            {
                return Err(CoreError::StateTransition);
            }
            let leaf = entry_leaf(entry);
            match cfg.accumulator_id {
                crate::encoding::ACC_MMR => mmr::verify_membership(
                    &self.frozen.accumulator_root,
                    self.frozen.entry_count,
                    entry.entry_nonce,
                    &leaf,
                    proof,
                )?,
                crate::encoding::ACC_SMT => smt::verify_membership(
                    &self.frozen.accumulator_root,
                    &nonce_key(entry.entry_nonce),
                    &leaf,
                    proof,
                )?,
                crate::encoding::ACC_IMT => imt::verify_membership(
                    &self.frozen.accumulator_root,
                    entry.entry_nonce,
                    &leaf,
                    proof,
                )?,
                _ => return Err(CoreError::InvalidArgument),
            }
            next.accepted_entries = next
                .accepted_entries
                .checked_add(1)
                .ok_or(CoreError::Overflow)?;
            next.accepted_tickets = next
                .accepted_tickets
                .checked_add(entry.ticket_count)
                .ok_or(CoreError::Overflow)?;
            next.accepted_principal = next
                .accepted_principal
                .checked_add(entry.principal)
                .ok_or(CoreError::Overflow)?;
            next.accepted_capacity = next
                .accepted_capacity
                .checked_add(*capacity)
                .ok_or(CoreError::Overflow)?;
            if next.accepted_entries > self.frozen.entry_count
                || next.accepted_tickets > self.frozen.ticket_count
                || next.accepted_principal > self.frozen.principal_total
            {
                return Err(CoreError::Conservation);
            }
            hash.update(&entry.encode());
            hash.update(&capacity.to_le_bytes());
        }
        batch.ticket_count = next.accepted_tickets - self.accepted_tickets;
        batch.principal = next.accepted_principal - self.accepted_principal;
        batch.input_capacity = next.accepted_capacity - self.accepted_capacity;
        batch.digest = hash.finalize();
        next.batches_root = ckb_hash256(&[
            b"DAOWOW_BATCH_LEDGER_APPEND_V2",
            &self.batches_root,
            &batch.digest,
        ]);
        Ok((next, batch))
    }

    /// After the failure deadline, close the prefix even if the next entry
    /// was refunded or a keeper stopped. No entry beyond this prefix may
    /// subsequently become a draw participant.
    pub fn close(&self, cfg: &RoundConfigV1, since: u64) -> Result<Self, CoreError> {
        if self.closed || cfg.commitment() != self.config_commitment {
            return Err(CoreError::StateTransition);
        }
        let deadline = if self.accepted_entries == self.frozen.entry_count {
            cfg.entry_end
        } else {
            cfg.aggregation_deadline
        };
        crate::epoch::absolute_epoch_at_least(since, deadline)?;
        Ok(Self {
            closed: true,
            ..*self
        })
    }

    pub fn is_refundable(&self, entry_nonce: u64) -> Result<bool, CoreError> {
        if !self.closed || entry_nonce >= self.frozen.entry_count {
            return Err(CoreError::StateTransition);
        }
        Ok(entry_nonce >= self.accepted_entries)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::accumulator::mmr::host::MmrHost;
    use crate::encoding::{ScriptRef, ACC_MMR};

    #[test]
    fn batch_ids_are_disjoint_and_checked() {
        assert_eq!(batch_id(0, 0), Ok(0));
        assert_eq!(batch_id(1, 0), Ok(1u64 << 56));
        assert_eq!(batch_id(255, (1u64 << 56) - 1), Ok(u64::MAX));
        assert_eq!(batch_id(256, 0), Err(CoreError::Overflow));
        assert_eq!(batch_id(0, 1u64 << 56), Err(CoreError::Overflow));
    }

    #[test]
    fn receipt_wire_is_exact() {
        let batch = BatchCommitment {
            digest: [9; 32],
            first_nonce: 0x0102,
            entry_count: 2,
            ticket_count: 4,
            principal: 400,
            input_capacity: 500,
        };
        let wire = batch.encode();
        assert_eq!(wire.len(), 73);
        assert_eq!(wire[0], 2);
        assert_eq!(&wire[1..33], &[9; 32]);
        assert_eq!(&wire[33..41], &[2, 1, 0, 0, 0, 0, 0, 0]);
        assert_eq!(&wire[41..49], &[2, 0, 0, 0, 0, 0, 0, 0]);
        assert_eq!(&wire[49..57], &[4, 0, 0, 0, 0, 0, 0, 0]);
        assert_eq!(&wire[57..65], &[144, 1, 0, 0, 0, 0, 0, 0]);
        assert_eq!(&wire[65..73], &[244, 1, 0, 0, 0, 0, 0, 0]);
        assert_eq!(BatchCommitment::decode(&wire), Ok(batch));
        for end in 0..wire.len() {
            assert!(BatchCommitment::decode(&wire[..end]).is_err());
        }
        let mut extra = wire.to_vec();
        extra.push(0);
        assert!(BatchCommitment::decode(&extra).is_err());
        let mut bad = wire;
        bad[0] = 1;
        assert!(BatchCommitment::decode(&bad).is_err());
    }

    #[test]
    fn ledger_codec_rejects_noncanonical_state() {
        let (cfg, frozen, _, _) = fixture();
        let state = AggregationState::new(&cfg, &frozen).unwrap();
        let wire = state.encode();
        assert_eq!(wire.len(), 207);
        assert_eq!(AggregationState::decode(&wire, &cfg), Ok(state));
        for end in 0..207 {
            assert!(AggregationState::decode(&wire[..end], &cfg).is_err());
        }
        let mut extra = wire.to_vec();
        extra.push(0);
        assert!(AggregationState::decode(&extra, &cfg).is_err());
        for (offset, value) in [
            (0, 1),
            (102, 255),
            (206, 2),
            (1, 99),
            (33, 1),
            (37, 0),
            (38, 4),
            (54, 0),
            (62, 0),
            (158, 1),
            (174, 99),
        ] {
            let mut bad = wire;
            bad[offset] = value;
            assert!(
                AggregationState::decode(&bad, &cfg).is_err(),
                "offset {offset}"
            );
        }
        let mut bad = wire;
        bad[166..174].copy_from_slice(&1u64.to_le_bytes());
        assert!(AggregationState::decode(&bad, &cfg).is_err());
    }

    #[test]
    fn accepted_ledger_rejects_inconsistent_counters() {
        let (cfg, frozen, entries, tree) = fixture();
        let state = AggregationState::new(&cfg, &frozen).unwrap();
        let proof = tree.membership_proof(0).unwrap();
        let (state, _) = state
            .accept(&cfg, &entries[..1], &[250], &[&proof])
            .unwrap();
        let wire = state.encode();
        for (offset, value) in [
            (134, 4u64),
            (134, 0),
            (142, 7),
            (142, 0),
            (150, 201),
            (158, 199),
            (166, 0),
            (166, 2),
        ] {
            let mut bad = wire;
            bad[offset..offset + 8].copy_from_slice(&value.to_le_bytes());
            assert!(
                AggregationState::decode(&bad, &cfg).is_err(),
                "offset {offset}, value {value}"
            );
        }
    }

    #[test]
    fn batch_count_limits_are_checked_without_multiplication_overflow() {
        let (mut cfg, mut frozen, _, _) = fixture();
        cfg.ticket_price = 1;
        frozen.entry_count = u64::MAX;
        frozen.sequence = u64::MAX;
        frozen.ticket_count = u64::MAX;
        frozen.principal_total = u64::MAX;
        let mut state = AggregationState::new(&cfg, &frozen).unwrap();
        state.accepted_batches = 1u64 << 56;
        state.accepted_entries = 1u64 << 56;
        state.accepted_tickets = 1u64 << 56;
        state.accepted_principal = 1u64 << 56;
        state.accepted_capacity = 1u64 << 56;
        assert_eq!(AggregationState::decode(&state.encode(), &cfg), Ok(state));
        assert_eq!(state.next_batch_id(), Err(CoreError::Overflow));
        state.accepted_batches += 1;
        assert!(AggregationState::decode(&state.encode(), &cfg).is_err());
        state.accepted_batches = 1;
        state.accepted_entries = 33;
        state.accepted_tickets = 33;
        state.accepted_principal = 33;
        state.accepted_capacity = 33;
        assert!(AggregationState::decode(&state.encode(), &cfg).is_err());
        state.accepted_entries = 32;
        state.accepted_tickets = 32;
        state.accepted_principal = 32;
        state.accepted_capacity = 32;
        assert_eq!(AggregationState::decode(&state.encode(), &cfg), Ok(state));
    }

    #[test]
    fn final_batch_ordinal_is_usable_and_then_exhausted() {
        let (cfg, frozen, entries, tree) = fixture();
        let mut state = AggregationState::new(&cfg, &frozen).unwrap();
        // Seed the private ordinal to exercise exhaustion without 2^56 batches.
        state.accepted_batches = (1u64 << 56) - 1;
        assert_eq!(state.next_batch_id(), Ok((1u64 << 56) - 1));
        let proof = tree.membership_proof(0).unwrap();
        let (next, _) = state
            .accept(&cfg, &entries[..1], &[250], &[&proof])
            .unwrap();
        assert_eq!(next.accepted_batches(), 1u64 << 56);
        let proof = tree.membership_proof(1).unwrap();
        assert_eq!(
            next.accept(&cfg, &entries[1..2], &[250], &[&proof]),
            Err(CoreError::Overflow)
        );
        assert_eq!(next.accepted_entries(), 1);
    }

    fn fixture() -> (RoundConfigV1, EntryShardDataV1, Vec<EntryDataV1>, MmrHost) {
        let script = ScriptRef {
            code_hash: [1; 32],
            hash_type: 2,
        };
        let cfg = RoundConfigV1 {
            version: 1,
            round_id: [7; 32],
            ticket_price: 100,
            minimum_tickets: 1,
            maximum_tickets: 0,
            entry_start: 0,
            entry_end: 10,
            aggregation_deadline: 20,
            dao_term_periods: 1,
            entry_shard_count: 1,
            prize_schedule_hash: [2; 32],
            fee_policy_hash: [0; 32],
            keeper_policy_hash: [0; 32],
            flags: 0,
            accumulator_id: ACC_MMR,
            entry_lock: script,
            dao_lock: script,
            settlement_type: script,
            entry_shard_type: script,
            dao_type: script,
        };
        let entries: Vec<_> = (0..3)
            .map(|nonce| EntryDataV1 {
                round_id: cfg.round_id,
                shard_id: 0,
                participant_lock_hash: [9; 32],
                ticket_count: 2,
                principal: 200,
                position_base: nonce * 2,
                entry_nonce: nonce,
                entropy_commitment: [nonce as u8; 32],
            })
            .collect();
        let mut tree = MmrHost::new();
        for entry in &entries {
            tree.append(&crate::leaf::entry_leaf(entry)).unwrap();
        }
        let shard = EntryShardDataV1 {
            round_id: cfg.round_id,
            shard_id: 0,
            state: SHARD_STATE_FROZEN,
            sequence: 3,
            entry_count: 3,
            ticket_count: 6,
            principal_total: 600,
            accumulator_root: tree.root().unwrap(),
        };
        (cfg, shard, entries, tree)
    }

    #[test]
    fn accepted_prefix_can_close_with_a_refundable_suffix() {
        let (cfg, shard, entries, tree) = fixture();
        let state = AggregationState::new(&cfg, &shard).unwrap();
        let proof = tree.membership_proof(0).unwrap();
        let (accepted, batch) = state
            .accept(&cfg, &entries[..1], &[250], &[&proof])
            .unwrap();
        assert_eq!(accepted.accepted_entries(), 1);
        assert_eq!(accepted.accepted_tickets(), 2);
        assert_eq!(accepted.accepted_batches(), 1);
        assert_eq!(accepted.next_batch_id(), Ok(1));
        assert_eq!(accepted.frozen(), &shard);
        assert!(!accepted.is_closed());
        assert_eq!(
            AggregationState::decode(&accepted.encode(), &cfg),
            Ok(accepted)
        );
        assert_eq!(batch.input_capacity, 250);
        assert_eq!(batch.principal, 200);
        assert!(accepted
            .close(&cfg, crate::epoch::ABSOLUTE_EPOCH_FLAG | 19)
            .is_err());
        let closed = accepted
            .close(&cfg, crate::epoch::ABSOLUTE_EPOCH_FLAG | 20)
            .unwrap();
        assert!(!closed.is_refundable(0).unwrap());
        assert!(closed.is_closed());
        assert_eq!(AggregationState::decode(&closed.encode(), &cfg), Ok(closed));
        assert!(closed.is_refundable(1).unwrap());
        assert!(closed.is_refundable(2).unwrap());
        assert!(closed.is_refundable(3).is_err());
        let next_proof = tree.membership_proof(1).unwrap();
        assert!(closed
            .accept(&cfg, &entries[1..2], &[250], &[&next_proof])
            .is_err());
    }

    #[test]
    fn acceptance_rejects_skips_replays_forgery_and_bad_capacity() {
        let (cfg, shard, entries, tree) = fixture();
        let state = AggregationState::new(&cfg, &shard).unwrap();
        let p0 = tree.membership_proof(0).unwrap();
        let p1 = tree.membership_proof(1).unwrap();
        assert!(state.accept(&cfg, &entries[1..2], &[250], &[&p1]).is_err());
        assert!(state.accept(&cfg, &entries[..1], &[199], &[&p0]).is_err());
        assert!(state.accept(&cfg, &entries[..1], &[250], &[&p1]).is_err());
        let (accepted, _) = state.accept(&cfg, &entries[..1], &[250], &[&p0]).unwrap();
        let (second, _) = accepted
            .accept(&cfg, &entries[1..2], &[250], &[&p1])
            .unwrap();
        assert_eq!(second.accepted_batches(), 2);
        assert_eq!(second.next_batch_id(), Ok(2));
        assert_eq!(AggregationState::decode(&second.encode(), &cfg), Ok(second));
        assert!(accepted
            .accept(&cfg, &entries[..1], &[250], &[&p0])
            .is_err());
        let mut changed = cfg;
        changed.ticket_price = 101;
        assert!(accepted
            .accept(&changed, &entries[1..2], &[250], &[&p1])
            .is_err());
        assert_eq!(
            state.accepted_entries(),
            0,
            "failed updates cannot mutate prior state"
        );
    }

    #[test]
    fn batch_commitment_binds_capacity_and_complete_membership() {
        let (cfg, shard, entries, tree) = fixture();
        let state = AggregationState::new(&cfg, &shard).unwrap();
        let p0 = tree.membership_proof(0).unwrap();
        let (_, first) = state.accept(&cfg, &entries[..1], &[250], &[&p0]).unwrap();
        let (_, changed_capacity) = state.accept(&cfg, &entries[..1], &[251], &[&p0]).unwrap();
        assert_ne!(first.digest, changed_capacity.digest);
        let mut forged = entries[0];
        forged.entropy_commitment = [99; 32];
        assert!(state.accept(&cfg, &[forged], &[250], &[&p0]).is_err());
    }

    #[test]
    fn completed_prefix_can_close_early_but_cannot_reopen() {
        let (cfg, shard, entries, tree) = fixture();
        let state = AggregationState::new(&cfg, &shard).unwrap();
        let proofs: Vec<_> = (0..3).map(|i| tree.membership_proof(i).unwrap()).collect();
        let refs: Vec<_> = proofs.iter().map(Vec::as_slice).collect();
        let (full, batch) = state
            .accept(&cfg, &entries, &[250, 250, 250], &refs)
            .unwrap();
        assert_eq!(batch.entry_count, 3);
        assert_eq!(full.accepted_batches(), 1);
        assert_eq!(batch.ticket_count, 6);
        assert_eq!(batch.principal, 600);
        assert_eq!(batch.input_capacity, 750);
        assert!(full
            .close(&cfg, crate::epoch::ABSOLUTE_EPOCH_FLAG | 9)
            .is_err());
        let closed = full
            .close(&cfg, crate::epoch::ABSOLUTE_EPOCH_FLAG | 10)
            .unwrap();
        assert!(closed
            .close(&cfg, crate::epoch::ABSOLUTE_EPOCH_FLAG | 20)
            .is_err());
        assert!(!closed.is_refundable(2).unwrap());
    }

    #[test]
    fn capacity_overflow_and_oversized_batches_do_not_advance_the_ledger() {
        let (cfg, shard, entries, tree) = fixture();
        let state = AggregationState::new(&cfg, &shard).unwrap();
        let p0 = tree.membership_proof(0).unwrap();
        let p1 = tree.membership_proof(1).unwrap();
        assert_eq!(
            state.accept(&cfg, &entries[..2], &[u64::MAX, 250], &[&p0, &p1]),
            Err(CoreError::Overflow)
        );
        assert!(state
            .accept(
                &cfg,
                &[entries[0]; MAX_BATCH_ENTRIES + 1],
                &[250; MAX_BATCH_ENTRIES + 1],
                &[p0.as_slice(); MAX_BATCH_ENTRIES + 1]
            )
            .is_err());
        assert_eq!(state.accepted_entries(), 0);
        assert_eq!(state.accepted_batches(), 0);
    }
}
