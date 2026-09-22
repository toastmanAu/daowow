"use strict";
// Wrapped in an IIFE: loaded as a classic script these files share one
// global scope, so top-level declarations would collide between modules.
(function () {
// The committed prize schedule, and how many places a round currently pays.
//
// Mirrors crates/daowow-core/src/schedule.rs. Payout depth is a function of
// the FIELD, not of the pool: the draw is derived from the seal, the entropy
// record and the ticket count alone, before any batch's yield is known, so a
// pool-dependent rule would let two batches disagree about who won.
//
// v1 is exactly v2 with thresholds [1, 2, ..., n], since place i paying at
// tickets >= i+1 is precisely min(tickets, n). Both paths are pinned to Rust
// oracles in ../test/quote.test.js.

const MAX_SCHEDULE_PRIZES = 32;

function decodeSchedule(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.length < 5) {
    throw new Error("a schedule is at least 5 bytes");
  }
  const version = bytes[0];
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const count = view.getUint32(1, true);
  // Bound the untrusted count before any allocation or arithmetic.
  if (count === 0 || count > MAX_SCHEDULE_PRIZES) {
    throw new Error("schedule prize count out of range");
  }
  const weights = [];
  const thresholds = [];
  if (version === 1) {
    if (bytes.length !== 5 + count * 8) {
      throw new Error("v1 schedule length does not match its count");
    }
    for (let i = 0; i < count; i++) {
      weights.push(view.getBigUint64(5 + i * 8, true));
      thresholds.push(BigInt(i + 1));
    }
  } else if (version === 2) {
    if (bytes.length !== 5 + count * 16) {
      throw new Error("v2 schedule length does not match its count");
    }
    for (let i = 0; i < count; i++) {
      weights.push(view.getBigUint64(5 + i * 16, true));
      thresholds.push(view.getBigUint64(5 + i * 16 + 8, true));
    }
  } else {
    throw new Error(`unsupported schedule version ${version}`);
  }
  if (weights.some((w) => w === 0n)) throw new Error("a weight cannot be zero");
  return Object.freeze({ version, weights, thresholds });
}

// The places open at this ticket count. Thresholds are non-decreasing, so the
// open places are a prefix — and the count is capped at the tickets sold,
// because a place cannot be paid to a position that does not exist.
function placesFor(schedule, tickets) {
  const t = BigInt(tickets);
  if (t === 0n) return 0;
  let open = 0;
  for (const threshold of schedule.thresholds) {
    if (threshold > t) break;
    open += 1;
  }
  return Number(BigInt(open) < t ? BigInt(open) : t);
}

// The next threshold a round has not yet reached, or null when every place is
// already open. This is what makes buying one more ticket intelligible.
function nextThreshold(schedule, tickets) {
  const t = BigInt(tickets);
  for (const threshold of schedule.thresholds) {
    if (threshold > t) return threshold;
  }
  return null;
}

const api = { decodeSchedule, placesFor, nextThreshold, MAX_SCHEDULE_PRIZES };
if (typeof module !== "undefined" && module.exports) module.exports = api;
if (typeof window !== "undefined") window.DaowowSchedule = api;
})();
