"use strict";
// Wrapped in an IIFE: loaded as a classic script these files share one
// global scope, so top-level declarations would collide between modules.
(function () {
// What state a round is in, in the six words a player needs.
//
// discovery.js's deriveRoundState knows three states, enough for the entry
// page alone. A player following a round to its end needs the rest. Like that
// function this DERIVES on every read and stores nothing, so a reorg restores
// what the chain says rather than leaving the page asserting something stale.

const codec = () =>
  typeof require === "function" ? require("../../chain/codec.js") : window.DaowowCodec;

const PLAYER_STATE = Object.freeze({
  UPCOMING: "upcoming",
  OPEN: "open",
  WAITING: "waiting",
  DRAWN: "drawn",
  REFUNDS: "refunds",
  FINISHED: "finished",
});

const sum = (ledgers) => ledgers.reduce((n, l) => n + BigInt(l.acceptedTickets), 0n);

// Tickets in the round. While entries are being taken the shards hold the
// count; once they are consumed the count lives in whichever cell replaced
// them.
function ticketsIn(snapshot) {
  if (snapshot.shards.length > 0) {
    return snapshot.shards.reduce((n, s) => n + BigInt(s.ticketCount), 0n);
  }
  if (snapshot.record) return sum(snapshot.record.record.seal.ledgers);
  if (snapshot.seal) return sum(snapshot.seal.seal.ledgers);
  if (snapshot.ledger) return BigInt(snapshot.ledger.state.acceptedTickets);
  return 0n;
}

/**
 * `entropyReady`: the last of the seal's four entropy blocks has been mined.
 * `liveEntryCount`: entry cells of this round still on chain.
 */
function derivePlayerState({ snapshot, nowEpoch, entropyReady, liveEntryCount }) {
  const { config, shards, ledger, seal, record } = snapshot;
  const now = BigInt(nowEpoch);
  const ticketsSold = ticketsIn(snapshot);
  const frozen = shards.length > 0
    && shards.every((s) => s.state === codec().SHARD_STATE.FROZEN);
  const closedShort = Boolean(ledger) && ledger.state.closed
    && BigInt(ledger.state.acceptedTickets) < BigInt(config.minimumTickets);
  const past = now >= BigInt(config.entryEnd); // entry_end is EXCLUSIVE
  const processed = Boolean(ledger || seal || record);

  let state;
  if (record || (seal && entropyReady)) {
    // The result exists as soon as the blocks do; the operator's record only
    // writes it down.
    state = PLAYER_STATE.DRAWN;
  } else if (closedShort && liveEntryCount > 0) {
    state = PLAYER_STATE.REFUNDS;
  } else if (closedShort) {
    state = PLAYER_STATE.FINISHED;
  } else if (!frozen && !processed && past && ticketsSold === 0n) {
    // Nobody entered and nobody can now. Without this an empty round would
    // read "waiting for draw" for ever.
    state = PLAYER_STATE.FINISHED;
  } else if (frozen || processed || past) {
    state = PLAYER_STATE.WAITING;
  } else if (now < BigInt(config.entryStart)) {
    state = PLAYER_STATE.UPCOMING;
  } else {
    state = PLAYER_STATE.OPEN; // entry_start is INCLUSIVE
  }

  // maximum_tickets 0 means uncapped.
  const cap = BigInt(config.maximumTickets) === 0n ? null : BigInt(config.maximumTickets);
  return Object.freeze({
    state,
    ticketsSold,
    cap,
    full: cap !== null && ticketsSold >= cap,
    viable: ticketsSold >= BigInt(config.minimumTickets),
  });
}

const byAge = (a, b) => {
  const x = a.config, y = b.config;
  if (x.entryStart !== y.entryStart) return x.entryStart < y.entryStart ? -1 : 1;
  return x.roundId < y.roundId ? -1 : x.roundId > y.roundId ? 1 : 0;
};

/** "Round 1", "Round 2"… oldest first. The hex id stays behind Details. */
function roundLabels(snapshots) {
  const labels = new Map();
  [...snapshots].sort(byAge).forEach((s, i) => labels.set(s.config.roundId, `Round ${i + 1}`));
  return labels;
}

function groupRounds(rows) {
  const groups = { open: [], upcoming: [], waiting: [], finished: [] };
  const where = {
    [PLAYER_STATE.OPEN]: "open",
    [PLAYER_STATE.UPCOMING]: "upcoming",
    [PLAYER_STATE.WAITING]: "waiting",
    [PLAYER_STATE.DRAWN]: "finished",
    [PLAYER_STATE.REFUNDS]: "finished",
    [PLAYER_STATE.FINISHED]: "finished",
  };
  const newestFirst = [...rows].sort((a, b) => byAge(b.snapshot, a.snapshot));
  for (const row of newestFirst) groups[where[row.view.state]].push(row);
  return groups;
}

const api = { PLAYER_STATE, derivePlayerState, groupRounds, roundLabels };
if (typeof module !== "undefined" && module.exports) module.exports = api;
if (typeof window !== "undefined") window.DaowowRoundState = api;
})();
