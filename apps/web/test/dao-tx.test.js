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

// ===========================================================================
// DAO phase two: the withdrawing cell becomes the batch's settlement cell.
// Rules: dao-lock phase_two, daowow-contracts-common validate_initial_funding,
// settlement-type creation, and the native DAO's own withdrawal (RFC 0023).
// ===========================================================================
const {
  buildDaoPhaseTwoTx, maturityOf, encodeWitnessArgs, withdrawingCellOccupied,
} = require("../chain/dao-tx.js");
const { decodeEntropyRecord } = require("../chain/seal-codec.js");
const { decodeBatchCommitment } = require("../chain/ledger-codec.js");
const { decodeEntryDataV1 } = require("../chain/entry-codec.js");
const { decodeSchedule } = require("../chain/schedule.js");
const { decodeSettlementFunding } = require("../chain/settlement-codec.js");
const { deriveEntitlements, encodeEntitlementWitness } = require("../chain/entitlements.js");

const D = V.computed_draw;
const E2 = D.entitlements;
const hexOf = (b) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
const RAW2 = decodeRoundConfigV1(unhex(D.config));
// The drawn round's own config, with the one field the fixture must own: the
// DAO type hash. Nothing the entitlements depend on reads it... except the
// commitment, so the commitment is taken from the vector, not recomputed.
const CONFIG2 = { ...RAW2, daoType: { codeHash: scriptHash(NATIVE_DAO), hashType: 1 }, commitment: D.commitment };
// The vector's config names placeholder scripts, so the fixture manifest says
// the settlement script is deployed where the config says it is.
const MANIFEST2 = {
  ...MANIFEST,
  scripts: {
    ...MANIFEST.scripts,
    "settlement-type": {
      ...MANIFEST.scripts["settlement-type"],
      codeHash: "0x" + RAW2.settlementType.codeHash, hashType: HASH_TYPE[RAW2.settlementType.hashType],
    },
  },
};
const RECORD = decodeEntropyRecord(unhex(D.record), 1);
const SCHEDULE = decodeSchedule(unhex(D.schedule));
const RECEIPT = decodeBatchCommitment(unhex(E2.receipt));
const ENTRIES = E2.entries.map((h) => decodeEntryDataV1(unhex(h)));
const CAPACITIES = E2.capacities.map(BigInt);
const daoHeader = (number, epoch, ar) => ({
  hash: "0x" + number.toString(16).padStart(64, "0"), number: "0x" + number.toString(16), epoch,
  // dao field: C (8) | AR (8) | S (8) | U (8), little-endian.
  dao: "0x" + "11".repeat(8) + u64leHex(ar) + "22".repeat(8) + "33".repeat(8),
});
const DEPOSIT_HEADER = daoHeader(23018766n, epochField(14170n, 700n, 1800n), 10000000000000000n);
// Far from the deposit on purpose, so reading the wrong header is visibly wrong.
const WITHDRAW_HEADER = daoHeader(23400000n, epochField(14351n, 100n, 1700n), 10023000000000000n);
const lock2 = {
  codeHash: "0x" + CONFIG2.daoLock.codeHash, hashType: HASH_TYPE[CONFIG2.daoLock.hashType],
  args: "0x" + CONFIG2.roundId + u64leHex(0n) + CONFIG2.commitment + RECEIPT.digest,
};
const withdrawing = {
  outPoint: { txHash: "0x" + "a1".repeat(32), index: 0 },
  receiptOutPoint: { txHash: "0x" + "b2".repeat(32), index: 2 },
  capacity: RECEIPT.inputCapacity,
  lock: lock2, type: NATIVE_DAO,
  data: "0x" + u64leHex(BigInt(DEPOSIT_HEADER.number)),
};
const base2 = (over = {}) => ({
  manifest: MANIFEST2, config: CONFIG2, withdrawing,
  depositHeader: DEPOSIT_HEADER, withdrawHeader: WITHDRAW_HEADER,
  record: RECORD, recordOutPoint: { txHash: "0x" + "c3".repeat(32), index: 0 },
  schedule: SCHEDULE, receipt: RECEIPT, entries: ENTRIES, capacities: CAPACITIES,
  configCellOutPoint: { txHash: "0x" + "44".repeat(32), index: 0 },
  daoTypeDep: { ...code("99", 2), script: NATIVE_DAO },
  sponsor, ...over,
});
const OCCUPIED = 186n * CKB;
const REALIZED = OCCUPIED
  + ((RECEIPT.inputCapacity - OCCUPIED) * 10023000000000000n) / 10000000000000000n;

