"use strict";
// Wrapped in an IIFE: loaded as a classic script these files share one
// global scope, so top-level declarations would collide between modules.
(function () {
// The last check before the wallet opens.
//
// An entry summary can sit on screen for minutes. In that time the round can
// close or sell out, and an entry sent then is refused by the chain with an
// error code that explains nothing. So the round is read again, and anything
// wrong is said in plain words while the money is still in the wallet.

const lib = (path, name) => (typeof require === "function" ? require(path) : window[name]);
const roundState = () => lib("./round-state.js", "DaowowRoundState");
const copy = () => lib("./copy.js", "DaowowCopy");

/** `block` stops the entry; `warn` needs the player's explicit yes. */
function entryProblem({ view, snapshot, tickets, nowEpoch, schedule }) {
  const S = roundState().PLAYER_STATE;
  const words = copy().text.entry;
  const none = { block: null, warn: null };
  if (view.state === S.UPCOMING) return { ...none, block: words.notOpenYet };
  if (view.state !== S.OPEN) return { ...none, block: words.closed };
  // Without a checked prize table the offer cannot be described, so it is
  // not made.
  if (!schedule) return { ...none, block: copy().errors.schedule };
  if (view.full) return { ...none, block: words.full };
  const want = BigInt(tickets);
  if (want <= 0n) return { ...none, block: words.none };
  if (view.cap !== null && view.ticketsSold + want > view.cap) {
    return { ...none, block: copy().ticketsLeft(view.cap - view.ticketsSold) };
  }
  // The window closes at the START of entry_end, so in the period before it
  // an entry races the clock.
  if (BigInt(nowEpoch) + 1n >= BigInt(snapshot.config.entryEnd)) {
    return { ...none, warn: words.late };
  }
  return none;
}

/**
 * Re-reads the round, then judges it. `row` in the answer is the FRESH round,
 * and is the one the transaction must be built from.
 */
async function checkBeforeSigning({ store, roundId, tickets, acceptLate }) {
  await store.refresh();
  if (store.state.status !== "ready") {
    return { ok: false, message: copy().errors.network, needsLateConsent: false, row: null };
  }
  const row = store.findRound(roundId);
  if (!row) {
    return { ok: false, message: copy().text.entry.gone, needsLateConsent: false, row: null };
  }
  const problem = entryProblem({
    view: row.view, snapshot: row.snapshot, tickets, schedule: row.schedule,
    nowEpoch: store.state.tip.epoch.number,
  });
  if (problem.block) return { ok: false, message: problem.block, needsLateConsent: false, row };
  if (problem.warn && !acceptLate) {
    return { ok: false, message: problem.warn, needsLateConsent: true, row };
  }
  return { ok: true, message: null, needsLateConsent: false, row };
}

const api = { entryProblem, checkBeforeSigning };
if (typeof module !== "undefined" && module.exports) module.exports = api;
if (typeof window !== "undefined") window.DaowowEntryGuard = api;
})();
