// Validates the transaction tools/create-demo-round.mjs produced, with the
// same code round-type runs. Building a round the contract would refuse is a
// failure that otherwise surfaces only after signing.
use daowow_core::encoding::*;

fn demo_dir() -> Option<String> {
    std::env::var("DEMO_DIR").ok()
}

fn load(name: &str) -> Vec<u8> {
    let dir = demo_dir().expect("DEMO_DIR");
    let hex = std::fs::read_to_string(format!("{dir}/{name}.hex")).unwrap();
    (0..hex.trim().len()).step_by(2)
        .map(|i| u8::from_str_radix(&hex.trim()[i..i + 2], 16).unwrap())
        .collect()
}

#[test]
fn the_generated_demo_round_is_valid() {
    // Opt-in: point DEMO_DIR at the directory holding config.hex, shard.hex
    // and witness.hex written by tools/create-demo-round.mjs. Skipped
    // otherwise so the ordinary suite does not depend on a generated file.
    if demo_dir().is_none() {
        println!("skipped: set DEMO_DIR to validate a generated demo round");
        return;
    }
    let cfg = RoundConfigV1::decode(&load("config")).expect("config must decode");
    cfg.validate().expect("round-type would refuse this config");
    assert_eq!(cfg.ticket_price, 10_000 * 100_000_000);
    assert_eq!(cfg.minimum_tickets, 5);
    assert_eq!(cfg.maximum_tickets, 10);
    assert_eq!(cfg.entry_shard_count, 1);
    assert_eq!(cfg.accumulator_id, ACC_MMR);
    assert!(cfg.entry_end >= cfg.entry_start);
    assert!(cfg.aggregation_deadline >= cfg.entry_end);

    let shard = EntryShardDataV1::decode(&load("shard")).expect("shard must decode");
    assert_eq!(shard.round_id, cfg.round_id, "the shard must belong to this round");
    assert_eq!(shard.state, SHARD_STATE_OPEN);
    assert_eq!(shard.ticket_count, 0);
    assert_eq!(
        shard.accumulator_root,
        daowow_core::accumulator::mmr::bag_peaks(&[]).unwrap(),
        "an empty MMR shard's root is bag_peaks of no peaks, not zeros",
    );

    // The schedule the witness publishes must match what the config commits
    // to, or creation_schedule refuses it.
    let witness = load("witness");
    let schedule_start = witness.len() - (5 + 5 * 16);
    let schedule = daowow_core::schedule::PrizeSchedule::decode(&witness[schedule_start..])
        .expect("the witness must carry a decodable schedule");
    assert_eq!(schedule.commitment(), cfg.prize_schedule_hash,
        "the published schedule must match the config's commitment");
    assert_eq!(schedule.thresholds(), &[1, 8, 20, 50, 100]);
    assert_eq!(schedule.weights_for(10).unwrap().len(), 2,
        "ten tickets must pay two places");
    println!("the generated demo round validates against round-type's own rules");
}
