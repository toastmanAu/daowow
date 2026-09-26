"use strict";
// Closing the ledger — the step the gate 3a plan missed.
//
// Not bookkeeping: entry-lock's refund branch calls excluded_membership, which
// returns false unless a canonical ledger cell is a cell dep AND it is CLOSED.
// Without this transaction an unaccepted entry's capacity is stranded, and the
// aggregation deadline passing is necessary but nowhere near sufficient.
const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const { buildCloseTx, closedState, closableFrom, ABSOLUTE_EPOCH_FLAG } =
  require("../chain/close-tx.js");
const { decodeAggregationState } = require("../chain/ledger-codec.js");
const { decodeRoundConfigV1 } = require("../chain/codec.js");
const { loadManifest } = require("../chain/manifest.js");

const V = JSON.parse(fs.readFileSync(path.join(
  __dirname, "..", "..", "..", "tests", "vectors", "daowow_core_vectors.json"), "utf8"));
const MANIFEST = loadManifest(JSON.parse(fs.readFileSync(path.join(
  __dirname, "..", "..", "..", "deployments", "dev-testnet-manifest.json"), "utf8")));
const unhex = (s) => Uint8Array.from(s.match(/../g).map((b) => parseInt(b, 16)));
const CKB = 100000000n;
const A = V.aggregation_state;
const CONFIG = decodeRoundConfigV1(unhex(A.config.hex));
const GENESIS = decodeAggregationState(unhex(A.genesis.hex));   // 0 of 2 accepted
const FULL = decodeAggregationState(unhex(A.after_batch.hex));  // 2 of 2 accepted

const ledger = {
  outPoint: { txHash: "0x" + "11".repeat(32), index: 0 },
  capacity: 318n * CKB,
  state: GENESIS,
  typeArgs: "0x" + CONFIG.commitment + "00000000",
};
const sponsor = {
  outPoint: { txHash: "0x" + "55".repeat(32), index: 1 },
  capacity: 1000n * CKB,
  lock: { codeHash: "0x" + "22".repeat(32), hashType: "type", args: "0x" + "ab".repeat(20) },
  lockDep: { outPoint: { txHash: "0x" + "77".repeat(32), index: 0 }, depType: "depGroup" },
};
const base = () => ({
  manifest: MANIFEST, config: CONFIG, ledger,
  nowEpoch: CONFIG.aggregationDeadline,
  configCellOutPoint: { txHash: "0x" + "44".repeat(32), index: 0 },
  sponsor,
});

// --- the two deadlines (lifecycle.rs:341) ---------------------------------

test("a partly accepted ledger waits for the aggregation deadline", () => {
  // Until then a keeper might still take the entries it skipped.
  assert.strictEqual(closableFrom(CONFIG, GENESIS), CONFIG.aggregationDeadline);
});

test("a fully accepted ledger may close from entry_end instead", () => {
  // Nothing left to wait for, so the earlier deadline governs. This is a real
  // distinction, not a simplification: entry_end is earlier than the
  // aggregation deadline by construction.
  assert.strictEqual(closableFrom(CONFIG, FULL), CONFIG.entryEnd);
  assert.ok(CONFIG.entryEnd < CONFIG.aggregationDeadline);
});

test("closing a partly accepted ledger at entry_end is refused", () => {
  // The case the two-deadline rule exists to forbid: closing early would
  // strand entries a keeper could still have accepted.
  assert.throws(() => closedState(CONFIG, GENESIS, CONFIG.entryEnd),
    /cannot be closed until epoch/);
});

test("closing a fully accepted ledger at entry_end is permitted", () => {
  assert.doesNotThrow(() => closedState(CONFIG, FULL, CONFIG.entryEnd));
});

test("the refusal says WHICH deadline governs and why", () => {
  // The chain reports SHARD_ERROR_STATE for this and says nothing.
  // assert.throws returns undefined in Node, so capture the error directly.
  let message = "";
  try { closedState(CONFIG, GENESIS, CONFIG.entryEnd); }
  catch (e) { message = e.message; }
  assert.match(message, /unaccepted/, "it must name why this deadline applies");
  assert.match(message, /aggregation deadline/);
  // And the other branch explains itself too.
  let full = "";
  try { closedState(CONFIG, FULL, CONFIG.entryEnd - 1n); }
  catch (e) { full = e.message; }
  assert.match(full, /every entry is accepted/);
});

// --- the transition itself ------------------------------------------------

test("closing sets one boolean and preserves everything else", () => {
  // What makes the accepted prefix permanent: no entry beyond it can ever
  // become a draw participant afterwards.
  const after = closedState(CONFIG, GENESIS, CONFIG.aggregationDeadline);
  assert.strictEqual(after.closed, true);
  for (const field of ["acceptedEntries", "acceptedTickets", "acceptedPrincipal",
                       "acceptedCapacity", "acceptedBatches", "batchesRoot",
                       "configCommitment"]) {
    assert.deepStrictEqual(after[field], GENESIS[field], `${field} must be preserved`);
  }
  assert.deepStrictEqual(after.frozen, GENESIS.frozen);
});

test("an already closed ledger is refused", () => {
  assert.throws(() => closedState(CONFIG, { ...GENESIS, closed: true }, 99999n),
    /already closed/);
});

test("the since carries the absolute-epoch flag and names the epoch", () => {
  const { tx } = buildCloseTx(base());
  assert.strictEqual(tx.inputs[0].since & ABSOLUTE_EPOCH_FLAG, ABSOLUTE_EPOCH_FLAG);
  assert.strictEqual(tx.inputs[0].since & 0xffffffn, CONFIG.aggregationDeadline);
});

test("the ledger cell keeps its capacity, lock and type args", () => {
  const { tx } = buildCloseTx(base());
  assert.strictEqual(BigInt(tx.outputs[0].capacity), ledger.capacity);
  assert.strictEqual(tx.outputs[0].lock.args, "0x00");
  assert.strictEqual(tx.outputs[0].type.args, ledger.typeArgs);
  const after = decodeAggregationState(unhex(tx.outputsData[0].replace(/^0x/, "")));
  assert.strictEqual(after.closed, true);
});

test("an entry-lock input is refused: closing cannot be combined with accepting", () => {
  const entryLock = MANIFEST.scripts["entry-lock"];
  assert.throws(() => buildCloseTx({
    ...base(),
    sponsor: { ...sponsor,
      lock: { codeHash: entryLock.codeHash, hashType: entryLock.hashType, args: "0x00" } },
  }), /no_entry_inputs/);
});

test("the sponsor's lock cell dep is required", () => {
  const { lockDep, ...without } = sponsor;
  assert.throws(() => buildCloseTx({ ...base(), sponsor: without }),
    /lockDep|ScriptNotFound/);
});

test("a ledger from another round is refused", () => {
  assert.throws(() => buildCloseTx({
    ...base(), ledger: { ...ledger, typeArgs: "0x" + "99".repeat(36) },
  }), /does not belong to this round/);
});
