"use strict";
// Chain time in words a person uses. Every figure is an estimate, because an
// epoch only TARGETS four hours, so every sentence must say "about".
const { test } = require("node:test");
const assert = require("node:assert");
const {
  EPOCH_MS, parseEpoch, msUntilEpoch, msUntilBlock, describeDuration, describeDate,
} = require("../dapp/model/time.js");

test("parseEpoch splits the packed field", () => {
  const f = "0x" + ((1800n << 40n) | (450n << 24n) | 14163n).toString(16);
  assert.deepStrictEqual(parseEpoch(f), { number: 14163n, index: 450n, length: 1800n });
});

test("a quarter of the way through an epoch, the next one is three hours off", () => {
  assert.strictEqual(msUntilEpoch(14164n, { number: 14163n, index: 450n, length: 1800n }), 10800000n);
});

test("a whole epoch is four hours", () => {
  assert.strictEqual(EPOCH_MS, 14400000n);
  assert.strictEqual(msUntilEpoch(14165n, { number: 14163n, index: 0n, length: 1800n }), 28800000n);
});

test("a target already reached is zero, never negative", () => {
  assert.strictEqual(msUntilEpoch(14000n, { number: 14163n, index: 0n, length: 1800n }), 0n);
  assert.strictEqual(msUntilEpoch(14163n, { number: 14163n, index: 900n, length: 1800n }), 0n);
  assert.strictEqual(msUntilBlock(10n, 500n), 0n);
});

test("a zero-length epoch field does not divide by zero", () => {
  assert.strictEqual(msUntilEpoch(2n, { number: 1n, index: 0n, length: 0n }), 14400000n);
});

test("every duration says 'about'", () => {
  assert.strictEqual(describeDuration(30000n), "about a minute");
  assert.strictEqual(describeDuration(45n * 60000n), "about 45 min");
  assert.strictEqual(describeDuration(18n * 3600000n), "about 18 h");
  assert.strictEqual(describeDuration(30n * 86400000n), "about 30 days");
});

test("durations round to the nearest unit, and the units change at 90 minutes and 48 hours", () => {
  assert.strictEqual(describeDuration(89n * 60000n), "about 89 min");
  assert.strictEqual(describeDuration(90n * 60000n), "about 2 h");
  assert.strictEqual(describeDuration(47n * 3600000n), "about 47 h");
  assert.strictEqual(describeDuration(48n * 3600000n), "about 2 days");
});

test("256 blocks is about 43 minutes", () => {
  assert.strictEqual(describeDuration(msUntilBlock(1256n, 1000n)), "about 43 min");
});

test("a date is approximate and names the day and month", () => {
  const now = Date.UTC(2026, 10, 10, 2, 0, 0);
  assert.strictEqual(describeDate(32n * 86400000n, now, "en-AU", "UTC"), "around 12 Dec");
});

const time = require("../dapp/model/time.js");

test("a moment is said as a day and a time of day, in the zone asked for", () => {
  const ms = BigInt(Date.UTC(2026, 10, 16, 1, 10));
  const utc = time.formatMoment(ms, "en-AU", "UTC");
  assert.match(utc, /16 Nov/);
  assert.match(utc, /1:10/);
  const adelaide = time.formatMoment(ms, "en-AU", "Australia/Adelaide");
  assert.match(adelaide, /16 Nov/);
  assert.match(adelaide, /11:40/);
});

test("the time until a period that has started is zero, never a past date", () => {
  assert.strictEqual(time.msUntilEpoch(1000n, { number: 1005n, index: 0n, length: 1800n }), 0n);
});

test("a moment that is not a real date is said as nothing, and never throws", () => {
  assert.strictEqual(time.formatMoment(0xffffffffffffffffn, "en-AU", "UTC"), "");
});
