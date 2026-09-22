"use strict";
// The append witness is what authorises an entry, so it is checked byte-for-
// byte against the Rust encoder. Both cases matter: a client's first entry
// hits an empty shard, whose old peak list is the single byte 0x00 rather
// than an absent field.
const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const { encodePeaks, encodeAppendWitnessMmr } = require("../chain/mmr-witness.js");
const core = require("../core.js");

const V = JSON.parse(fs.readFileSync(path.join(
  __dirname, "..", "..", "..", "tests", "vectors", "daowow_core_vectors.json"), "utf8"));
const W = V.mmr_witness;
const unhex = (s) => Uint8Array.from(s.match(/../g).map((b) => parseInt(b, 16)));
const hex = (b) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");

const entry = (nonce) => ({
  roundId: core.H("VECTOR-WITNESS-ROUND"),
  shardId: 0,
  participantLockHash: core.H("VECTOR-WITNESS-PARTICIPANT"),
  ticketCount: 1n,
  principal: 10000000000n,
  positionBase: BigInt(nonce),
  entryNonce: BigInt(nonce),
  entropyCommitment: core.H(Uint8Array.from([nonce])),
});

test("entry leaves match the Rust, which every peak derives from", () => {
  for (const nonce of [0, 1, 9, 10, 11]) {
    assert.strictEqual(
      hex(core.entryLeaf(entry(nonce))), W.entry_leaves[String(nonce)],
      `leaf ${nonce}`);
  }
});

test("an empty shard's peak list is the single byte 0x00", () => {
  assert.strictEqual(hex(encodePeaks([])), "00");
  assert.strictEqual(hex(encodePeaks([])), W.from_empty.old_peaks_hex);
});

test("appending to an empty shard reproduces the Rust witness", () => {
  const host = new core.MmrHost();
  const oldPeaks = encodePeaks(host.peaks);
  const entries = [entry(0), entry(1)];
  for (const e of entries) host.append(core.entryLeaf(e));
  const newPeaks = encodePeaks(host.peaks);

  assert.strictEqual(hex(oldPeaks), W.from_empty.old_peaks_hex, "old peaks");
  assert.strictEqual(hex(newPeaks), W.from_empty.new_peaks_hex, "new peaks");
  assert.strictEqual(hex(host.root()), W.from_empty.root_after, "root after");
  assert.strictEqual(
    hex(encodeAppendWitnessMmr(entries, oldPeaks, newPeaks)),
    W.from_empty.witness_hex);
});

test("appending to a shard that already holds an entry reproduces the Rust witness", () => {
  // The old peak list is non-empty here, so a client that always sent an
  // empty one cannot pass by luck.
  const host = new core.MmrHost();
  host.append(core.entryLeaf(entry(9)));
  assert.strictEqual(hex(host.root()), W.from_one_entry.root_before, "root before");
  const oldPeaks = encodePeaks(host.peaks);
  const entries = [entry(10), entry(11)];
  for (const e of entries) host.append(core.entryLeaf(e));
  const newPeaks = encodePeaks(host.peaks);

  assert.strictEqual(hex(oldPeaks), W.from_one_entry.old_peaks_hex, "old peaks");
  assert.strictEqual(hex(newPeaks), W.from_one_entry.new_peaks_hex, "new peaks");
  assert.strictEqual(hex(host.root()), W.from_one_entry.root_after, "root after");
  assert.strictEqual(
    hex(encodeAppendWitnessMmr(entries, oldPeaks, newPeaks)),
    W.from_one_entry.witness_hex);
});

test("the client's root is bag_peaks of the peaks it sends", () => {
  // The contract checks bag_peaks(new_peaks) == the successor's root, so the
  // two must be derived from the same peak list or the append is refused.
  const host = new core.MmrHost();
  for (const nonce of [0, 1, 9]) host.append(core.entryLeaf(entry(nonce)));
  assert.strictEqual(hex(host.root()), hex(core.MMR.bagPeaks(host.peaks)));
});

test("a malformed peak is refused rather than silently padded", () => {
  // Uint8Array.set would quietly write a short peak and leave the remaining
  // bytes zero, producing a witness the contract rejects with an opaque -33
  // rather than an error naming the cause.
  assert.throws(() => encodePeaks([new Uint8Array(31)]), /32 bytes/);
  assert.throws(() => encodePeaks([new Uint8Array(33)]), /32 bytes/);
  assert.throws(() => encodePeaks(["not bytes"]), /32 bytes/);
  assert.throws(() => encodePeaks(new Array(65).fill(new Uint8Array(32))), /64 peaks/);
});
