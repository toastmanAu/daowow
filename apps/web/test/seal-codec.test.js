"use strict";
// The seal and the entropy record, pinned field by field to the Rust oracle.
//
// One cell evolves through three shapes under one type script and one set of
// args: ledger (207 bytes) -> seal (212) -> entropy record (349). The record
// carries TWO version bytes — its own 4, then the seal's 3 — which an earlier
// draft of the spec missed, predicting 348. The vector caught it; these tests
// keep it caught.
const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const {
  decodeRoundSeal, encodeRoundSeal, decodeEntropyRecord, encodeEntropyRecord,
  sealSize, recordSize, SEAL_VERSION, RECORD_VERSION,
} = require("../chain/seal-codec.js");

const V = JSON.parse(fs.readFileSync(path.join(
  __dirname, "..", "..", "..", "tests", "vectors", "daowow_core_vectors.json"), "utf8"));
const unhex = (s) => Uint8Array.from(s.match(/../g).map((b) => parseInt(b, 16)));
const hex = (b) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");

test("the sizes follow the shard count", () => {
  assert.strictEqual(sealSize(1), 212);
  assert.strictEqual(recordSize(1), 349, "TWO version bytes: the record's 4, then the seal's 3");
  assert.strictEqual(sealSize(2), 5 + 2 * 207);
  assert.strictEqual(recordSize(2), 1 + sealSize(2) + 136);
});

test("the vectors are the sizes these functions claim", () => {
  assert.strictEqual(unhex(V.round_seal.hex).length, sealSize(1));
  assert.strictEqual(unhex(V.entropy_record.hex).length, recordSize(1));
});

test("the seal round-trips the Rust oracle", () => {
  const seal = decodeRoundSeal(unhex(V.round_seal.hex), 1);
  assert.strictEqual(hex(encodeRoundSeal(seal)), V.round_seal.hex);
});

test("the seal's fields decode to what Rust wrote", () => {
  const seal = decodeRoundSeal(unhex(V.round_seal.hex), 1);
  assert.strictEqual(seal.version, SEAL_VERSION);
  assert.strictEqual(seal.ledgers.length, 1);
  // The embedded ledger is the one Rust sealed, and it is CLOSED: RoundSeal
  // refuses any ledger that is not.
  assert.strictEqual(seal.ledgers[0].closed, true);
  assert.strictEqual(seal.ledgers[0].frozen.entryCount, 2n);
  assert.strictEqual(seal.ledgers[0].acceptedEntries, 2n);
});

test("the record round-trips the Rust oracle", () => {
  const r = decodeEntropyRecord(unhex(V.entropy_record.hex), 1);
  assert.strictEqual(hex(encodeEntropyRecord(r)), V.entropy_record.hex);
});

test("every record field decodes to what Rust wrote", () => {
  const r = decodeEntropyRecord(unhex(V.entropy_record.hex), 1);
  const o = V.entropy_record;
  assert.strictEqual(r.version, RECORD_VERSION);
  assert.strictEqual(r.inclusionHeight, BigInt(o.inclusion_height));
  assert.strictEqual(r.inclusionHash, o.inclusion_hash);
  assert.deepStrictEqual(r.entropyHashes, o.entropy_hashes);
  // The embedded seal is the same seal, byte for byte.
  assert.strictEqual(hex(encodeRoundSeal(r.seal)), V.round_seal.hex);
});

test("the record's second byte is the seal's own version", () => {
  // Pinned on its own because it is the byte the spec forgot.
  const bytes = unhex(V.entropy_record.hex);
  assert.strictEqual(bytes[0], RECORD_VERSION);
  assert.strictEqual(bytes[1], SEAL_VERSION);
});

// --- refusals, each on its OWN message ------------------------------------
// A shared /seal/i would pass for all of these and pin none of them.

test("a seal of the wrong length is refused", () => {
  assert.throws(() => decodeRoundSeal(new Uint8Array(211), 1), /212 bytes/);
});

test("a seal with the wrong version byte is refused", () => {
  const b = unhex(V.round_seal.hex); b[0] = 4;
  assert.throws(() => decodeRoundSeal(b, 1), /seal version/);
});

test("a seal whose declared shard count disagrees is refused", () => {
  // seal.rs:116 compares data[1..5] against the config's shard count.
  const b = unhex(V.round_seal.hex); b[1] = 2;
  assert.throws(() => decodeRoundSeal(b, 1), /declares 2 shard/);
});

test("a record of the wrong length is refused", () => {
  // 348 specifically: the length the spec originally predicted.
  assert.throws(() => decodeEntropyRecord(new Uint8Array(348), 1), /349 bytes/);
});

test("a record with the wrong version byte is refused", () => {
  const b = unhex(V.entropy_record.hex); b[0] = 3;
  assert.throws(() => decodeEntropyRecord(b, 1), /record version/);
});

test("an inclusion height above 2^53 survives the round trip", () => {
  // Number would round this silently. The vector's heights include one past
  // 2^53 for exactly this reason.
  const r = decodeEntropyRecord(unhex(V.entropy_record.hex), 1);
  const big = { ...r, inclusionHeight: 9007199254740993n };
  const back = decodeEntropyRecord(encodeEntropyRecord(big), 1);
  assert.strictEqual(back.inclusionHeight, 9007199254740993n);
});
