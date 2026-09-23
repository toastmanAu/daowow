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

const api = { describeQuote, describePayout, formatCkb };
if (typeof module !== "undefined" && module.exports) module.exports = api;
if (typeof window !== "undefined") window.DaowowEntryView = api;
})();
