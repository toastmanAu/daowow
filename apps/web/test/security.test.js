"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const core = require("../core.js");

test("MMR membership binds the mountain to the claimed position", () => {
  const tree = new core.MmrHost();
  const leaves = Array.from({ length: 5 }, (_, i) => core.H(`leaf-${i}`));
  for (const leaf of leaves) tree.append(leaf);
  const proof = tree.membershipProof(0);
  assert.equal(core.mmrVerifyMembership(tree.root(), 5, 0, leaves[0], proof), true);
  assert.equal(core.mmrVerifyMembership(tree.root(), 5, 4, leaves[0], proof), false);
});

test("MMR rejects trailing bytes and invalid positions", () => {
  const tree = new core.MmrHost();
  const leaf = core.H("leaf");
  tree.append(leaf);
  const proof = tree.membershipProof(0);
  const extra = core.concat([proof, new Uint8Array([0])]);
  assert.equal(core.mmrVerifyMembership(tree.root(), 1, 0, leaf, extra), false);
  assert.equal(core.mmrVerifyMembership(tree.root(), 1, -1, leaf, proof), false);
});

test("peak counts do not truncate to signed 32-bit integers", () => {
  assert.equal(core.popcount(2 ** 32 + 1), 2);
  assert.equal(core.popcount(2 ** 31), 1);
  assert.throws(() => core.popcount(-1));
});

test("draw rejects unsupported integer inputs before hashing", () => {
  const seed = new Uint8Array(32);
  for (const n of [-1, NaN, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => core.drawPositions(seed, n, 0));
  }
  assert.throws(() => core.drawPositions(seed, 1, -1));
  assert.throws(() => core.drawPositions(seed, 5000, 4097));
});

test("rejection boundaries match the Rust security vectors", () => {
  const max = new Uint8Array(32).fill(255);
  assert.equal(core.candidateModN(max, 3).rejected, true);
  assert.deepEqual(core.candidateModN(max, 2), { mod: 1, rejected: false });
  assert.deepEqual(core.candidateModN(max, 1), { mod: 0, rejected: false });
});
