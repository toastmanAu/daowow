"use strict";
// Wrapped in an IIFE: loaded as a classic script these files share one
// global scope, so top-level declarations would collide between modules.
(function () {
// Chain time, said the way a person says it.
//
// The chain counts in epochs and blocks; a player counts in hours and days.
// An epoch TARGETS four hours and a block averages about ten seconds, so
// every figure here is an estimate and every sentence says "about".

const EPOCH_MS = 14400000n;
const MINUTE = 60000n;
const HOUR = 3600000n;
const DAY = 86400000n;

/** RFC 0017: low 24 bits the epoch number, then 16 of index, then 16 of length. */
function parseEpoch(hexField) {
  const v = BigInt(hexField);
  return {
    number: v & 0xffffffn,
    index: (v >> 24n) & 0xffffn,
    length: (v >> 40n) & 0xffffn,
  };
}

/** Milliseconds until the START of `targetEpoch`. Never negative. */
function msUntilEpoch(targetEpoch, tipEpoch) {
  const whole = (BigInt(targetEpoch) - tipEpoch.number) * EPOCH_MS;
  const spent = tipEpoch.length === 0n ? 0n : (tipEpoch.index * EPOCH_MS) / tipEpoch.length;
  const left = whole - spent;
  return left > 0n ? left : 0n;
}

function msUntilBlock(targetHeight, tipHeight, msPerBlock = 10000n) {
  const left = (BigInt(targetHeight) - BigInt(tipHeight)) * BigInt(msPerBlock);
  return left > 0n ? left : 0n;
}

const nearest = (ms, unit) => (ms + unit / 2n) / unit;

function describeDuration(ms) {
  const v = BigInt(ms);
  if (v < MINUTE) return "about a minute";
  if (v < 90n * MINUTE) return `about ${nearest(v, MINUTE)} min`;
  if (v < 48n * HOUR) return `about ${nearest(v, HOUR)} h`;
  return `about ${nearest(v, DAY)} days`;
}

function describeDate(ms, nowMs, locale = "en-AU", timeZone = undefined) {
  const when = new Date(Number(nowMs) + Number(BigInt(ms)));
  const text = new Intl.DateTimeFormat(locale, { day: "numeric", month: "short", timeZone })
    .format(when);
  return `around ${text}`;
}

/** A day and a time of day, in the reader's own locale and zone by default. */
function formatMoment(ms, locale = undefined, timeZone = undefined) {
  const when = new Date(Number(BigInt(ms)));
  // Not every number is a date, and formatting one that is not throws.
  if (Number.isNaN(when.getTime())) return "";
  return new Intl.DateTimeFormat(locale, {
    day: "numeric", month: "short", hour: "numeric", minute: "2-digit", timeZone,
  }).format(when);
}

const api = {
  EPOCH_MS, parseEpoch, msUntilEpoch, msUntilBlock, describeDuration, describeDate, formatMoment,
};
if (typeof module !== "undefined" && module.exports) module.exports = api;
if (typeof window !== "undefined") window.DaowowTime = api;
})();
