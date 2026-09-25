"use strict";
// The aggregation ledger's wire formats, pinned field by field to the Rust
// oracle rather than to our own output. A round trip alone passes even if two
// offsets are swapped, so every field is asserted individually — that is how
// the entry codec's layout was pinned and it is the only check that catches an
// offset eight bytes out, because the neighbouring field still decodes to a
// plausible number.
const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const {
  decodeAggregationState, encodeAggregationState,
  decodeBatchCommitment, encodeBatchCommitment,
  batchId, AGGREGATION_STATE_SIZE, BATCH_RECEIPT_SIZE,
} = require("../chain/ledger-codec.js");
const { decodeRoundConfigV1 } = require("../chain/codec.js");

const V = JSON.parse(fs.readFileSync(path.join(
  __dirname, "..", "..", "..", "tests", "vectors", "daowow_core_vectors.json"), "utf8"));
const unhex = (s) => Uint8Array.from(s.match(/../g).map((b) => parseInt(b, 16)));
const hex = (b) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
const A = V.aggregation_state;

test("the sizes match the Rust constants", () => {
  assert.strictEqual(AGGREGATION_STATE_SIZE, 207);
  assert.strictEqual(BATCH_RECEIPT_SIZE, 73);
  assert.strictEqual(unhex(A.genesis.hex).length, AGGREGATION_STATE_SIZE);
  assert.strictEqual(unhex(V.batch_commitment.hex).length, BATCH_RECEIPT_SIZE);
});

test("the genesis state round-trips the Rust oracle", () => {
  const decoded = decodeAggregationState(unhex(A.genesis.hex));
  assert.strictEqual(hex(encodeAggregationState(decoded)), A.genesis.hex);
});

test("the post-batch state round-trips the Rust oracle", () => {
  const decoded = decodeAggregationState(unhex(A.after_batch.hex));
  assert.strictEqual(hex(encodeAggregationState(decoded)), A.after_batch.hex);
});

test("every genesis field decodes to the value Rust reports", () => {
  const s = decodeAggregationState(unhex(A.genesis.hex));
  assert.strictEqual(s.version, 2);
  assert.strictEqual(s.acceptedEntries, 0n);
  assert.strictEqual(s.acceptedTickets, 0n);
  assert.strictEqual(s.acceptedPrincipal, 0n);
  assert.strictEqual(s.acceptedCapacity, 0n);
  assert.strictEqual(s.acceptedBatches, 0n);
  assert.strictEqual(s.closed, false);
  assert.strictEqual(s.configCommitment, A.config.commitment);
  // The embedded frozen shard, which ledger.rs:43 reads at bytes 1..33 to find
  // the round id before it has authenticated anything.
  assert.strictEqual(s.frozen.state, 1, "the embedded shard must be FROZEN");
  assert.strictEqual(s.frozen.entryCount, 2n);
  assert.strictEqual(s.frozen.ticketCount, 5n);
  assert.strictEqual(s.frozen.accumulatorRoot, A.frozen.fields.accumulator_root);
});

test("every post-batch counter decodes to the value Rust reports", () => {
  const s = decodeAggregationState(unhex(A.after_batch.hex));
  const f = A.after_batch.fields;
  assert.strictEqual(s.acceptedEntries, BigInt(f.accepted_entries));
  assert.strictEqual(s.acceptedTickets, BigInt(f.accepted_tickets));
  assert.strictEqual(s.acceptedBatches, BigInt(f.accepted_batches));
  assert.strictEqual(s.closed, f.closed);
  // Not in the emitted fields, so derived from the batch: the ledger's
  // accepted capacity must be the batch's summed input capacity.
  assert.strictEqual(s.acceptedCapacity, BigInt(V.batch_commitment.fields.input_capacity));
  assert.strictEqual(s.acceptedPrincipal, BigInt(V.batch_commitment.fields.principal));
  // batches_root moved off its genesis value, so the append actually happened.
  const genesis = decodeAggregationState(unhex(A.genesis.hex));
  assert.notStrictEqual(s.batchesRoot, genesis.batchesRoot);
});

test("the batch commitment round-trips and every field matches Rust", () => {
  const b = decodeBatchCommitment(unhex(V.batch_commitment.hex));
  assert.strictEqual(hex(encodeBatchCommitment(b)), V.batch_commitment.hex);
  const f = V.batch_commitment.fields;
  assert.strictEqual(b.version, 2);
  assert.strictEqual(b.digest, f.digest);
  assert.strictEqual(b.firstNonce, BigInt(f.first_nonce));
  assert.strictEqual(b.entryCount, BigInt(f.entry_count));
  assert.strictEqual(b.ticketCount, BigInt(f.ticket_count));
  assert.strictEqual(b.principal, BigInt(f.principal));
  assert.strictEqual(b.inputCapacity, BigInt(f.input_capacity));
});

test("input_capacity is the summed CELL capacity, not the principal", () => {
  // The distinction the DAO deposit depends on: its capacity must equal the
  // entry cells' full capacity, and paying only the principal is refused.
  const b = decodeBatchCommitment(unhex(V.batch_commitment.hex));
  const summed = A.entries.reduce((s, e) => s + BigInt(e.capacity), 0n);
  assert.strictEqual(b.inputCapacity, summed);
  assert.ok(b.inputCapacity > b.principal, "capacity exceeds principal by the cell overhead");
});

test("batchId packs the shard into the top byte", () => {
  for (const v of V.batch_id) {
    assert.strictEqual(batchId(v.shard_id, BigInt(v.ordinal)), BigInt(v.value));
  }
});

test("batchId refuses a shard beyond 256 and an ordinal beyond 2^56", () => {
  // Two guards, asserted on their own messages: a shared pattern would pass
  // for both and pin neither.
  assert.throws(() => batchId(256, 0n), /shard/);
  assert.throws(() => batchId(0, 1n << 56n), /ordinal/);
});

test("a wrong length and a wrong version are both refused", () => {
  assert.throws(() => decodeAggregationState(new Uint8Array(206)), /207/);
  const bad = unhex(A.genesis.hex); bad[0] = 3;
  assert.throws(() => decodeAggregationState(bad), /version/);
  assert.throws(() => decodeBatchCommitment(new Uint8Array(72)), /73/);
});

test("the config the vectors were generated against decodes and is MMR", () => {
  // Guards the fixture itself: if this config were SMT the proofs in the
  // witness vector would be the wrong shape and every later task would be
  // pinned to something the client never builds.
  const cfg = decodeRoundConfigV1(unhex(A.config.hex));
  assert.strictEqual(cfg.accumulatorId, 1, "ACC_MMR");
  assert.strictEqual(cfg.commitment, A.config.commitment);
});
