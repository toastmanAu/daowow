use super::*;
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
