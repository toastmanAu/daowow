"use strict";
// Wrapped in an IIFE: loaded as a classic script these files share one
// global scope, so top-level declarations would collide between modules.
(function () {
// The ledger witness — the membership proofs that authorise a batch.
//
// RAW BYTES, not a WitnessArgs. The append witness for an entry is also raw,
// but this one differs in where it sits: it must land at the LEDGER INPUT's own
// index (validate_aggregation loads `load_witness(input, Source::Input)`), and
// the sponsor's signature needs its own slot in its own script group. Putting
// the ledger anywhere but input 0 moves this witness with it.
//
// Framing mirrors daowow_core::witness::encode_ledger_witness (witness.rs:188)
// and is pinned byte-for-byte to the Rust wire bytes in
// ../test/ledger-witness.test.js:
//
//   u8  version = 2
//   u32 LE count                  (1..=MAX_BATCH_ENTRIES)
//   repeat count:
//     u32 LE input_index          (distinct, must name an entry-lock input)
//     u32 LE proof_length
//     proof bytes
//
// No trailing bytes: witness.rs:247 requires the read to land exactly on the
// end, so tolerating slack here would accept a witness the contract rejects.

const MAX_BATCH_ENTRIES = 32;   // lifecycle.rs:14

function encodeLedgerWitness(records) {
  if (!Array.isArray(records) || records.length === 0) {
    throw new Error("a ledger witness needs at least one proof record");
  }
  if (records.length > MAX_BATCH_ENTRIES) {
    throw new Error(
      `a batch cannot exceed ${MAX_BATCH_ENTRIES} entries; got ${records.length}`,
    );
  }
  const seen = new Set();
  const parts = [];
  let size = 5;
  for (const record of records) {
    const index = Number(record.inputIndex);
    if (!Number.isInteger(index) || index < 0) {
      throw new Error(`input index ${record.inputIndex} is not a whole number`);
    }
    if (seen.has(index)) {
      throw new Error(`duplicate input index ${index}: one cell cannot be counted twice`);
    }
    seen.add(index);
    const proof = record.proof instanceof Uint8Array
      ? record.proof
      : Uint8Array.from(record.proof ?? []);
    parts.push({ index, proof });
    size += 8 + proof.length;
  }

  const out = new Uint8Array(size);
  const d = new DataView(out.buffer);
  out[0] = 2;
  d.setUint32(1, parts.length, true);
  let at = 5;
  for (const { index, proof } of parts) {
    d.setUint32(at, index, true); at += 4;
    d.setUint32(at, proof.length, true); at += 4;
    out.set(proof, at); at += proof.length;
  }
  return out;
}

function decodeLedgerWitness(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.length < 5) {
    throw new Error("a ledger witness is truncated: it needs a version and a count");
  }
  if (bytes[0] !== 2) {
    throw new Error(`ledger witness version ${bytes[0]} is not 2`);
  }
  const d = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const count = d.getUint32(1, true);
  if (count === 0) {
    throw new Error("a ledger witness needs at least one proof record");
  }
  if (count > MAX_BATCH_ENTRIES) {
    throw new Error(`a batch cannot exceed ${MAX_BATCH_ENTRIES} entries; got ${count}`);
  }
  const out = [];
  const seen = new Set();
  let at = 5;
  for (let i = 0; i < count; i++) {
    if (at + 8 > bytes.length) {
      throw new Error(`ledger witness is truncated at record ${i}`);
    }
    const inputIndex = d.getUint32(at, true); at += 4;
    const length = d.getUint32(at, true); at += 4;
    if (at + length > bytes.length) {
      throw new Error(`ledger witness is truncated inside record ${i}'s proof`);
    }
    if (seen.has(inputIndex)) {
      throw new Error(`duplicate input index ${inputIndex}`);
    }
    seen.add(inputIndex);
    out.push({ inputIndex, proof: bytes.slice(at, at + length) });
    at += length;
  }
  if (at !== bytes.length) {
    throw new Error(
      `ledger witness has ${bytes.length - at} trailing byte(s); the contract ` +
      "requires the read to end exactly on the buffer",
    );
  }
  return out;
}

const api = { encodeLedgerWitness, decodeLedgerWitness, MAX_BATCH_ENTRIES };
if (typeof module !== "undefined" && module.exports) module.exports = api;
if (typeof window !== "undefined") window.DaowowLedgerWitness = api;
})();
