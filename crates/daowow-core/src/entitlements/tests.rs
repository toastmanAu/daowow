use super::*;
use crate::{
    accumulator::mmr::{self, host::MmrHost},
    computed_draw::{
        tests::{fixture, winners, Fixture},
        ComputedDraw,
    },
    leaf::liability_leaf,
    lifecycle::{batch_id, AggregationState},
};
use alloc::vec;

fn receipt(f: &Fixture, shard: usize) -> BatchCommitment {
    AggregationState::new(
        &f.cfg,
        f.record.seal().ledger(shard as u32).unwrap().frozen(),
    )
    .unwrap()
    .accept(
        &f.cfg,
        &f.entries[shard][..1],
        &[250],
        &[&f.proofs[shard][0]],
    )
    .unwrap()
    .1
}

#[test]
fn independent_batches_pay_the_same_global_winners_and_full_capacity() {
    let f = fixture(1, true);
    let d = ComputedDraw::new(&f.cfg, &f.record, &f.schedule).unwrap();
    // Independent Python hashlib candidate/retry calculation from pinned seed.
    assert_eq!(d.positions(), &[(0, 3), (1, 2), (2, 1), (3, 0)]);
    let owners = winners(&f, &d);
    for shard in [0, 2] {
        let receipt = receipt(&f, shard);
        let input = EntitlementInput {
            batch_id: batch_id(shard as u32, 0).unwrap(),
            receipt: &receipt,
            entries: &f.entries[shard][..1],
            capacities: &[250],
            realized_total: 350,
            winners: &owners,
        };
        let derived = InitialEntitlements::derive(&f.cfg, &f.record, &f.schedule, &input).unwrap();
        assert_eq!(
            derived.liabilities(),
            &[
                PayoutItem {
                    participant_lock_hash: [10; 32],
                    principal: if shard == 0 { 250 } else { 0 },
                    prize: 30
                },
                PayoutItem {
                    participant_lock_hash: [12; 32],
                    principal: if shard == 2 { 250 } else { 0 },
                    prize: 70
                },
            ]
        );
        let mut tree = MmrHost::new();
        for p in derived.liabilities() {
            tree.append(&liability_leaf(
                &p.participant_lock_hash,
                p.principal,
                p.prize,
            ))
            .unwrap();
        }
        assert_eq!(
            derived.funding(),
            &SettlementFundingDataV2 {
                round_id: f.cfg.round_id,
                batch_id: input.batch_id,
                realized_total: 350,
                principal_liability: 250,
                prize_pool: 100,
                payout_cursor: 0,
                liability_count: 2,
                liabilities_root: tree.root().unwrap()
            }
        );
        for (i, p) in derived.liabilities().iter().enumerate() {
            mmr::verify_membership(
                &derived.funding().liabilities_root,
                2,
                i as u64,
                &liability_leaf(&p.participant_lock_hash, p.principal, p.prize),
                &tree.membership_proof(i as u64).unwrap(),
            )
            .unwrap();
        }
    }
}

#[test]
fn zero_yield_omits_zero_total_winner_only_records() {
    let f = fixture(1, true);
    let d = ComputedDraw::new(&f.cfg, &f.record, &f.schedule).unwrap();
    let owners = winners(&f, &d);
    let receipt = receipt(&f, 0);
    let input = EntitlementInput {
        batch_id: 0,
        receipt: &receipt,
        entries: &f.entries[0][..1],
        capacities: &[250],
        realized_total: 250,
        winners: &owners,
    };
    let e = InitialEntitlements::derive(&f.cfg, &f.record, &f.schedule, &input).unwrap();
    assert_eq!(
        e.liabilities(),
        &[PayoutItem {
            participant_lock_hash: [10; 32],
            principal: 250,
            prize: 0
        }]
    );
    assert_eq!(e.funding().liability_count, 1);
}

