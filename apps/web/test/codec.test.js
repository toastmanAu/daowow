"use strict";
// The decoders are pinned field by field to Rust-generated vectors. A length
// check alone would not catch an offset that is four bytes out, because the
// neighbouring field still decodes to a plausible number.
const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const { decodeRoundConfigV1, decodeEntryShardDataV1 } = require("../chain/codec.js");

const V = JSON.parse(fs.readFileSync(path.join(
  __dirname, "..", "..", "..", "tests", "vectors", "daowow_core_vectors.json"), "utf8"));
const unhex = (s) => Uint8Array.from(s.match(/../g).map((b) => parseInt(b, 16)));

test("decodeRoundConfigV1 reproduces every field of the Rust oracle", () => {
  const o = V.cell_encodings.round_config;
  const got = decodeRoundConfigV1(unhex(o.hex));
  const f = o.fields;
  assert.strictEqual(got.version, f.version, "version");
  assert.strictEqual(got.roundId, f.round_id, "roundId");
  assert.strictEqual(got.ticketPrice, BigInt(f.ticket_price), "ticketPrice");
  assert.strictEqual(got.minimumTickets, BigInt(f.minimum_tickets), "minimumTickets");
  assert.strictEqual(got.maximumTickets, BigInt(f.maximum_tickets), "maximumTickets");
  assert.strictEqual(got.entryStart, BigInt(f.entry_start), "entryStart");
  assert.strictEqual(got.entryEnd, BigInt(f.entry_end), "entryEnd");
  assert.strictEqual(got.aggregationDeadline, BigInt(f.aggregation_deadline), "aggregationDeadline");
  assert.strictEqual(got.daoTermPeriods, f.dao_term_periods, "daoTermPeriods");
  assert.strictEqual(got.entryShardCount, f.entry_shard_count, "entryShardCount");
  assert.strictEqual(got.prizeScheduleHash, f.prize_schedule_hash, "prizeScheduleHash");
  assert.strictEqual(got.feePolicyHash, f.fee_policy_hash, "feePolicyHash");
  assert.strictEqual(got.keeperPolicyHash, f.keeper_policy_hash, "keeperPolicyHash");
  assert.strictEqual(got.flags, f.flags, "flags");
  assert.strictEqual(got.accumulatorId, f.accumulator_id, "accumulatorId");
  const refs = {
    entryLock: "entry_lock", daoLock: "dao_lock", settlementType: "settlement_type",
    entryShardType: "entry_shard_type", daoType: "dao_type",
  };
  for (const [camel, snake] of Object.entries(refs)) {
    assert.strictEqual(got[camel].codeHash, f[snake].code_hash, `${snake} code hash`);
    assert.strictEqual(got[camel].hashType, f[snake].hash_type, `${snake} hash type`);
  }
});

test("decodeEntryShardDataV1 reproduces every field of the Rust oracle", () => {
  const o = V.cell_encodings.shard_data;
  const got = decodeEntryShardDataV1(unhex(o.hex));
  const f = o.fields;
  assert.strictEqual(got.roundId, f.round_id, "roundId");
  assert.strictEqual(got.shardId, f.shard_id, "shardId");
  assert.strictEqual(got.state, f.state, "state");
  assert.strictEqual(got.sequence, BigInt(f.sequence), "sequence");
  assert.strictEqual(got.entryCount, BigInt(f.entry_count), "entryCount");
  assert.strictEqual(got.ticketCount, BigInt(f.ticket_count), "ticketCount");
  assert.strictEqual(got.principalTotal, BigInt(f.principal_total), "principalTotal");
  assert.strictEqual(got.accumulatorRoot, f.accumulator_root, "accumulatorRoot");
});

test("a wrong-length cell is refused, never best-effort decoded", () => {
  // A short read that silently succeeds would report a wrong round rather
  // than no round, which is the failure mode hardest to notice.
  const o = V.cell_encodings.round_config;
  assert.throws(() => decodeRoundConfigV1(unhex(o.hex).slice(0, 357)), /358/);
  assert.throws(() => decodeEntryShardDataV1(new Uint8Array(100)), /101/);
});
