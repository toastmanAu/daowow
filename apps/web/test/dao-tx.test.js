"use strict";
// DAO phase one: a batch's deposit becomes a withdrawing cell.
// Rules from contracts/dao-lock/src/main.rs (phase_one,
// authenticated_deposit_receipt) and the native DAO (RFC 0023).
const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const { buildDaoPhaseOneTx, phaseOneSince, EPOCHS_PER_TERM } = require("../chain/dao-tx.js");
const { decodeRoundConfigV1 } = require("../chain/codec.js");
const { loadManifest } = require("../chain/manifest.js");
const { scriptHash } = require("../chain/refund-tx.js");

const V = JSON.parse(fs.readFileSync(path.join(
  __dirname, "..", "..", "..", "tests", "vectors", "daowow_core_vectors.json"), "utf8"));
const MANIFEST = loadManifest(JSON.parse(fs.readFileSync(path.join(
  __dirname, "..", "..", "..", "deployments", "dev-testnet-manifest.json"), "utf8")));
const unhex = (s) => Uint8Array.from(s.match(/../g).map((b) => parseInt(b, 16)));
const CKB = 100000000n;
const ABSOLUTE_EPOCH_FLAG = 0x2000000000000000n;

const NATIVE_DAO = {
  codeHash: "0x82d76d1b75fe2fd9a27dfbaa65a039221a380d76c926f378d3f81cf3e7e13f2e",
  hashType: "type", args: "0x",
};
const RAW = decodeRoundConfigV1(unhex(V.aggregation_state.config.hex));
// The vector's config commits two DAO terms; the live rounds commit one.
const CONFIG = { ...RAW, daoType: { codeHash: scriptHash(NATIVE_DAO), hashType: 1 }, daoTermPeriods: 1 };
const HASH_TYPE = { 0: "data", 1: "type", 2: "data1", 4: "data2" };
const u64leHex = (v) => {
  const b = new Uint8Array(8);
  new DataView(b.buffer).setBigUint64(0, BigInt(v), true);
  return Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
};
const daoLock = (batchId, digestByte) => ({
  codeHash: "0x" + CONFIG.daoLock.codeHash,
  hashType: HASH_TYPE[CONFIG.daoLock.hashType],
  args: "0x" + CONFIG.roundId + u64leHex(batchId) + CONFIG.commitment + digestByte.repeat(32),
});
const deposit = (n, batchId, capacityCkb) => ({
  outPoint: { txHash: "0x" + String(n).repeat(64), index: 1 },
  receiptOutPoint: { txHash: "0x" + String(n).repeat(64), index: 2 },
  capacity: capacityCkb * CKB,
  lock: daoLock(batchId, "a" + n),
  type: NATIVE_DAO,
});
// Epoch field: length << 40 | index << 24 | number.
const epochField = (number, index, length) => "0x" + ((length << 40n) | (index << 24n) | number).toString(16);
const deposits = [deposit(1, 0n, 50237n), deposit(2, 1n, 31000n)];
const depositHeaders = [
  { hash: "0x" + "d1".repeat(32), number: "0x15f9000", epoch: epochField(14170n, 700n, 1800n) },
  { hash: "0x" + "d2".repeat(32), number: "0x15f9400", epoch: epochField(14171n, 12n, 1750n) },
];
const code = (byte, index) => ({ outPoint: { txHash: "0x" + byte.repeat(32), index }, depType: "code" });
const sponsor = {
  outPoint: { txHash: "0x" + "55".repeat(32), index: 1 },
  capacity: 1000n * CKB,
  lock: { codeHash: "0x" + "22".repeat(32), hashType: "type", args: "0x" + "ab".repeat(20) },
  // The system lock, expanded: its code cell and the data table it loads.
  lockDeps: [code("77", 1), code("77", 3)],
};
const base = (over = {}) => ({
  manifest: MANIFEST, config: CONFIG, deposits, depositHeaders,
  configCellOutPoint: { txHash: "0x" + "44".repeat(32), index: 0 },
  daoTypeDep: { ...code("99", 2), script: NATIVE_DAO },
  sponsor, ...over,
});

test("output i corresponds to input i, position for position", () => {
  // A builder that appends outputs breaks this silently. Two deposits of
  // different sizes, so the pairing is observable.
  const { tx } = buildDaoPhaseOneTx(base());
  deposits.forEach((d, i) => {
    assert.deepStrictEqual(tx.inputs[i].previousOutput, d.outPoint);
    assert.strictEqual(BigInt(tx.outputs[i].capacity), d.capacity);
    assert.deepStrictEqual(tx.outputs[i].lock, d.lock, "no lock substitution");
    assert.deepStrictEqual(tx.outputs[i].type, NATIVE_DAO);
  });
});

