use super::*;
use crate::computed_draw::{
    tests::{fixture, fixture_unviable},
    ComputedDraw,
};
use crate::redemption::PrizeRedemptionState;
use crate::ticket::ticket_id;
use crate::CoreError;

fn args() -> ClaimArgs {
    ClaimArgs {
        commitment: [7; 32],
        shard_id: 3,
        position: 0x0102_0304_0506_0708,
    }
}

#[test]
fn args_round_trip_with_exact_layout() {
    let wire = args().encode();
    assert_eq!(wire.len(), CLAIM_ARGS_SIZE);
    assert_eq!(wire[0], CLAIM_TAG);
    assert_eq!(&wire[1..33], &[7; 32]);
    assert_eq!(&wire[33..37], &3u32.to_le_bytes());
    assert_eq!(&wire[37..45], &0x0102_0304_0506_0708u64.to_le_bytes());
    assert_eq!(ClaimArgs::decode(&wire), Ok(args()));
}

#[test]
fn args_decoder_rejects_wrong_length_or_tag() {
    let wire = args().encode();
    assert_eq!(ClaimArgs::decode(&wire[..44]), Err(CoreError::Encoding));
    let mut long = wire.to_vec();
    long.push(0);
    assert_eq!(ClaimArgs::decode(&long), Err(CoreError::Encoding));
    let mut bad_tag = wire;
    bad_tag[0] = 2;
    assert_eq!(ClaimArgs::decode(&bad_tag), Err(CoreError::Encoding));
    assert_eq!(ClaimArgs::decode(&[]), Err(CoreError::Encoding));
}

#[test]
fn identity_and_initial_state_derive_from_args() {
    let a = args();
    assert_eq!(a.ticket_id(), ticket_id(&[7; 32], 3, 0x0102_0304_0506_0708));
    let bytes = initial_state_bytes(&a);
    assert_eq!(bytes, PrizeRedemptionState::new(a.ticket_id()).encode());
    assert_eq!(bytes.len(), CLAIM_DATA_SIZE);
}

#[test]
fn transfer_requires_identical_decodable_state_with_matching_ticket() {
    let a = args();
    let state = initial_state_bytes(&a);
    assert_eq!(validate_transfer(&a, &state, &state), Ok(()));

    let mut changed = state;
    changed[73] = 1; // paid_total low byte: undecodable with count 0
    assert_eq!(
        validate_transfer(&a, &state, &changed),
        Err(CoreError::Encoding)
    );

    let other = initial_state_bytes(&ClaimArgs { position: 9, ..a });
    assert_eq!(
        validate_transfer(&a, &other, &other),
        Err(CoreError::Encoding)
    );
    assert_eq!(
        validate_transfer(&a, &state, &other),
        Err(CoreError::Encoding)
    );
    assert_eq!(
        validate_transfer(&a, &state, &state[..80]),
        Err(CoreError::Encoding)
    );
}

#[test]
fn transfer_rejects_any_paid_state_change() {
    use crate::accumulator::smt::host::SmtHost;
    use crate::redemption::{prize_obligation_key, prize_payment_leaf};
    let a = args();
    let initial = PrizeRedemptionState::new(a.ticket_id());
    let mut tree = SmtHost::new();
    let key = prize_obligation_key(&initial.ticket(), &[9; 32]);
    let proof = tree.absence_proof(&[key]).unwrap();
    let paid = initial.record_verified_prize(&[9; 32], 5, &proof).unwrap();
    tree.insert(&key, &prize_payment_leaf(&initial.ticket(), &[9; 32], 5))
        .unwrap();
    assert_eq!(
        validate_transfer(&a, &initial.encode(), &paid.encode()),
        Err(CoreError::StateTransition)
    );
    // a paid claim transfers unchanged
    assert_eq!(
        validate_transfer(&a, &paid.encode(), &paid.encode()),
        Ok(())
    );
}

#[test]
fn occupied_capacity_counts_every_cell_field() {
    // 8 capacity + 53 secp lock + (32 + 1 + 45) type + 81 data = 220 bytes
    assert_eq!(claim_occupied_capacity(53), 220 * 100_000_000);
}

fn entry(lock: u8, base: u64, tickets: u64) -> crate::encoding::EntryDataV1 {
    crate::encoding::EntryDataV1 {
        round_id: [1; 32],
        shard_id: 3,
        participant_lock_hash: [lock; 32],
        ticket_count: tickets,
        principal: tickets * 100,
        position_base: base,
        entry_nonce: base,
        entropy_commitment: [0; 32],
    }
}

