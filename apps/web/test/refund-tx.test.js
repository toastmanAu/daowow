"use strict";
// TX-04. Rewritten after reading what entry-lock ACTUALLY checks.
//
// The previous version of this file asserted a refund transaction the chain
// would have refused. It pinned three of the five conditions and missed the two
// that matter most: the refund requires a CLOSED aggregation ledger as a cell
// dep, and an exclusion proof in the witness at the entry's own input index. A
// passing aggregation deadline makes an entry ELIGIBLE, not refundable.
//
// So these tests were wrong, not the code — and being green over an
// unreachable path is exactly the shape this project's feedback log keeps
// recording.
const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const {
  buildRefundTx, isRefundable, refundBlocker, encodeAggregationWitness, scriptHash,
  ABSOLUTE_EPOCH_FLAG,
} = require("../chain/refund-tx.js");
const { decodeAggregationState } = require("../chain/ledger-codec.js");
const { decodeRoundConfigV1 } = require("../chain/codec.js");
const { decodeEntryDataV1 } = require("../chain/entry-codec.js");
const { loadManifest } = require("../chain/manifest.js");
const core = require("../core.js");

const V = JSON.parse(fs.readFileSync(path.join(
  __dirname, "..", "..", "..", "tests", "vectors", "daowow_core_vectors.json"), "utf8"));
const MANIFEST = loadManifest(JSON.parse(fs.readFileSync(path.join(
  __dirname, "..", "..", "..", "deployments", "dev-testnet-manifest.json"), "utf8")));
const unhex = (s) => Uint8Array.from(s.match(/../g).map((b) => parseInt(b, 16)));
const CKB = 100000000n;
const A = V.aggregation_state;
const CONFIG = decodeRoundConfigV1(unhex(A.config.hex));
const entries = A.entries.map((e) => decodeEntryDataV1(unhex(e.hex)));
const OPEN_LEDGER = decodeAggregationState(unhex(A.genesis.hex));
const CLOSED = { ...OPEN_LEDGER, closed: true };            // 0 accepted, closed
const CLOSED_WITH_ONE = {
  ...decodeAggregationState(unhex(A.after_batch.hex)), closed: true,
};                                                           // 2 accepted, closed

const participantLock = {
  codeHash: "0x" + "22".repeat(32), hashType: "type", args: "0x" + "ab".repeat(22),
};
const entryCell = {
  outPoint: { txHash: "0x" + "55".repeat(32), index: 1 },
  capacity: 10237n * CKB,
  entry: entries[0],
  participantLockHash: scriptHash(participantLock),
};
const ledgerCell = {
  outPoint: { txHash: "0x" + "66".repeat(32), index: 0 },
  state: CLOSED,
};
const sponsor = {
  outPoint: { txHash: "0x" + "77".repeat(32), index: 2 },
  capacity: 1000n * CKB,
  lock: { codeHash: "0x" + "33".repeat(32), hashType: "type", args: "0x" + "cd".repeat(20) },
  lockDep: { outPoint: { txHash: "0x" + "88".repeat(32), index: 0 }, depType: "depGroup" },
};
const base = () => ({
  manifest: MANIFEST, config: CONFIG, entryCell, participantLock,
  nowEpoch: CONFIG.aggregationDeadline,
  configCellOutPoint: { txHash: "0x" + "44".repeat(32), index: 0 },
  participantLockHash: scriptHash(participantLock),
  ledgerCell, allEntries: entries, sponsor,
});

// --- refundability has FOUR causes of "not yet" ---------------------------

test("a passed deadline alone is not enough: a missing ledger blocks the refund", () => {
  // The correction. Letting a round lapse does NOT make its entries
  // refundable; the shard must be frozen and its ledger created and closed.
  const why = refundBlocker({
    config: CONFIG, nowEpoch: CONFIG.aggregationDeadline,
    ledger: null, entryNonce: 0n,
  });
  assert.match(why, /no aggregation ledger/);
  assert.match(why, /not enough on its own/);
});

test("an OPEN ledger blocks the refund", () => {
  assert.match(refundBlocker({
    config: CONFIG, nowEpoch: CONFIG.aggregationDeadline,
    ledger: OPEN_LEDGER, entryNonce: 0n,
  }), /still open/);
});

