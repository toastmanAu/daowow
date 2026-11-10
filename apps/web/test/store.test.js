"use strict";
// The one shared store: every tab renders from it, so a wallet is connected
// once and the chain is read once. Its readers are injected, so everything a
// public node can do wrong is exercised here.
const { test } = require("node:test");
const assert = require("node:assert");
const F = require("./helpers/fake-chain.js");
const { createStore } = require("../dapp/model/store.js");
const { PLAYER_STATE: S } = require("../dapp/model/round-state.js");
const { OUTCOME } = require("../dapp/model/tickets.js");
const { decodeRoundConfigV1 } = require("../chain/codec.js");
const { decodeEntropyRecord, decodeRoundSeal } = require("../chain/seal-codec.js");
const { scheduleCommitment } = require("../chain/draw.js");

// The vector's own round: 1 shard, sealed at 1234567, two tickets accepted.
const RECORD = decodeEntropyRecord(F.unhex(F.V.entropy_record.hex), 1);
const SEAL = decodeRoundSeal(F.unhex(F.V.round_seal.hex), 1);
const SCHEDULE = { version: 2, weights: [60n, 40n], thresholds: [1n, 2n] };
const A = { ...F.CONFIG, prizeScheduleHash: scheduleCommitment(SCHEDULE), minimumTickets: 1n };
const B = decodeRoundConfigV1(F.variantConfigBytes());
const scheduleBytes = () => {
  const out = new Uint8Array(5 + 2 * 16);
  const v = new DataView(out.buffer);
  out[0] = 2; v.setUint32(1, 2, true);
  v.setBigUint64(5, 60n, true); v.setBigUint64(13, 1n, true);
  v.setBigUint64(21, 40n, true); v.setBigUint64(29, 2n, true);
  return out;
};
const snap = (config, over = {}) => ({
  config, outPoint: { txHash: "0x" + "09".repeat(32), index: 0 },
  shards: [], ledger: null, seal: null, record: null, ...over,
});
const tipHeader = (height, epoch = 1005n) => ({
  number: "0x" + height.toString(16),
  epoch: "0x" + ((1800n << 40n) | epoch).toString(16),
  dao: "0x" + "00".repeat(32),
});
const HEADERS = {
  inclusionHeader: { number: "0x" + (1234567n).toString(16), hash: "0x" + F.V.entropy_record.inclusion_hash },
  entropyHeaders: [64n, 128n, 192n].map((off, i) => ({
    number: "0x" + (1234567n + off).toString(16), hash: "0x" + F.V.entropy_record.entropy_hashes[i],
  })),
};

function readers(over = {}) {
  const calls = [];
  const log = (name, value) => async (...args) => { calls.push(name); return typeof value === "function" ? value(...args) : value; };
  return {
    calls,
    readTip: log("readTip", tipHeader(2000000n)),
    readDeployment: log("readDeployment", [snap(A, { record: { record: RECORD } }), snap(B, { shards: [{ shardId: 0, state: 0, ticketCount: 3n }] })]),
    countEntries: log("countEntries", new Map()),
    readSchedule: log("readSchedule", (rpc, s) => {
      if (s.config.roundId !== A.roundId) throw new Error("the published schedule does not match the round's commitment");
      return scheduleBytes();
    }),
    readEntropyHeaders: log("readEntropyHeaders", HEADERS),
    readPoolSoFar: log("readPoolSoFar", null),
    findClaims: log("findClaims", [{ commitment: A.commitment, shardId: 0, position: 0n, capacity: 1n }]),
    findMyEntries: log("findMyEntries", []),
    scriptHash: () => "ab".repeat(32),
    isTrustedRound: () => true,
    isSoundRound: () => true,
    ...over,
  };
}
const make = (over) => {
  const r = readers(over);
  return { r, store: createStore({ manifest: { rpcUrl: "https://node.example" }, rpc: { url: "x" }, readers: r }) };
};

test("a failing node leaves status 'error' and does not throw", async () => {
  const { store } = make({ readTip: async () => { throw new Error("Failed to fetch"); } });
  await store.refresh();
  assert.strictEqual(store.state.status, "error");
  assert.match(store.state.error, /Failed to fetch/);
  assert.deepStrictEqual(store.state.rows, []);
});

test("a retry after a failure reaches 'ready'", async () => {
  let fail = true;
  const { store } = make({ readTip: async () => { if (fail) throw new Error("down"); return tipHeader(2000000n); } });
  await store.refresh();
  fail = false;
  await store.refresh();
  assert.strictEqual(store.state.status, "ready");
  assert.strictEqual(store.state.error, null);
  assert.strictEqual(store.state.rows.length, 2);
});

test("the tip is parsed into a height and a period", async () => {
  const { store } = make();
  await store.refresh();
  assert.strictEqual(store.state.tip.height, 2000000n);
  assert.strictEqual(store.state.tip.epoch.number, 1005n);
});