fn claim(position: u64, lock: u8) -> MintedClaim {
    let a = ClaimArgs {
        commitment: [7; 32],
        shard_id: 3,
        position,
    };
    MintedClaim {
        position,
        lock_hash: [lock; 32],
        data: initial_state_bytes(&a),
    }
}

/// Two entries: A owns positions 10..13 (3 tickets), B owns 13..15 (2 tickets).
fn mint_fixture() -> (Vec<crate::encoding::EntryDataV1>, Vec<MintedClaim>) {
    let entries = vec![entry(0xA, 10, 3), entry(0xB, 13, 2)];
    let claims = vec![
        claim(10, 0xA),
        claim(11, 0xA),
        claim(12, 0xA),
        claim(13, 0xB),
        claim(14, 0xB),
    ];
    (entries, claims)
}

fn check(claims: &[MintedClaim]) -> Result<(), CoreError> {
    let (entries, _) = mint_fixture();
    validate_mint(10, 15, &[7; 32], 3, &entries, claims)
}

#[test]
fn mint_accepts_exactly_one_claim_per_new_ticket_in_any_order() {
    let (_, mut claims) = mint_fixture();
    assert_eq!(check(&claims), Ok(()));
    claims.reverse();
    assert_eq!(check(&claims), Ok(()));
    assert_eq!(validate_mint(10, 10, &[7; 32], 3, &[], &[]), Ok(()));
}

#[test]
fn mint_rejects_wrong_claim_count() {
    let (_, mut claims) = mint_fixture();
    let extra = claims.pop().unwrap();
    assert_eq!(check(&claims), Err(CoreError::InvalidArgument));
    claims.push(extra);
    claims.push(claim(14, 0xB));
    assert_eq!(check(&claims), Err(CoreError::InvalidArgument));
    let (entries, claims) = mint_fixture();
    assert_eq!(
        validate_mint(15, 10, &[7; 32], 3, &entries, &claims),
        Err(CoreError::InvalidArgument)
    );
}

#[test]
fn mint_rejects_positions_outside_the_new_range_and_duplicates() {
    let (_, mut claims) = mint_fixture();
    claims[4] = claim(9, 0xA); // remint of an earlier ticket
    assert_eq!(check(&claims), Err(CoreError::StateTransition));
    claims[4] = claim(15, 0xB); // beyond after_tickets
    assert_eq!(check(&claims), Err(CoreError::StateTransition));
    claims[4] = claim(13, 0xB); // duplicate of claims[3]
    assert_eq!(check(&claims), Err(CoreError::StateTransition));
}

#[test]
fn mint_rejects_claim_not_locked_to_the_owning_entrant() {
    let (_, mut claims) = mint_fixture();
    claims[3] = claim(13, 0xA); // B's ticket minted to A
    assert_eq!(check(&claims), Err(CoreError::StateTransition));
    claims[3] = claim(13, 0xC); // stranger
    assert_eq!(check(&claims), Err(CoreError::StateTransition));
}

#[test]
fn mint_rejects_position_with_no_owning_entry() {
    // entries cover 10..15 but the second entry is missing; count still 5.
    // Every claim uses A's lock so only the ownership lookup can reject.
    let entries = vec![entry(0xA, 10, 3)];
    let claims: Vec<MintedClaim> = (10..15).map(|p| claim(p, 0xA)).collect();
    assert_eq!(
        validate_mint(10, 15, &[7; 32], 3, &entries, &claims),
        Err(CoreError::StateTransition)
    );
}

#[test]
fn mint_rejects_nonzero_or_misidentified_data() {
    let (_, mut claims) = mint_fixture();
    claims[0].data[73] = 1; // paid_total
    assert_eq!(check(&claims), Err(CoreError::Encoding));
    let (_, mut claims) = mint_fixture();
    let wrong = ClaimArgs {
        commitment: [8; 32],
        shard_id: 3,
        position: 10,
    };
    claims[0].data = initial_state_bytes(&wrong);
    assert_eq!(check(&claims), Err(CoreError::Encoding));
    let (_, mut claims) = mint_fixture();
    let wrong = ClaimArgs {
        commitment: [7; 32],
        shard_id: 4,
        position: 10,
    };
    claims[0].data = initial_state_bytes(&wrong);
    assert_eq!(check(&claims), Err(CoreError::Encoding));
}

