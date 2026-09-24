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

// Every component named, with what happens to it afterwards. The most
// misleading reading of this quote is that the claim capacity is a fee; it is
// not, it is returned when the claim retires.
function describeQuote(quote) {
  const rows = [
    {
      label: "Ticket principal",
      value: `${formatCkb(quote.principal)} CKB`,
      note: "Returned to you at settlement, win or lose.",
    },
    {
      label: `Claim NFTs (${quote.tickets})`,
      value: `${formatCkb(quote.claimCapacity)} CKB`,
      note: "One per ticket. Locked, not spent — returned when the claim retires.",
    },
    {
      label: "Entry cell",
      value: `${formatCkb(quote.entryCellOverhead)} CKB`,
      note: "Storage for your entry. Returned at settlement.",
    },
  ];
  if (quote.fee > 0n) {
    rows.push({
      label: "Network fee",
      value: `${formatCkb(quote.fee)} CKB`,
      note: "Paid to miners. Not returned.",
    });
  }
  rows.push({
    label: "Total committed",
    value: `${formatCkb(quote.total)} CKB`,
    note: "Held for the round's duration, about one to two months.",
  });
  return rows;
}

// What the round pays now, and what buying more would open. A threshold the
// round's own cap puts out of reach is NOT advertised — implying a prize that
// cannot exist would misrepresent the offer.
function describePayout(sched, ticketsSold, maximumTickets) {
  const sold = BigInt(ticketsSold);
  const cap = BigInt(maximumTickets ?? 0n);
  const placesNow = schedule.placesFor(sched, sold === 0n ? 1n : sold);
  let next = schedule.nextThreshold(sched, sold);
  if (next !== null && cap !== 0n && next > cap) next = null;

  const places = `${placesNow} place${placesNow === 1 ? "" : "s"}`;
  const summary = next === null
    ? `Paying ${places}.`
    : `Paying ${places}. A further place opens at ${next} tickets.`;

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
