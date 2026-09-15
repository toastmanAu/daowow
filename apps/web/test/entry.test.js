"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { selection, formatCkb } = require("../entry-model.js");

test("preview calculates ticket principal in exact shannons, not a transaction total", () => {
  assert.deepEqual(selection("5"), { tickets: 5, principal: 50000000000n, total: null, canSubmit: false });
  assert.equal(selection("100").principal, 1000000000000n);
});
test("rejects blank, fractional, signed, exponent, unsafe and out-of-range quantities", () => {
  for (const value of ["", "0", "101", "-1", "1.5", "1e1", "+1", " 2", "NaN", "9007199254740993", "<script>"]) {
    assert.throws(() => selection(value), /whole number from 1 to 100/);
  }
});
test("CKB formatting preserves precision including sub-CKB amounts", () => {
  assert.equal(formatCkb(1000000000000n), "10,000");
  assert.equal(formatCkb(100000001n), "1.00000001");
  assert.equal(formatCkb(70133609n), "0.70133609");
});