test("each withdrawing cell carries its DEPOSIT's block number", () => {
  const { tx } = buildDaoPhaseOneTx(base());
  deposits.forEach((d, i) => {
    assert.strictEqual(tx.outputsData[i], "0x" + u64leHex(BigInt(depositHeaders[i].number)));
  });
  assert.notStrictEqual(tx.outputsData[0], tx.outputsData[1]);
});

test("the sponsor comes after every deposit, on both sides", () => {
  const { tx, fee } = buildDaoPhaseOneTx(base());
  assert.strictEqual(tx.inputs.length, 3);
  assert.strictEqual(tx.outputs.length, 3);
  assert.deepStrictEqual(tx.inputs[2].previousOutput, sponsor.outPoint);
  assert.strictEqual(tx.outputs[2].type, null);
  assert.deepStrictEqual(tx.outputs[2].lock, sponsor.lock);
  assert.strictEqual(BigInt(tx.outputs[2].capacity), sponsor.capacity - fee);
  assert.strictEqual(tx.outputsData[2], "0x");
  assert.strictEqual(tx.witnesses.length, tx.inputs.length);
});

test("capacity is conserved apart from the fee, which only the sponsor pays", () => {
  const { tx, fee } = buildDaoPhaseOneTx(base());
  const inTotal = deposits.reduce((s, d) => s + d.capacity, 0n) + sponsor.capacity;
  const outTotal = tx.outputs.reduce((s, o) => s + BigInt(o.capacity), 0n);
  assert.strictEqual(inTotal - outTotal, fee);
});

test("the since is one whole epoch past a full term from the DEPOSIT", () => {
  // dao-lock refuses phase one before deposit + 180 x periods
  // (absolute_epoch_after_dao_term). Naming the very next epoch, with no
  // fraction, clears that for any deposit fraction.
  const { tx, sinceEpochs } = buildDaoPhaseOneTx(base());
  assert.strictEqual(EPOCHS_PER_TERM, 180n);
  assert.deepStrictEqual(sinceEpochs, [14170n + 181n, 14171n + 181n]);
  assert.strictEqual(tx.inputs[0].since, ABSOLUTE_EPOCH_FLAG | 14351n);
  assert.strictEqual(tx.inputs[1].since, ABSOLUTE_EPOCH_FLAG | 14352n);
  assert.strictEqual(tx.inputs[2].since, 0n, "the sponsor waits for nothing");
});

test("more terms push the since out by 180 epochs each", () => {
  const { sinceEpochs } = buildDaoPhaseOneTx(base({ config: { ...CONFIG, daoTermPeriods: 2 } }));
  assert.deepStrictEqual(sinceEpochs, [14170n + 361n, 14171n + 361n]);
  assert.strictEqual(phaseOneSince(epochField(10n, 0n, 0n), 3), ABSOLUTE_EPOCH_FLAG | 551n);
});

test("the withdrawal matures a full native cycle later, and the builder says when", () => {
  // The native DAO rounds the stay UP to whole 180-epoch cycles from the
  // deposit. Phase one cannot land before deposit + 180, so the first cycle
  // boundary it can catch is deposit + 360: about sixty days, not thirty.
  const { maturityEpochs } = buildDaoPhaseOneTx(base());
  assert.deepStrictEqual(maturityEpochs, [14170n + 360n, 14171n + 360n]);
});

test("the header deps are the deposits' own blocks, once each", () => {
  const { tx } = buildDaoPhaseOneTx(base());
  assert.deepStrictEqual(tx.headerDeps, [depositHeaders[0].hash, depositHeaders[1].hash]);
  const sameBlock = [depositHeaders[0], depositHeaders[0]];
  const one = buildDaoPhaseOneTx(base({ depositHeaders: sameBlock }));
  assert.deepStrictEqual(one.tx.headerDeps, [depositHeaders[0].hash], "a repeated header dep is refused by the node");
});

test("the cell deps are the lock, the config, the native DAO, every receipt and the sponsor's lock", () => {
  const { tx } = buildDaoPhaseOneTx(base());
  const lock = MANIFEST.scripts["dao-lock"];
  assert.deepStrictEqual(tx.cellDeps, [
    { outPoint: lock.outPoint, depType: lock.depType },
    { outPoint: { txHash: "0x" + "44".repeat(32), index: 0 }, depType: "code" },
    code("99", 2),
    { outPoint: deposits[0].receiptOutPoint, depType: "code" },
    { outPoint: deposits[1].receiptOutPoint, depType: "code" },
    ...sponsor.lockDeps,
  ]);
});

test("a dep group is refused: the lock reads deps by position and supports only code deps", () => {
  // dao-lock authenticated_deposit_receipt returns false on any dep that is
  // not a plain code dep. The system lock normally ships as a dep group.
  const group = { outPoint: { txHash: "0x" + "78".repeat(32), index: 0 }, depType: "depGroup" };
  assert.throws(() => buildDaoPhaseOneTx(base({ sponsor: { ...sponsor, lockDeps: [group] } })),
    /dep group/);
});

