"use strict";
// Finding rounds on chain and deriving what to display about them.
//
// State is DERIVED on every read, never stored. The beta plan forbids keeping
// an irreversible local flag, because a reorg must be able to restore actual
// canonical state rather than leave the UI asserting something the chain no
// longer says.

const { decodeRoundConfigV1, decodeEntryShardDataV1, SHARD_STATE,
  ROUND_CONFIG_SIZE, SHARD_DATA_SIZE } = require("./codec.js");

const ROUND_STATE = Object.freeze({
  PENDING: "pending",
  OPEN: "open",
  FROZEN: "frozen",
});

const unhex = (s) => {
  const body = s.startsWith("0x") ? s.slice(2) : s;
  const out = new Uint8Array(body.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(body.substr(i * 2, 2), 16);
  }
  return out;
};

// `nowEpoch` is the chain's current absolute epoch number. Both window bounds
// in the config are absolute epoch numbers too.
function deriveRoundState(config, shards, nowEpoch) {
  const ticketsSold = shards.reduce((n, s) => n + s.ticketCount, 0n);
  const frozen = shards.length > 0 && shards.every((s) => s.state === SHARD_STATE.FROZEN);

  let state;
  if (frozen) {
    state = ROUND_STATE.FROZEN;
  } else if (nowEpoch < config.entryStart) {
    state = ROUND_STATE.PENDING;
  } else {
    // entry_start is INCLUSIVE: the shard script accepts an append whose
    // `since` equals entry_start, so the UI must not still say "pending" at
    // the exact epoch entry becomes legal.
    state = ROUND_STATE.OPEN;
  }

  // maximum_tickets 0 means uncapped. Subtracting from 0 would produce a
  // nonsense figure, so report that there is no cap rather than a wrong one.
  const ticketsRemaining = config.maximumTickets === 0n
    ? null
    : config.maximumTickets - ticketsSold;

  return Object.freeze({
    state,
    ticketsSold,
    ticketsRemaining,
    // A round below minimum_tickets does not draw. Inclusive at the boundary.
    viable: ticketsSold >= config.minimumTickets,
  });
}

// Every live cell whose TYPE script is the round-type script. Note: no
// script_len_range filter. It measures the SERIALIZED script length
// (32 + 1 + args) and is half-open, so a wrong bound silently returns zero
// cells with no error (2026-08-10). Filtering by code hash alone is correct
// and cannot fail closed.
async function findRounds(rpc, manifest) {
  const roundType = manifest.scripts["round-type"];
  const rounds = [];
  for await (const cell of rpc.getCells({
    script: { code_hash: roundType.codeHash, hash_type: roundType.hashType, args: "0x" },
    script_type: "type",
    script_search_mode: "prefix",
  })) {
    const data = unhex(cell.output_data ?? "0x");
    if (data.length !== ROUND_CONFIG_SIZE) continue; // not a round config cell
    rounds.push(Object.freeze({
      config: decodeRoundConfigV1(data),
      outPoint: cell.out_point,
    }));
  }
  return rounds;
}

// The shard cells belonging to one round, identified by the round id carried
// in their own data rather than by args, so a mis-shaped args layout cannot
// silently include a foreign shard.
async function findShards(rpc, manifest, roundId) {
  const shardType = manifest.scripts["entry-shard-type"];
  const shards = [];
  for await (const cell of rpc.getCells({
    script: { code_hash: shardType.codeHash, hash_type: shardType.hashType, args: "0x" },
    script_type: "type",
    script_search_mode: "prefix",
  })) {
    const data = unhex(cell.output_data ?? "0x");
    if (data.length !== SHARD_DATA_SIZE) continue;
    const shard = decodeEntryShardDataV1(data);
    if (shard.roundId !== roundId) continue;
    shards.push(Object.freeze({ ...shard, outPoint: cell.out_point }));
  }
  shards.sort((a, b) => a.shardId - b.shardId);
  return shards;
}

const api = { findRounds, findShards, deriveRoundState, ROUND_STATE };
if (typeof module !== "undefined" && module.exports) module.exports = api;
if (typeof window !== "undefined") window.DaowowDiscovery = api;
