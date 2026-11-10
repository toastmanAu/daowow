"use strict";
// Preparing a refund. Two rules from the old refund page must survive the
// move into the app, because each one was learned from a failed live refund:
//   - the proof is built from the shard's FULL entry history, never from the
//     entry cells still on chain (a refund spends a cell; the frozen tree
//     still contains it);
//   - if that history cannot be rebuilt in full, no refund is offered.
const { test } = require("node:test");
const assert = require("node:assert");
const { prepareRefund } = require("../dapp/model/refund-guard.js");

const ledger = (entryCount) => ({
  state: { closed: true, acceptedEntries: 0n, frozen: { entryCount: BigInt(entryCount) } },
  outPoint: { txHash: "0x" + "aa".repeat(32), index: 0 },
  capacity: 1n,
});
const row = (l) => ({
  snapshot: {
    config: { roundId: "ab".repeat(32), commitment: "cd".repeat(32) },
    outPoint: { txHash: "0x" + "bb".repeat(32), index: 0 }, ledger: l,
  },
});
const entry = { participantLockHash: "ee".repeat(32), capacity: 5n, entry: { entryNonce: 1n }, outPoint: {} };
const session = { lockScript: { codeHash: "0x1", hashType: "type", args: "0x" } };
const history = (n) => Array.from({ length: n }, (_, i) => ({ nonce: i }));
const run = (over = {}) => {
  const seen = {};
  const readers = {
    readShardEntries: async (rpc, from, count) => { seen.read = { from, count }; return history(2); },
    buildRefundTx: (args) => { seen.build = args; return { tx: { marker: true } }; },
    ...over.readers,
  };
  return prepareRefund({
    rpc: {}, manifest: { m: 1 }, row: over.row ?? row(ledger(2)), entry, session, nowEpoch: 300n, readers,
  }).then((result) => ({ result, seen }));
};

test("the refund is built from the replayed history, not the cells still on chain", async () => {
  const { result, seen } = await run();
  assert.strictEqual(result.ok, true);
  assert.deepStrictEqual(result.tx, { marker: true });
  assert.deepStrictEqual(seen.build.allEntries, history(2));
  assert.strictEqual(seen.read.count, 2n);
  assert.strictEqual(seen.read.from.txHash, "0x" + "aa".repeat(32));
});

test("the builder is handed the entry, the wallet's lock, the ledger and the round's config cell", async () => {
  const { seen } = await run();
  assert.strictEqual(seen.build.entryCell, entry);
  assert.strictEqual(seen.build.participantLock, session.lockScript);
  assert.strictEqual(seen.build.participantLockHash, entry.participantLockHash);
  assert.strictEqual(seen.build.nowEpoch, 300n);
  assert.strictEqual(seen.build.configCellOutPoint.txHash, "0x" + "bb".repeat(32));
  assert.strictEqual(seen.build.ledgerCell.capacity, 1n);
  assert.deepStrictEqual(seen.build.manifest, { m: 1 });
});

test("an incomplete history replay offers no refund", async () => {
  const { result, seen } = await run({ readers: { readShardEntries: async () => history(1) } });
  assert.strictEqual(result.ok, false);
  assert.match(result.message, /couldn't rebuild/);
  assert.strictEqual(seen.build, undefined, "nothing is built from a partial history");
});

test("a round with no ledger offers no refund and reads nothing", async () => {
  const { result, seen } = await run({ row: row(null) });
  assert.strictEqual(result.ok, false);
  assert.strictEqual(seen.read, undefined);
});

test("a refusal from the builder comes back as a message, with its reason kept", async () => {
  const { result } = await run({ readers: { buildRefundTx: () => { throw new Error("ledger is still open"); } } });
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.detail, "ledger is still open");
  assert.doesNotMatch(result.message, /ledger/);
});

// --- reading the round again before a refund is signed -----------------------
const { checkBeforeRefund } = require("../dapp/model/refund-guard.js");
const key = { txHash: "0x" + "e1".repeat(32), index: 0 };
const mineEntry = { ...entry, outPoint: key };
const refundStore = ({ status = "ready", refundable = [mineEntry], found = true } = {}) => {
  const store = {
    refreshes: 0,
    state: { status: "ready", tip: { epoch: { number: 300n } }, mine: null },
    async refresh() {
      store.refreshes += 1;
      store.state.status = status;
      store.state.mine = [{ roundId: "ab".repeat(32), refundable }];
    },
    findRound: () => (found ? row(ledger(2)) : null),
  };
  return store;
};

test("a refund re-reads the round and hands on the FRESH entry and round", async () => {
  const store = refundStore();
  const result = await checkBeforeRefund({ store, roundId: "ab".repeat(32), outPoint: key });
  assert.strictEqual(store.refreshes, 1);
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.entry, mineEntry);
  assert.strictEqual(result.nowEpoch, 300n);
});

test("a re-read that failed stops the refund, even though old data is still in memory", async () => {
  const result = await checkBeforeRefund({ store: refundStore({ status: "error" }), roundId: "ab".repeat(32), outPoint: key });
  assert.strictEqual(result.ok, false);
  assert.match(result.message, /can't reach the network/);
});

test("a network that is still catching up stops the refund", async () => {
  const store = refundStore();
  const refresh = store.refresh;
  store.refresh = async () => { await refresh(); store.state.lagging = true; };
  const result = await checkBeforeRefund({ store, roundId: "ab".repeat(32), outPoint: key });
  assert.strictEqual(result.ok, false);
  assert.match(result.message, /catching up/);
});

test("an entry that is gone or no longer refundable stops the refund", async () => {
  for (const store of [refundStore({ refundable: [] }), refundStore({ found: false }),
    refundStore({ refundable: [{ ...entry, outPoint: { txHash: key.txHash, index: 1 } }] })]) {
    const result = await checkBeforeRefund({ store, roundId: "ab".repeat(32), outPoint: key });
    assert.strictEqual(result.ok, false);
  }
});
