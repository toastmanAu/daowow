"use strict";
// Wrapped in an IIFE: loaded as a classic script these files share one
// global scope, so top-level declarations would collide between modules.
(function () {
// A pretend draw, for showing the machine from Home when no round has a
// result to watch.
//
// Nothing here touches a round, a wallet or the network. The winners are
// picked by the same function a real draw uses (core.js drawPositions), so the
// demo shows the real selection, but the seed is made under its own tag. A
// real draw's seed is H("DAOWOW_AUTHENTICATED_DRAW_V1" ...) over chain data;
// this one can never equal it, and the result carries `demo: true`.
//
// Each run is a counter, not a random number: run 1 always shows the same
// winners, "draw again" shows run 2, and nothing calls Math.random.

const core = () => typeof require === "function" ? require("../../core.js") : window.DaowowCore;

const DEMO_TAG = "DAOWOW_DEMO_DRAW_V1";
const DEMO_TICKETS = 24;
const DEMO_PLACES = 3;
const MAX_RUN = 0xffffffff;

const hexRaw = (b) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");

function u32le(v) {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, v, true);
  return b;
}

/**
 * @param {number} run which demo to show, a whole number from 1 to MAX_RUN
 * @returns {{seed: string, tickets: bigint, places: number, viable: true,
 *   positions: {prizeIndex: number, position: number}[], demo: true}}
 */
function buildDemoDraw(run) {
  if (!Number.isInteger(run) || run < 1 || run > MAX_RUN) {
    throw new Error("a demo run must be a whole number from 1 to 4294967295");
  }
  const seed = core().H(DEMO_TAG, u32le(run));
  return Object.freeze({
    seed: hexRaw(seed),
    tickets: BigInt(DEMO_TICKETS),
    places: DEMO_PLACES,
    viable: true,
    positions: core().drawPositions(seed, DEMO_TICKETS, DEMO_PLACES),
    demo: true,
  });
}

/** The run "draw again" shows next. Wraps rather than ever being refused. */
function nextRun(run) {
  return run >= MAX_RUN ? 1 : run + 1;
}

const api = { DEMO_TAG, DEMO_TICKETS, DEMO_PLACES, MAX_RUN, buildDemoDraw, nextRun };
if (typeof module !== "undefined" && module.exports) module.exports = api;
if (typeof window !== "undefined") window.DaowowDemoDraw = api;
})();
