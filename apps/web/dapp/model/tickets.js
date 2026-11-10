"use strict";
// Wrapped in an IIFE: loaded as a classic script these files share one
// global scope, so top-level declarations would collide between modules.
(function () {
// "My tickets": what one wallet holds, across every round.
//
// A ticket IS its claim: one claim per ticket, minted at entry under the
// entrant's lock. Claims are transferable and the current holder of a winning
// claim redeems its prize. So the question "did I win?" is asked of the claims
// the wallet HOLDS, never of the entries it once made.
//
// Entry cells are the other half. They exist until the round takes them in,
// and they are what a refund returns. They are never added to the ticket
// count: until then an entry and its claims are the same tickets seen twice.

const roundState = () =>
  typeof require === "function" ? require("./round-state.js") : window.DaowowRoundState;
const refundTx = () =>
  typeof require === "function" ? require("../../chain/refund-tx.js") : window.DaowowRefundTx;

const OUTCOME = Object.freeze({
  IN_ROUND: "in-round",
  WAITING: "waiting",
  REFUNDABLE: "refundable",
  REFUND_LATER: "refund-later",
  DID_NOT_RUN: "did-not-run",
  WON: "won",
  NOT_THIS_TIME: "not-this-time",
});

const ACTION = Object.freeze({
  ENTER_MORE: "enter-more",
  REFUND: "refund",
  WATCH_DRAW: "watch-draw",
  CLAIM_SOON: "claim-soon",
  RETIRE_SOON: "retire-soon",
  NONE: "none",
});

const ascending = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

function winsFor(positions, draw) {
  const held = new Set(positions.map(String));
  return draw.positions
    .filter((p) => held.has(String(BigInt(p.position))))
    .map((p) => ({ place: Number(p.prizeIndex) + 1, position: BigInt(p.position) }))
    .sort((a, b) => a.place - b.place);
}

// Outcome and actions for one round, before any refund is added.
function judge({ row, draw, wins, refundable, blocked, multiShard }) {
  const S = roundState().PLAYER_STATE;
  const state = row.view.state;
  if (state === S.OPEN) {
    return [OUTCOME.IN_ROUND, row.view.full ? [] : [ACTION.ENTER_MORE]];
  }
  if (state === S.REFUNDS) {
    if (refundable.length > 0) return [OUTCOME.REFUNDABLE, []];
    if (blocked.length > 0) return [OUTCOME.REFUND_LATER, []];
    return [OUTCOME.DID_NOT_RUN, [ACTION.RETIRE_SOON]];
  }
  if (state === S.FINISHED) return [OUTCOME.DID_NOT_RUN, [ACTION.RETIRE_SOON]];
  if (state === S.DRAWN) {
    // No draw to hand means it could not be computed or checked. Saying
    // "not this time" then would be inventing a result.
    if (!draw || multiShard) return [OUTCOME.WAITING, []];
    if (!draw.viable) return [OUTCOME.DID_NOT_RUN, [ACTION.RETIRE_SOON]];
    return wins.length > 0
      ? [OUTCOME.WON, [ACTION.WATCH_DRAW, ACTION.CLAIM_SOON]]
      : [OUTCOME.NOT_THIS_TIME, [ACTION.WATCH_DRAW, ACTION.RETIRE_SOON]];
  }
  return [OUTCOME.WAITING, []];
}

function buildMyTickets({ rows, claims, entries, draws, nowEpoch }) {
  const cards = [];
  // Newest round first. Claims or entries naming a round that is not in
  // `rows` (another deployment, say) simply match nothing.
  const newestFirst = [...rows].sort((a, b) =>
    ascending(b.snapshot.config.entryStart, a.snapshot.config.entryStart));
  for (const row of newestFirst) {
    const { config, ledger } = row.snapshot;
    const myClaims = claims.filter((c) => c.commitment === config.commitment);
    const myEntries = entries.filter((e) => e.commitment === config.commitment);
    if (myClaims.length === 0 && myEntries.length === 0) continue;

    const refundable = [];
    const blocked = [];
    for (const e of myEntries) {
      const reason = refundTx().refundBlocker({
        config, nowEpoch, ledger: ledger ? ledger.state : null, entryNonce: e.entry.entryNonce,
      });
      if (reason === null) refundable.push(e);
      else blocked.push({ entry: e, reason });
    }

    const positions = myClaims.map((c) => BigInt(c.position)).sort(ascending);
    // Positions are shard-local. With one shard they are also the draw's
    // positions; with more they are not, and guessing would name winners.
    const multiShard = Number(config.entryShardCount) !== 1;
    const draw = draws.get(config.commitment) ?? null;
    const wins = draw && draw.viable && !multiShard ? winsFor(positions, draw) : [];
    const [outcome, base] = judge({ row, draw, wins, refundable, blocked, multiShard });
    // A refund is offered wherever one is possible, whatever became of the
    // round: an entry the round never took in is the player's to take back.
    const actions = refundable.length > 0 ? [ACTION.REFUND, ...base] : base;

    cards.push({
      roundId: config.roundId,
      commitment: config.commitment,
      ticketsHeld: myClaims.length,
      positions,
      outcome,
      actions,
      wins,
      refundable,
      blocked,
      multiShard,
    });
  }
  return cards;
}

const api = { OUTCOME, ACTION, buildMyTickets };
if (typeof module !== "undefined" && module.exports) module.exports = api;
if (typeof window !== "undefined") window.DaowowTickets = api;
})();
