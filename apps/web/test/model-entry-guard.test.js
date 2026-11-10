"use strict";
// The last check before the wallet opens. A summary can sit on screen for
// minutes; the round can close or fill in that time, and an entry sent then
// is refused by the chain with no explanation. So the round is read AGAIN,
// and anything wrong is said in plain words while the money is still here.
const { test } = require("node:test");
const assert = require("node:assert");
const { entryProblem, checkBeforeSigning } = require("../dapp/model/entry-guard.js");
const { PLAYER_STATE: S } = require("../dapp/model/round-state.js");

const { quoteEntry } = require("../chain/quote.js");
const CKB = 100000000n;
const SCHED = { version: 2, weights: [60n, 40n], thresholds: [1n, 2n] };
const snapshot = { config: {
  roundId: "ab".repeat(32), entryStart: 1001n, entryEnd: 1010n,
  ticketPrice: 100n * CKB, maximumTickets: 10n,
} };
const joyid = { codeHash: "0x1", hashType: "type", args: "0x" + "ab".repeat(22) };
const secp = { codeHash: "0x2", hashType: "type", args: "0x" + "ab".repeat(20) };
const shown = (lockScript, tickets) => quoteEntry({
  config: snapshot.config, schedule: SCHED, lockScript, tickets, feeShannons: 0n,
}).total;
// What the player confirmed: this wallet, this total.
const OFFER = { lockScript: joyid, shownTotal: shown(joyid, 2n) };
const view = (over = {}) => ({ state: S.OPEN, ticketsSold: 3n, cap: 10n, full: false, ...over });
const check = (over = {}) => entryProblem({
  view: view(), snapshot, tickets: 2n, nowEpoch: 1005n, schedule: SCHED, sound: true, ...over,
});

test("an ordinary entry has no problem", () => {
  assert.deepStrictEqual(check(), { block: null, warn: null });
});

test("a round that closed while the summary was open is refused in plain words", () => {
  assert.strictEqual(check({ view: view({ state: S.WAITING }) }).block,
    "Entries for this round have closed.");
});

test("a round that has not opened yet is refused", () => {
  assert.match(check({ view: view({ state: S.UPCOMING }) }).block, /hasn't opened/);
});

test("a round that filled while the summary was open is refused", () => {
  assert.strictEqual(check({ view: view({ ticketsSold: 10n, full: true }) }).block,
    "This round is now full.");
});

test("asking for more tickets than remain is refused with the number left", () => {
  assert.strictEqual(check({ view: view({ ticketsSold: 9n }), tickets: 2n }).block,
    "Only 1 ticket is left in this round.");
  assert.strictEqual(check({ view: view({ ticketsSold: 7n }), tickets: 4n }).block,
    "Only 3 tickets are left in this round.");
  assert.strictEqual(check({ view: view({ ticketsSold: 7n }), tickets: 3n }).block, null);
});

test("an uncapped round never runs out", () => {
  assert.strictEqual(check({ view: view({ cap: null, ticketsSold: 5000n }), tickets: 100n }).block, null);
});

test("zero or negative tickets is refused", () => {
  assert.match(check({ tickets: 0n }).block, /at least one/);
});

test("a round whose prize table could not be checked is refused", () => {
  assert.match(check({ schedule: null }).block, /prize table/);
});

test("a round that can never run takes no entries", () => {
  assert.strictEqual(check({ sound: false }).block, "This round can't take entries.");
});

test("an entry in the round's last period is a warning, not a refusal", () => {
  const late = check({ nowEpoch: 1009n });
  assert.strictEqual(late.block, null);
  assert.match(late.warn, /may not arrive in time/);
  assert.strictEqual(check({ nowEpoch: 1008n }).warn, null);
});

const BANNED = /\b(epochs?|shards?|cells?|ledgers?|freez\w*|frozen|genesis|aggregat\w*|commitments?|out ?points?|lock hash\w*|witness\w*)\b/i;
test("no refusal uses a banned word", () => {
  for (const r of [
    check({ view: view({ state: S.WAITING }) }), check({ view: view({ state: S.UPCOMING }) }),
    check({ view: view({ full: true, ticketsSold: 10n }) }), check({ tickets: 99n }),
    check({ tickets: 0n }), check({ schedule: null }), check({ nowEpoch: 1009n }),
  ]) assert.doesNotMatch(`${r.block} ${r.warn}`, BANNED);
});

// A store whose round changes when it is re-read.
const fakeStore = (after, { status = "ready" } = {}) => {
  const store = {
    refreshes: 0,
    state: { status: "ready", tip: { epoch: { number: 1005n } } },
    row: { snapshot, view: view(), schedule: SCHED, sound: true },
    async refresh() { store.refreshes += 1; store.state.status = status; store.row = after; },
    findRound: () => store.row,
  };
  return store;
};

test("the entry flow re-reads the round before the wallet opens", async () => {
  const fresh = { snapshot, view: view({ ticketsSold: 4n }), schedule: SCHED, sound: true };
  const store = fakeStore(fresh);
  const result = await checkBeforeSigning({ store, roundId: snapshot.config.roundId, tickets: 2n, acceptLate: false, ...OFFER });
  assert.strictEqual(store.refreshes, 1);
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.row, fresh, "the FRESH round is the one handed on");
});

