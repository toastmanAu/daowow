"use strict";
// The ledger genesis: a FROZEN shard becomes the 207-byte AggregationState that
// batches are then accepted into.
//
// The frozen shard and the ledger SHARE a type script and its args, so this is
// one script group in which a 101-byte cell becomes a 207-byte one. ledger.rs
// tells them apart by decoding the input data, which is also why this cannot be
// combined with the freeze: a state of OPEN reaches new_bound and is refused.
const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const { buildLedgerGenesisTx, LEDGER_CELL_CKB } = require("../chain/genesis-tx.js");
const { decodeAggregationState } = require("../chain/ledger-codec.js");
const { decodeEntryShardDataV1, decodeRoundConfigV1 } = require("../chain/codec.js");
const { loadManifest } = require("../chain/manifest.js");

const V = JSON.parse(fs.readFileSync(path.join(
  __dirname, "..", "..", "..", "tests", "vectors", "daowow_core_vectors.json"), "utf8"));
const MANIFEST = loadManifest(JSON.parse(fs.readFileSync(path.join(
  __dirname, "..", "..", "..", "deployments", "dev-testnet-manifest.json"), "utf8")));
const unhex = (s) => Uint8Array.from(s.match(/../g).map((b) => parseInt(b, 16)));
const hex = (b) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
const CKB = 100000000n;

const CONFIG = decodeRoundConfigV1(unhex(V.aggregation_state.config.hex));
const frozenShard = {
  ...decodeEntryShardDataV1(unhex(V.aggregation_state.frozen.hex)),
  outPoint: { txHash: "0x" + "11".repeat(32), index: 0 },
  capacity: 312n * CKB,          // what create-demo-round.mjs actually mints
  typeArgs: "0x" + CONFIG.commitment + "00000000",
};
const CONFIG_DEP = { txHash: "0x" + "44".repeat(32), index: 0 };
const sponsor = {
  outPoint: { txHash: "0x" + "55".repeat(32), index: 1 },
  capacity: 1000n * CKB,
  lock: { codeHash: "0x" + "22".repeat(32), hashType: "type", args: "0x" + "ab".repeat(20) },
  lockDep: { outPoint: { txHash: "0x" + "77".repeat(32), index: 0 }, depType: "depGroup" },
};
const base = () => ({
  manifest: MANIFEST, config: CONFIG, frozenShard,
  configCellOutPoint: CONFIG_DEP, sponsor,
});

test("the ledger cell's occupied floor is 318 CKB", () => {
  // 8 capacity + 207 data + 34 lock (32 + 1 + 1 arg) + 69 type (32 + 1 + 36).
  // Stated as a constant because the gate 3a spec PREDICTS this number and a
  // prediction nobody can check is worthless.
  assert.strictEqual(LEDGER_CELL_CKB, 318n);
});

test("the demo shard's 312 CKB cannot cover the ledger, so a top-up is required", () => {
  // The prediction the spec makes, verified rather than asserted in prose: the
  // shard mints at 312 and the ledger needs 318, so genesis is six short of its
  // own floor. This is the 2026-09-16 lesson — cell floors bind transaction
  // order — arriving exactly where that lesson says it will.
  const { tx, topUp } = buildLedgerGenesisTx(base());
  assert.strictEqual(topUp, 6n * CKB, "312 + 6 = 318");
  assert.strictEqual(BigInt(tx.outputs[0].capacity), 318n * CKB);
});

test("the ledger cell clears BOTH its floor and the input's capacity", () => {
  // ledger.rs:54 demands out_cap >= in_cap independently of the floor, so a
  // shard minted with generous slack must not be shrunk to 318.
  const fat = { ...frozenShard, capacity: 500n * CKB };
  const { tx, topUp } = buildLedgerGenesisTx({ ...base(), frozenShard: fat });
  assert.strictEqual(BigInt(tx.outputs[0].capacity), 500n * CKB);
  assert.strictEqual(topUp, 0n, "no top-up needed when the shard already clears the floor");
});