test("before the deadline, the deadline is the reason given", () => {
  assert.match(refundBlocker({
    config: CONFIG, nowEpoch: CONFIG.aggregationDeadline - 1n,
    ledger: CLOSED, entryNonce: 0n,
  }), /aggregation deadline/);
});

test("an ACCEPTED entry cannot be refunded, and is told why", () => {
  // Inside the closed prefix it takes part in the draw. This is the condition
  // that stops a winner reclaiming their stake and keeping the prize.
  assert.match(refundBlocker({
    config: CONFIG, nowEpoch: CONFIG.aggregationDeadline,
    ledger: CLOSED_WITH_ONE, entryNonce: 0n,
  }), /takes part in the draw/);
});

test("an unaccepted entry under a closed ledger past the deadline is refundable", () => {
  assert.strictEqual(refundBlocker({
    config: CONFIG, nowEpoch: CONFIG.aggregationDeadline,
    ledger: CLOSED, entryNonce: 0n,
  }), null);
  assert.strictEqual(isRefundable({
    config: CONFIG, nowEpoch: CONFIG.aggregationDeadline,
    ledger: CLOSED, entryNonce: 0n,
  }), true);
});

// --- the transaction -----------------------------------------------------

test("the closed ledger travels as a cell dep", () => {
  // Without it excluded_membership returns false and the spend is refused with
  // no hint that a dep is missing.
  const { tx } = buildRefundTx(base());
  const deps = tx.cellDeps.map((d) => `${d.outPoint.txHash}:${d.outPoint.index}`);
  assert.ok(deps.includes(`${ledgerCell.outPoint.txHash}:0`), "the ledger dep");
  const entryLockDep = MANIFEST.scripts["entry-lock"].outPoint;
  assert.ok(deps.includes(`${entryLockDep.txHash}:${entryLockDep.index}`));
  assert.ok(deps.includes(`${sponsor.lockDep.outPoint.txHash}:0`), "the sponsor's lock dep");
});

test("a missing ledger out point is refused before anything is built", () => {
  assert.throws(() => buildRefundTx({
    ...base(), ledgerCell: { state: CLOSED },
  }), /out point is required/);
});

test("the exclusion proof sits in the witness at the entry's input index", () => {
  // Raw bytes: u32 LE length then the proof (witness.rs:168), not a WitnessArgs.
  const { tx } = buildRefundTx(base());
  const w = unhex(tx.witnesses[0].replace(/^0x/, ""));
  const declared = new DataView(w.buffer, w.byteOffset).getUint32(0, true);
  assert.strictEqual(declared, w.length - 4, "the length prefix must match the proof");
  const proof = w.slice(4);
  // And it must actually verify against the frozen root, or it is -4 on chain.
  assert.ok(core.mmrVerifyMembership(
    unhex(CLOSED.frozen.accumulatorRoot), Number(CLOSED.frozen.entryCount),
    Number(entries[0].entryNonce), core.entryLeaf(entries[0]), proof));
});

test("a replay set that does not reproduce the frozen root is refused", () => {
  // The RIGHT NUMBER of entries in the WRONG order, so the replay-set length
  // check cannot refuse it first and report the correct conclusion for the
  // wrong reason. An empty set trips that check instead and leaves this guard
  // deletable — which a probe caught.
  assert.throws(() => buildRefundTx({
    ...base(), allEntries: [entries[1], entries[0]],
  }), /accumulator root/);
});

test("an entry outside the replay set is refused separately", () => {
  // The sibling guard, pinned on its own so neither hides behind the other.
  // The replay set is CORRECT here — it reproduces the frozen root — and only
  // the entry's nonce is out of range, so the root check cannot refuse it
  // first. An empty replay set trips the root check instead, which is how this
  // test was wrong on its first attempt.
  const beyond = {
    ...entryCell,
    entry: { ...entries[0], entryNonce: 5n },
  };
  assert.throws(() => buildRefundTx({ ...base(), entryCell: beyond }),
    /outside the replay set/);
});