test("a round that closed during the summary stops the flow before signing", async () => {
  const store = fakeStore({ snapshot, view: view({ state: S.WAITING }), schedule: SCHED, sound: true });
  const result = await checkBeforeSigning({ store, roundId: snapshot.config.roundId, tickets: 2n, acceptLate: false, ...OFFER });
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.message, "Entries for this round have closed.");
});

test("a round that vanished, or a network that failed, stops the flow", async () => {
  const gone = await checkBeforeSigning({ store: fakeStore(null), roundId: "ab".repeat(32), tickets: 2n, acceptLate: false, ...OFFER });
  assert.strictEqual(gone.ok, false);
  const down = await checkBeforeSigning({
    store: fakeStore({ snapshot, view: view(), schedule: SCHED, sound: true }, { status: "error" }),
    roundId: "ab".repeat(32), tickets: 2n, acceptLate: false, ...OFFER,
  });
  assert.strictEqual(down.ok, false);
  assert.match(down.message, /can't reach the network/);
});

test("an unsound round stops the flow before signing", async () => {
  const store = fakeStore({ snapshot, view: view(), schedule: SCHED, sound: false });
  const result = await checkBeforeSigning({ store, roundId: "ab".repeat(32), tickets: 2n, acceptLate: false, ...OFFER });
  assert.strictEqual(result.ok, false);
  assert.match(result.message, /can't take entries/);
});

test("a late entry goes ahead only when the player has accepted the risk", async () => {
  const lateStore = () => {
    const s = fakeStore({ snapshot, view: view(), schedule: SCHED, sound: true });
    s.state.tip.epoch.number = 1009n;
    return s;
  };
  const refused = await checkBeforeSigning({ store: lateStore(), roundId: "ab".repeat(32), tickets: 2n, acceptLate: false, ...OFFER });
  assert.strictEqual(refused.ok, false);
  assert.strictEqual(refused.needsLateConsent, true);
  const accepted = await checkBeforeSigning({ store: lateStore(), roundId: "ab".repeat(32), tickets: 2n, acceptLate: true, ...OFFER });
  assert.strictEqual(accepted.ok, true);
});

// --- the total the player confirmed is the total that gets signed ------------
const priced = { snapshot, view: view(), schedule: SCHED, sound: true };
const sign = (over) => checkBeforeSigning({
  store: fakeStore(priced), roundId: "ab".repeat(32), tickets: 2n, acceptLate: false,
  lockScript: joyid, shownTotal: shown(joyid, 2n), ...over,
});

test("the same wallet and the same total go ahead", async () => {
  assert.strictEqual((await sign({})).ok, true);
});

test("a wallet swapped after the summary was shown stops the flow", async () => {
  // A JoyID lock and a secp lock hold different deposits per ticket, so the
  // total on screen would not be the total signed.
  const result = await sign({ lockScript: secp });
  assert.strictEqual(result.ok, false);
  assert.match(result.message, /total has changed/);
});

test("a total that no longer matches the round stops the flow", async () => {
  const result = await sign({ shownTotal: shown(joyid, 2n) - 1n });
  assert.strictEqual(result.ok, false);
});

test("signing without a confirmed total is refused", async () => {
  assert.strictEqual((await sign({ shownTotal: undefined })).ok, false);
});
