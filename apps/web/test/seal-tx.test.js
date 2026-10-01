"use strict";
// Sealing: the CLOSED ledger of shard zero becomes the RoundSeal that freezes
// the round's entry universe. Rules from contracts/entry-shard-type/src/seal.rs.
const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const { buildSealTx, SEAL_CELL_CKB } = require("../chain/seal-tx.js");
const { decodeRoundSeal } = require("../chain/seal-codec.js");
const { decodeAggregationState } = require("../chain/ledger-codec.js");
const { decodeRoundConfigV1 } = require("../chain/codec.js");
const { loadManifest } = require("../chain/manifest.js");

const V = JSON.parse(fs.readFileSync(path.join(
  __dirname, "..", "..", "..", "tests", "vectors", "daowow_core_vectors.json"), "utf8"));
const MANIFEST = loadManifest(JSON.parse(fs.readFileSync(path.join(
  __dirname, "..", "..", "..", "deployments", "dev-testnet-manifest.json"), "utf8")));
const unhex = (s) => Uint8Array.from(s.match(/../g).map((b) => parseInt(b, 16)));
const CKB = 100000000n;

const CONFIG = decodeRoundConfigV1(unhex(V.aggregation_state.config.hex));
const CLOSED = decodeAggregationState(unhex(V.round_seal.ledger_hex));
const OPEN = { ...CLOSED, closed: false };

const ledger = {
  outPoint: { txHash: "0x" + "11".repeat(32), index: 0 },
  capacity: 318n * CKB,          // what genesis actually minted on testnet
  state: CLOSED,
  typeArgs: "0x" + CONFIG.commitment + "00000000",
};
const sponsor = {
  outPoint: { txHash: "0x" + "55".repeat(32), index: 1 },
  capacity: 1000n * CKB,
  lock: { codeHash: "0x" + "22".repeat(32), hashType: "type", args: "0x" + "ab".repeat(20) },
  lockDep: { outPoint: { txHash: "0x" + "77".repeat(32), index: 0 }, depType: "depGroup" },
};
const base = () => ({
  manifest: MANIFEST, config: CONFIG, ledger, otherLedgers: [],
  configCellOutPoint: { txHash: "0x" + "44".repeat(32), index: 0 }, sponsor,
});

test("the seal cell's occupied floor is 323 CKB", () => {
  // 8 capacity + 212 data + 34 lock + 69 type. A prediction the plan made, so
  // it is a test rather than a comment.
  assert.strictEqual(SEAL_CELL_CKB, 323n);
});

test("a closed ledger becomes exactly the seal the contract will recompute", () => {
  // Pinned to the Rust oracle: seal.rs re-derives the seal and compares, so
  // the client computes nothing it is trusted on — but a wrong value would be
  // refused, and finding that out locally is the point.
  const { tx } = buildSealTx(base());
  assert.strictEqual(tx.outputsData[0].replace(/^0x/, ""), V.round_seal.hex);
});

test("the ledger's 318 CKB needs a 5 CKB top-up to reach the seal's floor", () => {
  const { tx, topUp } = buildSealTx(base());
  assert.strictEqual(BigInt(tx.outputs[0].capacity), 323n * CKB);
  assert.strictEqual(topUp, 5n * CKB, "318 + 5 = 323, the second step to grow its cell");
});

test("a ledger already above the floor keeps its capacity", () => {
  // seal.rs requires out_cap >= in_cap independently of the floor.
  const { tx, topUp } = buildSealTx({ ...base(), ledger: { ...ledger, capacity: 500n * CKB } });
  assert.strictEqual(BigInt(tx.outputs[0].capacity), 500n * CKB);
  assert.strictEqual(topUp, 0n);
});

test("an OPEN ledger is refused: only a closed one can be sealed", () => {
  // RoundSeal::new refuses it; the chain would say SHARD_ERROR_DATA and
  // nothing about the ledger being open.
  assert.throws(() => buildSealTx({ ...base(), ledger: { ...ledger, state: OPEN } }),
    /closed/);
});

