"use strict";
// "My tickets": one card per round the wallet holds something in. A ticket is
// its claim, claims move between wallets, and the HOLDER of a winning claim
// wins — so this is built from what the wallet holds now, not what it entered.
const { test } = require("node:test");
const assert = require("node:assert");
const { OUTCOME: O, ACTION: A, buildMyTickets } = require("../dapp/model/tickets.js");
const { PLAYER_STATE: S } = require("../dapp/model/round-state.js");

const C1 = "c1".repeat(32), C2 = "c2".repeat(32);
const row = (commitment, state, over = {}) => ({
  snapshot: {
    config: {
      roundId: commitment.replace(/c/g, "a"), commitment, entryStart: over.entryStart ?? 100n,
      aggregationDeadline: 200n, entryShardCount: over.shards ?? 1, minimumTickets: 5n,
    },
    ledger: over.ledger ?? null,
  },
  view: { state, full: over.full ?? false },
});
const claim = (commitment, position) => ({ commitment, shardId: 0, position: BigInt(position), capacity: 22200000000n });
const entry = (commitment, nonce, tickets = 5) => ({
  commitment, capacity: 50237n * 100000000n,
  entry: { entryNonce: BigInt(nonce), ticketCount: BigInt(tickets) },
});
const closed = (acceptedEntries) => ({ state: { closed: true, acceptedEntries: BigInt(acceptedEntries) } });
const draw = (positions, viable = true) => ({
  viable, positions: positions.map(([prizeIndex, position]) => ({ prizeIndex, position })),
});
const build = (over) => buildMyTickets({
  rows: [], claims: [], entries: [], draws: new Map(), nowEpoch: 300n, ...over,
});

test("ticketsHeld counts claims, not entry cells, so nothing is counted twice", () => {
  const cards = build({
    rows: [row(C1, S.OPEN)],
    claims: [0, 1, 2, 3, 4].map((p) => claim(C1, p)),
    entries: [entry(C1, 0, 5)],
  });
  assert.strictEqual(cards.length, 1);
  assert.strictEqual(cards[0].ticketsHeld, 5);
  assert.deepStrictEqual(cards[0].positions, [0n, 1n, 2n, 3n, 4n]);
  assert.strictEqual(cards[0].outcome, O.IN_ROUND);
  assert.deepStrictEqual(cards[0].actions, [A.ENTER_MORE]);
});

test("a claim sent from another wallet counts for the holder", () => {
  const cards = build({ rows: [row(C1, S.WAITING)], claims: [claim(C1, 8)] });
  assert.strictEqual(cards[0].ticketsHeld, 1);
  assert.strictEqual(cards[0].outcome, O.WAITING);
  assert.deepStrictEqual(cards[0].actions, []);
});

test("the holder of a winning claim wins, with its place", () => {
  const cards = build({
    rows: [row(C1, S.DRAWN)], claims: [claim(C1, 3), claim(C1, 7)],
    draws: new Map([[C1, draw([[1, 7], [0, 3], [2, 9]])]]),
  });
  assert.strictEqual(cards[0].outcome, O.WON);
  assert.deepStrictEqual(cards[0].wins, [{ place: 1, position: 3n }, { place: 2, position: 7n }]);
  assert.deepStrictEqual(cards[0].actions, [A.WATCH_DRAW, A.CLAIM_SOON]);
});

test("a drawn round with no winning claim is 'not this time'", () => {
  const cards = build({
    rows: [row(C1, S.DRAWN)], claims: [claim(C1, 4)],
    draws: new Map([[C1, draw([[0, 3]])]]),
  });
  assert.strictEqual(cards[0].outcome, O.NOT_THIS_TIME);
  assert.deepStrictEqual(cards[0].wins, []);
  assert.deepStrictEqual(cards[0].actions, [A.WATCH_DRAW, A.RETIRE_SOON]);
});

test("a drawn round whose draw could not be computed says waiting, never a result", () => {
  const cards = build({ rows: [row(C1, S.DRAWN)], claims: [claim(C1, 4)] });
  assert.strictEqual(cards[0].outcome, O.WAITING);
  assert.deepStrictEqual(cards[0].wins, []);
});

