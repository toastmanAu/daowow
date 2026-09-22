"use strict";
// Wrapped in an IIFE: loaded as a classic script these files share one
// global scope, so top-level declarations would collide between modules.
(function () {
// What entering actually costs, stated in full.
//
// Entering commits more than principal, and the difference is large enough
// that hiding it would misrepresent the offer. A claim NFT is minted per
// TICKET, so its capacity scales with the number of tickets bought, and it is
// locked for the round's duration rather than spent — it returns when the
// claim retires.
//
// Nothing here is a constant: the price comes from the round config and the
// claim capacity from the CONNECTED wallet's own lock, because a JoyID lock
// (22-byte args) gives 222 CKB and a secp lock (20-byte args) gives 220.

const schedule =
  typeof require === "function" ? require("./schedule.js") : window.DaowowSchedule;

const SHANNONS_PER_CKB = 100000000n;
// Sizes from daowow-core: a claim's args and data, and an entry's data.
const CLAIM_ARGS_SIZE = 45n;
const CLAIM_DATA_SIZE = 81n;
const ENTRY_DATA_SIZE = 132n;
// entry-lock args are the participant lock hash plus the config commitment.
const ENTRY_LOCK_ARGS_SIZE = 64n;

const argsLength = (lockScript) => {
  const args = lockScript && lockScript.args;
  if (typeof args !== "string" || !args.startsWith("0x")) {
    throw new Error("lock script args must be 0x-prefixed hex");
  }
  return BigInt((args.length - 2) / 2);
};

// CKB counts a script as code_hash + hash_type + args, never its molecule
// serialization — the serialization adds a header that is not occupied
// capacity.
const lockScriptSize = (lockScript) => 32n + 1n + argsLength(lockScript);

function claimCellCapacity(lockScript) {
  const size =
    8n + lockScriptSize(lockScript) + (32n + 1n + CLAIM_ARGS_SIZE) + CLAIM_DATA_SIZE;
  return size * SHANNONS_PER_CKB;
}

function entryCellCapacity(principal) {
  const overhead = 8n + ENTRY_DATA_SIZE + 33n + ENTRY_LOCK_ARGS_SIZE;
  return BigInt(principal) + overhead * SHANNONS_PER_CKB;
}

function quoteEntry({ config, schedule: sched, lockScript, tickets, feeShannons = 0n }) {
  const n = BigInt(tickets);
  if (n <= 0n) throw new Error("an entry needs at least one ticket");
  if (config.maximumTickets !== 0n && n > config.maximumTickets) {
    throw new Error("more tickets than the round's cap");
  }
  const principal = n * BigInt(config.ticketPrice);
  const claimCapacity = n * claimCellCapacity(lockScript);
  const entryCellOverhead = entryCellCapacity(0n);
  const fee = BigInt(feeShannons);
  return Object.freeze({
    tickets: n,
    principal,
    claimCapacity,
    entryCellOverhead,
    fee,
    total: principal + claimCapacity + entryCellOverhead + fee,
    // What the visitor is deciding against: the places this round pays now,
    // and the next threshold that would open another.
    placesNow: schedule.placesFor(sched, n),
    nextThreshold: schedule.nextThreshold(sched, n),
  });
}

const api = { quoteEntry, claimCellCapacity, entryCellCapacity, SHANNONS_PER_CKB };
if (typeof module !== "undefined" && module.exports) module.exports = api;
if (typeof window !== "undefined") window.DaowowQuote = api;
})();