test("rows are labelled Round 1..N oldest first, in the order the reader gave", async () => {
  const { store } = make();
  await store.refresh();
  assert.deepStrictEqual(store.state.rows.map((r) => r.label), ["Round 1", "Round 2"]);
  assert.strictEqual(store.state.rows[0].snapshot.config.roundId, A.roundId);
});

test("a round whose published schedule fails its check gets scheduleError and no schedule", async () => {
  const { store } = make();
  await store.refresh();
  const b = store.state.rows[1];
  assert.strictEqual(b.schedule, null);
  assert.match(b.scheduleError, /does not match/);
  assert.strictEqual(store.state.rows[0].scheduleError, null);
  assert.deepStrictEqual(store.state.rows[0].schedule.weights, [60n, 40n]);
});

test("a schedule is read once per round, not on every refresh", async () => {
  const { store, r } = make();
  await store.refresh();
  await store.refresh();
  // Round A's succeeded and is kept; round B's failed and is retried.
  assert.strictEqual(r.calls.filter((c) => c === "readSchedule").length, 3);
});

test("a round with a record on chain is drawn, and the browser's own derivation agrees", async () => {
  const { store } = make();
  await store.refresh();
  const a = store.state.rows[0];
  assert.strictEqual(a.view.state, S.DRAWN);
  assert.strictEqual(a.drawError, null);
  assert.strictEqual(a.draw.viable, true);
  assert.strictEqual(a.draw.positions.length, 2);
  assert.strictEqual(a.drawHeight, 1234567n + 192n);
});

test("a drawn round that paid no prizes is shown as finished, not as drawn", async () => {
  // Below its minimum the draw names nobody: saying "winners are drawn" would be false.
  const short = { ...A, minimumTickets: 99n };
  const { store } = make({ readDeployment: async () => [snap(short, { record: { record: RECORD } })] });
  await store.refresh();
  assert.strictEqual(store.state.rows[0].draw.viable, false);
  assert.strictEqual(store.state.rows[0].view.state, S.FINISHED);
});

test("a derived record that disagrees with the on-chain record yields drawError and no draw", async () => {
  const forged = { ...HEADERS, entropyHeaders: HEADERS.entropyHeaders.map((h, i) => (i === 1 ? { ...h, hash: "0x" + "00".repeat(32) } : h)) };
  const { store } = make({ readEntropyHeaders: async () => forged });
  await store.refresh();
  const a = store.state.rows[0];
  assert.strictEqual(a.draw, null);
  assert.match(a.drawError, /does not match/);
});

test("a sealed round is drawn from the browser's own record once the last block exists", async () => {
  const sealed = snap(A, { seal: { seal: SEAL, inclusionHeight: 1234567n } });
  const { store } = make({ readDeployment: async () => [sealed] });
  await store.refresh();
  assert.strictEqual(store.state.rows[0].view.state, S.DRAWN);
  assert.strictEqual(store.state.rows[0].draw.positions.length, 2);
});

test("a sealed round one block short of its last entropy block is waiting, with no draw", async () => {
  const sealed = snap(A, { seal: { seal: SEAL, inclusionHeight: 1234567n } });
  const { store, r } = make({
    readDeployment: async () => [sealed], readTip: async () => tipHeader(1234567n + 191n),
  });
  await store.refresh();
  assert.strictEqual(store.state.rows[0].view.state, S.WAITING);
  assert.strictEqual(store.state.rows[0].draw, null);
  assert.ok(!r.calls.includes("readEntropyHeaders"));
});

test("a round with entries still on chain below its minimum has refunds open", async () => {
  const failed = snap(B, { ledger: { state: { closed: true, acceptedTickets: 0n, acceptedEntries: 0n } } });
  const { store } = make({
    readDeployment: async () => [failed], countEntries: async () => new Map([[B.commitment, 2]]),
  });
  await store.refresh();
  assert.strictEqual(store.state.rows[0].view.state, S.REFUNDS);
});

test("the pool is asked for only once a round has been taken in, and a failure there is not fatal", async () => {
  const { store, r } = make({ readPoolSoFar: async () => { r.calls.push("readPoolSoFar"); throw new Error("no header"); } });
  await store.refresh();
  assert.strictEqual(store.state.status, "ready");
  assert.strictEqual(r.calls.filter((c) => c === "readPoolSoFar").length, 1); // round A only
  assert.strictEqual(store.state.rows[0].pool, null);
});

test("without a session, mine is null and no wallet read happens", async () => {
  const { store, r } = make();
  await store.refresh();
  assert.strictEqual(store.state.mine, null);
  assert.ok(!r.calls.includes("findClaims"));
});

test("with a session, mine is built from that lock's claims and entries", async () => {
  const { store } = make();
  await store.refresh();
  await store.setSession({ address: "ckt1x", lockScript: { codeHash: "0x1", hashType: "type", args: "0x" } });
  assert.strictEqual(store.state.mine.length, 1);
  assert.strictEqual(store.state.mine[0].commitment, A.commitment);
  assert.ok([OUTCOME.WON, OUTCOME.NOT_THIS_TIME].includes(store.state.mine[0].outcome));
  await store.setSession(null);
  assert.strictEqual(store.state.mine, null);
});