test("the since is measured from the DEPOSIT, not the withdrawal", () => {
  // Recorded as a live bug in ckb-transactions.feedback.md (2026-06-16): a
  // scanner read the withdrawing cell's own block and computed W+180.
  const { tx, maturity } = buildDaoPhaseTwoTx(base2());
  const depositEpoch = BigInt(DEPOSIT_HEADER.epoch) & 0xffffffn;
  const withdrawEpoch = BigInt(WITHDRAW_HEADER.epoch) & 0xffffffn;
  assert.strictEqual(maturity.epoch, depositEpoch + 360n);
  assert.strictEqual(tx.inputs[0].since & 0xffffffn, maturity.epoch);
  assert.strictEqual(tx.inputs[0].since >> 56n, 0x20n, "an absolute epoch");
  assert.notStrictEqual(maturity.epoch, withdrawEpoch + 180n);
  assert.notStrictEqual(maturity.epoch, withdrawEpoch + 360n);
});

test("the since keeps the deposit's own fraction of its epoch", () => {
  // RFC 0023: the cell matures at the same point WITHIN the epoch as it was
  // deposited, a whole number of cycles later.
  const { tx } = buildDaoPhaseTwoTx(base2());
  const since = tx.inputs[0].since;
  assert.strictEqual((since >> 24n) & 0xffffn, 700n);
  assert.strictEqual((since >> 40n) & 0xffffn, 1800n);
});

test("maturity rounds the stay up to whole 180-epoch cycles, by fraction", () => {
  const dep = epochField(1000n, 500n, 1000n);
  const at = (number, index, length) => maturityOf(dep, epochField(number, index, length)).epoch;
  assert.strictEqual(at(1001n, 0n, 1000n), 1180n);
  assert.strictEqual(at(1180n, 499n, 1000n), 1180n, "just short of a full cycle: still the first");
  assert.strictEqual(at(1180n, 500n, 1000n), 1180n, "exactly a full cycle");
  assert.strictEqual(at(1180n, 501n, 1000n), 1360n, "one block past it: the next cycle");
  assert.strictEqual(at(1180n, 251n, 500n), 1360n, "fractions compare by cross-multiplying, not by index");
  assert.strictEqual(at(1181n, 0n, 1000n), 1360n);
  assert.strictEqual(at(1360n, 500n, 1000n), 1360n);
  assert.strictEqual(at(1360n, 501n, 1000n), 1540n);
});

test("the realised total is the native DAO's own figure: interest on free capacity only", () => {
  assert.strictEqual(withdrawingCellOccupied(withdrawing), OCCUPIED);
  const { tx, realized } = buildDaoPhaseTwoTx(base2());
  assert.strictEqual(realized, REALIZED);
  assert.strictEqual(BigInt(tx.outputs[0].capacity), REALIZED, "exactly, or the contract refuses");
});

test("the rates are read from the deposit's block and the withdrawal's block, that way round", () => {
  // Only the ratio matters, so doubling both leaves the figure where it was.
  const doubled = buildDaoPhaseTwoTx(base2({
    depositHeader: daoHeader(23018766n, DEPOSIT_HEADER.epoch, 20000000000000000n),
    withdrawHeader: daoHeader(23400000n, WITHDRAW_HEADER.epoch, 20046000000000000n),
  }));
  assert.strictEqual(doubled.realized, REALIZED);
  // The two headers exchanged: the "withdrawal" rate is now the lower one.
  assert.throws(() => buildDaoPhaseTwoTx(base2({
    depositHeader: { ...DEPOSIT_HEADER, dao: WITHDRAW_HEADER.dao },
    withdrawHeader: { ...WITHDRAW_HEADER, dao: DEPOSIT_HEADER.dao },
  })), /rate/);
});

