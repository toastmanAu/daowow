"use strict";
// Every sentence a player reads on Home, Rounds, My tickets, entry, refund and
// the draw comes from copy.js, so the no-jargon rule can be a test instead of
// a good intention.
const { test } = require("node:test");
const assert = require("node:assert");
const copy = require("../dapp/model/copy.js");
const { PLAYER_STATE: S } = require("../dapp/model/round-state.js");
const { OUTCOME, ACTION } = require("../dapp/model/tickets.js");

const BANNED = /\b(epochs?|shards?|cells?|ledgers?|freez\w*|frozen|genesis|aggregat\w*|commitments?|out ?points?|lock hash\w*|witness\w*)\b/i;

test("no banned word reaches the player", () => {
  const samples = copy.ALL_SAMPLES();
  assert.ok(samples.length > 40, "the sample set must cover the copy");
  for (const s of samples) {
    assert.strictEqual(typeof s, "string");
    assert.doesNotMatch(s, BANNED, s);
  }
});

test("the jargon check itself bites", () => {
  for (const w of ["epoch", "the ledger", "frozen", "Aggregation", "a cell", "lock hash", "outpoint"]) {
    assert.match(w, BANNED, w);
  }
  assert.doesNotMatch("We cancelled the excellent miscellaneous parcel.", BANNED);
});

test("every state, outcome and action has a label", () => {
  for (const s of Object.values(S)) assert.ok(copy.stateBadge(s, { full: false }).length > 0, s);
  for (const o of Object.values(OUTCOME)) assert.ok(copy.outcomeBadge(o).length > 0, o);
  for (const a of Object.values(ACTION)) {
    if (a !== ACTION.NONE) assert.ok(copy.actionLabel(a).length > 0, a);
  }
});

test("an open round at its cap reads Full", () => {
  assert.strictEqual(copy.stateBadge(S.OPEN, { full: true }), "Full");
  assert.strictEqual(copy.stateBadge(S.OPEN, { full: false }), "Open now");
});

test("tickets sold is said against the cap when there is one", () => {
  assert.strictEqual(copy.ticketsLine(7n, 10n), "7 of 10 tickets sold");
  assert.strictEqual(copy.ticketsLine(1n, null), "1 ticket sold");
  assert.strictEqual(copy.ticketsLine(0n, null), "0 tickets sold");
});

const tip = { height: 1100n, epoch: { number: 1005n, index: 0n, length: 1800n } };
const config = { entryStart: 1001n, entryEnd: 1010n };

test("a time milestone always says 'about'", () => {
  assert.strictEqual(
    copy.milestone({ view: { state: S.OPEN }, snapshot: { config, seal: null }, tip }),
    "Closes in about 20 h");
  assert.strictEqual(
    copy.milestone({ view: { state: S.UPCOMING }, snapshot: { config: { ...config, entryStart: 1011n }, seal: null }, tip }),
    "Opens in about 24 h");
  assert.strictEqual(
    copy.milestone({ view: { state: S.WAITING }, snapshot: { config, seal: { inclusionHeight: 1000n } }, tip }),
    "Draw in about 15 min");
});

test("a waiting round with no draw scheduled promises no time", () => {
  const line = copy.milestone({ view: { state: S.WAITING }, snapshot: { config, seal: null }, tip });
  assert.doesNotMatch(line, /\d/);
});

test("amounts are whole CKB with separators, rounded down", () => {
  assert.strictEqual(copy.ckb(5023712345678n), "50,237");
  assert.strictEqual(copy.ckb(99999999n), "0");
});

test("the estimate line says it is still growing and never rounds up", () => {
  assert.strictEqual(copy.estimateLine(4199999999n), "about 41 CKB so far, still growing");
  assert.strictEqual(copy.estimateLine(50000000n), "under 1 CKB so far, still growing");
});

test("the honesty line names the block", () => {
  assert.strictEqual(copy.honestyLine(1192n),
    "This result was fixed on-chain at block 1,192. The animation only reveals it.");
});

test("a wallet error keeps the wallet's own words and says what to do", () => {
  const line = copy.errors.wallet("popup closed");
  assert.match(line, /popup closed/);
  assert.match(line, /try again/i);
});

test("a short address keeps both ends", () => {
  assert.strictEqual(copy.shortAddress("ckt1qrfrwcdnvssswdwpn3s9v8fp87emat306ctjwsm3nmlkjg8qyza2cqgqq9sfrkfah2cj79nyp7e6p283ualq8779rscnjmrj88znr8"),
    "ckt1qr…88znr8");
});

test("ordinals read naturally", () => {
  assert.deepStrictEqual([1, 2, 3, 4, 11, 12, 13, 21, 22, 23].map(copy.ordinal),
    ["1st", "2nd", "3rd", "4th", "11th", "12th", "13th", "21st", "22nd", "23rd"]);
});
