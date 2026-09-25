"use strict";
// The ledger witness framing, byte-checked against the Rust encoder.
//
// A hand-rolled framing or molecule encoder that was never byte-checked
// against the on-chain Rust is the single most repeated failure in this
// project's history — codegen and hand-rolled code disagree on length
// prefixes, and the disagreement is invisible until a contract reads the wrong
// field. So the parity test against the Rust wire bytes comes first and
// everything else is secondary.
const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const {
  encodeLedgerWitness, decodeLedgerWitness, MAX_BATCH_ENTRIES,
} = require("../chain/ledger-witness.js");

const V = JSON.parse(fs.readFileSync(path.join(
  __dirname, "..", "..", "..", "tests", "vectors", "daowow_core_vectors.json"), "utf8"));
const unhex = (s) => Uint8Array.from(s.match(/../g).map((b) => parseInt(b, 16)));
const hex = (b) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");

const records = () => V.ledger_witness.records.map((r) => ({
  inputIndex: r.input_index, proof: unhex(r.proof),
}));

test("the encoder reproduces the Rust wire bytes exactly", () => {
  assert.strictEqual(hex(encodeLedgerWitness(records())), V.ledger_witness.hex);
});

test("the ledger sits at input 0, so the entry records start at 1", () => {
  // Not arbitrary: the raw proof witness must land at the LEDGER input's own
  // index, and the sponsor's signature needs its own slot in its own group.
  const r = records();
  assert.deepStrictEqual(r.map((x) => x.inputIndex), [1, 2]);
});

test("decode round-trips the encoder", () => {
  const out = decodeLedgerWitness(encodeLedgerWitness(records()));
  assert.strictEqual(out.length, 2);
  assert.strictEqual(out[0].inputIndex, 1);
  assert.strictEqual(hex(out[0].proof), V.ledger_witness.records[0].proof);
});

test("decode reads the Rust bytes back into the same records", () => {
  // Parity in the other direction: our decoder against bytes we did not write.
  const out = decodeLedgerWitness(unhex(V.ledger_witness.hex));
  assert.deepStrictEqual(
    out.map((r) => ({ inputIndex: r.inputIndex, proof: hex(r.proof) })),
    V.ledger_witness.records.map((r) => ({ inputIndex: r.input_index, proof: r.proof })));
});

// --- the refusals, each asserted on its OWN message ------------------------
// A shared /ledger/i pattern would pass for every one of these and pin none of
// them, which is the trap recorded on 2026-08-09.

test("an empty record list is refused", () => {
  assert.throws(() => encodeLedgerWitness([]), /at least one/);
});

test("more than MAX_BATCH_ENTRIES records is refused", () => {
  const many = Array.from({ length: MAX_BATCH_ENTRIES + 1 }, (_, i) => ({
    inputIndex: i + 1, proof: new Uint8Array(4),
  }));
  assert.throws(() => encodeLedgerWitness(many), new RegExp(String(MAX_BATCH_ENTRIES)));
});

test("a duplicate input index is refused", () => {
  // Two records naming one cell would let a batch count an entry twice.
  assert.throws(() => encodeLedgerWitness([
    { inputIndex: 1, proof: new Uint8Array(4) },
    { inputIndex: 1, proof: new Uint8Array(8) },
  ]), /duplicate/);
});

test("a trailing byte is refused rather than ignored", () => {
  // witness.rs:247 requires the offset to land exactly on the end. Tolerating
  // slack here would accept a witness the contract rejects.
  const wire = encodeLedgerWitness(records());
  const padded = new Uint8Array(wire.length + 1);
  padded.set(wire);
  assert.throws(() => decodeLedgerWitness(padded), /trailing/);
});

test("a truncated buffer is refused rather than returning a short list", () => {
  const wire = encodeLedgerWitness(records());
  assert.throws(() => decodeLedgerWitness(wire.slice(0, wire.length - 5)), /truncated/);
});

test("a wrong version is refused", () => {
  const wire = encodeLedgerWitness(records());
  wire[0] = 1;
  assert.throws(() => decodeLedgerWitness(wire), /version/);
});

test("a zero count is refused on the way back in", () => {
  const wire = new Uint8Array([2, 0, 0, 0, 0]);
  assert.throws(() => decodeLedgerWitness(wire), /at least one/);
});