test("the genesis state is the one the contract will recompute", () => {
  // The client computes this so it can be checked locally, but ledger.rs:60
  // recomputes AggregationState::new itself and compares — so a wrong value is
  // refused rather than accepted. Pinned to the Rust oracle.
  const { tx } = buildLedgerGenesisTx(base());
  assert.strictEqual(tx.outputsData[0].replace(/^0x/, ""), V.aggregation_state.genesis.hex);
  const state = decodeAggregationState(unhex(tx.outputsData[0].replace(/^0x/, "")));
  assert.strictEqual(state.acceptedEntries, 0n);
  assert.strictEqual(state.acceptedBatches, 0n);
  assert.strictEqual(state.closed, false);
  assert.strictEqual(state.configCommitment, CONFIG.commitment);
});

test("an OPEN shard is refused: genesis needs state FROZEN", () => {
  // lifecycle.rs:99. The dispatch at main.rs:101 routes on data LENGTH alone,
  // so this transaction would be built, decoded as a genesis, and refused as
  // SHARD_ERROR_STATE — which says nothing about the cause. This is also the
  // rule that makes freeze-plus-genesis in one transaction impossible.
  assert.throws(() => buildLedgerGenesisTx({
    ...base(), frozenShard: { ...frozenShard, state: 0 },
  }), /frozen/i);
});

test("an entry cell among the inputs is refused: no_entry_inputs", () => {
  // ledger.rs:26 — genesis and acceptance are separate transactions by
  // construction, and this is the rule that makes them so.
  const entryLock = MANIFEST.scripts["entry-lock"];
  assert.throws(() => buildLedgerGenesisTx({
    ...base(),
    sponsor: {
      ...sponsor,
      lock: { codeHash: entryLock.codeHash, hashType: entryLock.hashType, args: "0x00" },
    },
  }), /entry cell|entry-lock/i);
});

test("the ledger keeps the shard's type args, and a mismatch is refused", () => {
  const { tx } = buildLedgerGenesisTx(base());
  assert.strictEqual(tx.outputs[0].type.args, "0x" + CONFIG.commitment + "00000000");
  assert.throws(() => buildLedgerGenesisTx({
    ...base(), frozenShard: { ...frozenShard, typeArgs: "0x" + "99".repeat(36) },
  }), /does not belong to this round/);
});

test("the ledger is under the public lock", () => {
  // is_public_lock: entry-shard-type with one zero byte of args. Required on
  // both the input and the output, and it is what makes a keeper replaceable.
  const shardScript = MANIFEST.scripts["entry-shard-type"];
  const { tx } = buildLedgerGenesisTx(base());
  assert.strictEqual(tx.outputs[0].lock.codeHash, shardScript.codeHash);
  assert.strictEqual(tx.outputs[0].lock.args, "0x00");
});

test("the sponsor covers the fee and the top-up, and the arithmetic balances", () => {
  const { tx, fee, topUp } = buildLedgerGenesisTx(base());
  const inputs = frozenShard.capacity + sponsor.capacity;
  const outputs = tx.outputs.reduce((s, o) => s + BigInt(o.capacity), 0n);
  assert.strictEqual(inputs - outputs, fee);
  assert.ok(topUp > 0n);
});

test("a sponsor that cannot cover fee plus top-up plus a change floor is refused", () => {
  assert.throws(() => buildLedgerGenesisTx({
    ...base(), sponsor: { ...sponsor, capacity: 62n * CKB },
  }), /sponsor|capacity|change/i);
});

// Found by the dry run on its FIRST live run, which is what it exists for: the
// sponsor's own lock had no cell dep, so the node would have refused the
// transaction with ScriptNotFound — the same failure that cost two signing
// rounds on the round-creation transaction. Required rather than resolved, so
// it cannot be forgotten again.
test("the sponsor's lock cell dep is required and lands among the deps", () => {
  const { tx } = buildLedgerGenesisTx(base());
  const deps = tx.cellDeps.map((d) => `${d.outPoint.txHash}:${d.outPoint.index}`);
  assert.ok(deps.includes("0x" + "77".repeat(32) + ":0"),
    "the sponsor's lock dep must be present, or its input is ScriptNotFound");
  const { lockDep, ...without } = sponsor;
  assert.throws(() => buildLedgerGenesisTx({ ...base(), sponsor: without }), /lockDep|ScriptNotFound/);
});
