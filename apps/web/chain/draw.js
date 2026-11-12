"use strict";
// Wrapped in an IIFE: loaded as a classic script these files share one
// global scope, so top-level declarations would collide between modules.
(function () {
// The draw — who won — derived from an authenticated entropy record.
//
// A CLIENT capability, not a transaction. Nothing writes a winner list to a
// cell: ComputedDraw (computed_draw.rs:44) derives the winning positions from
// the sealed ledgers and four block hashes, and every script that needs to
// know re-derives them the same way. This port is how the dApp says who won,
// pinned to that function through the computed_draw vectors.
//
// THE SEED IS THE AUTHENTICATED ONE:
//   H("DAOWOW_AUTHENTICATED_DRAW_V1" || config commitment || record bytes)
// core.js also exports an older drawSeed over "DAOWOW_DRAW_SEED_V1" from the
// superseded participant-reveal design. It is still used by its own vector
// tests and must not be used here: it would produce a confident, well-formed,
// wrong list of winners.

const core = () => typeof require === "function" ? require("../core.js") : window.DaowowCore;
const scheduleLib = () =>
  typeof require === "function" ? require("./schedule.js") : window.DaowowSchedule;
const sealCodec = () =>
  typeof require === "function" ? require("./seal-codec.js") : window.DaowowSealCodec;

// computed_draw.rs:28. A schedule whose cheapest zero-free pool exceeds this is
// treated as a failed round rather than an error.
const MAX_POOL_BAR = 1000000n;

const hexRaw = (b) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
const unhex = (s) => {
  const body = s.startsWith("0x") ? s.slice(2) : s;
  return Uint8Array.from(body.match(/../g) ?? [], (b) => parseInt(b, 16));
};

// The schedule's committed bytes, rebuilt from its decoded form by its own
// version byte. The decoded schedule came from canonical bytes, so this
// reproduces them exactly — which is what makes the commitment check below
// meaningful rather than circular.
function encodeSchedule(schedule) {
  const n = schedule.weights.length;
  const stride = schedule.version === 1 ? 8 : 16;
  const out = new Uint8Array(5 + n * stride);
  const view = new DataView(out.buffer);
  out[0] = schedule.version;
  view.setUint32(1, n, true);
  schedule.weights.forEach((w, i) => {
    view.setBigUint64(5 + i * stride, BigInt(w), true);
    if (stride === 16) view.setBigUint64(5 + i * 16 + 8, BigInt(schedule.thresholds[i]), true);
  });
  return out;
}

function scheduleCommitment(schedule) {
  return hexRaw(core().H("DAOWOW_PRIZE_SCHEDULE_V1", encodeSchedule(schedule)));
}

/** ceil(sum of the open weights / the smallest open weight) — schedule.rs:188. */
function minViablePool(schedule, tickets) {
  const open = scheduleLib().placesFor(schedule, BigInt(tickets));
  const weights = schedule.weights.slice(0, open).map(BigInt);
  if (weights.length === 0) throw new Error("no place is open at this ticket count");
  const sum = weights.reduce((a, b) => a + b, 0n);
  const min = weights.reduce((a, b) => (b < a ? b : a));
  return (sum + min - 1n) / min;
}

/**
 * The draw. `record` is a decoded EntropyRecord; the caller must have read it
 * from the canonical shard-zero cell, exactly as the contract requires of
 * ComputedDraw's own callers.
 */
function computeDraw({ config, record, schedule }) {
  if (scheduleCommitment(schedule) !== config.prizeScheduleHash) {
    throw new Error(
      "this prize schedule is not the one the round's config commits to; " +
      "drawing under it would name the wrong winners",
    );
  }
  const ledgers = record.seal.ledgers;
  if (ledgers.length !== Number(config.entryShardCount)) {
    throw new Error(
      `the seal carries ${ledgers.length} ledger(s) for a round of ` +
      `${config.entryShardCount} shard(s)`,
    );
  }
  let total = 0n;
  ledgers.forEach((ledger, id) => {
    if (ledger.configCommitment !== config.commitment) {
      throw new Error(`the sealed ledger for shard ${id} is bound to a different round`);
    }
    if (!ledger.closed) throw new Error(`the sealed ledger for shard ${id} is not closed`);
    if (Number(ledger.frozen.shardId) !== id) {
      throw new Error(`sealed ledger ${id} names shard ${ledger.frozen.shardId}`);
    }
    // ACCEPTED tickets, not frozen ones: an unaggregated suffix takes no part.
    total += BigInt(ledger.acceptedTickets);
  });

  const seed = hexRaw(core().ckbHash256([
    new TextEncoder().encode("DAOWOW_AUTHENTICATED_DRAW_V1"),
    unhex(config.commitment),
    sealCodec().encodeEntropyRecord(record),
  ]));

  // An unviable round is a FAILED round, not an error: it returns principal and
  // yield and every claim retires as a non-winner (computed_draw.rs:79).
  const viable = total !== 0n
    && total >= BigInt(config.minimumTickets)
    && minViablePool(schedule, total) <= MAX_POOL_BAR;
  const places = viable ? scheduleLib().placesFor(schedule, total) : 0;
  const positions = viable
    ? core().drawPositions(unhex(seed), Number(total), places)
    : [];

  return Object.freeze({ seed, tickets: total, places, viable, positions });
}

/**
 * Words for a person. Gate 2's D7 constraints apply with more force here than
 * anywhere: this is where a reader decides whether to trust the draw. The seed
 * is four block hashes fixed before the draw — not a VRF, and not "provably"
 * anything — and a failed round must not read as a round nobody won.
 */
function describeDraw(draw) {
  const method =
    "The seed is a hash of the round's committed configuration and four block " +
    "hashes: the block that sealed the entries, and the blocks 64, 128 and 192 " +
    "after it. None of them existed when the entries were sealed, and the " +
    "derivation is public, so anyone can recompute this result.";
  if (!draw.viable) {
    // Two different situations, and the words must not conflate them. Found
    // on the first real failed draw, which printed "All 0 tickets are
    // returned at settlement" — wrong twice, since an empty round has nothing
    // to return and its entries go back through the REFUND path instead.
    if (draw.tickets === 0n) {
      return {
        summary:
          "No entries were accepted into this round, so nothing was drawn. " +
          "Entries the round did not accept are returned by refund.",
        method,
        winners: [],
      };
    }
    return {
      summary:
        `This round did not reach its minimum, so no prizes were drawn. Its ` +
        `${draw.tickets} tickets are returned at settlement.`,
      method,
      winners: [],
    };
  }
  return {
    summary: `${draw.tickets} tickets, ${draw.places} places paid.`,
    method,
    winners: draw.positions.map((p) => ({
      place: Number(p.prizeIndex) + 1,
      ticket: BigInt(p.position),
    })),
  };
}

const api = {
  computeDraw, describeDraw, minViablePool, scheduleCommitment, encodeSchedule, MAX_POOL_BAR,
};
if (typeof module !== "undefined" && module.exports) module.exports = api;
if (typeof window !== "undefined") window.DaowowDraw = api;
})();
