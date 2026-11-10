"use strict";
// Wrapped in an IIFE: loaded as a classic script these files share one
// global scope, so top-level declarations would collide between modules.
(function () {
// Prize figures before payout.
//
// The exact prize is only known when the deposit is withdrawn. Until then a
// winner is shown their place, their share, and what that share is worth of
// the interest earned SO FAR. This is an estimate that is still growing and
// is always labelled as one; it is never a projection of the final figure.

const scheduleLib = () =>
  typeof require === "function" ? require("../../chain/schedule.js") : window.DaowowSchedule;

/**
 * Port of allocate_prizes_complete (crates/daowow-core/src/accounting.rs):
 * each place gets floor(pool * w / W) and every rounding shannon goes to
 * first place, so nothing is left unowned.
 */
function allocatePrizes(weights, pool) {
  if (weights.length === 0 || weights.some((w) => BigInt(w) === 0n)) {
    throw new Error("prize weights must be present and positive");
  }
  const total = weights.reduce((a, b) => a + BigInt(b), 0n);
  const amounts = weights.map((w) => (BigInt(pool) * BigInt(w)) / total);
  const dust = BigInt(pool) - amounts.reduce((a, b) => a + b, 0n);
  amounts[0] += dust;
  return amounts;
}

const openWeights = (schedule, tickets) =>
  schedule.weights.slice(0, scheduleLib().placesFor(schedule, BigInt(tickets))).map(BigInt);

/** `poolSoFar` null means no deposit exists yet, so there is no figure to show. */
function estimatePrizes({ schedule, tickets, poolSoFar }) {
  if (poolSoFar === null || poolSoFar === undefined) return null;
  const weights = openWeights(schedule, tickets);
  if (weights.length === 0) return null;
  return { pool: BigInt(poolSoFar), prizes: allocatePrizes(weights, poolSoFar) };
}

/** A place's weight over the weights of the open places, or null if not open. */
function shareOf(schedule, tickets, place) {
  const weights = openWeights(schedule, tickets);
  if (place < 1 || place > weights.length) return null;
  return { weight: weights[place - 1], total: weights.reduce((a, b) => a + b, 0n) };
}

const api = { allocatePrizes, estimatePrizes, shareOf };
if (typeof module !== "undefined" && module.exports) module.exports = api;
if (typeof window !== "undefined") window.DaowowPrizeEstimate = api;
})();
