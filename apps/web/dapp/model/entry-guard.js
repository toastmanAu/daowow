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
const quote = () => lib("../../chain/quote.js", "DaowowQuote");

// The most tickets one wallet may hold in a round. THE CHAIN HAS NO SUCH
// RULE: this app is the only thing that applies it, so it is a courtesy
// between players and not a guarantee. Several wallets get round it.
const TICKETS_PER_WALLET = 5n;

/**
 * Tickets a wallet holds in one round, from the store's `mine`. Null when
 * `mine` has not been read, which is not the same as holding none.
 */
function heldIn(mine, roundId) {
  if (!Array.isArray(mine)) return null;
  const card = mine.find((c) => c.roundId === roundId);
  return card ? BigInt(card.ticketsHeld) : 0n;
}

/**
 * `block` stops the entry; `warn` needs the player's explicit yes.
 *
 * `held` is what the connected wallet already holds in this round: leave it
 * out when no wallet is connected, pass null when one is but its tickets
 * could not be read.
 */
function entryProblem({ view, snapshot, tickets, nowEpoch, schedule, sound, held }) {
  const S = roundState().PLAYER_STATE;
  const words = copy().text.entry;
  const none = { block: null, warn: null };
  if (view.state === S.UPCOMING) return { ...none, block: words.notOpenYet };
  if (view.state !== S.OPEN) return { ...none, block: words.closed };
  // A round that can never place its tickets in savings takes no entries.
  if (!sound) return { ...none, block: words.unsound };
  // Without a checked prize table the offer cannot be described, so it is
  // not made.
  if (!schedule) return { ...none, block: copy().errors.schedule };
  if (view.full) return { ...none, block: words.full };
  const want = BigInt(tickets);
  if (want <= 0n) return { ...none, block: words.none };
  if (view.cap !== null && view.ticketsSold + want > view.cap) {
    return { ...none, block: copy().ticketsLeft(view.cap - view.ticketsSold) };
  }
  if (held === null) return { ...none, block: words.holdingsUnknown };
  const holds = held === undefined ? 0n : BigInt(held);
  if (holds + want > TICKETS_PER_WALLET) {
    return { ...none, block: copy().walletLimit(TICKETS_PER_WALLET, holds) };
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
async function checkBeforeSigning({ store, roundId, tickets, acceptLate, lockScript, shownTotal }) {
  await store.refresh();
  if (store.state.status !== "ready") {
    return { ok: false, message: copy().errors.network, needsLateConsent: false, row: null };
  }
  if (store.state.lagging) {
    return { ok: false, message: copy().errors.lagging, needsLateConsent: false, row: null };
  }
  const row = store.findRound(roundId);
  if (!row) {
    return { ok: false, message: copy().text.entry.gone, needsLateConsent: false, row: null };
  }
  const problem = entryProblem({
    view: row.view, snapshot: row.snapshot, tickets, schedule: row.schedule, sound: row.sound,
    nowEpoch: store.state.tip.epoch.number,
    held: store.state.session ? heldIn(store.state.mine, row.snapshot.config.roundId) : undefined,
  });
  if (problem.block) return { ok: false, message: problem.block, needsLateConsent: false, row };
  if (problem.warn && !acceptLate) {
    return { ok: false, message: problem.warn, needsLateConsent: true, row };
  }
  // The total the player ticked is the total that gets signed. It is quoted
  // again here from the fresh round and the wallet that will sign; a wallet
  // swapped after the summary was drawn holds a different deposit per ticket.
  let total = null;
  try {
    total = quote().quoteEntry({
      config: row.snapshot.config, schedule: row.schedule, lockScript, tickets, feeShannons: 0n,
    }).total;
  } catch {
    total = null;
  }
  if (total === null || shownTotal === undefined || shownTotal === null || total !== BigInt(shownTotal)) {
    return { ok: false, message: copy().text.entry.changed, needsLateConsent: false, row };
  }
  return { ok: true, message: null, needsLateConsent: false, row };
}

const api = { entryProblem, checkBeforeSigning, heldIn, TICKETS_PER_WALLET };
if (typeof module !== "undefined" && module.exports) module.exports = api;
if (typeof window !== "undefined") window.DaowowEntryGuard = api;
})();
