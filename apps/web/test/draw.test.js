"use strict";
// The draw, pinned to ComputedDraw (computed_draw.rs:44).
//
// A CLIENT capability, not a transaction: nothing writes winners to a cell, so
// this port is the only way the dApp can say who won, and the Rust vector is
// the only thing it can be checked against.
//
// Note the seed: H("DAOWOW_AUTHENTICATED_DRAW_V1" || commitment || record
// bytes). core.js also carries an OLDER drawSeed over "DAOWOW_DRAW_SEED_V1"
// from the participant-reveal design; using that here would produce a
// confident, well-formed, wrong answer.
const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const { computeDraw, describeDraw, minViablePool, MAX_POOL_BAR } =
  require("../chain/draw.js");
const { decodeRoundConfigV1 } = require("../chain/codec.js");
const { decodeSchedule } = require("../chain/schedule.js");
const { decodeEntropyRecord } = require("../chain/seal-codec.js");

const V = JSON.parse(fs.readFileSync(path.join(
  __dirname, "..", "..", "..", "tests", "vectors", "daowow_core_vectors.json"), "utf8"));
const unhex = (s) => Uint8Array.from(s.match(/../g).map((b) => parseInt(b, 16)));

const load = (v) => {
  const config = decodeRoundConfigV1(unhex(v.config));
  return {
    config,
    schedule: decodeSchedule(unhex(v.schedule)),
    record: decodeEntropyRecord(unhex(v.record), config.entryShardCount),
  };
};
const VIABLE = load(V.computed_draw);
const FAILED = load(V.computed_draw_failed);

test("the seed is the AUTHENTICATED derivation Rust uses", () => {
  assert.strictEqual(computeDraw(VIABLE).seed, V.computed_draw.seed);
  assert.strictEqual(computeDraw(FAILED).seed, V.computed_draw_failed.seed,
    "a failed round still HAS a seed; it simply draws nothing");
});

test("the winning positions match Rust exactly, prize by prize", () => {
  const d = computeDraw(VIABLE);
  assert.deepStrictEqual(
    d.positions.map((p) => [String(p.prizeIndex), String(p.position)]),
    V.computed_draw.positions);
});

test("total tickets is the ACCEPTED count from the sealed ledgers", () => {
  // Not the frozen count: an unaggregated suffix takes no part in the draw.
  assert.strictEqual(computeDraw(VIABLE).tickets, BigInt(V.computed_draw.total_tickets));
});

test("an unaggregated suffix takes no part: the draw counts ACCEPTED tickets", () => {
  // A ledger closed at the aggregation deadline with entries never batched:
  // the frozen shard counts them, the ledger did not accept them. In the
  // vector every entry was accepted, so frozen and accepted are both 10 and a
  // port reading the wrong one passed every other test here — this case is
  // what makes the difference visible.
  const ledger = VIABLE.record.seal.ledgers[0];
  const withSuffix = {
    ...ledger,
    frozen: { ...ledger.frozen, ticketCount: 15n, entryCount: 3n },
  };
  const record = { ...VIABLE.record, seal: { ...VIABLE.record.seal, ledgers: [withSuffix] } };
  const d = computeDraw({ ...VIABLE, record });
  assert.strictEqual(d.tickets, 10n, "5 frozen-but-unaccepted tickets must not be drawable");
  for (const p of d.positions) assert.ok(BigInt(p.position) < 10n);
});

test("ten tickets under the demo schedule open exactly two places", () => {
  const d = computeDraw(VIABLE);
  assert.strictEqual(d.places, 2);
  assert.strictEqual(d.viable, true);
});

test("a round below its minimum draws nothing", () => {
  const d = computeDraw(FAILED);
  assert.strictEqual(d.viable, false);
  assert.deepStrictEqual(d.positions, []);
  assert.strictEqual(V.computed_draw_failed.success, false);
});

test("minViablePool matches Rust: ceil(sum of open weights / smallest)", () => {
  // [40, 25] at ten tickets: 65 / 25, rounded up, is 3.
  assert.strictEqual(minViablePool(VIABLE.schedule, 10n),
    BigInt(V.computed_draw.min_viable_pool));
  assert.strictEqual(MAX_POOL_BAR, 1000000n);
});

test("a schedule the config does not commit to is refused", () => {
  // ComputedDraw refuses it; drawing under the wrong table would name the
  // wrong winners with total confidence.
  const forged = { ...VIABLE, config: { ...VIABLE.config, prizeScheduleHash: "00".repeat(32) } };
  assert.throws(() => computeDraw(forged), /schedule/);
});

test("a record sealed against a different config is refused", () => {
  const other = { ...VIABLE, config: { ...VIABLE.config, commitment: "99".repeat(32) } };
  assert.throws(() => computeDraw(other), /different round|bound/);
});

test("positions are distinct and inside the ticket range", () => {
  const d = computeDraw(VIABLE);
  const seen = new Set(d.positions.map((p) => p.position));
  assert.strictEqual(seen.size, d.positions.length);
  for (const p of d.positions) assert.ok(BigInt(p.position) < d.tickets);
});

// --- the wording: gate 2's D7 honesty constraints, as executable tests -----
// Scoped to the SENTENCES a person reads — summary and method — not to the
// object's field names or ticket numbers. A first version scanned the whole
// JSON: it flagged the field name "winners" on a round with no winners, and
// it never reached the word check at all on a viable round because
// JSON.stringify throws on BigInt. Neither failure said anything about the
// wording.
const prose = (text) => `${text.summary} ${text.method}`.toLowerCase();

test("a viable draw names its winners and says how the seed was made", () => {
  const text = describeDraw(computeDraw(VIABLE));
  assert.match(text.summary, /2 places/);
  assert.match(text.method, /block hash/i);
  assert.strictEqual(text.winners.length, 2);
});

test("a failed round says it did not draw, and never implies anyone won", () => {
  const text = describeDraw(computeDraw(FAILED));
  assert.match(text.summary, /did not reach|no prizes/i);
  assert.doesNotMatch(prose(text), /\bwon\b|winner/i);
  assert.deepStrictEqual(text.winners, []);
});

test("the description never overclaims", () => {
  // This is the moment a reader decides whether to trust the draw. The seed is
  // four block hashes fixed in advance: not a VRF, not "provably" anything.
  for (const d of [computeDraw(VIABLE), computeDraw(FAILED)]) {
    const text = prose(describeDraw(d));
    for (const forbidden of ["provably fair", "truly random", "verifiably random",
                             "unpredictable", "vrf", "guaranteed", "tamper-proof"]) {
      assert.ok(!text.includes(forbidden), `must not say "${forbidden}"`);
    }
  }
});
