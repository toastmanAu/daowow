"use strict";
// Wrapped in an IIFE: loaded as a classic script these files share one
// global scope, so top-level declarations would collide between modules.
(function () {
// The draw, as a timeline to be shown.
//
// The winners are fixed by chain data before any of this runs. computeDraw
// produced them; this file only decides which balls are on screen and when
// each real result is revealed. It never chooses a winner and never reorders
// by anything but prize place.
//
// The animation's motion needs random-looking numbers. They come from a
// generator seeded with the draw's own seed, so a replay moves identically
// and nothing near a lottery result ever calls Math.random.

const entropy = () => typeof require === "function"
  ? require("../../chain/entropy-derive.js") : window.DaowowEntropyDerive;

const MAX_BALLS = 40;
const TUMBLE_MS = 3000;
const REVEAL_GAP_MS = 3500;
const SETTLE_MS = 2500;

/** xorshift128, seeded from the first 16 bytes of the draw seed. */
function seededRandom(seedHex) {
  const body = String(seedHex).replace(/^0x/, "").padEnd(32, "0");
  const s = [0, 1, 2, 3].map((i) => parseInt(body.substr(i * 8, 8), 16) >>> 0);
  // An all-zero state never moves.
  if ((s[0] | s[1] | s[2] | s[3]) === 0) s[0] = 0x9e3779b9;
  return function next() {
    let t = s[3];
    t ^= t << 11; t ^= t >>> 8;
    s[3] = s[2]; s[2] = s[1]; s[1] = s[0];
    t ^= s[0]; t ^= s[0] >>> 19;
    s[0] = t >>> 0;
    return s[0] / 4294967296;
  };
}

const ascending = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

function buildDrawScript({ draw, myPositions }) {
  const total = BigInt(draw.tickets);
  const inRound = (p) => p >= 0n && p < total;
  const mine = new Set(myPositions.map((p) => BigInt(p)).filter(inRound).map(String));
  const drawn = new Set(draw.positions.map((p) => String(BigInt(p.position))));

  // Every winner and every one of the viewer's tickets is always shown. At
  // 200 tickets the rest of the drum is a sample, lowest numbers first.
  const ids = new Set([...drawn, ...mine]);
  for (let p = 0n; p < total && ids.size < MAX_BALLS; p += 1n) ids.add(String(p));
  const balls = [...ids].map(BigInt).sort(ascending).map((id) => ({
    id,
    label: String(id + 1n), // tickets are numbered from 1 for people
    mine: mine.has(String(id)),
    drawn: drawn.has(String(id)),
  }));

  const reveals = draw.viable
    ? [...draw.positions]
      .sort((a, b) => Number(a.prizeIndex) - Number(b.prizeIndex))
      .map((p, i) => ({
        place: Number(p.prizeIndex) + 1,
        ticket: BigInt(p.position),
        label: String(BigInt(p.position) + 1n),
        mine: mine.has(String(BigInt(p.position))),
        atMs: TUMBLE_MS + i * REVEAL_GAP_MS,
      }))
    : [];
  const durationMs = reveals.length === 0 ? 0 : reveals[reveals.length - 1].atMs + SETTLE_MS;
  return { balls, reveals, durationMs, viable: Boolean(draw.viable), seed: draw.seed };
}

/**
 * Where a round's draw stands. "ready" needs both the last block AND a result
 * the app has in hand and has checked; the block alone is not enough.
 */
function drawPhase({ snapshot, tipHeight, hasDraw }) {
  const inclusion = snapshot.record
    ? snapshot.record.record.inclusionHeight
    : snapshot.seal ? snapshot.seal.inclusionHeight : null;
  if (inclusion === null) return { phase: "not-sealed", blocksLeft: 0n, lastHeight: null };
  const lastHeight = entropy().lastEntropyHeight(inclusion);
  const left = lastHeight - BigInt(tipHeight);
  const blocksLeft = left > 0n ? left : 0n;
  if (blocksLeft === 0n && hasDraw) return { phase: "ready", blocksLeft, lastHeight };
  return { phase: "countdown", blocksLeft, lastHeight };
}

/**
 * Should the draw screen keep asking the network? Only while a sealed round
 * is counting down to a result. A result that failed its check will fail it
 * again in fifteen seconds, and an unsealed round is covered by the page's
 * ordinary once-a-minute read.
 */
function needsPolling({ snapshot, draw, drawError }) {
  return Boolean(snapshot.seal) && !snapshot.record && !draw && !drawError;
}

/**
 * Has the result changed since it was first shown? A block the result
 * depended on can be replaced; if that happens after winners were on screen,
 * the screen must say so rather than quietly show different winners.
 */
function resultChanged(firstSeed, draw) {
  if (firstSeed === null || firstSeed === undefined) return false;
  return !draw || draw.seed !== firstSeed;
}

const api = {
  MAX_BALLS, TUMBLE_MS, REVEAL_GAP_MS, seededRandom, buildDrawScript, drawPhase,
  needsPolling, resultChanged,
};
if (typeof module !== "undefined" && module.exports) module.exports = api;
if (typeof window !== "undefined") window.DaowowDrawScript = api;
})();
