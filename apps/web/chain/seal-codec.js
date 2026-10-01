"use strict";
// Wrapped in an IIFE: loaded as a classic script these files share one
// global scope, so top-level declarations would collide between modules.
(function () {
// The seal and the entropy record.
//
// One cell evolves through three shapes under one type script and one set of
// args, told apart by length and first byte exactly as the contract's own
// dispatch does it:
//
//   ledger   207 bytes   version 2   AggregationState
//   seal     212 bytes   version 3   u8 3 | u32 LE shard count | ledgers
//   record   349 bytes   version 4   u8 4 | SEAL | u64 height | hash | 3 hashes
//
// The record holds TWO version bytes — its own 4, then the seal's 3 — because
// it embeds the seal whole. An earlier draft of the gate 3b spec predicted 348
// by counting one; the Rust vector caught it before any code depended on it.
//
// Layouts mirror crates/daowow-core/src/seal.rs and are pinned field by field
// to Rust-generated vectors in ../test/seal-codec.test.js.

// Resolved LAZILY rather than destructured at load. discovery.js once
// destructured a sibling at load time, threw inside its IIFE, never published
// itself, and took out entry.html with an error that named neither file.
const ledgerCodec = () =>
  typeof require === "function" ? require("./ledger-codec.js") : window.DaowowLedgerCodec;

const SEAL_VERSION = 3;
const RECORD_VERSION = 4;
const LEDGER_SIZE = 207;          // AGGREGATION_STATE_SIZE
const RECORD_TAIL = 8 + 32 + 3 * 32;   // height, inclusion hash, three hashes

const hexOf = (b, o, n) =>
  Array.from(b.slice(o, o + n), (x) => x.toString(16).padStart(2, "0")).join("");
const unhex = (s) => {
  const body = s.startsWith("0x") ? s.slice(2) : s;
  return Uint8Array.from(body.match(/../g) ?? [], (b) => parseInt(b, 16));
};

/** 5 + 207 per shard (seal.rs:104). */
function sealSize(shardCount) {
  return 5 + Number(shardCount) * LEDGER_SIZE;
}

/** The record's own version byte, the whole seal, then 136 bytes (seal.rs:37). */
function recordSize(shardCount) {
  return 1 + sealSize(shardCount) + RECORD_TAIL;
}

function decodeRoundSeal(bytes, shardCount) {
  const want = sealSize(shardCount);
  if (!(bytes instanceof Uint8Array) || bytes.length !== want) {
    throw new Error(
      `a round seal for ${shardCount} shard(s) must be exactly ${want} bytes; ` +
      `got ${bytes?.length}`,
    );
  }
  if (bytes[0] !== SEAL_VERSION) {
    throw new Error(`seal version ${bytes[0]} is not ${SEAL_VERSION}`);
  }
  // seal.rs:116 compares the declared count against the config, so a seal
  // naming a different number of shards is refused rather than misread.
  const declared = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    .getUint32(1, true);
  if (declared !== Number(shardCount)) {
    throw new Error(
      `this seal declares ${declared} shard(s) but the round has ${shardCount}`,
    );
  }
  const ledgers = [];
  for (let i = 0; i < declared; i++) {
    const at = 5 + i * LEDGER_SIZE;
    ledgers.push(ledgerCodec().decodeAggregationState(bytes.slice(at, at + LEDGER_SIZE)));
  }
  return Object.freeze({ version: SEAL_VERSION, ledgers });
}

function encodeRoundSeal(seal) {
  const n = seal.ledgers.length;
  const out = new Uint8Array(sealSize(n));
  out[0] = SEAL_VERSION;
  new DataView(out.buffer).setUint32(1, n, true);
  seal.ledgers.forEach((ledger, i) => {
    out.set(ledgerCodec().encodeAggregationState(ledger), 5 + i * LEDGER_SIZE);
  });
  return out;
}

function decodeEntropyRecord(bytes, shardCount) {
  const want = recordSize(shardCount);
  if (!(bytes instanceof Uint8Array) || bytes.length !== want) {
    throw new Error(
      `an entropy record for ${shardCount} shard(s) must be exactly ${want} bytes; ` +
      `got ${bytes?.length}`,
    );
  }
  if (bytes[0] !== RECORD_VERSION) {
    throw new Error(`record version ${bytes[0]} is not ${RECORD_VERSION}`);
  }
  const sealLen = sealSize(shardCount);
  const seal = decodeRoundSeal(bytes.slice(1, 1 + sealLen), shardCount);
  const at = 1 + sealLen;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return Object.freeze({
    version: RECORD_VERSION,
    seal,
    // u64, kept BigInt: a height past 2^53 would round silently as a Number.
    inclusionHeight: view.getBigUint64(at, true),
    inclusionHash: hexOf(bytes, at + 8, 32),
    entropyHashes: [0, 1, 2].map((i) => hexOf(bytes, at + 40 + i * 32, 32)),
  });
}

function encodeEntropyRecord(record) {
  const sealBytes = encodeRoundSeal(record.seal);
  const out = new Uint8Array(1 + sealBytes.length + RECORD_TAIL);
  out[0] = RECORD_VERSION;
  out.set(sealBytes, 1);
  const at = 1 + sealBytes.length;
  new DataView(out.buffer).setBigUint64(at, BigInt(record.inclusionHeight), true);
  out.set(unhex(record.inclusionHash), at + 8);
  record.entropyHashes.forEach((h, i) => out.set(unhex(h), at + 40 + i * 32));
  return out;
}

const api = {
  decodeRoundSeal, encodeRoundSeal, decodeEntropyRecord, encodeEntropyRecord,
  sealSize, recordSize, SEAL_VERSION, RECORD_VERSION,
};
if (typeof module !== "undefined" && module.exports) module.exports = api;
if (typeof window !== "undefined") window.DaowowSealCodec = api;
})();
