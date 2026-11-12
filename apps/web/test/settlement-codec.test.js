"use strict";
// SettlementFundingDataV3: the 160 bytes a batch's settlement cell carries,
// pinned field by field to the Rust oracle (encoding.rs).
const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const {
  decodeSettlementFunding, encodeSettlementFunding, advanceFunding,
  SETTLEMENT_FUNDING_SIZE, IMMUTABLE_FIELDS,
} = require("../chain/settlement-codec.js");

const V = JSON.parse(fs.readFileSync(path.join(
  __dirname, "..", "..", "..", "tests", "vectors", "daowow_core_vectors.json"), "utf8"));
const unhex = (s) => Uint8Array.from(s.match(/../g).map((b) => parseInt(b, 16)));
const hex = (b) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
const F = V.settlement_funding.fields;
const BYTES = unhex(V.settlement_funding.hex);
const decoded = () => decodeSettlementFunding(BYTES);

test("the vector is the size Rust declares", () => {
  assert.strictEqual(SETTLEMENT_FUNDING_SIZE, 160);
  assert.strictEqual(V.canonical_sizes.settlement_funding, 160);
  assert.strictEqual(BYTES.length, 160);
});

test("every field decodes to what Rust wrote", () => {
  const f = decoded();
  assert.strictEqual(f.roundId, F.round_id);
  assert.strictEqual(f.batchId, BigInt(F.batch_id));
  assert.strictEqual(f.realizedTotal, BigInt(F.realized_total));
  assert.strictEqual(f.principalLiability, BigInt(F.principal_liability));
  assert.strictEqual(f.prizePool, BigInt(F.prize_pool));
  assert.strictEqual(f.payoutCursor, BigInt(F.payout_cursor));
  assert.strictEqual(f.liabilityCount, BigInt(F.liability_count));
  assert.strictEqual(f.liabilitiesRoot, F.liabilities_root);
  assert.strictEqual(f.prizeCount, BigInt(F.prize_count));
  assert.strictEqual(f.prizeRoot, F.prize_root);
  assert.strictEqual(f.prizePaid, BigInt(F.prize_paid));
});

test("every field is distinct in the vector, so a neighbouring offset reads wrong", () => {
  const values = Object.values(F);
  assert.strictEqual(new Set(values).size, values.length);
});

test("encoding round-trips the Rust bytes", () => {
  assert.strictEqual(hex(encodeSettlementFunding(decoded())), V.settlement_funding.hex);
});

test("a wrong length is refused", () => {
  assert.throws(() => decodeSettlementFunding(BYTES.slice(0, 159)), /exactly 160 bytes/);
  assert.throws(() => decodeSettlementFunding(new Uint8Array(161)), /exactly 160 bytes/);
});

// The refusals of SettlementFundingDataV3::decode (encoding.rs:433), one each.
const withField = (change) => encodeSettlementFunding({ ...decoded(), ...change }, { unchecked: true });
test("a funding cell with no liabilities is refused", () => {
  assert.throws(() => decodeSettlementFunding(withField({ liabilityCount: 0n, payoutCursor: 0n })), /no liabilities/);
});
test("a cursor past the last liability is refused", () => {
  assert.throws(() => decodeSettlementFunding(withField({ payoutCursor: 8n })), /cursor/);
  assert.doesNotThrow(() => decodeSettlementFunding(withField({ payoutCursor: 7n })));
});
test("more prizes paid than the pool holds is refused", () => {
  assert.throws(() => decodeSettlementFunding(withField({ prizePaid: 2222223n })), /prize pool/);
  assert.doesNotThrow(() => decodeSettlementFunding(withField({ prizePaid: 2222222n })));
});
test("a prize count and a prize root must be both present or both absent", () => {
  assert.throws(() => decodeSettlementFunding(withField({ prizeCount: 0n, prizePaid: 0n })), /prize root/);
  assert.throws(() => decodeSettlementFunding(withField({ prizeRoot: "00".repeat(32) })), /prize root/);
  assert.doesNotThrow(() => decodeSettlementFunding(
    withField({ prizeCount: 0n, prizeRoot: "00".repeat(32), prizePaid: 0n })));
});
test("the encoder refuses what the decoder would refuse", () => {
  assert.throws(() => encodeSettlementFunding({ ...decoded(), payoutCursor: 8n }), /cursor/);
});

// settlement-type compares nine fields before and after and refuses any
// difference (main.rs: SETTLE_ERROR_ROUND_MISMATCH). Only two may move.
test("the immutable fields are exactly the nine the contract compares", () => {
  assert.deepStrictEqual([...IMMUTABLE_FIELDS].sort(), [
    "batchId", "liabilitiesRoot", "liabilityCount", "principalLiability", "prizeCount",
    "prizePool", "prizeRoot", "realizedTotal", "roundId",
  ]);
});

test("advancing moves the cursor and the prizes paid, and nothing else", () => {
  const before = decoded();
  const after = advanceFunding(before, { payoutCursor: 5n, prizePaid: 444445n });
  assert.strictEqual(after.payoutCursor, 5n);
  assert.strictEqual(after.prizePaid, 444445n);
  for (const field of IMMUTABLE_FIELDS) assert.strictEqual(after[field], before[field], field);
  assert.strictEqual(advanceFunding(before, { payoutCursor: 4n }).prizePaid, before.prizePaid);
});

test("advancing refuses to move an immutable field, or to go backwards", () => {
  const before = decoded();
  for (const field of IMMUTABLE_FIELDS) {
    assert.throws(() => advanceFunding(before, { [field]: before[field] }), /immutable/, field);
  }
  assert.throws(() => advanceFunding(before, { payoutCursor: 2n }), /backwards/);
  assert.throws(() => advanceFunding(before, { prizePaid: 444443n }), /backwards/);
  assert.throws(() => advanceFunding(before, { payoutCursor: 8n }), /cursor/);
});