#[test]
fn every_receipt_field_and_actual_capacity_is_bound() {
    let f = fixture(1, true);
    let d = ComputedDraw::new(&f.cfg, &f.record, &f.schedule).unwrap();
    let owners = winners(&f, &d);
    let original = receipt(&f, 0);
    for mutation in 0..9 {
        let mut receipt = original;
        let mut entries = f.entries[0][..1].to_vec();
        let mut capacities = vec![250];
        match mutation {
            0 => receipt.digest[0] ^= 1,
            1 => receipt.first_nonce = 1,
            2 => receipt.entry_count = 2,
            3 => receipt.ticket_count = 3,
            4 => receipt.principal = 199,
            5 => receipt.input_capacity = 251,
            6 => capacities[0] = 251,
            7 => entries[0].entropy_commitment[0] ^= 1,
            _ => entries.clear(),
        }
        let input = EntitlementInput {
            batch_id: 0,
            receipt: &receipt,
            entries: &entries,
            capacities: &capacities,
            realized_total: 350,
            winners: &owners,
        };
        assert!(InitialEntitlements::derive(&f.cfg, &f.record, &f.schedule, &input).is_err());
    }
}

#[test]
fn rejects_unaccepted_batch_ids_missing_winners_and_realized_underflow() {
    let f = fixture(1, true);
    let d = ComputedDraw::new(&f.cfg, &f.record, &f.schedule).unwrap();
    let owners = winners(&f, &d);
    let receipt = receipt(&f, 0);
    let mut input = EntitlementInput {
        batch_id: 0,
        receipt: &receipt,
        entries: &f.entries[0][..1],
        capacities: &[250],
        realized_total: 350,
        winners: &owners,
    };
    for id in [1, 1u64 << 56, u64::MAX] {
        input.batch_id = id;
        assert!(InitialEntitlements::derive(&f.cfg, &f.record, &f.schedule, &input).is_err());
    }
    input.batch_id = 0;
    input.realized_total = 249;
    assert!(InitialEntitlements::derive(&f.cfg, &f.record, &f.schedule, &input).is_err());
    input.realized_total = 350;
    input.winners = &[];
    assert!(InitialEntitlements::derive(&f.cfg, &f.record, &f.schedule, &input).is_err());
}

#[test]
fn failed_round_returns_yield_to_depositor_without_winners() {
    let f = fixture(5, true);
    let receipt = receipt(&f, 0);
    let input = EntitlementInput {
        batch_id: 0,
        receipt: &receipt,
        entries: &f.entries[0][..1],
        capacities: &[250],
        realized_total: 351,
        winners: &[],
    };
    let e = InitialEntitlements::derive(&f.cfg, &f.record, &f.schedule, &input).unwrap();
    assert_eq!(
        e.liabilities(),
        &[PayoutItem {
            participant_lock_hash: [10; 32],
            principal: 250,
            prize: 101
        }]
    );
}

#[test]
fn failed_round_consolidates_before_proportional_rounding() {
    for (capacities, owners) in [
        (vec![300, 600, 300], vec![12u8, 10, 12]),
        (vec![600, 600], vec![10, 12]),
    ] {
        let f = fixture(100, true);
        let mut cfg = f.cfg.clone();
        cfg.entry_shard_count = 1;
        let entries: Vec<_> = owners
            .iter()
            .enumerate()
            .map(|(i, owner)| EntryDataV1 {
                round_id: cfg.round_id,
                shard_id: 0,
                participant_lock_hash: [*owner; 32],
                ticket_count: 2,
                principal: 200,
                position_base: i as u64 * 2,
                entry_nonce: i as u64,
                entropy_commitment: [0; 32],
            })
            .collect();
        let mut tree = MmrHost::new();
        for e in &entries {
            tree.append(&crate::leaf::entry_leaf(e)).unwrap();
        }
        let frozen = crate::encoding::EntryShardDataV1 {
            round_id: cfg.round_id,
            shard_id: 0,
            state: crate::encoding::SHARD_STATE_FROZEN,
            sequence: entries.len() as u64,
            entry_count: entries.len() as u64,
            ticket_count: entries.len() as u64 * 2,
            principal_total: entries.len() as u64 * 200,
            accumulator_root: tree.root().unwrap(),
        };
        let proofs: Vec<_> = (0..entries.len())
            .map(|i| tree.membership_proof(i as u64).unwrap())
            .collect();
        let proof_refs: Vec<_> = proofs.iter().map(|p| p.as_slice()).collect();
        let (ledger, receipt) = AggregationState::new(&cfg, &frozen)
            .unwrap()
            .accept(&cfg, &entries, &capacities, &proof_refs)
            .unwrap();
        let closed = ledger
            .close(&cfg, crate::epoch::ABSOLUTE_EPOCH_FLAG | 20)
            .unwrap();
        let record = EntropyRecord::new(
            crate::seal::RoundSeal::new(&cfg, &[closed]).unwrap(),
            100,
            [1; 32],
            [[2; 32]; 3],
        )
        .unwrap();
        let input = EntitlementInput {
            batch_id: 0,
            receipt: &receipt,
            entries: &entries,
            capacities: &capacities,
            realized_total: 1203,
            winners: &[],
        };
        let e = InitialEntitlements::derive(&cfg, &record, &f.schedule, &input).unwrap();
        assert_eq!(
            e.liabilities(),
            &[
                PayoutItem {
                    participant_lock_hash: [10; 32],
                    principal: 600,
                    prize: 2
                },
                PayoutItem {
                    participant_lock_hash: [12; 32],
                    principal: 600,
                    prize: 1
                }
            ]
        );
        let mut reversed = entries.clone();
        reversed.reverse();
        let bad = EntitlementInput {
            entries: &reversed,
            ..input
        };
        assert!(InitialEntitlements::derive(&cfg, &record, &f.schedule, &bad).is_err());
    }
}

