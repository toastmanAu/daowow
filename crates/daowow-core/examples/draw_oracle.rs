//! Compute the draw for a LIVE round with the same code the contracts link.
//!
//! The dApp's draw is a JavaScript port. It is pinned to gen_vectors, but a
//! port checked only against fixtures has never been checked against the
//! round it is actually reporting on. This takes the real bytes off chain and
//! runs ComputedDraw over them, so a disagreement shows up before anyone
//! reads a winner list.
//!
//! Usage:
//!   cargo run -p daowow-core --example draw_oracle -- <config hex> <schedule hex> <record hex>
//! Prints one line per field, in a shape a script can compare.

use daowow_core::{
    computed_draw::ComputedDraw, encoding::RoundConfigV1, schedule::PrizeSchedule,
    seal::EntropyRecord,
};

fn unhex(s: &str) -> Vec<u8> {
    let s = s.trim_start_matches("0x");
    assert!(s.len() % 2 == 0, "odd-length hex");
    (0..s.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&s[i..i + 2], 16).expect("hex"))
        .collect()
}

fn hex(b: &[u8]) -> String {
    b.iter().map(|x| format!("{x:02x}")).collect()
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    assert_eq!(args.len(), 4, "usage: draw_oracle <config> <schedule> <record>");
    let cfg = RoundConfigV1::decode(&unhex(&args[1])).expect("config decodes");
    // decode_committed: the schedule must hash to what the config commits to,
    // exactly as on chain. An oracle that skipped this would agree with a
    // forged table.
    let schedule = PrizeSchedule::decode_committed(&unhex(&args[2]), &cfg.prize_schedule_hash)
        .expect("schedule decodes and matches the config's commitment");
    let record = EntropyRecord::decode(&unhex(&args[3]), &cfg).expect("record decodes");
    let draw = ComputedDraw::new(&cfg, &record, &schedule).expect("draw computes");
    println!("seed {}", hex(&draw.seed()));
    println!("total {}", draw.total_tickets());
    println!("success {}", draw.is_success());
    for (prize, position) in draw.positions() {
        println!("position {prize} {position}");
    }
}
