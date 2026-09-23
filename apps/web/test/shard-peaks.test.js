"use strict";
// The peaks are the one piece of accumulator state the chain does NOT store.
// A shard cell commits to its root only, so a client appending to a shard that
// already holds entries must obtain the peak list some other way. These tests
// pin where it comes from and, more importantly, that a wrong list is refused
// locally rather than at broadcast as an opaque -33.
const { test } = require("node:test");
const assert = require("node:assert");
const { readShardPeaks, decodePeaks } = require("../chain/shard-peaks.js");
const { encodePeaks, encodeAppendWitnessMmr } = require("../chain/mmr-witness.js");
const core = require("../core.js");

const hex = (b) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
const entry = (nonce) => ({
  roundId: new Uint8Array(32).fill(1),
  shardId: 0,
  participantLockHash: new Uint8Array(32).fill(2),
  ticketCount: 1n,
  principal: 1000n,
  positionBase: BigInt(nonce),
  entryNonce: BigInt(nonce),
  entropyCommitment: new Uint8Array(32),
});

// Replay n entries the way the shard did, returning the state a client must
// reconstruct.
function afterAppends(n) {
  const host = new core.MmrHost();
  for (let i = 0; i < n; i++) host.append(core.entryLeaf(entry(i)));
  return host;
}

// A node serving the transaction that last moved the shard head.
const rpcServing = (witnessHex) => ({
  call: async (method, params) => {
    assert.strictEqual(method, "get_transaction");
    return { transaction: { witnesses: [witnessHex] } };
  },
});

test("an empty shard needs no witness at all", async () => {
  // The creating transaction's witness is the round's schedule, not an append
  // witness. Reading it as one would misparse it; entry_count 0 says not to.
  let called = false;
  const rpc = { call: async () => { called = true; } };
  const peaks = await readShardPeaks(rpc, {
    entryCount: 0n, accumulatorRoot: hex(core.MMR.bagPeaks([])),
    outPoint: { txHash: "0x" + "00".repeat(32), index: 0 },
  });
  assert.deepStrictEqual(peaks, []);
  assert.strictEqual(called, false, "no RPC call for a shard with no entries");
});

test("the peaks come from the append witness that last moved the shard", async () => {
  const before = afterAppends(2);
  const after = afterAppends(3);
  const witness = "0x" + hex(encodeAppendWitnessMmr(
    [entry(2)], encodePeaks(before.peaks), encodePeaks(after.peaks)));
  const peaks = await readShardPeaks(rpcServing(witness), {
    entryCount: 3n, accumulatorRoot: hex(after.root()),
    outPoint: { txHash: "0x" + "ab".repeat(32), index: 0 },
  });
  assert.deepStrictEqual(peaks, after.peaks.map(hex));
});

test("peaks that do not bag to the shard's committed root are refused", async () => {
  // The whole reason reading the node's copy is safe: a served witness that
  // disagrees with the cell cannot pass this check, so a lying or stale node
  // is caught here rather than by the contract.
  const after = afterAppends(3);
  // The RIGHT NUMBER of peaks, so the count guard cannot refuse it first and
  // report the correct conclusion for the wrong reason — only the bag check
  // can say no here.
  const tampered = after.peaks.map((p, i) => {
    const copy = Uint8Array.from(p);
    if (i === 0) copy[0] ^= 0xff;
    return copy;
  });
  const witness = "0x" + hex(encodeAppendWitnessMmr(
    [entry(2)], encodePeaks(afterAppends(2).peaks), encodePeaks(tampered)));
  await assert.rejects(() => readShardPeaks(rpcServing(witness), {
    entryCount: 3n, accumulatorRoot: hex(after.root()),
    outPoint: { txHash: "0x" + "ab".repeat(32), index: 0 },
  }), /committed accumulator root/);
});

test("a peak count disagreeing with the entry count is refused", async () => {
  // entry_count.count_ones() is the contract's own rule. Catching it here
  // names the problem; the contract would only say -33.
  const after = afterAppends(3);      // 3 entries -> 2 peaks
  const witness = "0x" + hex(encodeAppendWitnessMmr(
    [entry(3)], encodePeaks(after.peaks), encodePeaks(after.peaks)));
  await assert.rejects(() => readShardPeaks(rpcServing(witness), {
    entryCount: 4n, accumulatorRoot: hex(after.root()),   // 4 entries -> 1 peak
    outPoint: { txHash: "0x" + "ab".repeat(32), index: 0 },
  }), /peak/);
});

test("decodePeaks refuses a truncated list rather than returning a short one", async () => {
  // A short read here would produce a peak list that bags to something, just
  // not the right thing — a wrong answer instead of an error.
  assert.throws(() => decodePeaks(new Uint8Array([2, ...new Array(40).fill(0)])),
    /truncated/);
});

test("a transaction serving no witness is an error, not empty peaks", async () => {
  const rpc = { call: async () => ({ transaction: { witnesses: [] } }) };
  await assert.rejects(() => readShardPeaks(rpc, {
    entryCount: 1n, accumulatorRoot: "00".repeat(32),
    outPoint: { txHash: "0x" + "ab".repeat(32), index: 0 },
  }), /witness/);
});