test("the settlement cell holds exactly what the contract will derive", () => {
  const { tx, entitlements } = buildDaoPhaseTwoTx(base2());
  const expected = deriveEntitlements({
    config: CONFIG2, record: RECORD, schedule: SCHEDULE, batchId: 0n, receipt: RECEIPT,
    entries: ENTRIES, capacities: CAPACITIES, realizedTotal: REALIZED,
  });
  const funding = decodeSettlementFunding(unhex(tx.outputsData[0].slice(2)));
  assert.deepStrictEqual(funding, expected.funding);
  assert.deepStrictEqual(entitlements.liabilities, expected.liabilities);
  assert.strictEqual(funding.payoutCursor, 0n);
  assert.ok(funding.liabilityCount > 0n);
  assert.strictEqual(funding.realizedTotal, REALIZED);
});

test("the settlement cell is under the public settlement lock and this batch's type", () => {
  const { tx } = buildDaoPhaseTwoTx(base2());
  const st = MANIFEST2.scripts["settlement-type"];
  assert.deepStrictEqual(tx.outputs[0].lock, { codeHash: st.codeHash, hashType: st.hashType, args: "0x00" });
  assert.deepStrictEqual(tx.outputs[0].type, {
    codeHash: st.codeHash, hashType: st.hashType,
    args: "0x" + CONFIG2.commitment + u64leHex(0n) + RECEIPT.digest,
  });
  assert.strictEqual(tx.outputs[0].type.args.length, 2 + 72 * 2);
});

test("no output is a DAO cell, and the sponsor's change is the only other output", () => {
  // validate_initial_funding refuses ANY output of the native DAO type.
  const { tx, fee } = buildDaoPhaseTwoTx(base2());
  assert.strictEqual(tx.outputs.length, 2);
  for (const o of tx.outputs) assert.notDeepStrictEqual(o.type, NATIVE_DAO);
  assert.strictEqual(tx.outputs[1].type, null);
  assert.strictEqual(BigInt(tx.outputs[1].capacity), sponsor.capacity - fee);
  assert.deepStrictEqual(tx.inputs.map((i) => i.previousOutput), [withdrawing.outPoint, sponsor.outPoint]);
  assert.strictEqual(tx.inputs[1].since, 0n);
});

test("the header deps are the deposit's block then the withdrawal's", () => {
  const { tx } = buildDaoPhaseTwoTx(base2());
  assert.deepStrictEqual(tx.headerDeps, [DEPOSIT_HEADER.hash, WITHDRAW_HEADER.hash]);
});

test("the DAO input's witness names the deposit header and carries the batch evidence", async () => {
  const { tx } = buildDaoPhaseTwoTx(base2());
  const payload = encodeEntitlementWitness(SCHEDULE, ENTRIES, CAPACITIES);
  assert.strictEqual(hexOf(payload), E2.witness, "the evidence is Rust's own encoding");
  // Checked against the vendored CKB library's WitnessArgs, not our own reading of molecule.
  const { ccc } = await import("../vendor/ccc.min.mjs");
  const args = ccc.WitnessArgs.fromBytes(ccc.bytesFrom(tx.witnesses[0]));
  assert.strictEqual(args.lock, undefined);
  assert.strictEqual(args.inputType, "0x" + "00".repeat(8), "header dep index 0, as eight LE bytes");
  assert.strictEqual(args.outputType, "0x" + E2.witness);
  assert.strictEqual(tx.witnesses.length, 2);
  assert.strictEqual(tx.witnesses[1], "0x");
});

test("the WitnessArgs encoder matches the CKB library for every mix of fields", async () => {
  const { ccc } = await import("../vendor/ccc.min.mjs");
  const some = [undefined, new Uint8Array(0), Uint8Array.from([1, 2, 3])];
  for (const lock of some) for (const inputType of some) for (const outputType of some) {
    const ours = "0x" + hexOf(encodeWitnessArgs({ lock, inputType, outputType }));
    const theirs = ccc.hexFrom(ccc.WitnessArgs.from({ lock, inputType, outputType }).toBytes());
    assert.strictEqual(ours, theirs);
  }
  // The classic DAO phase-two witness, from memory of the wire.
  assert.strictEqual(
    "0x" + hexOf(encodeWitnessArgs({ inputType: new Uint8Array(8) })),
    "0x1c00000010000000100000001c000000080000000000000000000000");
});

