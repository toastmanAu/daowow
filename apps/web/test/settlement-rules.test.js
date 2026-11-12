"use strict";
// tools/settlement-rules.mjs: the gate 3c rules re-derived from a FINISHED
// transaction. Each test starts from a transaction the builders produce, which
// must pass clean, then breaks one thing and expects that one reason.
const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const core = require("../core.js");
const { buildDaoPhaseOneTx, buildDaoPhaseTwoTx, encodeWitnessArgs } = require("../chain/dao-tx.js");
const { buildPayoutTx, encodeSettlementWitness, decodeSettlementWitness } = require("../chain/payout-tx.js");
const { decodeRoundConfigV1 } = require("../chain/codec.js");
const { decodeEntropyRecord } = require("../chain/seal-codec.js");
const { decodeBatchCommitment, encodeBatchCommitment } = require("../chain/ledger-codec.js");
const { decodeEntryDataV1 } = require("../chain/entry-codec.js");
const { decodeSchedule } = require("../chain/schedule.js");
const { decodeSettlementFunding, encodeSettlementFunding } = require("../chain/settlement-codec.js");
const { scriptHash } = require("../chain/refund-tx.js");

const ROOT = path.join(__dirname, "..", "..", "..");
const load = () => import(path.join(ROOT, "tools", "settlement-rules.mjs"));
const V = JSON.parse(fs.readFileSync(path.join(ROOT, "tests", "vectors", "daowow_core_vectors.json"), "utf8"));
const unhex = (s) => Uint8Array.from((s.startsWith("0x") ? s.slice(2) : s).match(/../g) ?? [], (b) => parseInt(b, 16));
const hex = (b) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
const CKB = 100000000n;
const HASH_TYPE = { 0: "data", 1: "type", 2: "data1", 4: "data2" };
const u64 = (v) => hex(core.u64le(BigInt(v)));
const clone = (tx) => ({
  ...tx, cellDeps: tx.cellDeps.map((d) => ({ ...d })), headerDeps: [...tx.headerDeps],
  inputs: tx.inputs.map((i) => ({ ...i })), outputs: tx.outputs.map((o) => ({ ...o })),
  outputsData: [...tx.outputsData], witnesses: [...tx.witnesses],
});

const D = V.computed_draw;
const E = D.entitlements;
const NATIVE_DAO = {
  codeHash: "0x82d76d1b75fe2fd9a27dfbaa65a039221a380d76c926f378d3f81cf3e7e13f2e", hashType: "type", args: "0x",
};
const RAW = decodeRoundConfigV1(unhex(D.config));
const CONFIG = { ...RAW, daoType: { codeHash: scriptHash(NATIVE_DAO), hashType: 1 }, commitment: D.commitment, daoTermPeriods: 1 };
const scriptOf = (ref, args) => ({ codeHash: "0x" + ref.codeHash, hashType: HASH_TYPE[ref.hashType], args });
const outPoint = (byte, index) => ({ txHash: "0x" + byte.repeat(32), index });
const MANIFEST = {
  scripts: {
    "dao-lock": { ...scriptOf(CONFIG.daoLock, "0x"), outPoint: outPoint("d0", 0), depType: "code" },
    "settlement-type": { ...scriptOf(CONFIG.settlementType, "0x"), outPoint: outPoint("d1", 0), depType: "code" },
  },
};
const RECEIPT = decodeBatchCommitment(unhex(E.receipt));
const epochField = (number, index, length) => "0x" + ((length << 40n) | (index << 24n) | number).toString(16);
const header = (number, epoch, ar) => ({
  hash: "0x" + number.toString(16).padStart(64, "0"), number: "0x" + number.toString(16), epoch,
  dao: "0x" + "11".repeat(8) + u64(ar) + "22".repeat(8) + "33".repeat(8),
});
const DEPOSIT_HEADER = header(23018766n, epochField(14170n, 700n, 1800n), 10000000000000000n);
const WITHDRAW_HEADER = header(23400000n, epochField(14351n, 100n, 1700n), 10023000000000000n);
const DAO_LOCK = scriptOf(CONFIG.daoLock, "0x" + CONFIG.roundId + u64(0n) + CONFIG.commitment + RECEIPT.digest);
const sponsorCell = {
  capacity: 1000n * CKB, lock: { codeHash: "0x" + "22".repeat(32), hashType: "type", args: "0x" + "ab".repeat(20) },
  type: null, data: "0x",
};
const sponsor = {
  outPoint: outPoint("55", 1), capacity: sponsorCell.capacity, lock: sponsorCell.lock,
  lockDeps: [{ outPoint: outPoint("77", 1), depType: "code" }, { outPoint: outPoint("77", 3), depType: "code" }],
};
const publicShardLock = scriptOf(CONFIG.entryShardType, "0x00");
const receiptCell = {
  capacity: 225n * CKB, lock: publicShardLock, data: "0x" + E.receipt,
  type: scriptOf(CONFIG.entryShardType, "0x02" + CONFIG.commitment + "00000000" + u64(0n) + RECEIPT.digest),
};
const recordCell = {
  capacity: 460n * CKB, lock: publicShardLock, data: "0x" + D.record,
  type: scriptOf(CONFIG.entryShardType, "0x" + CONFIG.commitment + "00000000"),
};
const DEPOSIT_TX = "a1";
const depositCell = { capacity: RECEIPT.inputCapacity, lock: DAO_LOCK, type: NATIVE_DAO, data: "0x" + "00".repeat(8) };
const daoTypeDep = { outPoint: outPoint("99", 2), depType: "code", script: NATIVE_DAO };