test("a drawn but unviable round is did-not-run, never 'not this time'", () => {
  const cards = build({
    rows: [row(C1, S.DRAWN)], claims: [claim(C1, 4)],
    draws: new Map([[C1, draw([], false)]]),
  });
  assert.strictEqual(cards[0].outcome, O.DID_NOT_RUN);
  assert.deepStrictEqual(cards[0].actions, [A.RETIRE_SOON]);
});

test("a failed round with a refundable entry offers Refund", () => {
  const e = entry(C1, 0);
  const cards = build({
    rows: [row(C1, S.REFUNDS, { ledger: closed(0) })], claims: [claim(C1, 0)], entries: [e],
  });
  assert.strictEqual(cards[0].outcome, O.REFUNDABLE);
  assert.deepStrictEqual(cards[0].actions, [A.REFUND]);
  assert.deepStrictEqual(cards[0].refundable, [e]);
  assert.deepStrictEqual(cards[0].blocked, []);
});

test("before the refund date the entry is blocked with its reason and no Refund is offered", () => {
  const e = entry(C1, 0);
  const cards = build({
    rows: [row(C1, S.REFUNDS, { ledger: closed(0) })], entries: [e], nowEpoch: 199n,
  });
  assert.strictEqual(cards[0].outcome, O.REFUND_LATER);
  assert.deepStrictEqual(cards[0].actions, []);
  assert.strictEqual(cards[0].refundable.length, 0);
  assert.strictEqual(cards[0].blocked[0].entry, e);
  assert.match(cards[0].blocked[0].reason, /deadline/);
});

test("an entry left out of a round that went ahead can still be refunded", () => {
  // Accepted prefix of 1: nonce 0 plays, nonce 1 was never taken in.
  const cards = build({
    rows: [row(C1, S.WAITING, { ledger: closed(1) })],
    claims: [claim(C1, 0)], entries: [entry(C1, 1)],
  });
  assert.strictEqual(cards[0].outcome, O.WAITING);
  assert.deepStrictEqual(cards[0].actions, [A.REFUND]);
});

test("after the refund, the remaining claims leave a did-not-run card", () => {
  const cards = build({
    rows: [row(C1, S.FINISHED, { ledger: closed(0) })],
    claims: [0, 1, 2, 3, 4].map((p) => claim(C1, p)),
  });
  assert.strictEqual(cards[0].outcome, O.DID_NOT_RUN);
  assert.deepStrictEqual(cards[0].actions, [A.RETIRE_SOON]);
  assert.strictEqual(cards[0].ticketsHeld, 5);
});

test("a claim or entry from a round the app cannot find is skipped, not thrown", () => {
  const cards = build({
    rows: [row(C1, S.OPEN)],
    claims: [claim(C1, 0), claim("ee".repeat(32), 1)],
    entries: [entry("ff".repeat(32), 0)],
  });
  assert.strictEqual(cards.length, 1);
  assert.strictEqual(cards[0].commitment, C1);
});

test("a round the wallet holds nothing in has no card", () => {
  assert.deepStrictEqual(build({ rows: [row(C1, S.OPEN), row(C2, S.OPEN)], claims: [claim(C2, 0)] })
    .map((c) => c.commitment), [C2]);
});

test("an open, full round offers no Enter more", () => {
  const cards = build({ rows: [row(C1, S.OPEN, { full: true })], claims: [claim(C1, 0)] });
  assert.deepStrictEqual(cards[0].actions, []);
});

test("a multi-shard round is flagged rather than given a guessed result", () => {
  const cards = build({
    rows: [row(C1, S.DRAWN, { shards: 2 })], claims: [claim(C1, 3)],
    draws: new Map([[C1, draw([[0, 3]])]]),
  });
  assert.strictEqual(cards[0].multiShard, true);
  assert.strictEqual(cards[0].outcome, O.WAITING);
  assert.deepStrictEqual(cards[0].wins, []);
});

test("cards come back newest round first", () => {
  const cards = build({
    rows: [row(C1, S.OPEN, { entryStart: 100n }), row(C2, S.OPEN, { entryStart: 500n })],
    claims: [claim(C1, 0), claim(C2, 0)],
  });
  assert.deepStrictEqual(cards.map((c) => c.commitment), [C2, C1]);
});