test("the cell deps are the two scripts, the config, the DAO, the receipt, the record and the sponsor's lock", () => {
  const { tx } = buildDaoPhaseTwoTx(base2());
  const dl = MANIFEST2.scripts["dao-lock"], st = MANIFEST2.scripts["settlement-type"];
  assert.deepStrictEqual(tx.cellDeps, [
    { outPoint: dl.outPoint, depType: dl.depType },
    { outPoint: st.outPoint, depType: st.depType },
    { outPoint: { txHash: "0x" + "44".repeat(32), index: 0 }, depType: "code" },
    code("99", 2),
    { outPoint: withdrawing.receiptOutPoint, depType: "code" },
    { outPoint: { txHash: "0x" + "c3".repeat(32), index: 0 }, depType: "code" },
    ...sponsor.lockDeps,
  ]);
});

test("a deposit that has not been through phase one is refused", () => {
  assert.throws(() => buildDaoPhaseTwoTx(base2({ withdrawing: { ...withdrawing, data: "0x" + "00".repeat(8) } })),
    /phase one/);
  assert.throws(() => buildDaoPhaseTwoTx(base2({ withdrawing: { ...withdrawing, data: "0x" + u64leHex(5n) } })),
    /deposit header/);
  assert.throws(() => buildDaoPhaseTwoTx(base2({ withdrawing: { ...withdrawing, data: "0x" } })), /phase one/);
});

test("a withdrawal before the round's result is recorded is refused", () => {
  // The contract needs the entropy record as a cell dep: prizes cannot be
  // assigned to tickets until the draw is fixed.
  assert.throws(() => buildDaoPhaseTwoTx(base2({ record: null })), /result/);
  assert.throws(() => buildDaoPhaseTwoTx(base2({ recordOutPoint: null })), /result/);
});

test("a withdrawing cell that is not this batch's is refused", () => {
  const otherDigest = { ...lock2, args: lock2.args.slice(0, -64) + "ee".repeat(32) };
  assert.throws(() => buildDaoPhaseTwoTx(base2({ withdrawing: { ...withdrawing, lock: otherDigest } })), /receipt/);
  const otherBatch = { ...lock2, args: lock2.args.slice(0, 66) + u64leHex(1n) + lock2.args.slice(82) };
  assert.throws(() => buildDaoPhaseTwoTx(base2({ withdrawing: { ...withdrawing, lock: otherBatch } })), /accepted|receipt/);
  assert.throws(() => buildDaoPhaseTwoTx(base2({ withdrawing: { ...withdrawing, capacity: withdrawing.capacity + 1n } })),
    /capacity/);
  assert.throws(() => buildDaoPhaseTwoTx(base2({ withdrawing: { ...withdrawing, type: null } })), /native DAO/);
  assert.throws(() => buildDaoPhaseTwoTx(base2({ withdrawing: { ...withdrawing, lock: { ...lock2, codeHash: "0x" + "ee".repeat(32) } } })),
    /DAOWOW lock/);
});

test("a manifest whose settlement script is not the config's is refused", () => {
  // The real manifest's settlement script is not the vector config's.
  assert.throws(() => buildDaoPhaseTwoTx(base2({ manifest: MANIFEST })), /settlement/);
  const wrongKind = { ...MANIFEST2, scripts: { ...MANIFEST2.scripts, "settlement-type": { ...MANIFEST2.scripts["settlement-type"], hashType: "type" } } };
  assert.throws(() => buildDaoPhaseTwoTx(base2({ manifest: wrongKind })), /settlement/);
});

test("phase two also takes only plain code deps, each once, and a sponsor that can pay", () => {
  const group = { outPoint: { txHash: "0x" + "78".repeat(32), index: 0 }, depType: "depGroup" };
  assert.throws(() => buildDaoPhaseTwoTx(base2({ sponsor: { ...sponsor, lockDeps: [group] } })), /dep group/);
  assert.throws(() => buildDaoPhaseTwoTx(base2({ sponsor: { ...sponsor, capacity: 61n * CKB } })), /61 CKB/);
  assert.throws(() => buildDaoPhaseTwoTx(base2({ configCellOutPoint: null })), /config cell/);
});
