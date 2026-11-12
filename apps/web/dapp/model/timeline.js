"use strict";
// Wrapped in an IIFE: loaded as a classic script these files share one
// global scope, so top-level declarations would collide between modules.
(function () {
// A round's life as five steps, with "you are here".
//
// The order is the chain's own: the draw happens soon after entries close,
// the savings term runs AFTER the draw, and prizes are paid when the term
// ends. Every time is an estimate and says so.

const lib = (path, name) => (typeof require === "function" ? require(path) : window[name]);
const roundState = () => lib("./round-state.js", "DaowowRoundState");
const time = () => lib("./time.js", "DaowowTime");
const entropy = () => lib("../../chain/entropy-derive.js", "DaowowEntropyDerive");

// One native savings cycle is 180 four-hour periods.
const PERIODS_PER_TERM = 180n;

/**
 * How long a ticket's deposit is held from the moment it goes into savings.
 * One cycle MORE than the round commits: a withdrawal cannot be started until
 * the committed term is over, and it then pays out at the end of the next
 * cycle. (Interest stops when the withdrawal is started.)
 */
function heldMs(config) {
  return (BigInt(config.daoTermPeriods) + 1n) * PERIODS_PER_TERM * time().EPOCH_MS;
}

function buildTimeline({ snapshot, view, tip }) {
  const S = roundState().PLAYER_STATE;
  const t = time();
  const { config, seal } = snapshot;
  const inAbout = (ms) => `in ${t.describeDuration(ms)}`;
  const hereKey = {
    [S.UPCOMING]: "opens",
    [S.OPEN]: "closes",
    [S.WAITING]: "draw",
    [S.DRAWN]: "term",
    [S.REFUNDS]: "payout",
    [S.FINISHED]: "payout",
  }[view.state];

  let drawWhen = "soon after entries close";
  if (view.state === S.WAITING && seal) {
    drawWhen = inAbout(t.msUntilBlock(entropy().lastEntropyHeight(seal.inclusionHeight), tip.height));
  }
  const termMs = heldMs(config);

  const order = [
    ["opens", "Entries open", view.state === S.UPCOMING
      ? inAbout(t.msUntilEpoch(config.entryStart, tip.epoch)) : ""],
    ["closes", "Entries close", view.state === S.UPCOMING || view.state === S.OPEN
      ? inAbout(t.msUntilEpoch(config.entryEnd, tip.epoch)) : ""],
    ["draw", "Draw", drawWhen],
    ["term", "Savings term", t.describeDuration(termMs)],
    ["payout", "Payout", "after the savings term"],
  ];
  const hereIndex = order.findIndex(([key]) => key === hereKey);
  const steps = order.map(([key, label, when], i) => ({
    key, label, done: i < hereIndex, here: i === hereIndex, when: i < hereIndex ? "" : when,
  }));
  // A round that did not go ahead has no draw and no payout to wait for.
  const ended = view.state === S.REFUNDS || view.state === S.FINISHED;
  return { steps, ended };
}

const api = { buildTimeline, heldMs, PERIODS_PER_TERM };
if (typeof module !== "undefined" && module.exports) module.exports = api;
if (typeof window !== "undefined") window.DaowowTimeline = api;
})();
