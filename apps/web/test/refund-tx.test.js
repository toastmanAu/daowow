"use strict";
// TX-04. entry-lock's refund path requires an absolute-epoch `since` at or
// after the aggregation deadline, and the FULL entry capacity returning to
// the committed participant lock as a plain cell — no type script, no data.
const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const { buildRefundTx, isRefundable, scriptHash } = require("../chain/refund-tx.js");
const { loadManifest } = require("../chain/manifest.js");

const MANIFEST = loadManifest(JSON.parse(fs.readFileSync(path.join(
  __dirname, "..", "..", "..", "deployments", "dev-testnet-manifest.json"), "utf8")));
const CKB = 100000000n;
const CONFIG_DEP = { txHash: "0x" + "44".repeat(32), index: 0 };
const participantLock = {
  codeHash: "0x" + "22".repeat(32), hashType: "type", args: "0x" + "ab".repeat(22),
};
const config = { aggregationDeadline: 300n, commitment: "cc".repeat(32) };
const entryCell = {
  outPoint: { txHash: "0x" + "55".repeat(32), index: 1 },
  capacity: 10237n * CKB,
  // The entry commits to the participant's LOCK HASH, so the fixture must be
  // the real hash of the lock above or the destination check fires.
  participantLockHash: scriptHash(participantLock),
};

test("an entry is refundable only once the aggregation deadline has passed", () => {
  // Derived from chain state every time. The beta plan forbids an
  // irreversible local flag precisely because a reorg can reverse this.
  assert.strictEqual(isRefundable({ config, nowEpoch: 299n }), false);
  assert.strictEqual(isRefundable({ config, nowEpoch: 300n }), true, "inclusive at the deadline");
  assert.strictEqual(isRefundable({ config, nowEpoch: 301n }), true);
});

test("the refund spends the entry with an absolute-epoch since at the deadline", () => {
  const { tx } = buildRefundTx({
    manifest: MANIFEST, config, entryCell, participantLock,
    nowEpoch: 305n, configCellOutPoint: CONFIG_DEP,
  });
  assert.deepStrictEqual(tx.inputs[0].previousOutput, entryCell.outPoint);
  assert.strictEqual(tx.inputs[0].since >> 56n, 0x20n, "must be an absolute epoch");
  assert.ok((tx.inputs[0].since & 0xffffffffffffffn) >= config.aggregationDeadline);
});

test("the full capacity returns to the committed participant lock", () => {
  const { tx } = buildRefundTx({
    manifest: MANIFEST, config, entryCell, participantLock,
    nowEpoch: 305n, configCellOutPoint: CONFIG_DEP,
  });
  const out = tx.outputs[0];
  assert.deepStrictEqual(out.lock, participantLock);
  assert.strictEqual(out.capacity, entryCell.capacity,
    "the contract requires the FULL capacity back; the fee must come from another input");
  assert.strictEqual(out.type, null, "a refund destination carries no type script");
  assert.strictEqual(tx.outputsData[0], "", "and no data");
});

test("refunding before the deadline is refused before anything is built", () => {
  assert.throws(() => buildRefundTx({
    manifest: MANIFEST, config, entryCell, participantLock,
    nowEpoch: 299n, configCellOutPoint: CONFIG_DEP,
  }), /deadline/i);
});

test("the entry-lock and config cell deps are present", () => {
  const { tx } = buildRefundTx({
    manifest: MANIFEST, config, entryCell, participantLock,
    nowEpoch: 305n, configCellOutPoint: CONFIG_DEP,
  });
  const deps = tx.cellDeps.map((d) => `${d.outPoint.txHash}:${d.outPoint.index}`);
  const lockDep = MANIFEST.scripts["entry-lock"].outPoint;
  assert.ok(deps.includes(`${lockDep.txHash}:${lockDep.index}`),
    "entry-lock runs on the input being spent");
  assert.ok(deps.includes(`${CONFIG_DEP.txHash}:${CONFIG_DEP.index}`),
    "the contract reads the authenticated config");
});

test("a mismatched participant lock is refused", () => {
  // entry-lock compares the output lock's HASH to the one committed in the
  // entry. A refund to any other destination is refused on chain, so refuse
  // it here rather than after the visitor signs.
  assert.throws(() => buildRefundTx({
    manifest: MANIFEST, config, entryCell,
    participantLock: { ...participantLock, args: "0x" + "ee".repeat(22) },
    nowEpoch: 305n, configCellOutPoint: CONFIG_DEP,
    participantLockHash: "99".repeat(32),
  }), /participant lock/i);
});

test("our script hash agrees with CCC, which is the on-chain definition", async () => {
  // Hand-rolled molecule is where this project's feedback log records the
  // most expensive bugs: a wrong length prefix or offset produces a plausible
  // hash that matches nothing. CCC is the independent oracle.
  const { ccc } = await import("../vendor/ccc-joyid.min.mjs");
  for (const script of [
    participantLock,
    { codeHash: "0x" + "9b".repeat(32), hashType: "data1", args: "0x" },
    { codeHash: "0x" + "01".repeat(32), hashType: "data", args: "0x" + "ff".repeat(20) },
    { codeHash: "0x" + "02".repeat(32), hashType: "data2", args: "0x" + "ab".repeat(32) },
  ]) {
    const mine = scriptHash(script);
    const theirs = ccc.Script.from({
      codeHash: script.codeHash, hashType: script.hashType, args: script.args,
    }).hash().replace(/^0x/, "");
    assert.strictEqual(mine, theirs, `script hash for hashType ${script.hashType}`);
  }
});

test("a missing round config dep is refused, not silently omitted", () => {
  // The contract reads the authenticated config to learn the aggregation
  // deadline. Without the dep every refund is refused on chain, so a
  // forgotten argument must not produce a transaction at all.
  assert.throws(() => buildRefundTx({
    manifest: MANIFEST, config, entryCell, participantLock, nowEpoch: 305n,
  }), /config cell/i);
});
