"use strict";
// Splitting the pool so far by the committed schedule, the way settlement
// will: floor each share, remainder to first place.
const { test } = require("node:test");
const assert = require("node:assert");
const { allocatePrizes, estimatePrizes, shareOf } = require("../dapp/model/prize-estimate.js");

const schedule = { version: 2, weights: [50n, 30n, 20n], thresholds: [1n, 5n, 10n] };

test("allocation floors each share and gives the remainder to first place", () => {
  assert.deepStrictEqual(allocatePrizes([3n, 7n], 3n), [1n, 2n]); // accounting.rs's own example
  assert.deepStrictEqual(allocatePrizes([50n, 30n, 20n], 101n), [51n, 30n, 20n]);
});

test("the allocation always sums to the pool", () => {
  for (const pool of [0n, 1n, 7n, 999n, 123456789n]) {
    const total = allocatePrizes([50n, 30n, 20n], pool).reduce((a, b) => a + b, 0n);
    assert.strictEqual(total, pool);
  }
});

test("empty or zero weights are refused", () => {
  assert.throws(() => allocatePrizes([], 10n));
  assert.throws(() => allocatePrizes([5n, 0n], 10n));
});

test("only the places open at this ticket count share the pool", () => {
  assert.deepStrictEqual(estimatePrizes({ schedule, tickets: 5n, poolSoFar: 800n }),
    { pool: 800n, prizes: [500n, 300n] });
  assert.deepStrictEqual(estimatePrizes({ schedule, tickets: 10n, poolSoFar: 1000n }),
    { pool: 1000n, prizes: [500n, 300n, 200n] });
});

test("before any deposit there is no estimate", () => {
  assert.strictEqual(estimatePrizes({ schedule, tickets: 10n, poolSoFar: null }), null);
});

test("with no place open there is no estimate", () => {
  assert.strictEqual(estimatePrizes({ schedule, tickets: 0n, poolSoFar: 100n }), null);
});

test("a place's share is its weight over the weights of the open places", () => {
  assert.deepStrictEqual(shareOf(schedule, 5n, 2), { weight: 30n, total: 80n });
  assert.deepStrictEqual(shareOf(schedule, 10n, 1), { weight: 50n, total: 100n });
  assert.strictEqual(shareOf(schedule, 5n, 3), null);
});