test("a wallet read that fails sets mineError and leaves the rounds showing", async () => {
  const { store } = make({ findClaims: async () => { throw new Error("indexer behind"); } });
  await store.refresh();
  await store.setSession({ address: "ckt1x", lockScript: { codeHash: "0x1", hashType: "type", args: "0x" } });
  assert.strictEqual(store.state.status, "ready");
  assert.strictEqual(store.state.mine, null);
  assert.match(store.state.mineError, /indexer behind/);
});

test("subscribers hear every change and can leave", async () => {
  const { store } = make();
  let heard = 0;
  const leave = store.subscribe(() => { heard += 1; });
  await store.refresh();
  assert.ok(heard >= 1);
  const before = heard;
  leave();
  await store.refresh();
  assert.strictEqual(heard, before);
});

test("refreshes run one after another, and each caller waits for its OWN read", async () => {
  // "Read the round again before signing" is only true if the promise a
  // caller awaits is the read it asked for. A refresh that returned early
  // because another was in flight would hand back state up to a minute old.
  let release;
  const gate = new Promise((r) => { release = r; });
  let reads = 0;
  const { store } = make({
    readTip: async () => { reads += 1; if (reads === 1) { await gate; return tipHeader(100n); } return tipHeader(2000000n); },
  });
  const first = store.refresh();
  let secondDone = false;
  const second = store.refresh().then(() => { secondDone = true; });
  await new Promise((r) => setTimeout(r, 20));
  assert.strictEqual(secondDone, false, "the second must not resolve before it has read");
  release();
  await first;
  await second;
  assert.strictEqual(reads, 2);
  assert.strictEqual(store.state.tip.height, 2000000n);
});

test("a round that is not built on this deployment's contracts is never listed", async () => {
  const { store } = make({ isTrustedRound: (config) => config.roundId === A.roundId });
  await store.refresh();
  assert.deepStrictEqual(store.state.rows.map((r) => r.snapshot.config.roundId), [A.roundId]);
  assert.strictEqual(store.findRound(B.roundId.slice(0, 8)), null);
});

test("a round of ours that can never run is listed but marked unsound", async () => {
  const { store } = make({ isSoundRound: (config) => config.roundId !== B.roundId });
  await store.refresh();
  assert.deepStrictEqual(store.state.rows.map((r) => r.sound), [true, false]);
});

test("if soundness cannot be checked, the round is treated as unsound, not as fine", async () => {
  const { store } = make({ isSoundRound: async () => { throw new Error("no consensus"); } });
  await store.refresh();
  assert.strictEqual(store.state.status, "ready");
  assert.deepStrictEqual(store.state.rows.map((r) => r.sound), [false, false]);
});

test("the store keeps who is connected, never the means to sign", async () => {
  const { store } = make();
  await store.refresh();
  await store.setSession({
    address: "ckt1x", lockScript: { codeHash: "0x1", hashType: "type", args: "0x" },
    balance: async () => 5n, signEntry: async () => "signed", broadcast: async () => "sent",
  });
  assert.deepStrictEqual(Object.keys(store.state.session).sort(), ["address", "balance", "lockScript"]);
  assert.strictEqual(store.state.session.signEntry, undefined);
});

test("tickets loaded for one wallet never appear under another", async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  let calls = 0;
  const { store } = make({
    findClaims: async () => {
      calls += 1;
      if (calls === 1) { await gate; return [{ commitment: A.commitment, shardId: 0, position: 0n, capacity: 1n }]; }
      return [];
    },
  });
  await store.refresh();
  const lock = (n) => ({ codeHash: "0x1", hashType: "type", args: "0x0" + n });
  const a = store.setSession({ address: "ckt1a", lockScript: lock(1) });
  await new Promise((r) => setTimeout(r, 10));
  await store.setSession({ address: "ckt1b", lockScript: lock(2) });
  release();
  await a;
  assert.strictEqual(store.state.session.address, "ckt1b");
  assert.deepStrictEqual(store.state.mine, []);
});

test("findRound resolves a unique id prefix and nothing else", async () => {
  const { store } = make();
  await store.refresh();
  assert.strictEqual(store.findRound(A.roundId.slice(0, 8)).snapshot.config.roundId, A.roundId);
  assert.strictEqual(store.findRound("0000"), null);
  assert.strictEqual(store.findRound(A.roundId.slice(0, 7)), null, "a link needs at least 8 characters");
  assert.strictEqual(store.findRound(""), null);
});

test("the store never reads the page's address", () => {
  const src = require("node:fs").readFileSync(require.resolve("../dapp/model/store.js"), "utf8");
  assert.doesNotMatch(src, /location\.|URLSearchParams|document\./);
});
