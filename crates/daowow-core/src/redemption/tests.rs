use super::*;
use crate::accumulator::{smt::host::SmtHost, MAX_PROOF_BYTES};
use crate::CoreError;

fn pay(
    state: &PrizeRedemptionState,
    tree: &mut SmtHost,
    source: [u8; 32],
    amount: u64,
) -> PrizeRedemptionState {
    let key = prize_obligation_key(&state.ticket(), &source);
    let proof = tree.absence_proof(&[key]).unwrap();
    let next = state
        .record_verified_prize(&source, amount, &proof)
        .unwrap();
    tree.insert(&key, &prize_payment_leaf(&state.ticket(), &source, amount))
        .unwrap();
    assert_eq!(next.paid_root(), tree.root());
    next
}

#[test]
fn obligation_and_payment_bind_their_domains_and_fields() {
    let ticket = [1; 32];
    let source = [2; 32];
    let key = prize_obligation_key(&ticket, &source);
    let mut message = b"DAOWOW_PRIZE_OBLIGATION_V1".to_vec();
    message.extend_from_slice(&ticket);
    message.extend_from_slice(&source);
    message.push(1);
    assert_eq!(key, crate::hash::ckb_hash256_one(&message));
    assert_ne!(key, prize_obligation_key(&[3; 32], &source));
    assert_ne!(key, prize_obligation_key(&ticket, &[3; 32]));
    let mut message = b"DAOWOW_PRIZE_PAYMENT_V1".to_vec();
    message.extend_from_slice(&key);
    message.extend_from_slice(&[7, 0, 0, 0, 0, 0, 0, 0]);
    assert_eq!(
        prize_payment_leaf(&ticket, &source, 7),
        crate::hash::ckb_hash256_one(&message)
    );
    assert_ne!(
        prize_payment_leaf(&ticket, &source, 7),
        prize_payment_leaf(&ticket, &source, 8)
    );
}

#[test]
fn duplicate_source_cannot_be_repaid_with_a_different_amount() {
    let initial = PrizeRedemptionState::new([1; 32]);
    let mut tree = SmtHost::new();
    let source = [2; 32];
    let key = prize_obligation_key(&initial.ticket(), &source);
    let old_proof = tree.absence_proof(&[key]).unwrap();
    let paid = pay(&initial, &mut tree, source, 7);
    assert_eq!(paid.paid_count(), 1);
    assert_eq!(paid.paid_total(), 7);
    assert_eq!(initial.paid_total(), 0);
    let fresh_proof = tree.absence_proof(&[key]).unwrap();
    for proof in [&old_proof, &fresh_proof] {
        assert!(paid.record_verified_prize(&source, 7, proof).is_err());
        assert!(paid.record_verified_prize(&source, 8, proof).is_err());
    }
}

#[test]
fn independent_sources_can_be_paid_in_either_order() {
    let initial = PrizeRedemptionState::new([1; 32]);
    let mut forward = SmtHost::new();
    let a = pay(&initial, &mut forward, [2; 32], 7);
    let a = pay(&a, &mut forward, [3; 32], 11);
    let mut reverse = SmtHost::new();
    let b = pay(&initial, &mut reverse, [3; 32], 11);
    let b = pay(&b, &mut reverse, [2; 32], 7);
    assert_eq!(a, b);
    assert_eq!(a.paid_count(), 2);
    assert_eq!(a.paid_total(), 18);
}

#[test]
fn stale_corrupt_and_unbounded_proofs_cannot_replace_paid_history() {
    let initial = PrizeRedemptionState::new([1; 32]);
    let mut tree = SmtHost::new();
    let key = prize_obligation_key(&initial.ticket(), &[3; 32]);
    let stale = tree.absence_proof(&[key]).unwrap();
    let paid = pay(&initial, &mut tree, [2; 32], 7);
    let before = paid.encode();
    let proof = tree.absence_proof(&[key]).unwrap();
    let mut corrupt = proof.clone();
    corrupt[0] = 0xff;
    for bad in [stale, corrupt] {
        assert_eq!(
            paid.record_verified_prize(&[3; 32], 11, &bad),
            Err(CoreError::AppendProof)
        );
    }
    // Size bounds are enforced before decoding: the length guard reports
    // `MembershipProof`, so an oversize but otherwise valid proof cannot slip
    // through on decoder leniency. Padding keeps the prefix a real proof.
    let mut oversize = proof.clone();
    oversize.resize(MAX_PROOF_BYTES + 1, 0);
    for bad in [vec![], oversize] {
        assert_eq!(
            paid.record_verified_prize(&[3; 32], 11, &bad),
            Err(CoreError::MembershipProof)
        );
    }
    assert_eq!(paid.encode(), before);
    assert!(paid.record_verified_prize(&[3; 32], 11, &proof).is_ok());
}

