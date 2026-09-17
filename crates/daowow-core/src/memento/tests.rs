use super::*;

fn args() -> MementoArgs {
    MementoArgs {
        commitment: [7; 32],
        shard_id: 2,
        position: 9,
    }
}

fn data() -> MementoData {
    MementoData {
        renderer_version: MEMENTO_RENDERER_V1,
        prize_index: 3,
        paid_count: 4,
        paid_total: 4000,
    }
}

#[test]
fn args_round_trip_and_carry_tag_six() {
    let wire = args().encode();
    assert_eq!(wire.len(), MEMENTO_ARGS_SIZE);
    assert_eq!(wire[0], MEMENTO_TAG);
    assert_eq!(MementoArgs::decode(&wire), Ok(args()));
}

#[test]
fn args_reject_the_claim_tag_and_wrong_lengths() {
    let mut wire = args().encode();
    wire[0] = crate::claim::CLAIM_TAG;
    assert_eq!(MementoArgs::decode(&wire), Err(CoreError::Encoding));
    let good = args().encode();
    assert_eq!(MementoArgs::decode(&good[..44]), Err(CoreError::Encoding));
    let mut long = good.to_vec();
    long.push(0);
    assert_eq!(MementoArgs::decode(&long), Err(CoreError::Encoding));
}

#[test]
fn args_ticket_matches_the_claim_of_the_same_identity() {
    let a = args();
    let c = crate::claim::ClaimArgs {
        commitment: a.commitment,
        shard_id: a.shard_id,
        position: a.position,
    };
    assert_eq!(a.ticket_id(), c.ticket_id());
}

#[test]
fn data_round_trips_and_commits_the_template() {
    let wire = data().encode();
    assert_eq!(wire.len(), MEMENTO_DATA_SIZE);
    assert_eq!(wire[0], 1);
    assert_eq!(&wire[2..34], &WINNER_TEMPLATE_SHA256);
    assert_eq!(MementoData::decode(&wire), Ok(data()));
}

#[test]
fn data_rejects_a_substituted_template_or_renderer() {
    let mut wire = data().encode();
    wire[2] ^= 1;
    assert_eq!(MementoData::decode(&wire), Err(CoreError::Encoding));
    let mut wire = data().encode();
    wire[1] = MEMENTO_RENDERER_V1 + 1;
    assert_eq!(MementoData::decode(&wire), Err(CoreError::Encoding));
    let mut wire = data().encode();
    wire[0] = 2;
    assert_eq!(MementoData::decode(&wire), Err(CoreError::Encoding));
}

#[test]
fn data_rejects_counters_a_winner_cannot_have() {
    // a winner discharged at least one source, each of a positive amount
    let mut zero = data();
    zero.paid_count = 0;
    assert_eq!(
        MementoData::decode(&zero.encode()),
        Err(CoreError::Encoding)
    );
    let mut thin = data();
    thin.paid_count = 5;
    thin.paid_total = 4;
    assert_eq!(
        MementoData::decode(&thin.encode()),
        Err(CoreError::Encoding)
    );
    let mut ranked = data();
    ranked.prize_index = crate::schedule::MAX_SCHEDULE_PRIZES as u32;
    assert_eq!(
        MementoData::decode(&ranked.encode()),
        Err(CoreError::Encoding)
    );
}

#[test]
fn occupied_capacity_matches_the_spec_arithmetic() {
    // 8 capacity + 53 secp lock + (32 + 1 + 45) type + 54 data = 193 CKB
    assert_eq!(memento_occupied_capacity(53), 193 * 100_000_000);
}