test("the since is an absolute epoch at the deadline", () => {
  const { tx } = buildRefundTx(base());
  assert.strictEqual(tx.inputs[0].since & ABSOLUTE_EPOCH_FLAG, ABSOLUTE_EPOCH_FLAG);
  assert.strictEqual(tx.inputs[0].since & 0xffffffn, CONFIG.aggregationDeadline);
});

test("the FULL entry capacity returns, with the fee taken from the sponsor", () => {
  // returned >= required, where required is the entry's whole capacity. Taking
  // the fee from the refund is ENTRY_ERROR_REFUND_DESTINATION.
  const { tx, refunded, fee } = buildRefundTx(base());
  assert.strictEqual(BigInt(tx.outputs[0].capacity), entryCell.capacity);
  assert.strictEqual(refunded, entryCell.capacity);
  assert.deepStrictEqual(tx.outputs[0].lock, participantLock);
  assert.strictEqual(tx.outputs[0].type, null, "a plain cell: no type script");
  assert.strictEqual(tx.outputsData[0], "0x", "and empty data");
  const inputs = entryCell.capacity + sponsor.capacity;
  const outputs = tx.outputs.reduce((s, o) => s + BigInt(o.capacity), 0n);
  assert.strictEqual(inputs - outputs, fee);
});

test("without a sponsor the transaction is left for the WALLET to fund", () => {
  // Two funding modes. A CLI passes a sponsor and gets a complete transaction;
  // the browser omits it and CCC adds the fee input and a change output.
  //
  // Omitting it is safe here for a reason specific to refunds: the change lands
  // under the participant's OWN lock, which is the same lock the refund pays,
  // so entry-lock's `returned >= required` still holds. It would not be safe
  // for a transaction whose change went anywhere else.
  const { sponsor: _drop, ...without } = base();
  const { tx, fee } = buildRefundTx(without);
  assert.strictEqual(tx.inputs.length, 1, "only the entry; the wallet adds the rest");
  assert.strictEqual(tx.outputs.length, 1, "only the refund; the wallet adds change");
  assert.strictEqual(tx.witnesses.length, tx.inputs.length,
    "balanced at handover, so CCC's splices append rather than displace");
  assert.strictEqual(BigInt(tx.outputs[0].capacity), entryCell.capacity);
  assert.strictEqual(fee, 0n, "the wallet decides the fee, so none is claimed here");
  // The sponsor's lock dep is absent because the wallet's prepareTransaction
  // adds its own; the ledger and entry-lock deps are still ours to supply.
  const deps = tx.cellDeps.map((d) => `${d.outPoint.txHash}:${d.outPoint.index}`);
  assert.ok(deps.includes(`${ledgerCell.outPoint.txHash}:0`));
});

test("a sponsor without its lock cell dep is still refused", () => {
  // Passing a sponsor is a promise to supply its dep. Omitting the sponsor
  // entirely delegates to the wallet; omitting only the dep is an error.
  const { lockDep: _d, ...noDep } = sponsor;
  assert.throws(() => buildRefundTx({ ...base(), sponsor: noDep }),
    /lockDep|ScriptNotFound/);
});

test("no output is under the round's dao-lock", () => {
  // entry-lock refuses the whole transaction if one is.
  const { tx } = buildRefundTx(base());
  for (const o of tx.outputs) {
    assert.notStrictEqual(o.lock.codeHash.replace(/^0x/, ""), CONFIG.daoLock.codeHash);
  }
});

test("a mismatched participant lock is refused", () => {
  const stranger = { ...participantLock, args: "0x" + "ff".repeat(22) };
  assert.throws(() => buildRefundTx({ ...base(), participantLock: stranger }),
    /only the original depositor/);
});

test("the aggregation witness refuses an empty proof", () => {
  assert.throws(() => encodeAggregationWitness(new Uint8Array(0)), /membership proof/);
});

test("our script hash agrees with CCC, which is the on-chain definition", async () => {
  const { ccc } = await import("../vendor/ccc-joyid.min.mjs");
  for (const hashType of ["data", "type", "data1", "data2"]) {
    const script = { ...participantLock, hashType };
    assert.strictEqual(
      "0x" + scriptHash(script),
      ccc.Script.from({
        codeHash: script.codeHash, hashType, args: script.args,
      }).hash(),
      `${hashType} must agree`);
  }
});
