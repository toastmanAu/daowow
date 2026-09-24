// The two creation rules a round-creation transaction must satisfy, ported so
// they are checked locally instead of costing a broadcast to discover.
//
// Both are reported by round-type as -17 ROUND_ERROR_CONFIG, and that one code
// covers every failure in the creation branch — so the node's answer never
// says which rule was broken. These functions do.

import { ccc } from "../apps/web/vendor/ccc-joyid.min.mjs";

export const MAX_EPOCH_NUMBER = 0x00ffffffn;   // epoch.rs:5
export const ACC_IMT = 2;                      // encoding.rs:61

/**
 * The round id round-type demands (daowow-contracts-common/src/lib.rs:54,
 * checked at contracts/round-type/src/main.rs:67):
 *
 *   ckb_hash256(&[CellInput(input 0).as_slice(), &(config_output_index as u64).to_le_bytes()])
 *
 * That is the Type ID derivation, which is what makes a round id unique to the
 * cell that funded it: a second round cannot claim the same identity without
 * spending the same cell. An invented id is refused.
 *
 * `input` is the ckb JSON-RPC shape, `{previous_output: {tx_hash, index}, since}`.
 */
export function creationRoundId(input, configOutputIndex) {
  const cellInput = ccc.CellInput.from({
    previousOutput: {
      txHash: input.previous_output.tx_hash,
      index: Number(input.previous_output.index),
    },
    since: BigInt(input.since ?? 0),
  });
  return ccc.hashTypeId(cellInput, configOutputIndex).replace(/^0x/, "");
}

/**
 * RoundConfigV1::validate (encoding.rs:192), rule for rule, returning the
 * reason rather than a boolean — the whole point is to say which one bit.
 * Returns an array of problems, empty when the config is valid.
 */
export function validateRoundConfig(cfg) {
  const bad = [];
  if (cfg.version !== 1) bad.push(`version is ${cfg.version}, must be 1`);
  if (cfg.ticketPrice === 0n) bad.push("ticket_price is 0");
  if (cfg.entryShardCount === 0 || cfg.entryShardCount > 256) {
    bad.push(`entry_shard_count is ${cfg.entryShardCount}, must be 1..=256`);
  }
  // A cap is only round-wide at one shard: shard.rs compares a SINGLE shard's
  // ticket count against maximum_tickets, so a multi-shard capped round would
  // accept up to entry_shard_count times the advertised cap.
  if (cfg.maximumTickets !== 0n && cfg.entryShardCount > 1) {
    bad.push(
      `a capped round cannot shard: maximum_tickets is ${cfg.maximumTickets} ` +
      `with ${cfg.entryShardCount} shards, and the cap is enforced per shard`,
    );
  }
  if (cfg.maximumTickets !== 0n && cfg.minimumTickets > cfg.maximumTickets) {
    bad.push(
      `minimum_tickets ${cfg.minimumTickets} exceeds maximum_tickets ` +
      `${cfg.maximumTickets}; the round could never draw`,
    );
  }
  if (cfg.entryStart > cfg.entryEnd || cfg.entryEnd > cfg.aggregationDeadline) {
    bad.push(
      `the windows are out of order: entry ${cfg.entryStart}..${cfg.entryEnd}, ` +
      `aggregate by ${cfg.aggregationDeadline}`,
    );
  }
  if (cfg.aggregationDeadline > MAX_EPOCH_NUMBER) {
    bad.push(`aggregation_deadline ${cfg.aggregationDeadline} exceeds the epoch field`);
  }
  if (cfg.daoTermPeriods === 0) bad.push("dao_term_periods is 0");
  if (cfg.accumulatorId > ACC_IMT) {
    bad.push(`accumulator_id is ${cfg.accumulatorId}, must be 0..=${ACC_IMT}`);
  }
  return bad;
}
