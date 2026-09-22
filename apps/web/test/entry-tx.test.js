"use strict";
// TX-02 assembly. A wrong shard successor or a missing cell dep fails only at
// broadcast, and ckb-testtool structurally cannot catch a missing dep because
// its context makes every deployed binary available regardless (2026-09-17).
// So the deps are asserted here explicitly.
const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const { encodeEntryShardDataV1, decodeEntryShardDataV1 } = require("../chain/codec.js");
const { buildEntryTx, ABSOLUTE_EPOCH_FLAG } = require("../chain/entry-tx.js");
const { decodeSchedule } = require("../chain/schedule.js");
const { loadManifest } = require("../chain/manifest.js");

const V = JSON.parse(fs.readFileSync(path.join(
  __dirname, "..", "..", "..", "tests", "vectors", "daowow_core_vectors.json"), "utf8"));
const MANIFEST = loadManifest(JSON.parse(fs.readFileSync(path.join(
  __dirname, "..", "..", "..", "deployments", "dev-testnet-manifest.json"), "utf8")));
const unhex = (s) => Uint8Array.from(s.match(/../g).map((b) => parseInt(b, 16)));
const hex = (b) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
const CKB = 100000000n;

test("encodeEntryShardDataV1 round-trips the Rust oracle", () => {
  const o = V.cell_encodings.shard_data;
  const decoded = decodeEntryShardDataV1(unhex(o.hex));
  assert.strictEqual(hex(encodeEntryShardDataV1(decoded)), o.hex);
});

const config = {
  roundId: V.cell_encodings.round_config.fields.round_id,
  commitment: V.cell_encodings.round_config.commitment,
  ticketPrice: 10000n * CKB,
  minimumTickets: 5n,
  maximumTickets: 10n,
  entryStart: 1001n,
  entryShardCount: 1,
};
const shard = {
  roundId: config.roundId,
  shardId: 0,
  state: 0,
  sequence: 0n,
  entryCount: 0n,
  ticketCount: 0n,
  principalTotal: 0n,
  accumulatorRoot: "00".repeat(32),
  outPoint: { txHash: "0x" + "11".repeat(32), index: 0 },
  capacity: 300n * CKB,
};
const CONFIG_DEP = { txHash: "0x" + "44".repeat(32), index: 0 };
const lock = { codeHash: "0x" + "22".repeat(32), hashType: "type", args: "0x" + "ab".repeat(22) };
const build = (tickets = 3n, nowEpoch = 1005n) => buildEntryTx({
  manifest: MANIFEST,
  config,
  schedule: decodeSchedule(unhex(V.prize_schedule_v2.hex)),
  shard,
  lock,
  participantLockHash: "33".repeat(32),
  tickets,
  nowEpoch,
  configCellOutPoint: CONFIG_DEP,
});

test("the shard head is input zero, spent with an absolute-epoch since", () => {
  const { tx } = build();
  assert.deepStrictEqual(tx.inputs[0].previousOutput, shard.outPoint);
  // since is a LOWER bound and must be an ABSOLUTE EPOCH: the contract's
  // absolute_epoch_number requires the top byte to be exactly 0x20, so a bare
  // block number would be refused with SHARD_ERROR_NOT_OPEN (-39).
  assert.strictEqual(tx.inputs[0].since >> 56n, 0x20n);
  assert.ok((tx.inputs[0].since & 0xffffffffffffffn) >= config.entryStart,
    "since must not precede entry_start");
});

test("outputs are the shard successor, the entry cell, one claim per ticket, then change", () => {
  const { tx, claims } = build(3n);
  assert.strictEqual(claims.length, 3, "one claim per ticket");
  const after = decodeEntryShardDataV1(unhex(tx.outputsData[0]));
  assert.strictEqual(after.ticketCount, 3n);
  assert.strictEqual(after.entryCount, 1n);
  assert.strictEqual(after.sequence, 1n);
  assert.strictEqual(after.principalTotal, 3n * config.ticketPrice);
  // shard successor, entry cell, then one claim per ticket. Change is NOT
  // here: buildEntryTx is pure, and only the signing adapter completes fees
  // and therefore knows the change.
  assert.strictEqual(tx.outputs.length, 1 + 1 + 3);
  for (let i = 0; i < 3; i++) {
    const claim = tx.outputs[2 + i];
    assert.deepStrictEqual(claim.lock, lock, "a claim is locked to the entrant");
    assert.strictEqual(claim.type.codeHash, MANIFEST.scripts["entry-shard-type"].codeHash);
    assert.strictEqual(unhex(tx.outputsData[2 + i]).length, 81);
  }
});