#[test]
fn a_non_winner_retires_with_nothing_paid() {
    let f = fixture(1, true);
    let draw = ComputedDraw::new(&f.cfg, &f.record, &f.schedule).unwrap();
    let args = f.non_winning_claim_args(&draw);
    let state = PrizeRedemptionState::new(args.ticket_id());
    assert_eq!(
        retire_decision(&args, &state, &draw, 7),
        Ok(RetireDecision::NonWinner)
    );
}

#[test]
fn a_winner_retires_only_when_every_batch_is_discharged() {
    let f = fixture(1, true);
    let draw = ComputedDraw::new(&f.cfg, &f.record, &f.schedule).unwrap();
    let (args, prize_index) = f.winning_claim_args(&draw);
    let state = f.state_with_paid_count(&args, 3);
    assert_eq!(
        retire_decision(&args, &state, &draw, 3),
        Ok(RetireDecision::Winner { prize_index })
    );
    // one source short is refused
    assert_eq!(
        retire_decision(&args, &state, &draw, 4),
        Err(CoreError::StateTransition)
    );
}

/// `retire_decision` compares `paid_count()` to `universe` with a strict
/// `!=`, not a one-sided `< universe`. Nothing today should be able to
/// record more paid sources than the round's own batch universe (each
/// source is a distinct real batch, inserted under an absence proof), but
/// that is an invariant of other modules, not of `retire_decision` itself —
/// the `!=` is defence against that invariant ever failing elsewhere.
/// A `<` in its place would let an over-credited winner retire as though
/// exactly discharged instead of refusing it.
#[test]
fn a_winner_with_more_paid_sources_than_the_universe_is_refused() {
    let f = fixture(1, true);
    let draw = ComputedDraw::new(&f.cfg, &f.record, &f.schedule).unwrap();
    let (args, _prize_index) = f.winning_claim_args(&draw);
    let state = f.state_with_paid_count(&args, 4);
    assert_eq!(
        retire_decision(&args, &state, &draw, 3),
        Err(CoreError::StateTransition)
    );
}

#[test]
fn a_claim_sharing_a_winners_shard_but_not_its_position_is_a_non_winner() {
    // `non_winning_claim_args` only ever varies shard_id (a shard past the
    // last real one), so it cannot pin the `position != args.position` half
    // of retire_decision's membership test. This identity reuses a real
    // winner's shard_id and varies only the position, so the shard half
    // alone cannot make it match.
    let f = fixture(1, true);
    let draw = ComputedDraw::new(&f.cfg, &f.record, &f.schedule).unwrap();
    let args = f.same_shard_wrong_position_claim_args(&draw);
    let state = PrizeRedemptionState::new(args.ticket_id());
    assert_eq!(
        retire_decision(&args, &state, &draw, 7),
        Ok(RetireDecision::NonWinner)
    );
}

#[test]
fn a_non_winner_carrying_payments_is_refused() {
    // Only a drawn ticket can ever have redeemed; anything else is forged.
    let f = fixture(1, true);
    let draw = ComputedDraw::new(&f.cfg, &f.record, &f.schedule).unwrap();
    let args = f.non_winning_claim_args(&draw);
    let state = f.state_with_paid_count(&args, 1);
    assert_eq!(
        retire_decision(&args, &state, &draw, 3),
        Err(CoreError::StateTransition)
    );
}

#[test]
fn state_belonging_to_another_ticket_is_refused() {
    let f = fixture(1, true);
    let draw = ComputedDraw::new(&f.cfg, &f.record, &f.schedule).unwrap();
    let args = f.non_winning_claim_args(&draw);
    let state = PrizeRedemptionState::new([0xAB; 32]);
    assert_eq!(
        retire_decision(&args, &state, &draw, 3),
        Err(CoreError::Encoding)
    );
}

#[test]
fn every_claim_of_a_voided_round_is_a_non_winner() {
    let f = fixture_unviable(1, true);
    let draw = ComputedDraw::new(&f.cfg, &f.record, &f.schedule).unwrap();
    assert!(!draw.is_success());
    let args = f.any_claim_args();
    let state = PrizeRedemptionState::new(args.ticket_id());
    assert_eq!(
        retire_decision(&args, &state, &draw, 9),
        Ok(RetireDecision::NonWinner)
    );
}