test("the same cell named twice as a dep is refused", () => {
  assert.throws(
    () => buildDaoPhaseOneTx(base({ sponsor: { ...sponsor, lockDeps: [code("77", 1), code("77", 1)] } })),
    /twice/);
  assert.throws(
    () => buildDaoPhaseOneTx(base({ sponsor: { ...sponsor, lockDeps: [code("99", 2)] } })),
    /twice/);
});

test("the sponsor's lock deps are required", () => {
  const { lockDeps, ...bare } = sponsor;
  assert.throws(() => buildDaoPhaseOneTx(base({ sponsor: bare })), /lockDeps/);
  assert.throws(() => buildDaoPhaseOneTx(base({ sponsor: { ...sponsor, lockDeps: [] } })), /lockDeps/);
});

test("a receipt from a different transaction than its deposit is refused", () => {
  // The lock binds the receipt and the deposit to one creation transaction.
  const stray = { ...deposits[0], receiptOutPoint: { txHash: "0x" + "3".repeat(64), index: 2 } };
  assert.throws(() => buildDaoPhaseOneTx(base({ deposits: [stray, deposits[1]] })), /same transaction/);
  const { receiptOutPoint, ...none } = deposits[0];
  assert.throws(() => buildDaoPhaseOneTx(base({ deposits: [none, deposits[1]] })), /receipt/);
});

test("a deposit under another lock, round or config is refused", () => {
  const swap = (lock) => base({ deposits: [{ ...deposits[0], lock }, deposits[1]] });
  const good = deposits[0].lock;
  assert.throws(() => buildDaoPhaseOneTx(swap({ ...good, codeHash: "0x" + "ee".repeat(32) })), /DAOWOW lock/);
  assert.throws(() => buildDaoPhaseOneTx(swap({ ...good, hashType: "type" })), /DAOWOW lock/);
  assert.throws(() => buildDaoPhaseOneTx(swap({ ...good, args: good.args.slice(0, -2) })), /104 bytes/);
  const otherRound = "0x" + "ff".repeat(32) + good.args.slice(66);
  assert.throws(() => buildDaoPhaseOneTx(swap({ ...good, args: otherRound })), /different round/);
  const otherConfig = good.args.slice(0, 82) + "ee".repeat(32) + good.args.slice(146);
  assert.throws(() => buildDaoPhaseOneTx(swap({ ...good, args: otherConfig })), /different round/);
});

test("two deposits under one lock are refused: each lock may spend one cell", () => {
  // phase_one: group_abs.len() != 1 is DAO_ERROR_PHASE1_STRUCTURE.
  const twin = { ...deposits[1], lock: deposits[0].lock };
  assert.throws(() => buildDaoPhaseOneTx(base({ deposits: [deposits[0], twin] })), /one cell/);
});

test("a deposit that is not a native DAO cell is refused", () => {
  const typed = (type) => base({ deposits: [{ ...deposits[0], type }, deposits[1]] });
  assert.throws(() => buildDaoPhaseOneTx(typed(null)), /native DAO/);
  assert.throws(() => buildDaoPhaseOneTx(typed({ ...NATIVE_DAO, args: "0x00" })), /native DAO/);
  assert.throws(() => buildDaoPhaseOneTx(base({ daoTypeDep: code("99", 2) })), /native DAO/);
});

test("deposits and their headers must pair up", () => {
  assert.throws(() => buildDaoPhaseOneTx(base({ depositHeaders: [depositHeaders[0]] })), /header for each deposit/);
  assert.throws(() => buildDaoPhaseOneTx(base({ deposits: [], depositHeaders: [] })), /at least one deposit/);
});

test("a sponsor that cannot pay the fee and keep a cell is refused", () => {
  assert.throws(() => buildDaoPhaseOneTx(base({ sponsor: { ...sponsor, capacity: 61n * CKB } })), /61 CKB/);
  assert.doesNotThrow(() => buildDaoPhaseOneTx(base({ sponsor: { ...sponsor, capacity: 62n * CKB } })));
});

test("the config cell is required", () => {
  assert.throws(() => buildDaoPhaseOneTx(base({ configCellOutPoint: null })), /config cell/);
});

test("a DAO script the config does not commit to is refused, even if the deposits carry it", () => {
  // Deposits and dep agreeing with each other proves nothing: the contract
  // compares against the hash in the round's config.
  const other = { ...NATIVE_DAO, args: "0x01" };
  assert.throws(() => buildDaoPhaseOneTx(base({
    daoTypeDep: { ...code("99", 2), script: other },
    deposits: deposits.map((d) => ({ ...d, type: other })),
  })), /commits to/);
});
