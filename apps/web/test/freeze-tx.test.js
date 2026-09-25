"use strict";
// TX-03. The simplest transaction in the protocol and the one that gates every
// later step: nothing can aggregate a shard that is still OPEN.
const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const { buildFreezeTx, ABSOLUTE_EPOCH_FLAG } = require("../chain/freeze-tx.js");
const { decodeEntryShardDataV1, decodeRoundConfigV1 } = require("../chain/codec.js");
const { loadManifest } = require("../chain/manifest.js");

const V = JSON.parse(fs.readFileSync(path.join(
  __dirname, "..", "..", "..", "tests", "vectors", "daowow_core_vectors.json"), "utf8"));
const MANIFEST = loadManifest(JSON.parse(fs.readFileSync(path.join(
  __dirname, "..", "..", "..", "deployments", "dev-testnet-manifest.json"), "utf8")));
const unhex = (s) => Uint8Array.from(s.match(/../g).map((b) => parseInt(b, 16)));
const CKB = 100000000n;

const CONFIG = decodeRoundConfigV1(unhex(V.aggregation_state.config.hex));
// The same shard the ledger vectors freeze, but back in its OPEN state.
const FROZEN = decodeEntryShardDataV1(unhex(V.aggregation_state.frozen.hex));
const shard = {
  ...FROZEN,
  state: 0,
  outPoint: { txHash: "0x" + "11".repeat(32), index: 0 },
  capacity: 312n * CKB,
  typeArgs: "0x" + CONFIG.commitment + "00000000",
};
const CONFIG_DEP = { txHash: "0x" + "44".repeat(32), index: 0 };
const sponsor = {
  outPoint: { txHash: "0x" + "55".repeat(32), index: 1 },
  capacity: 1000n * CKB,
  lock: { codeHash: "0x" + "22".repeat(32), hashType: "type", args: "0x" + "ab".repeat(20) },
};
const base = () => ({
  manifest: MANIFEST, config: CONFIG, shard,
  nowEpoch: CONFIG.entryEnd, configCellOutPoint: CONFIG_DEP, sponsor,
});

test("the shard head is input zero", () => {
  const { tx } = buildFreezeTx(base());
  assert.deepStrictEqual(tx.inputs[0].previousOutput, shard.outPoint);
});

test("the successor differs from the head in state and nothing else", () => {
  // validate_freeze (shard.rs:132) compares all seven of these. A freeze that
  // altered any of them would be refused as SHARD_ERROR_FROZEN.
  const { tx } = buildFreezeTx(base());
  const after = decodeEntryShardDataV1(unhex(tx.outputsData[0].replace(/^0x/, "")));
  assert.strictEqual(after.state, 1, "the successor must be FROZEN");
  for (const field of ["roundId", "shardId", "sequence", "entryCount",
                       "ticketCount", "principalTotal", "accumulatorRoot"]) {
    assert.deepStrictEqual(after[field], shard[field], `${field} must be preserved`);
  }
});

test("the since carries the RFC 0017 absolute-epoch flag", () => {
  // Without the top byte 0x20 the node reads the value as a BLOCK NUMBER, and
  // epoch 1002 as a block number is long past — the shard would freeze
  // immediately regardless of the entry window.
  const { tx } = buildFreezeTx(base());
  assert.strictEqual(tx.inputs[0].since & ABSOLUTE_EPOCH_FLAG, ABSOLUTE_EPOCH_FLAG);
  assert.strictEqual(tx.inputs[0].since & 0xffffffn, CONFIG.entryEnd);
});

test("freezing before entry_end is refused locally", () => {
  // The contract checks absolute_epoch_at_least(since, cfg.entry_end), so a
  // since below it is refused on chain as SHARD_ERROR_FROZEN with no
  // indication that timing was the problem.
  assert.throws(() => buildFreezeTx({ ...base(), nowEpoch: CONFIG.entryEnd - 1n }),
    /entry_end|epoch/);
});

test("freezing exactly at entry_end is permitted", () => {
  // Inclusive: at_least, not after. An off-by-one here would make the shard
  // unfreezable for a whole epoch.
  assert.doesNotThrow(() => buildFreezeTx({ ...base(), nowEpoch: CONFIG.entryEnd }));
});

test("a shard that is already frozen is refused", () => {
  assert.throws(() => buildFreezeTx({ ...base(), shard: { ...shard, state: 1 } }),
    /already frozen|OPEN/);
});

test("the successor keeps the head's type args", () => {
  // The same guard buildEntryTx carries: args derived from the config that
  // disagree with the cell being spent make the type script appear in the
  // inputs and vanish from the outputs, which is BadState and says nothing.
  assert.throws(() => buildFreezeTx({
    ...base(), shard: { ...shard, typeArgs: "0x" + "99".repeat(36) },
  }), /does not belong to this round/);
});

test("no claim cells are produced", () => {
  // main.rs:258 refuses a freeze carrying claim cells outright.
  const { tx } = buildFreezeTx(base());
  const shardType = MANIFEST.scripts["entry-shard-type"];
  const claimish = tx.outputs.filter((o, i) =>
    i > 0 && o.type && o.type.codeHash === shardType.codeHash);
  assert.strictEqual(claimish.length, 0);
});

test("the shard's own code cell and the config cell are both deps", () => {
  // The shard's type AND its lock are both entry-shard-type, so one dep
  // serves both; the config travels as a cell dep because the contract reads
  // the authenticated round config from there.
  const { tx } = buildFreezeTx(base());
  const deps = tx.cellDeps.map((d) => `${d.outPoint.txHash}:${d.outPoint.index}`);
  const shardDep = MANIFEST.scripts["entry-shard-type"].outPoint;
  assert.ok(deps.includes(`${shardDep.txHash}:${shardDep.index}`), "entry-shard-type dep");
  assert.ok(deps.includes(`${CONFIG_DEP.txHash}:${CONFIG_DEP.index}`), "config cell dep");
});

test("the successor keeps at least the head's capacity", () => {
  const { tx } = buildFreezeTx(base());
  assert.ok(BigInt(tx.outputs[0].capacity) >= shard.capacity);
});

test("the sponsor funds the fee and takes the change", () => {
  const { tx, fee } = buildFreezeTx(base());
  const inputs = shard.capacity + sponsor.capacity;
  const outputs = tx.outputs.reduce((s, o) => s + BigInt(o.capacity), 0n);
  assert.strictEqual(inputs - outputs, fee, "inputs less outputs is exactly the fee");
  assert.ok(fee > 0n, "a zero fee is pool-rejected before any script runs");
});

test("a sponsor too small to cover the fee and a change floor is refused", () => {
  assert.throws(() => buildFreezeTx({
    ...base(), sponsor: { ...sponsor, capacity: 10n * CKB },
  }), /sponsor|capacity|change/i);
});