test("a shard other than zero is refused", () => {
  // seal.rs:17 — args[32..] must be zero. Shard zero carries the seal for the
  // whole round; the others are cell deps.
  const shardOne = {
    ...ledger,
    state: { ...CLOSED, frozen: { ...CLOSED.frozen, shardId: 1 } },
    typeArgs: "0x" + CONFIG.commitment + "01000000",
  };
  assert.throws(() => buildSealTx({ ...base(), ledger: shardOne }), /shard zero/);
});

test("a shard-zero ledger cell carrying another round's type args is refused", () => {
  // Shard zero, closed, bound to THIS config in its data — only the cell's own
  // type args are wrong. Without this case the guard was unpinned: the only
  // other mismatched-args fixture was the shard-one ledger, which the shard-zero
  // guard refuses first, reporting the right conclusion for the wrong reason.
  assert.throws(() => buildSealTx({
    ...base(), ledger: { ...ledger, typeArgs: "0x" + "99".repeat(32) + "00000000" },
  }), /does not belong to this round/);
});

test("a ledger bound to a different round config is refused", () => {
  const foreign = { ...CLOSED, configCommitment: "99".repeat(32) };
  assert.throws(() => buildSealTx({ ...base(), ledger: { ...ledger, state: foreign } }),
    /different round/);
});

test("a multi-shard round needs every other shard's closed ledger as a dep", () => {
  // The beta is one shard, but the rule is the seal's: it carries EVERY
  // ledger, and only shard zero's is an input.
  const twoShard = { ...CONFIG, entryShardCount: 2 };
  assert.throws(() => buildSealTx({ ...base(), config: twoShard }), /every other shard/);
});

test("the seal keeps the ledger's type args and the public lock", () => {
  const { tx } = buildSealTx(base());
  assert.strictEqual(tx.outputs[0].type.args, ledger.typeArgs);
  assert.strictEqual(tx.outputs[0].lock.args, "0x00");
});

test("the seal's embedded ledger is the input ledger, unchanged", () => {
  const { tx } = buildSealTx(base());
  const seal = decodeRoundSeal(unhex(tx.outputsData[0].replace(/^0x/, "")), 1);
  assert.strictEqual(seal.ledgers[0].closed, true);
  assert.strictEqual(seal.ledgers[0].acceptedEntries, CLOSED.acceptedEntries);
  assert.strictEqual(seal.ledgers[0].batchesRoot, CLOSED.batchesRoot);
});

test("an entry-lock input is refused: no_entry_inputs", () => {
  const entryLock = MANIFEST.scripts["entry-lock"];
  assert.throws(() => buildSealTx({
    ...base(),
    sponsor: { ...sponsor,
      lock: { codeHash: entryLock.codeHash, hashType: entryLock.hashType, args: "0x00" } },
  }), /no_entry_inputs/);
});

test("the sponsor's lock cell dep is required and lands among the deps", () => {
  const { tx } = buildSealTx(base());
  const deps = tx.cellDeps.map((d) => `${d.outPoint.txHash}:${d.outPoint.index}`);
  assert.ok(deps.includes("0x" + "77".repeat(32) + ":0"));
  const { lockDep, ...without } = sponsor;
  assert.throws(() => buildSealTx({ ...base(), sponsor: without }), /lockDep|ScriptNotFound/);
});

test("the config cell travels as a dep, because the contract reads it there", () => {
  const { tx } = buildSealTx(base());
  const deps = tx.cellDeps.map((d) => `${d.outPoint.txHash}:${d.outPoint.index}`);
  assert.ok(deps.includes("0x" + "44".repeat(32) + ":0"));
});

test("witnesses and inputs are balanced and the arithmetic closes", () => {
  const { tx, fee } = buildSealTx(base());
  assert.strictEqual(tx.witnesses.length, tx.inputs.length);
  const inputs = ledger.capacity + sponsor.capacity;
  const outputs = tx.outputs.reduce((s, o) => s + BigInt(o.capacity), 0n);
  assert.strictEqual(inputs - outputs, fee);
});
