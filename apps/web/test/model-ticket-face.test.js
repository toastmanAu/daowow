"use strict";
// The face of one ticket: what is printed on the card a holder sees. Its
// number must be the number on the ball in the draw, and its hash must be the
// identity the chain gave it at entry.
const { test } = require("node:test");
const assert = require("node:assert");
const core = require("../core.js");
const { ticketId } = require("../chain/entry-codec.js");
const { OUTCOME: O } = require("../dapp/model/tickets.js");
const { buildTicketFaces, RESULT, ART } = require("../dapp/model/ticket-face.js");
const { buildDrawScript } = require("../dapp/model/draw-script.js");

const C = "c1".repeat(32);
const card = (over = {}) => ({
  commitment: C, outcome: O.IN_ROUND, multiShard: false, wins: [],
  tickets: [{ shardId: 0, position: 36n }, { shardId: 0, position: 4n }],
  times: null, ...over,
});
const faces = (over) => buildTicketFaces({ card: card(over), label: "Round 5" });

test("one face per ticket held, lowest number first", () => {
  assert.deepStrictEqual(faces().map((f) => f.number), ["5", "37"]);
  assert.deepStrictEqual(faces().map((f) => f.roundLabel), ["Round 5", "Round 5"]);
});

test("a ticket's number is the number on its ball in the draw", () => {
  const script = buildDrawScript({
    draw: { viable: true, tickets: 40n, positions: [{ prizeIndex: 0, position: 36n }], seed: "0x01" },
    myPositions: [],
  });
  const ball = script.reveals[0].label;
  assert.strictEqual(ball, "37");
  assert.ok(faces().some((f) => f.number === ball));
});

test("the hash is the ticket identity the chain derives, in full", () => {
  const [five] = faces();
  assert.strictEqual(five.ticketId, "0x" + core.hex(ticketId(core.unhex(C), 0, 4n)));
  assert.strictEqual(five.ticketId.length, 66);
  assert.notStrictEqual(faces()[1].ticketId, five.ticketId);
});

test("the hash depends on which part of the round the ticket sits in", () => {
  const a = buildTicketFaces({ card: card({ tickets: [{ shardId: 0, position: 4n }] }), label: "R" })[0];
  const b = buildTicketFaces({ card: card({ tickets: [{ shardId: 1, position: 4n }] }), label: "R" })[0];
  assert.notStrictEqual(a.ticketId, b.ticketId);
});

test("before a result there is none on the face, and the plain artwork", () => {
  for (const outcome of [O.IN_ROUND, O.WAITING]) {
    for (const f of faces({ outcome })) {
      assert.strictEqual(f.result, null);
      assert.strictEqual(f.art, ART.BLANK);
    }
  }
});

test("only the winning ticket shows a place and the winner artwork", () => {
  const [five, thirtySeven] = faces({ outcome: O.WON, wins: [{ place: 2, position: 36n }] });
  assert.deepStrictEqual(thirtySeven.result, { kind: RESULT.WON, place: 2 });
  assert.strictEqual(thirtySeven.art, ART.WINNER);
  assert.deepStrictEqual(five.result, { kind: RESULT.NOT_THIS_TIME });
  assert.strictEqual(five.art, ART.BLANK);
});

test("a drawn round with no win says not this time on every ticket", () => {
  for (const f of faces({ outcome: O.NOT_THIS_TIME })) {
    assert.deepStrictEqual(f.result, { kind: RESULT.NOT_THIS_TIME });
  }
});

test("a round that did not go ahead says so, whatever the refund state", () => {
  for (const outcome of [O.DID_NOT_RUN, O.REFUNDABLE, O.REFUND_LATER]) {
    for (const f of faces({ outcome })) assert.deepStrictEqual(f.result, { kind: RESULT.DID_NOT_RUN });
  }
});

test("the dates on the face are the card's, passed through untouched", () => {
  const times = {
    opens: { ms: 1000n, exact: true }, closes: { ms: 2000n, exact: false }, draw: null,
  };
  const [f] = faces({ times });
  assert.deepStrictEqual(f.opens, times.opens);
  assert.deepStrictEqual(f.closes, times.closes);
  assert.strictEqual(f.draw, null);
  const [bare] = faces({ times: null });
  assert.deepStrictEqual([bare.opens, bare.closes, bare.draw], [null, null, null]);
});

test("a round in several parts shows no faces: its numbers are not draw numbers", () => {
  assert.deepStrictEqual(faces({ multiShard: true }), []);
});

test("'soon' is said about the draw only while there is no result yet", () => {
  for (const outcome of [O.IN_ROUND, O.WAITING]) {
    for (const f of faces({ outcome })) assert.strictEqual(f.drawPending, true, outcome);
  }
  // A drawn round whose draw time could not be read has had its draw: saying
  // "soon" would be false. A round that did not run has none to wait for.
  for (const outcome of [O.WON, O.NOT_THIS_TIME, O.DID_NOT_RUN, O.REFUNDABLE, O.REFUND_LATER]) {
    for (const f of faces({ outcome })) assert.strictEqual(f.drawPending, false, outcome);
  }
  const dated = { opens: null, closes: null, draw: { ms: 5n, exact: false } };
  for (const f of faces({ outcome: O.WAITING, times: dated })) assert.strictEqual(f.drawPending, false);
});

test("a round that did not run shows no draw date, even if one exists on the chain", () => {
  const times = { opens: null, closes: null, draw: { ms: 5n, exact: true } };
  for (const f of faces({ outcome: O.DID_NOT_RUN, times })) assert.strictEqual(f.draw, null);
  for (const f of faces({ outcome: O.NOT_THIS_TIME, times })) assert.deepStrictEqual(f.draw, times.draw);
});
