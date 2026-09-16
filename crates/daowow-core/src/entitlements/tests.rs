use super::*;
use crate::{
    accumulator::mmr::{self, host::MmrHost},
    computed_draw::{
        tests::{fixture, Fixture},
        ComputedDraw,
    },
    leaf::{liability_leaf, prize_leaf},
    lifecycle::{batch_id, AggregationState},
    ticket::ticket_id,
    CoreError,
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
fn success_round_credits_prizes_to_tickets_and_principal_to_depositors() {
    let f = fixture(1, true);
    let d = ComputedDraw::new(&f.cfg, &f.record, &f.schedule).unwrap();
    // Independent Python hashlib candidate/retry calculation from pinned seed.
    assert_eq!(d.positions(), &[(0, 3), (1, 2), (2, 1), (3, 0)]);
    let commitment = f.cfg.commitment();
    // weights [4,3,2,1] over pool 100: 40, 30, 20, 10 to global 3, 2, 1, 0
    let mut expected = vec![
        PrizeEntitlement {
            ticket: ticket_id(&commitment, 2, 1),
            amount: 40,
        },
        PrizeEntitlement {
            ticket: ticket_id(&commitment, 2, 0),
            amount: 30,
        },
        PrizeEntitlement {
            ticket: ticket_id(&commitment, 0, 1),
            amount: 20,
        },
        PrizeEntitlement {
            ticket: ticket_id(&commitment, 0, 0),
            amount: 10,
        },
    ];
    expected.sort_by(|a, b| a.ticket.cmp(&b.ticket));
    for shard in [0, 2] {
        let receipt = receipt(&f, shard);
        let input = EntitlementInput {
            batch_id: batch_id(shard as u32, 0).unwrap(),
            receipt: &receipt,
            entries: &f.entries[shard][..1],
            capacities: &[250],
            realized_total: 350,
        };
        let derived = InitialEntitlements::derive(&f.cfg, &f.record, &f.schedule, &input).unwrap();
        // principal only, to the depositor of this batch
        assert_eq!(
            derived.liabilities(),
            &[PayoutItem {
                participant_lock_hash: [10 + shard as u8; 32],
                principal: 250,
                prize: 0
            }]
        );
        assert_eq!(derived.prizes(), expected.as_slice());
        let mut tree = MmrHost::new();
        for p in derived.prizes() {
            tree.append(&prize_leaf(&p.ticket, p.amount)).unwrap();
        }
        let f3 = derived.funding();
        assert_eq!(f3.prize_count, 4);
        assert_eq!(f3.prize_root, tree.root().unwrap());
        assert_eq!(f3.prize_paid, 0);
        assert_eq!(f3.prize_pool, 100);
        assert_eq!(f3.principal_liability, 250);
        assert_eq!(f3.liability_count, 1);
        let mut liabilities = MmrHost::new();
        liabilities
            .append(&liability_leaf(&[10 + shard as u8; 32], 250, 0))
            .unwrap();
        assert_eq!(f3.liabilities_root, liabilities.root().unwrap());
        for (i, p) in derived.prizes().iter().enumerate() {
            mmr::verify_membership(
                &f3.prize_root,
                4,
                i as u64,
                &prize_leaf(&p.ticket, p.amount),
                &tree.membership_proof(i as u64).unwrap(),
            )
            .unwrap();
        }
    }
}

#[test]
fn prize_domain_conserves_and_is_sorted_and_unique() {
    let f = fixture(1, true);
    let receipt = receipt(&f, 0);
    let input = EntitlementInput {
        batch_id: batch_id(0, 0).unwrap(),
        receipt: &receipt,
        entries: &f.entries[0][..1],
        capacities: &[250],
        realized_total: 350,
    };
    let derived = InitialEntitlements::derive(&f.cfg, &f.record, &f.schedule, &input).unwrap();
    let prizes = derived.prizes();
    assert!(prizes.windows(2).all(|w| w[0].ticket < w[1].ticket));
    let total: u64 = prizes.iter().map(|p| p.amount).sum();
    let principal: u64 = derived
        .liabilities()
        .iter()
        .map(|l| l.principal + l.prize)
        .sum();
    assert_eq!(total + principal, 350);
}

#[test]
fn a_success_round_with_zero_realized_yield_is_refused() {
    // realized_total == principal_total, so prize_pool is exactly 0 and
    // every drawn position allocates zero. This used to be tolerated by
    // silently omitting all winner records (the same class of defect
    // fixed in a_batch_allocating_zero_to_a_drawn_position_is_refused,
    // just uniform across every position instead of a subset): the guard
    // added there is unconditional on `amount == 0`, so a genuine
    // zero-yield successful draw is refused rather than settled with an
    // empty prize list.
    let f = fixture(1, true);
    let receipt = receipt(&f, 0);
    let input = EntitlementInput {
        batch_id: 0,
        receipt: &receipt,
        entries: &f.entries[0][..1],
        capacities: &[250],
        realized_total: 250,
    };
    assert_eq!(
        InitialEntitlements::derive(&f.cfg, &f.record, &f.schedule, &input),
        Err(CoreError::Conservation)
    );
}

#[test]
fn every_receipt_field_and_actual_capacity_is_bound() {
    let f = fixture(1, true);
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
        };
        assert!(InitialEntitlements::derive(&f.cfg, &f.record, &f.schedule, &input).is_err());
    }
}

#[test]
fn rejects_unaccepted_batch_ids_and_realized_underflow() {
    let f = fixture(1, true);
    let receipt = receipt(&f, 0);
    let mut input = EntitlementInput {
        batch_id: 0,
        receipt: &receipt,
        entries: &f.entries[0][..1],
        capacities: &[250],
        realized_total: 350,
    };
    for id in [1, 1u64 << 56, u64::MAX] {
        input.batch_id = id;
        assert!(InitialEntitlements::derive(&f.cfg, &f.record, &f.schedule, &input).is_err());
    }
    input.batch_id = 0;
    input.realized_total = 249;
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

#[test]
fn a_batch_allocating_zero_to_a_drawn_position_is_refused() {
    // Fixture schedule weights [4,3,2,1] (sum 10) draw 4 positions. A pool of
    // 2 allocates floor(2*w_i/10) = 0 to every position before dust; the dust
    // of 2 lands entirely on position 0, leaving positions 1..3 at zero. A
    // pool smaller than the number of drawn positions cannot pay them all.
    // This is unreachable through the viability gate and is pinned anyway:
    // it is the invariant the retirement count argument rests on.
    let f = fixture(1, true);
    let receipt = receipt(&f, 0);
    let input = EntitlementInput {
        batch_id: batch_id(0, 0).unwrap(),
        receipt: &receipt,
        entries: &f.entries[0][..1],
        capacities: &[250],
        realized_total: receipt.input_capacity + 2,
    };
    assert_eq!(
        InitialEntitlements::derive(&f.cfg, &f.record, &f.schedule, &input),
        Err(CoreError::Conservation)
    );
}

#[test]
fn pool_size_alone_is_not_the_condition() {
    // weights [1,1,1000] with pool 3 allocates [1,0,2]: the pool exceeds the
    // position count and a position is still zero, so the guard must test
    // the computed allocation, not the pool.
    assert_eq!(
        crate::accounting::allocate_prizes_complete(&[1, 1, 1000], 3),
        Ok(vec![1, 0, 2])
    );
}
