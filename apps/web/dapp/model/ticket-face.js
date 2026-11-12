"use strict";
// Wrapped in an IIFE: loaded as a classic script these files share one
// global scope, so top-level declarations would collide between modules.
(function () {
// The face of one ticket: what is printed on the card its holder sees.
//
// A ticket's NUMBER is its place in the round, counted from 1, which is the
// number on its ball in the draw. Its HASH is the identity the chain derives
// for it at entry and writes into the ticket itself; it never changes, whoever
// holds the ticket.

const lib = (path, name) => (typeof require === "function" ? require(path) : window[name]);
const core = () => lib("../../core.js", "DaowowCore");
const entryCodec = () => lib("../../chain/entry-codec.js", "DaowowEntryCodec");
const ticketsLib = () => lib("./tickets.js", "DaowowTickets");

const RESULT = Object.freeze({ WON: "won", NOT_THIS_TIME: "not-this-time", DID_NOT_RUN: "did-not-run" });
const ART = Object.freeze({ BLANK: "blank", WINNER: "winner" });

const ascending = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

function resultFor(card, position) {
  const O = ticketsLib().OUTCOME;
  if (card.outcome === O.WON || card.outcome === O.NOT_THIS_TIME) {
    const win = card.wins.find((w) => BigInt(w.position) === position);
    return win ? { kind: RESULT.WON, place: win.place } : { kind: RESULT.NOT_THIS_TIME };
  }
  if (card.outcome === O.DID_NOT_RUN || card.outcome === O.REFUNDABLE || card.outcome === O.REFUND_LATER) {
    return { kind: RESULT.DID_NOT_RUN };
  }
  return null;
}

/**
 * `card` is one of buildMyTickets' cards, with `times` attached by the store.
 * A round in several parts gets no faces: its positions are counted within a
 * part, so they are not the numbers the draw uses.
 */
function buildTicketFaces({ card, label }) {
  if (card.multiShard) return [];
  const commitment = core().unhex(card.commitment);
  const times = card.times ?? { opens: null, closes: null, draw: null };
  return [...card.tickets]
    .sort((a, b) => ascending(BigInt(a.position), BigInt(b.position)))
    .map((ticket) => {
      const position = BigInt(ticket.position);
      const result = resultFor(card, position);
      return {
        number: String(position + 1n),
        ticketId: "0x" + core().hex(entryCodec().ticketId(commitment, ticket.shardId, position)),
        roundLabel: label,
        opens: times.opens,
        closes: times.closes,
        // A round that did not run had no draw to date.
        draw: result && result.kind === RESULT.DID_NOT_RUN ? null : times.draw,
        // No date and no result: the draw is still to come.
        drawPending: !times.draw && result === null,
        result,
        art: result && result.kind === RESULT.WON ? ART.WINNER : ART.BLANK,
      };
    });
}

const api = { RESULT, ART, buildTicketFaces };
if (typeof module !== "undefined" && module.exports) module.exports = api;
if (typeof window !== "undefined") window.DaowowTicketFace = api;
})();
