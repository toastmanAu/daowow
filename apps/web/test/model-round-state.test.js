"use strict";
// The six states a player sees, each derived from cells the app can find.
// One case per rule, and one per boundary, because the boundaries are where
// "open" and "closed" differ by a single period.
const { test } = require("node:test");
const assert = require("node:assert");
const { PLAYER_STATE: S, derivePlayerState, groupRounds, roundLabels } =
  require("../dapp/model/round-state.js");

// entry_start 1001 (inclusive), entry_end 1010 (exclusive), min 5, cap 10.
const config = (over = {}) => ({
  roundId: "aa".repeat(32), entryStart: 1001n, entryEnd: 1010n,
  minimumTickets: 5n, maximumTickets: 10n, entryShardCount: 1, ...over,
});
const shard = (tickets, state = 0) => ({ shardId: 0, state, ticketCount: BigInt(tickets) });
const ledger = (accepted, closed = true) =>
  ({ state: { closed, acceptedTickets: BigInt(accepted) } });
const snap = (over = {}) => ({
  config: config(), shards: [shard(3)], ledger: null, seal: null, record: null, ...over,
});
const SEALED = { seal: { ledgers: [{ acceptedTickets: 6n }] }, inclusionHeight: 1000n };
const at = (snapshot, nowEpoch, extra = {}) =>
  derivePlayerState({ snapshot, nowEpoch, entropyReady: false, liveEntryCount: 0, ...extra });

test("before entry start it is upcoming", () => {
  assert.strictEqual(at(snap(), 1000n).state, S.UPCOMING);
});
test("AT entry start it is open (inclusive)", () => {
  assert.strictEqual(at(snap(), 1001n).state, S.OPEN);
});
test("one period before entry end it is still open", () => {
  assert.strictEqual(at(snap(), 1009n).state, S.OPEN);
});
test("AT entry end it is waiting (exclusive), even though nothing is frozen yet", () => {
  assert.strictEqual(at(snap(), 1010n).state, S.WAITING);
});
test("a frozen round is waiting, whatever the time", () => {
  assert.strictEqual(at(snap({ shards: [shard(6, 1)] }), 1005n).state, S.WAITING);
});
test("past entry end with nothing sold it is finished, not waiting forever", () => {
  assert.strictEqual(at(snap({ shards: [shard(0)] }), 1010n).state, S.FINISHED);
  assert.strictEqual(at(snap({ shards: [] }), 1500n).state, S.FINISHED);
});
test("a closed ledger below the minimum with entries still on chain means refunds are open", () => {
  const s = snap({ shards: [], ledger: ledger(0) });
  assert.strictEqual(at(s, 1100n, { liveEntryCount: 2 }).state, S.REFUNDS);
});
test("the same round with no entries left is finished", () => {
  const s = snap({ shards: [], ledger: ledger(0) });
  assert.strictEqual(at(s, 1100n, { liveEntryCount: 0 }).state, S.FINISHED);
});
test("a closed ledger AT the minimum is waiting, not refunds", () => {
  const s = snap({ shards: [], ledger: ledger(5) });
  assert.strictEqual(at(s, 1100n, { liveEntryCount: 1 }).state, S.WAITING);
});
test("an open ledger is waiting however few it has accepted so far", () => {
  const s = snap({ shards: [], ledger: ledger(0, false) });
  assert.strictEqual(at(s, 1100n, { liveEntryCount: 2 }).state, S.WAITING);
});
test("a sealed round is waiting until its last entropy block exists", () => {
  const s = snap({ shards: [], seal: SEALED });
  assert.strictEqual(at(s, 1100n, { entropyReady: false }).state, S.WAITING);
});
test("a sealed round with its entropy blocks mined is drawn before the operator posts the record", () => {
  const s = snap({ shards: [], seal: SEALED });
  assert.strictEqual(at(s, 1100n, { entropyReady: true }).state, S.DRAWN);
});
test("a round with a record on chain is drawn", () => {
  assert.strictEqual(at(snap({ shards: [], record: { record: { seal: SEALED.seal } } }), 1100n).state, S.DRAWN);
});
test("entropyReady alone, with no seal, draws nothing", () => {
  assert.strictEqual(at(snap(), 1005n, { entropyReady: true }).state, S.OPEN);
});
test("an open round at its cap is open and full", () => {
  const v = at(snap({ shards: [shard(10)] }), 1005n);
  assert.strictEqual(v.state, S.OPEN);
  assert.strictEqual(v.full, true);
  assert.strictEqual(v.ticketsSold, 10n);
  assert.strictEqual(v.cap, 10n);
  assert.strictEqual(at(snap({ shards: [shard(9)] }), 1005n).full, false);
});
test("an uncapped round reports cap null and is never full", () => {
  const v = at(snap({ config: config({ maximumTickets: 0n }), shards: [shard(5000)] }), 1005n);
  assert.strictEqual(v.cap, null);
  assert.strictEqual(v.full, false);
});
test("viable is inclusive at the minimum", () => {
  assert.strictEqual(at(snap({ shards: [shard(5)] }), 1005n).viable, true);
  assert.strictEqual(at(snap({ shards: [shard(4)] }), 1005n).viable, false);
});
test("after the shards are gone, tickets sold comes from the ledger, seal or record", () => {
  assert.strictEqual(at(snap({ shards: [], ledger: ledger(7) }), 1100n).ticketsSold, 7n);
  const sealed = { seal: { ledgers: [{ acceptedTickets: 8n }] }, inclusionHeight: 1n };
  assert.strictEqual(at(snap({ shards: [], seal: sealed }), 1100n).ticketsSold, 8n);
  const rec = { record: { seal: { ledgers: [{ acceptedTickets: 9n }] } } };
  assert.strictEqual(at(snap({ shards: [], record: rec }), 1100n).ticketsSold, 9n);
});

const row = (id, entryStart, state) =>
  ({ snapshot: { config: config({ roundId: id, entryStart }) }, view: { state } });

test("labels number rounds oldest first and do not depend on input order", () => {
  const a = { config: config({ roundId: "0f".repeat(32), entryStart: 10n }) };
  const b = { config: config({ roundId: "01".repeat(32), entryStart: 30n }) };
  const c = { config: config({ roundId: "02".repeat(32), entryStart: 30n }) };
  for (const order of [[a, b, c], [c, b, a], [b, a, c]]) {
    const labels = roundLabels(order);
    assert.strictEqual(labels.get(a.config.roundId), "Round 1");
    assert.strictEqual(labels.get(b.config.roundId), "Round 2");
    assert.strictEqual(labels.get(c.config.roundId), "Round 3");
  }
});
test("groups list newest first, and drawn, refund and finished rounds sit under finished", () => {
  const g = groupRounds([
    row("01", 10n, S.OPEN), row("02", 20n, S.OPEN), row("03", 5n, S.UPCOMING),
    row("04", 1n, S.WAITING), row("05", 2n, S.DRAWN), row("06", 4n, S.REFUNDS), row("07", 3n, S.FINISHED),
  ]);
  assert.deepStrictEqual(g.open.map((r) => r.snapshot.config.roundId), ["02", "01"]);
  assert.deepStrictEqual(g.upcoming.map((r) => r.snapshot.config.roundId), ["03"]);
  assert.deepStrictEqual(g.waiting.map((r) => r.snapshot.config.roundId), ["04"]);
  assert.deepStrictEqual(g.finished.map((r) => r.snapshot.config.roundId), ["06", "07", "05"]);
});