test("positions continue from the shard's ticket count", () => {
  // A shard holding entries needs its accumulator peaks rebuilt by replaying
  // them: the cell commits only to the root. Two prior entries give one peak.
  const { derivePeaks } = require("../chain/entry-tx.js");
  const prior = [0, 1].map((nonce) => ({
    roundId: unhex(config.roundId), shardId: 0,
    participantLockHash: unhex("33".repeat(32)),
    ticketCount: 2n, principal: 2n * config.ticketPrice,
    positionBase: BigInt(nonce * 2), entryNonce: BigInt(nonce),
    entropyCommitment: new Uint8Array(32),
  }));
  const core = require("../core.js");
  const host = new core.MmrHost();
  for (const e of prior) host.append(core.entryLeaf(e));
  const seeded = {
    ...shard, ticketCount: 4n, entryCount: 2n, sequence: 2n,
    peaks: derivePeaks(prior),
    accumulatorRoot: Array.from(host.root(), (x) => x.toString(16).padStart(2, "0")).join(""),
  };
  const { claims } = buildEntryTx({
    manifest: MANIFEST, config, schedule: decodeSchedule(unhex(V.prize_schedule_v2.hex)),
    shard: seeded, lock, participantLockHash: "33".repeat(32), tickets: 2n, nowEpoch: 1005n,
    configCellOutPoint: CONFIG_DEP,
  });
  assert.deepStrictEqual(claims.map((c) => c.position), [4n, 5n]);
});

test("every script that runs has a cell dep", () => {
  const { tx } = build();
  const deps = tx.cellDeps.map((d) => `${d.outPoint.txHash}:${d.outPoint.index}`);
  const shardDep = MANIFEST.scripts["entry-shard-type"].outPoint;
  assert.ok(deps.includes(`${shardDep.txHash}:${shardDep.index}`),
    "entry-shard-type runs as the shard type, the shard lock and every claim type");
  assert.ok(deps.includes(`${CONFIG_DEP.txHash}:${CONFIG_DEP.index}`),
    "the contract reads the authenticated round config from a cell dep");
});

test("an entry beyond the round's cap is refused before anything is built", () => {
  assert.throws(() => build(11n), /cap/i);
});

test("an entry before the round opens is refused", () => {
  assert.throws(() => build(3n, 999n), /entry_start|not open/i);
});

test("a missing round config dep is refused, not silently omitted", () => {
  // Without it every append is refused on chain. A guaranteed broadcast
  // failure must not be reachable by forgetting an argument.
  assert.throws(() => buildEntryTx({
    manifest: MANIFEST, config, schedule: decodeSchedule(unhex(V.prize_schedule_v2.hex)),
    shard, lock, participantLockHash: "33".repeat(32), tickets: 1n, nowEpoch: 1005n,
  }), /config cell/i);
});

test("the entry continues the shard's position and nonce sequence", () => {
  // shard.rs:46 requires entry_nonce == first_nonce_in_tx + index, and
  // position_base must continue the shard's ticket space. Getting either
  // wrong is refused on chain, so assert the entry itself rather than only
  // the claims derived from it.
  const { entry } = build(3n);
  assert.strictEqual(entry.positionBase, shard.ticketCount);
  assert.strictEqual(entry.entryNonce, shard.entryCount);

  const core = require("../core.js");
  const { derivePeaks } = require("../chain/entry-tx.js");
  const prior = [{
    roundId: unhex(config.roundId), shardId: 0,
    participantLockHash: unhex("33".repeat(32)), ticketCount: 4n,
    principal: 4n * config.ticketPrice, positionBase: 0n, entryNonce: 0n,
    entropyCommitment: new Uint8Array(32),
  }];
  const host = new core.MmrHost();
  host.append(core.entryLeaf(prior[0]));
  const seeded = {
    ...shard, ticketCount: 4n, entryCount: 1n, sequence: 1n,
    peaks: derivePeaks(prior),
    accumulatorRoot: hex(host.root()),
  };
  const second = buildEntryTx({
    manifest: MANIFEST, config, schedule: decodeSchedule(unhex(V.prize_schedule_v2.hex)),
    shard: seeded, lock, participantLockHash: "33".repeat(32), tickets: 2n,
    nowEpoch: 1005n, configCellOutPoint: CONFIG_DEP,
  });
  assert.strictEqual(second.entry.positionBase, 4n, "positions continue");
  assert.strictEqual(second.entry.entryNonce, 1n, "the nonce continues");
});

test("peaks that do not fit the shard are refused with a usable message", () => {
  // The chain stores only the root, so a client must rebuild the peaks. Both
  // ways of getting that wrong are refused here rather than surfacing as an
  // opaque -33 after the visitor has signed.
  const wrongCount = { ...shard, entryCount: 2n, peaks: [] };
  assert.throws(() => buildEntryTx({
    manifest: MANIFEST, config, schedule: decodeSchedule(unhex(V.prize_schedule_v2.hex)),
    shard: wrongCount, lock, participantLockHash: "33".repeat(32), tickets: 1n,
    nowEpoch: 1005n, configCellOutPoint: CONFIG_DEP,
  }), /peak/i);

  const wrongPeaks = {
    ...shard, entryCount: 1n, peaks: ["aa".repeat(32)],
    accumulatorRoot: "bb".repeat(32),
  };
  assert.throws(() => buildEntryTx({
    manifest: MANIFEST, config, schedule: decodeSchedule(unhex(V.prize_schedule_v2.hex)),
    shard: wrongPeaks, lock, participantLockHash: "33".repeat(32), tickets: 1n,
    nowEpoch: 1005n, configCellOutPoint: CONFIG_DEP,
  }), /accumulator root/i);
});