// ---- phase one ---------------------------------------------------------------
function phaseOne() {
  const { tx } = buildDaoPhaseOneTx({
    manifest: MANIFEST, config: CONFIG, sponsor, daoTypeDep,
    deposits: [{
      outPoint: outPoint(DEPOSIT_TX, 1), receiptOutPoint: outPoint(DEPOSIT_TX, 2),
      capacity: depositCell.capacity, lock: DAO_LOCK, type: NATIVE_DAO,
    }],
    depositHeaders: [DEPOSIT_HEADER], configCellOutPoint: outPoint("44", 0),
  });
  return {
    config: CONFIG, tx: clone(tx),
    inputCells: [depositCell, sponsorCell], inputHeaders: [DEPOSIT_HEADER, null],
    // In cell dep order: lock code, config, DAO code, receipt, sponsor's two.
    depCells: [null, null, null, receiptCell, null, null],
  };
}

test("phase one: what the builder makes passes every rule", async () => {
  const { checkDaoPhaseOne } = await load();
  assert.deepStrictEqual(checkDaoPhaseOne(phaseOne()), []);
});

const ONE = [
  ["an appended output breaks the pairing", (c) => { c.tx.outputs.reverse(); c.tx.outputsData.reverse(); }, /not a native DAO cell|capacity|shannons/],
  ["a changed capacity", (c) => { c.tx.outputs[0].capacity -= 1n; }, /shannons, not input 0's/],
  ["a substituted lock", (c) => { c.tx.outputs[0].lock = { ...DAO_LOCK, args: DAO_LOCK.args.slice(0, -2) + "00" }; }, /no lock substitution/],
  ["a dropped DAO type", (c) => { c.tx.outputs[0].type = null; }, /output 0 is not a native DAO cell/],
  ["data that is not the deposit's block number", (c) => { c.tx.outputsData[0] = "0x" + "00".repeat(8); }, /deposit block number/],
  ["a since before a full term", (c) => { c.tx.inputs[0].since -= 2n; }, /before a full term/],
  ["a since of the wrong kind", (c) => { c.tx.inputs[0].since = 14351n; }, /absolute epoch/],
  ["a missing header dep", (c) => { c.tx.headerDeps = []; }, /header deps/],
  ["a dep group", (c) => { c.tx.cellDeps[4].depType = "depGroup"; }, /dep group/],
  ["a repeated dep", (c) => { c.tx.cellDeps[5] = { ...c.tx.cellDeps[4] }; }, /already named/],
  ["a missing receipt", (c) => { c.depCells[3] = null; }, /exactly one batch receipt.*found 0/],
  ["a receipt from another transaction", (c) => { c.tx.cellDeps[3] = { outPoint: outPoint("b2", 2), depType: "code" }; }, /not created by the transaction that made the deposit/],
  ["a receipt recording another capacity", (c) => {
    c.depCells[3] = { ...receiptCell, data: "0x" + hex(encodeBatchCommitment({ ...RECEIPT, inputCapacity: RECEIPT.inputCapacity + 1n })) };
  }, /capacity is not the capacity its receipt records/],
  ["a receipt under another lock", (c) => { c.depCells[3] = { ...receiptCell, lock: sponsorCell.lock }; }, /public lock/],
  ["a cell that is already withdrawing", (c) => { c.inputCells[0] = { ...depositCell, data: "0x" + u64(5n) }; }, /phase one has already happened/],
  ["lock args of the wrong length", (c) => { c.inputCells[0] = { ...depositCell, lock: { ...DAO_LOCK, args: DAO_LOCK.args.slice(0, -2) } }; }, /must be 104 bytes/],
  ["a deposit bound to another config", (c) => {
    c.inputCells[0] = { ...depositCell, lock: { ...DAO_LOCK, args: DAO_LOCK.args.slice(0, 82) + "ee".repeat(32) + DAO_LOCK.args.slice(146) } };
  }, /different round config/],
  ["a transaction with no DAOWOW input", (c) => { c.inputCells[0] = sponsorCell; }, /no input is under/],
  ["two inputs under one lock", (c) => { c.inputCells[1] = depositCell; c.inputHeaders[1] = DEPOSIT_HEADER; }, /shares its lock/],
  ["a receipt recording another digest", (c) => {
    c.depCells[3] = { ...receiptCell, data: "0x" + hex(encodeBatchCommitment({ ...RECEIPT, digest: "ab".repeat(32) })) };
  }, /different batch digest/],
  ["an input that is not a DAO cell", (c) => { c.inputCells[0] = { ...depositCell, type: null }; }, /input 0 is not a native DAO cell/],
  ["no output to pair with", (c) => { c.tx.outputs = []; c.tx.outputsData = []; }, /no output 0 to pair/],
  ["an unknown deposit block", (c) => { c.inputHeaders[0] = null; }, /is unknown/],
  ["a deposit of another round", (c) => { c.inputCells[0] = { ...depositCell, lock: { ...DAO_LOCK, args: "0x" + "ff".repeat(32) + DAO_LOCK.args.slice(66) } }; }, /different round/],
];
for (const [name, breakIt, reason] of ONE) {
  test(`phase one refuses ${name}`, async () => {
    const { checkDaoPhaseOne } = await load();
    const c = phaseOne();
    breakIt(c);
    const reasons = checkDaoPhaseOne(c);
    assert.ok(reasons.some((r) => reason.test(r)), `expected ${reason}, got: ${reasons.join(" | ") || "(clean)"}`);
  });
}

test("the term rule is Rust's, fraction for fraction", async () => {
  // epoch.rs dao_term_preserves_the_deposit_epoch_fraction.
  const { daoTermReason } = await load();
  const FLAG = 0x2000000000000000n;
  const deposit = (1000n << 40n) | (500n << 24n) | 10n;
  const early = FLAG | (1000n << 40n) | (499n << 24n) | 190n;
  const boundary = FLAG | (2n << 40n) | (1n << 24n) | 190n;
  assert.ok(daoTermReason(early, deposit, 1));
  assert.strictEqual(daoTermReason(boundary, deposit, 1), null);
  assert.ok(daoTermReason(boundary, deposit, 2));
  assert.strictEqual(daoTermReason(FLAG | 371n, deposit, 2), null);
  assert.ok(daoTermReason(FLAG | (1n << 24n) | 200n, deposit, 1), "index without a length is not a fraction");
});

// ---- phase two ---------------------------------------------------------------
const withdrawingCell = { ...depositCell, data: "0x" + u64(BigInt(DEPOSIT_HEADER.number)) };
function phaseTwo() {
  const { tx } = buildDaoPhaseTwoTx({
    manifest: MANIFEST, config: CONFIG, sponsor, daoTypeDep,
    withdrawing: {
      outPoint: outPoint("c5", 0), receiptOutPoint: outPoint(DEPOSIT_TX, 2),
      capacity: withdrawingCell.capacity, lock: DAO_LOCK, type: NATIVE_DAO, data: withdrawingCell.data,
    },
    depositHeader: DEPOSIT_HEADER, withdrawHeader: WITHDRAW_HEADER,
    record: decodeEntropyRecord(unhex(D.record), 1), recordOutPoint: outPoint("c3", 0),
    schedule: decodeSchedule(unhex(D.schedule)), receipt: RECEIPT,
    entries: E.entries.map((h) => decodeEntryDataV1(unhex(h))), capacities: E.capacities.map(BigInt),
    configCellOutPoint: outPoint("44", 0),
  });
  return {
    config: CONFIG, tx: clone(tx),
    inputCells: [withdrawingCell, sponsorCell], inputHeaders: [WITHDRAW_HEADER, null],
    // lock code, settlement code, config, DAO code, receipt, record, sponsor's two.
    depCells: [null, null, null, null, receiptCell, recordCell, null, null],
    headers: {
      [DEPOSIT_HEADER.hash.slice(2)]: DEPOSIT_HEADER, [WITHDRAW_HEADER.hash.slice(2)]: WITHDRAW_HEADER,
    },
  };
}

test("phase two: what the builder makes passes every rule", async () => {
  const { checkDaoPhaseTwo } = await load();
  assert.deepStrictEqual(checkDaoPhaseTwo(phaseTwo()), []);
});

const mutateFunding = (c, change) => {
  const state = decodeSettlementFunding(unhex(c.tx.outputsData[0]));
  c.tx.outputsData[0] = "0x" + hex(encodeSettlementFunding({ ...state, ...change }, { unchecked: true }));
};
const TWO = [
  ["a since one epoch early", (c) => { c.tx.inputs[0].since -= 1n; }, /before maturity.*DEPOSIT/],
  ["a since at maturity's epoch but an earlier fraction", (c) => { c.tx.inputs[0].since -= (1n << 24n); }, /before maturity/],
  ["a since that is not an epoch", (c) => { c.tx.inputs[0].since = 14530n; }, /not an absolute epoch/],
  ["a settlement cell holding a shannon less", (c) => { c.tx.outputs[0].capacity -= 1n; }, /the DAO pays exactly/],
  ["a settlement cell holding a shannon more", (c) => { c.tx.outputs[0].capacity += 1n; }, /the DAO pays exactly/],
  ["a moved cursor", (c) => mutateFunding(c, { payoutCursor: 1n }), /not what the contract derives/],
  ["a changed liabilities root", (c) => mutateFunding(c, { liabilitiesRoot: "ab".repeat(32) }), /not what the contract derives/],
  ["a changed prize root", (c) => mutateFunding(c, { prizeRoot: "ab".repeat(32) }), /not what the contract derives/],
  ["a settlement cell under a private lock", (c) => { c.tx.outputs[0].lock = sponsorCell.lock; }, /public settlement lock/],
  ["a settlement cell for another batch", (c) => {
    c.tx.outputs[0].type = { ...c.tx.outputs[0].type, args: c.tx.outputs[0].type.args.slice(0, -2) + "00" };
  }, /exactly one settlement cell.*found 0/],
  ["a DAO cell among the outputs", (c) => { c.tx.outputs[1].type = NATIVE_DAO; }, /may create none/],
  ["header deps the wrong way round", (c) => { c.tx.headerDeps.reverse(); }, /not the deposit block the withdrawing cell names/],
  ["a missing withdrawal header dep", (c) => { c.tx.headerDeps = [c.tx.headerDeps[0]]; }, /withdrawal's own block/],
  ["no recorded result among the deps", (c) => { c.depCells[5] = null; }, /recorded result.*found 0/],
  ["no receipt among the deps", (c) => { c.depCells[4] = null; }, /exactly one batch receipt.*found 0/],
  ["a witness that is not a WitnessArgs", (c) => { c.tx.witnesses[0] = "0x1234"; }, /not a WitnessArgs/],
  ["evidence for a different batch", (c) => {
    c.inputCells[0] = { ...withdrawingCell, capacity: withdrawingCell.capacity + 1n };
  }, /capacity is not what its receipt records|cannot be derived/],
  ["a cell that never went through phase one", (c) => { c.inputCells[0] = depositCell; }, /phase one must be committed first/],
  ["an input that is not a DAO cell", (c) => { c.inputCells[0] = { ...withdrawingCell, type: null }; }, /input 0 is not a native DAO cell/],
  ["a witness with no header index", (c) => {
    c.tx.witnesses[0] = "0x" + hex(encodeWitnessArgs({ inputType: new Uint8Array(4), outputType: unhex(E.witness) }));
  }, /does not name the deposit header's index/],
  ["a witness pointing past the header deps", (c) => {
    c.tx.witnesses[0] = "0x" + hex(encodeWitnessArgs({ inputType: Uint8Array.from([5, 0, 0, 0, 0, 0, 0, 0]), outputType: unhex(E.witness) }));
  }, /not among the header deps/],
  ["an unknown withdrawal block", (c) => { c.inputHeaders[0] = null; }, /is unknown/],
  ["a withdrawal rate below the deposit's", (c) => {
    c.headers[DEPOSIT_HEADER.hash.slice(2)] = { ...DEPOSIT_HEADER, dao: header(1n, "0x0", 10099000000000000n).dao };
  }, /accumulated rate/],
  ["a receipt under a private lock", (c) => { c.depCells[4] = { ...receiptCell, lock: sponsorCell.lock }; }, /receipt is not under the public lock/],
  ["a recorded result under a private lock", (c) => { c.depCells[5] = { ...recordCell, lock: sponsorCell.lock }; }, /recorded result is not under the public lock/],
  ["detached evidence", (c) => {
    c.tx.witnesses[0] = "0x" + hex(encodeWitnessArgs({ inputType: new Uint8Array(8), outputType: Uint8Array.from([0, 2, 0, 0, 0]) }));
  }, /detached/],
  ["a settlement cell that already exists", (c) => { c.inputCells[1] = { ...sponsorCell, type: c.tx.outputs[0].type }; }, /already exists/],
  ["a second DAOWOW cell", (c) => { c.inputCells[1] = withdrawingCell; }, /exactly one DAOWOW cell.*spends 2/],
];
for (const [name, breakIt, reason] of TWO) {
  test(`phase two refuses ${name}`, async () => {
    const { checkDaoPhaseTwo } = await load();
    const c = phaseTwo();
    breakIt(c);
    const reasons = checkDaoPhaseTwo(c);
    assert.ok(reasons.some((r) => reason.test(r)), `expected ${reason}, got: ${reasons.join(" | ") || "(clean)"}`);
  });
}

// ---- payout ------------------------------------------------------------------
const lockOf = (n) => ({ codeHash: "0x" + "9b".repeat(32), hashType: "type", args: "0x" + String(n).repeat(40) });
const people = [1, 2, 3].map(lockOf).map((lock) => ({ lock, hash: scriptHash(lock) }))
  .sort((a, b) => (a.hash < b.hash ? -1 : 1));
const PRINCIPALS = [50237n * CKB, 10237n * CKB, 20237n * CKB];
const liabilities = people.map((p, i) => ({ participantLockHash: p.hash, principal: PRINCIPALS[i], prize: 0n }));
const tree = new core.MmrHost();
for (const l of liabilities) tree.append(core.liabilityLeaf(unhex(l.participantLockHash), l.principal, l.prize));
const PRINCIPAL = PRINCIPALS.reduce((a, b) => a + b, 0n);
const ST = MANIFEST.scripts["settlement-type"];
function payout({ state: over = {}, count } = {}) {
  const state = {
    roundId: CONFIG.roundId, batchId: 0n, realizedTotal: PRINCIPAL + 900n * CKB, principalLiability: PRINCIPAL,
    prizePool: 900n * CKB, payoutCursor: 0n, liabilityCount: 3n, liabilitiesRoot: hex(tree.root()),
    prizeCount: 2n, prizeRoot: "77".repeat(32), prizePaid: 0n, ...over,
  };
  const paidAlready = liabilities.slice(0, Number(state.payoutCursor)).reduce((s, l) => s + l.principal, 0n);
  const cell = {
    capacity: state.realizedTotal - state.prizePaid - paidAlready,
    lock: { codeHash: ST.codeHash, hashType: ST.hashType, args: "0x00" },
    type: { codeHash: ST.codeHash, hashType: ST.hashType, args: "0x" + CONFIG.commitment + u64(0n) + RECEIPT.digest },
    data: "0x" + hex(encodeSettlementFunding(state)),
  };
  const { tx } = buildPayoutTx({
    manifest: MANIFEST, liabilities, sponsor: { ...sponsor }, count,
    locks: Object.fromEntries(people.map((p) => [p.hash, p.lock])),
    funding: { outPoint: outPoint("f1", 0), capacity: cell.capacity, lock: cell.lock, type: cell.type, state },
  });
  return { config: CONFIG, tx: clone(tx), inputCells: [cell, sponsorCell] };
}

test("payout: what the builder makes passes every rule, part-way and closing", async () => {
  const { checkPayout } = await load();
  assert.deepStrictEqual(checkPayout(payout({ count: 2 })), []);
  assert.deepStrictEqual(checkPayout(payout()), []);
  assert.deepStrictEqual(checkPayout(payout({ state: { prizePaid: 900n * CKB, payoutCursor: 2n } })), []);
});

const rewitness = (c, change) => {
  const rows = decodeSettlementWitness(unhex(c.tx.witnesses[0]));
  c.tx.witnesses[0] = "0x" + hex(encodeSettlementWitness(change(rows)));
};
const restate = (c, change) => {
  const state = decodeSettlementFunding(unhex(c.tx.outputsData[0]));
  c.tx.outputsData[0] = "0x" + hex(encodeSettlementFunding({ ...state, ...change }, { unchecked: true }));
};
const PAY = [
  ["an underpaid participant", (c) => { c.tx.outputs[1].capacity -= 1n; c.tx.outputs[3].capacity += 1n; }, /holds less than/],
  ["a skipped participant", (c) => rewitness(c, (rows) => rows.slice(1)), /not the liability at position 0/],
  ["a proof for another position", (c) => rewitness(c, (rows) => [{ ...rows[0], proof: rows[1].proof }, rows[1]]), /proof does not verify/],
  ["an inflated amount", (c) => rewitness(c, (rows) => [{ ...rows[0], item: { ...rows[0].item, principal: rows[0].item.principal + 1n } }, rows[1]]), /proof does not verify/],
  ["participants out of order", (c) => rewitness(c, (rows) => [rows[1], rows[0]]), /out of order/],
  ["a payment with a type script", (c) => { c.tx.outputs[1].type = NATIVE_DAO; }, /not an ordinary empty cell/],
  ["a payment carrying data", (c) => { c.tx.outputsData[1] = "0x00"; }, /not an ordinary empty cell/],
  ["a payment to another lock", (c) => { c.tx.outputs[1].lock = sponsorCell.lock; }, /no output is under that participant's lock/],
  ["a witness declaring another lock", (c) => rewitness(c, (rows) => [{ ...rows[0], lock: { ...rows[0].lock, hashType: "data1" } }, rows[1]]), /declares a different lock/],
  ["a cursor that did not advance", (c) => restate(c, { payoutCursor: 1n }), /cursor must advance to 2/],
  ["a cursor that jumped", (c) => restate(c, { payoutCursor: 3n }), /cursor must advance to 2/],
  ["prizes marked paid by a payout", (c) => restate(c, { prizePaid: 1n }), /must not change the prizes paid/],
  ["a changed liabilities root", (c) => restate(c, { liabilitiesRoot: "ab".repeat(32) }), /liabilitiesRoot changed/],
  ["a shannon skimmed from the settlement cell", (c) => { c.tx.outputs[0].capacity -= 1n; }, /conservation/],
  ["a settlement cell moved to another lock", (c) => { c.tx.outputs[0].lock = sponsorCell.lock; }, /lock changed/],
  ["a settlement cell under a private lock", (c) => { c.inputCells[0] = { ...c.inputCells[0], lock: sponsorCell.lock }; }, /not under the public settlement lock/],
  ["two settlement cells among the outputs", (c) => {
    c.tx.outputs.unshift({ ...c.tx.outputs[0] }); c.tx.outputsData.unshift(c.tx.outputsData[0]);
  }, /more than one settlement cell/],
  ["more participants than the batch has", (c) => rewitness(c, (rows) => [
    ...rows, { ...rows[1], item: { ...rows[1].item, participantLockHash: "fe".repeat(32) } },
    { ...rows[1], item: { ...rows[1].item, participantLockHash: "ff".repeat(32) } },
  ]), /more participants are paid than the batch has/],
  ["a payment below its own cell floor", (c) => { c.tx.outputs[1].capacity = 10n * CKB; }, /below its own cell floor/],
  ["an empty witness", (c) => rewitness(c, () => []), /lists nobody/],
  ["a sponsor output ahead of a payment under the same lock", (c) => {
    // The contract takes the FIRST output under the participant's lock.
    c.tx.outputs.splice(1, 0, { capacity: 100n * CKB, lock: c.tx.outputs[1].lock, type: NATIVE_DAO });
    c.tx.outputsData.splice(1, 0, "0x");
  }, /FIRST output under that lock/],
];
for (const [name, breakIt, reason] of PAY) {
  test(`payout refuses ${name}`, async () => {
    const { checkPayout } = await load();
    const c = payout({ count: 2 });
    breakIt(c);
    const reasons = checkPayout(c);
    assert.ok(reasons.some((r) => reason.test(r)), `expected ${reason}, got: ${reasons.join(" | ") || "(clean)"}`);
  });
}

test("payout refuses closing the cell early, or keeping it when it must close", async () => {
  const { checkPayout } = await load();
  // Closing with a participant unpaid: drop the successor from a part payout.
  const early = payout({ count: 2 });
  early.tx.outputs.shift(); early.tx.outputsData.shift();
  assert.ok(checkPayout(early).some((r) => /closed before every participant is paid/.test(r)));
  // Closing while prizes are unredeemed.
  const unredeemed = payout();
  unredeemed.tx.outputs.shift(); unredeemed.tx.outputsData.shift();
  assert.ok(checkPayout(unredeemed).some((r) => /closed while prizes are still unredeemed/.test(r)));
  // Keeping the cell when everyone is paid and nothing is outstanding.
  const kept = payout({ state: { prizePaid: 900n * CKB, payoutCursor: 2n } });
  kept.tx.outputs.unshift({ capacity: 0n, lock: kept.inputCells[0].lock, type: kept.inputCells[0].type });
  kept.tx.outputsData.unshift("0x" + hex(encodeSettlementFunding({
    ...decodeSettlementFunding(unhex(kept.inputCells[0].data)), payoutCursor: 3n,
  })));
  assert.ok(checkPayout(kept).some((r) => /must be closed, not kept/.test(r)));
});

test("payout refuses a settlement cell left below its own floor", async () => {
  const { checkPayout } = await load();
  // Everyone paid with 306 CKB of prizes unredeemed: the cell cannot hold it.
  const c = payout({ state: { realizedTotal: PRINCIPAL + 900n * CKB }, count: 3 });
  c.tx.outputs[0].capacity = 306n * CKB;
  assert.ok(checkPayout(c).some((r) => /below its own floor.*prizes are redeemed/.test(r)));
});
