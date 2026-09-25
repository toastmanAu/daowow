"use strict";
// The browser builds the entry transaction itself, so every encoder here is
// checked byte-for-byte against the Rust rather than against itself. A codec
// that agrees only with its own tests is the recurring failure in the CKB
// feedback log.
const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const {
  encodeEntryDataV1, ticketId, encodeClaimArgs, initialClaimState,
} = require("../chain/entry-codec.js");

const V = JSON.parse(fs.readFileSync(path.join(
  __dirname, "..", "..", "..", "tests", "vectors", "daowow_core_vectors.json"), "utf8"));
const O = V.entry_encoding;
const unhex = (s) => Uint8Array.from(s.match(/../g).map((b) => parseInt(b, 16)));
const hex = (b) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");

const entry = {
  roundId: unhex(O.entry.fields.round_id),
  shardId: O.entry.fields.shard_id,
  participantLockHash: unhex(O.entry.fields.participant_lock_hash),
  ticketCount: BigInt(O.entry.fields.ticket_count),
  principal: BigInt(O.entry.fields.principal),
  positionBase: BigInt(O.entry.fields.position_base),
  entryNonce: BigInt(O.entry.fields.entry_nonce),
  entropyCommitment: unhex(O.entry.fields.entropy_commitment),
};

test("encodeEntryDataV1 reproduces the Rust bytes exactly", () => {
  assert.strictEqual(hex(encodeEntryDataV1(entry)), O.entry.hex);
  assert.strictEqual(encodeEntryDataV1(entry).length, 132);
});

test("ticketId reproduces the Rust derivation", () => {
  const got = ticketId(
    unhex(O.claim.config_commitment), O.claim.shard_id, BigInt(O.claim.position));
  assert.strictEqual(hex(got), O.claim.ticket_id);
});

test("encodeClaimArgs reproduces the Rust bytes exactly", () => {
  const args = encodeClaimArgs({
    commitment: unhex(O.claim.config_commitment),
    shardId: O.claim.shard_id,
    position: BigInt(O.claim.position),
  });
  assert.strictEqual(hex(args), O.claim.args_hex);
  assert.strictEqual(args[0], 5, "CLAIM_TAG");
  assert.strictEqual(args.length, 45);
});

test("initialClaimState reproduces the Rust bytes exactly", () => {
  const state = initialClaimState({
    commitment: unhex(O.claim.config_commitment),
    shardId: O.claim.shard_id,
    position: BigInt(O.claim.position),
  });
  assert.strictEqual(hex(state), O.claim.initial_state_hex);
  assert.strictEqual(state.length, 81);
  assert.strictEqual(state[0], 1, "version");
  // A freshly minted claim has discharged nothing: root and counters are zero.
  assert.ok(state.slice(33).every((b) => b === 0), "paid root and counters must be zero");
});

test("malformed input is refused rather than silently truncated", () => {
  assert.throws(() => encodeEntryDataV1({ ...entry, roundId: new Uint8Array(31) }), /32/);
  assert.throws(() => encodeClaimArgs({
    commitment: new Uint8Array(31), shardId: 0, position: 0n }), /32/);
});

// Aggregation reads entry cells back off chain, so the decoder is pinned to the
// same oracle the encoder is — and to the encoder itself, so the pair cannot
// drift. An offset error here would put a plausible number in the wrong field.
test("decodeEntryDataV1 round-trips the canonical entry oracle", () => {
  const { decodeEntryDataV1 } = require("../chain/entry-codec.js");
  const o = V.entry_encoding.entry;
  const decoded = decodeEntryDataV1(unhex(o.hex));
  assert.strictEqual(hex(encodeEntryDataV1(decoded)), o.hex);
  assert.strictEqual(decoded.shardId, o.fields.shard_id);
  assert.strictEqual(decoded.ticketCount, BigInt(o.fields.ticket_count));
  assert.strictEqual(decoded.principal, BigInt(o.fields.principal));
  assert.strictEqual(decoded.positionBase, BigInt(o.fields.position_base));
  assert.strictEqual(decoded.entryNonce, BigInt(o.fields.entry_nonce));
  assert.strictEqual(hex(decoded.roundId), o.fields.round_id);
  assert.strictEqual(hex(decoded.participantLockHash), o.fields.participant_lock_hash);
  assert.strictEqual(hex(decoded.entropyCommitment), o.fields.entropy_commitment);
});

test("decodeEntryDataV1 refuses a wrong length", () => {
  const { decodeEntryDataV1 } = require("../chain/entry-codec.js");
  assert.throws(() => decodeEntryDataV1(new Uint8Array(131)), /132/);
});
