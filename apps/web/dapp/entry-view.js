"use strict";
// Wrapped in an IIFE: loaded as a classic script these files share one
// global scope, so top-level declarations would collide between modules.
(function () {
// How the entry offer is described. Kept pure — it returns rows and strings,
// never touches the DOM — so the WORDING and the FIGURES are testable rather
// than only that a page loaded.

const schedule =
  typeof require === "function" ? require("../chain/schedule.js") : window.DaowowSchedule;

const SHANNONS_PER_CKB = 100000000n;

// Thousands separators for readability, but never rounding: a quote that
// understates what is charged is worse than an ugly one.
function formatCkb(shannons) {
  const value = BigInt(shannons);
  const whole = value / SHANNONS_PER_CKB;
  const frac = value % SHANNONS_PER_CKB;
  const grouped = whole.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  if (frac === 0n) return grouped;
  return `${grouped}.${frac.toString().padStart(8, "0")}`;
}

// Every part named in plain words, with what happens to it afterwards. The
// most misleading reading of this summary is that the ticket deposit is a
// fee; it is not, it comes back. Only the network fee is spent.
//
// `term` is how long the round holds the money, in words, from the round's
// own configuration.
function describeQuote(quote, { term = "the length of the round" } = {}) {
  return [
    {
      label: `Your tickets (${quote.tickets})`,
      value: `${formatCkb(quote.principal)} CKB`,
      note: "Returned to you after the round, win or lose.",
    },
    {
      label: `Ticket deposit (${quote.tickets})`,
      value: `${formatCkb(quote.claimCapacity)} CKB`,
      note: "Held with your tickets. Returned when the round is finished.",
    },
    {
      label: "Storage deposit",
      value: `${formatCkb(quote.entryCellOverhead)} CKB`,
      note: "Once per purchase. Returned after the round.",
    },
    {
      label: "Network fee",
      // The wallet sizes the exact fee when it prepares the transaction, so
      // before then the honest figure is a ceiling.
      value: quote.fee > 0n ? `${formatCkb(quote.fee)} CKB` : "under 0.01 CKB",
      note: "Paid to the network. Not returned.",
    },
    {
      label: "Total leaving your wallet now",
      value: `${formatCkb(quote.total)} CKB`,
      // A term that already says when ("until payout, …") takes no "for".
      note: `Held ${/^until /.test(term) ? term : `for ${term}`}, then returned except the fee.`,
    },
  ];
}

// What the round pays now, and what buying more would open. A threshold the
// round's own cap puts out of reach is NOT advertised — implying a prize that
// cannot exist would misrepresent the offer.
function describePayout(sched, ticketsSold, maximumTickets) {
  const sold = BigInt(ticketsSold);
  const cap = BigInt(maximumTickets ?? 0n);
  const placesNow = schedule.placesFor(sched, sold === 0n ? 1n : sold);
  // An empty round is described as it will be once it has its first ticket,
  // so the next place is the one after that, not the first.
  let next = schedule.nextThreshold(sched, sold === 0n ? 1n : sold);
  if (next !== null && cap !== 0n && next > cap) next = null;

  const places = `${placesNow} place${placesNow === 1 ? "" : "s"}`;
  const summary = next === null
    ? `Paying ${places}.`
    : `Paying ${places}. A further place opens at ${next} ticket${next === 1n ? "" : "s"}.`;

  const rows = sched.thresholds.map((threshold, i) => ({
    place: i + 1,
    opensAt: threshold,
    open: sold >= threshold && i < placesNow,
    reachable: cap === 0n || threshold <= cap,
    share: sched.weights[i],
  }));
  return { placesNow, nextThreshold: next, summary, rows };
}

// What the visitor asked for, and whether the round can serve it.
//
// Kept pure and separate from the DOM because the WORDING matters here: a
// round with every ticket sold said "only 0 tickets remain in this round",
// which is arithmetic rather than English, and it is the sentence a visitor
// sees at the exact moment the round is most interesting.
//
// `value` is the raw input string. Returns `tickets: null` when the request
// cannot be served, with `note` saying why.
function describeTicketRequest({ value, ticketsSold, cap }) {
  const sold = BigInt(ticketsSold);
  const full = cap !== 0n && sold >= cap;
  if (full) {
    return {
      tickets: null, full: true,
      note: `This round is full — all ${cap} tickets are sold.`,
    };
  }

  let tickets;
  try {
    tickets = BigInt(String(value ?? "").trim() || "0");
  } catch {
    return { tickets: null, full: false, note: "Enter a whole number of tickets." };
  }
  if (tickets <= 0n) {
    return { tickets: null, full: false, note: "Enter at least one ticket." };
  }
  if (cap !== 0n && sold + tickets > cap) {
    const left = cap - sold;
    return {
      tickets: null, full: false,
      note: `Only ${left} ticket${left === 1n ? "" : "s"} remain${left === 1n ? "s" : ""} in this round.`,
    };
  }
  return { tickets, full: false, note: "" };
}

const api = { describeQuote, describePayout, formatCkb, describeTicketRequest };
if (typeof module !== "undefined" && module.exports) module.exports = api;
if (typeof window !== "undefined") window.DaowowEntryView = api;
})();
