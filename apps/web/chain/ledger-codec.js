"use strict";
// Wrapped in an IIFE: loaded as a classic script these files share one
// global scope, so top-level declarations would collide between modules.
(function () {
// The aggregation ledger's wire formats.
//
// Byte layouts mirror crates/daowow-core/src/lifecycle.rs and are pinned field
// by field to Rust-generated vectors in ../test/ledger-codec.test.js. A length
// check alone would not catch an offset eight bytes out, because the
// neighbouring counter still decodes to a plausible number.
//
// u64 fields are BigInt. Shannon amounts exceed 2^53 and Number would round
// them silently — and these are the numbers the DAO deposit's capacity must
// equal exactly.

const codec = typeof require === "function" ? require("./codec.js") : window.DaowowCodec;

const AGGREGATION_STATE_SIZE = 207;   // lifecycle.rs:16
const BATCH_RECEIPT_SIZE = 73;        // lifecycle.rs:15
const MAX_BATCH_ENTRIES = 32;         // lifecycle.rs:14
const SHARD_DATA_SIZE = 101;

const hex = (b, o, n) =>
  Array.from(b.slice(o, o + n), (x) => x.toString(16).padStart(2, "0")).join("");
const unhex = (s) => {
  const body = s.startsWith("0x") ? s.slice(2) : s;
  return Uint8Array.from(body.match(/../g) ?? [], (b) => parseInt(b, 16));
};
const view = (b) => new DataView(b.buffer, b.byteOffset, b.byteLength);

/**
 * Disjoint u64 ids for the 256 shards and their batch ordinals
 * (lifecycle.rs:19). The shard occupies the top byte, so a batch id names one
 * ordinal of one shard and two shards can never collide.
 */
function batchId(shardId, ordinal) {
  const shard = BigInt(shardId);
  const ord = BigInt(ordinal);
  if (shard >= 256n) throw new Error(`shard id ${shard} must be below 256`);
  if (ord >= 1n << 56n) throw new Error(`batch ordinal ${ord} must be below 2^56`);
  return (shard << 56n) | ord;
}

// AggregationState, 207 bytes (lifecycle.rs:153):
//   0        u8 version = 2
//   1..102   the frozen EntryShardDataV1, 101 bytes
//   102..134 config commitment
//   134..174 five LE u64: entries, tickets, principal, capacity, batches
//   174..206 batches root
//   206      u8 closed
function decodeAggregationState(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.length !== AGGREGATION_STATE_SIZE) {
    throw new Error(`an aggregation state must be exactly ${AGGREGATION_STATE_SIZE} bytes`);
  }
  if (bytes[0] !== 2) {
    throw new Error(`aggregation state version ${bytes[0]} is not 2`);
  }
  if (bytes[206] > 1) {
    throw new Error(`the closed flag is ${bytes[206]}, which is neither 0 nor 1`);
  }
  const d = view(bytes);
  return Object.freeze({
    version: bytes[0],
    frozen: codec.decodeEntryShardDataV1(bytes.slice(1, 1 + SHARD_DATA_SIZE)),
    configCommitment: hex(bytes, 102, 32),
    acceptedEntries: d.getBigUint64(134, true),
    acceptedTickets: d.getBigUint64(142, true),
    acceptedPrincipal: d.getBigUint64(150, true),
    acceptedCapacity: d.getBigUint64(158, true),
    acceptedBatches: d.getBigUint64(166, true),
    batchesRoot: hex(bytes, 174, 32),
    closed: bytes[206] === 1,
  });
}

function encodeAggregationState(state) {
  const out = new Uint8Array(AGGREGATION_STATE_SIZE);
  const d = view(out);
  out[0] = 2;
  out.set(codec.encodeEntryShardDataV1(state.frozen), 1);
  out.set(unhex(state.configCommitment), 102);
  d.setBigUint64(134, BigInt(state.acceptedEntries), true);
  d.setBigUint64(142, BigInt(state.acceptedTickets), true);
  d.setBigUint64(150, BigInt(state.acceptedPrincipal), true);
  d.setBigUint64(158, BigInt(state.acceptedCapacity), true);
  d.setBigUint64(166, BigInt(state.acceptedBatches), true);
  out.set(unhex(state.batchesRoot), 174);
  out[206] = state.closed ? 1 : 0;
  return out;
}

// BatchCommitment, 73 bytes (lifecycle.rs:37). This is the RECEIPT cell's
// payload and the source of the digest that both the dao_lock args and the
// receipt args commit to.
function decodeBatchCommitment(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.length !== BATCH_RECEIPT_SIZE) {
    throw new Error(`a batch commitment must be exactly ${BATCH_RECEIPT_SIZE} bytes`);
  }
  if (bytes[0] !== 2) {
    throw new Error(`batch commitment version ${bytes[0]} is not 2`);
  }
  const d = view(bytes);
  return Object.freeze({
    version: bytes[0],
    digest: hex(bytes, 1, 32),
    firstNonce: d.getBigUint64(33, true),
    entryCount: d.getBigUint64(41, true),
    ticketCount: d.getBigUint64(49, true),
    principal: d.getBigUint64(57, true),
    // The summed CELL capacity of the batch's entry inputs, NOT their
    // principal. The DAO deposit's capacity must equal this exactly.
    inputCapacity: d.getBigUint64(65, true),
  });
}

function encodeBatchCommitment(batch) {
  const out = new Uint8Array(BATCH_RECEIPT_SIZE);
  const d = view(out);
  out[0] = 2;
  out.set(unhex(batch.digest), 1);
  d.setBigUint64(33, BigInt(batch.firstNonce), true);
  d.setBigUint64(41, BigInt(batch.entryCount), true);
  d.setBigUint64(49, BigInt(batch.ticketCount), true);
  d.setBigUint64(57, BigInt(batch.principal), true);
  d.setBigUint64(65, BigInt(batch.inputCapacity), true);
  return out;
}

const api = {
  decodeAggregationState, encodeAggregationState,
  decodeBatchCommitment, encodeBatchCommitment,
  batchId,
  AGGREGATION_STATE_SIZE, BATCH_RECEIPT_SIZE, MAX_BATCH_ENTRIES,
};
if (typeof module !== "undefined" && module.exports) module.exports = api;
if (typeof window !== "undefined") window.DaowowLedgerCodec = api;
})();