#[test]
fn later_batch_uses_its_actual_nonce_range_not_the_first_batch() {
    let f = fixture(100, true);
    let frozen = f.record.seal().ledger(0).unwrap().frozen();
    let first = AggregationState::new(&f.cfg, frozen)
        .unwrap()
        .accept(&f.cfg, &f.entries[0][..1], &[250], &[&f.proofs[0][0]])
        .unwrap()
        .0;
    let (second, receipt) = first
        .accept(
            &f.cfg,
            &f.entries[0][1..],
            &[250, 300],
            &[&f.proofs[0][1], &f.proofs[0][2]],
        )
        .unwrap();
    let closed = second
        .close(&f.cfg, crate::epoch::ABSOLUTE_EPOCH_FLAG | 20)
        .unwrap();
    let mut ledgers: Vec<_> = (0..4)
        .map(|id| *f.record.seal().ledger(id).unwrap())
        .collect();
    ledgers[0] = closed;
    let record = EntropyRecord::new(
        crate::seal::RoundSeal::new(&f.cfg, &ledgers).unwrap(),
        100,
        [1; 32],
        [[2; 32]; 3],
    )
    .unwrap();
    let input = EntitlementInput {
        batch_id: 1,
        receipt: &receipt,
        entries: &f.entries[0][1..],
        capacities: &[250, 300],
        realized_total: 555,
        winners: &[],
    };
    let e = InitialEntitlements::derive(&f.cfg, &record, &f.schedule, &input).unwrap();
    assert_eq!(
        e.liabilities(),
        &[
            PayoutItem {
                participant_lock_hash: [11; 32],
                principal: 250,
                prize: 3
            },
            PayoutItem {
                participant_lock_hash: [12; 32],
                principal: 300,
                prize: 2
            }
        ]
    );
    assert_eq!(e.funding().batch_id, 1);
    assert_eq!(e.funding().liability_count, 2);
    let wrong = EntitlementInput {
        batch_id: 0,
        ..input
    };
    assert!(InitialEntitlements::derive(&f.cfg, &record, &f.schedule, &wrong).is_err());
}

#[test]
fn receipt_replay_is_bounded_and_maximum_realized_value_conserves() {
    let f = fixture(100, true);
    let receipt = receipt(&f, 0);
    let input = EntitlementInput {
        batch_id: 0,
        receipt: &receipt,
        entries: &f.entries[0][..1],
        capacities: &[250],
        realized_total: u64::MAX,
        winners: &[],
    };
    let e = InitialEntitlements::derive(&f.cfg, &f.record, &f.schedule, &input).unwrap();
    assert_eq!(
        e.liabilities(),
        &[PayoutItem {
            participant_lock_hash: [10; 32],
            principal: 250,
            prize: u64::MAX - 250
        }]
    );
    let oversized = [f.entries[0][0]; 33];
    let invalid = EntitlementInput {
        entries: &oversized,
        capacities: &[250; 33],
        ..input
    };
    assert!(InitialEntitlements::derive(&f.cfg, &f.record, &f.schedule, &invalid).is_err());
    let invalid = EntitlementInput {
        capacities: &[],
        ..input
    };
    assert!(InitialEntitlements::derive(&f.cfg, &f.record, &f.schedule, &invalid).is_err());
    let invalid = EntitlementInput {
        capacities: &[199],
        ..input
    };
    assert!(InitialEntitlements::derive(&f.cfg, &f.record, &f.schedule, &invalid).is_err());
}
