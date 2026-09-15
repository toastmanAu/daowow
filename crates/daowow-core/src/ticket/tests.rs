use super::*;
use alloc::vec::Vec;

#[test]
fn identity_binds_config_shard_and_position() {
    let base = ticket_id(&[1; 32], 2, 3);
    assert_eq!(base, ticket_id(&[1; 32], 2, 3));
    assert_ne!(base, ticket_id(&[2; 32], 2, 3));
    assert_ne!(base, ticket_id(&[1; 32], 3, 3));
    assert_ne!(base, ticket_id(&[1; 32], 2, 4));
}

#[test]
fn identity_has_explicit_domain_and_little_endian_layout() {
    let mut message = b"DAOWOW_TICKET_ID_V1".to_vec();
    message.extend_from_slice(&[1; 32]);
    message.extend_from_slice(&[2, 0, 0, 0]);
    message.extend_from_slice(&[3, 0, 0, 0, 0, 0, 0, 0]);
    assert_eq!(
        ticket_id(&[1; 32], 2, 3),
        crate::hash::ckb_hash256_one(&message)
    );
}

#[test]
fn overhead_is_conserved_in_immutable_ticket_order() {
    assert_eq!(ticket_capacity(100, 305, 3, 0), Ok(102));
    assert_eq!(ticket_capacity(100, 305, 3, 1), Ok(102));
    assert_eq!(ticket_capacity(100, 305, 3, 2), Ok(101));
    for count in 1..=32 {
        for overhead in 0..=65 {
            let total = 100 * count + overhead;
            let shares: Vec<_> = (0..count)
                .map(|i| ticket_capacity(100, total, count, i).unwrap())
                .collect();
            assert!(shares.iter().all(|share| *share >= 100));
            assert_eq!(shares.iter().sum::<u64>(), total);
        }
    }
}

#[test]
fn allocation_rejects_invalid_inputs_and_handles_u64_limit() {
    for args in [
        (0, 100, 1, 0),
        (1, 100, 0, 0),
        (1, 100, 1, 1),
        (100, 299, 3, 0),
        (u64::MAX, u64::MAX, 2, 0),
    ] {
        assert!(ticket_capacity(args.0, args.1, args.2, args.3).is_err());
    }
    assert_eq!(ticket_capacity(1, u64::MAX, 1, 0), Ok(u64::MAX));
}