#[test]
fn zero_and_total_overflow_leave_state_unchanged() {
    let initial = PrizeRedemptionState::new([1; 32]);
    let mut tree = SmtHost::new();
    let proof = tree
        .absence_proof(&[prize_obligation_key(&initial.ticket(), &[2; 32])])
        .unwrap();
    assert_eq!(
        initial.record_verified_prize(&[2; 32], 0, &proof),
        Err(CoreError::InvalidArgument)
    );
    let paid = pay(&initial, &mut tree, [2; 32], u64::MAX);
    let before = paid.encode();
    let proof = tree
        .absence_proof(&[prize_obligation_key(&paid.ticket(), &[3; 32])])
        .unwrap();
    assert_eq!(
        paid.record_verified_prize(&[3; 32], 1, &proof),
        Err(CoreError::Overflow)
    );
    assert_eq!(paid.encode(), before);
}

#[test]
fn canonical_wire_preserves_paid_history_for_a_successor() {
    let initial = PrizeRedemptionState::new([1; 32]);
    let wire = initial.encode();
    assert_eq!(wire.len(), 81);
    assert_eq!(wire[0], 1);
    assert_eq!(&wire[1..33], &[1; 32]);
    assert_eq!(&wire[33..], &[0; 48]);
    assert_eq!(PrizeRedemptionState::decode(&wire), Ok(initial.clone()));
    let mut tree = SmtHost::new();
    let paid = pay(&initial, &mut tree, [2; 32], 7);
    let wire = paid.encode();
    assert_eq!(&wire[65..73], &[1, 0, 0, 0, 0, 0, 0, 0]);
    assert_eq!(&wire[73..81], &[7, 0, 0, 0, 0, 0, 0, 0]);
    let restored = PrizeRedemptionState::decode(&wire).unwrap();
    assert_eq!(restored, paid);
    let next = pay(&restored, &mut tree, [3; 32], 11);
    assert_eq!(next.paid_total(), 18);
    let proof = tree
        .absence_proof(&[prize_obligation_key(&next.ticket(), &[2; 32])])
        .unwrap();
    assert!(next.record_verified_prize(&[2; 32], 7, &proof).is_err());
}

#[test]
fn decoder_rejects_noncanonical_wire_and_inconsistent_counters() {
    let empty = PrizeRedemptionState::new([1; 32]).encode();
    for end in 0..empty.len() {
        assert!(PrizeRedemptionState::decode(&empty[..end]).is_err());
    }
    let mut extra = empty.to_vec();
    extra.push(0);
    assert!(PrizeRedemptionState::decode(&extra).is_err());
    for offset in [0, 33, 65, 73] {
        let mut wire = empty;
        wire[offset] = 2;
        assert!(PrizeRedemptionState::decode(&wire).is_err());
    }
    let mut tree = SmtHost::new();
    let paid = pay(&PrizeRedemptionState::new([1; 32]), &mut tree, [2; 32], 7);
    let mut wire = paid.encode();
    wire[65..73].copy_from_slice(&8u64.to_le_bytes());
    assert!(PrizeRedemptionState::decode(&wire).is_err());
    let mut wire = paid.encode();
    wire[33..65].fill(0);
    assert!(PrizeRedemptionState::decode(&wire).is_err());
}

#[test]
fn saturated_decoded_counters_cannot_accept_another_payment() {
    // A live cell could carry a maximal paid state only through decode, never
    // through 2^64 transitions. Both counters saturate together because decode
    // enforces total >= count, so any positive amount must overflow.
    let mut tree = SmtHost::new();
    let paid = pay(&PrizeRedemptionState::new([1; 32]), &mut tree, [2; 32], 7);
    let mut wire = paid.encode();
    wire[65..73].copy_from_slice(&u64::MAX.to_le_bytes());
    wire[73..81].copy_from_slice(&u64::MAX.to_le_bytes());
    let saturated = PrizeRedemptionState::decode(&wire).unwrap();
    assert_eq!(saturated.paid_count(), u64::MAX);
    assert_eq!(saturated.paid_root(), tree.root());
    let proof = tree
        .absence_proof(&[prize_obligation_key(&saturated.ticket(), &[3; 32])])
        .unwrap();
    assert_eq!(
        saturated.record_verified_prize(&[3; 32], 1, &proof),
        Err(CoreError::Overflow)
    );
    assert_eq!(saturated.encode(), wire);
}
