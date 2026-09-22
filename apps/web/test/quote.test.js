"use strict";
// The quote is what a visitor agrees to before signing, so every figure is
// pinned to a Rust oracle rather than to arithmetic written twice.
const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const { decodeSchedule, placesFor } = require("../chain/schedule.js");
const { claimCellCapacity, entryCellCapacity, quoteEntry } = require("../chain/quote.js");

const V = JSON.parse(fs.readFileSync(path.join(
  __dirname, "..", "..", "..", "tests", "vectors", "daowow_core_vectors.json"), "utf8"));
const unhex = (s) => Uint8Array.from(s.match(/../g).map((b) => parseInt(b, 16)));
const CKB = 100000000n;

test("a v1 schedule decodes with the default thresholds", () => {
  const s = decodeSchedule(unhex(V.prize_schedule_v1.hex));
  assert.strictEqual(s.version, 1);
  assert.deepStrictEqual(s.thresholds.map(Number), V.prize_schedule_v1.thresholds);
});

test("a v2 schedule decodes its committed thresholds", () => {
  const s = decodeSchedule(unhex(V.prize_schedule_v2.hex));
  assert.strictEqual(s.version, 2);
  assert.deepStrictEqual(s.thresholds.map(Number), V.prize_schedule_v2.thresholds);
  assert.deepStrictEqual(s.weights.map(Number), V.prize_schedule_v2.weights);
});

test("placesFor matches the Rust at both sides of every threshold", () => {
  for (const [name, key] of [["v1", "prize_schedule_v1"], ["v2", "prize_schedule_v2"]]) {
    const s = decodeSchedule(unhex(V[key].hex));
    for (const [tickets, places] of Object.entries(V[key].places_at)) {
      assert.strictEqual(
        placesFor(s, BigInt(tickets)), places,
        `${name}: ${tickets} tickets should pay ${places}`);
    }
  }
});

test("a malformed schedule is refused, never best-effort decoded", () => {
  const good = unhex(V.prize_schedule_v2.hex);
  assert.throws(() => decodeSchedule(good.slice(0, good.length - 1)), /length|bytes/i);
  const badVersion = Uint8Array.from(good);
  badVersion[0] = 3;
  assert.throws(() => decodeSchedule(badVersion), /version/i);
});

test("claim capacity comes from the connected lock, not a constant", () => {
  const joyid = { args: "0x" + "ab".repeat(22) };   // 22-byte args -> 55-byte script
  const secp = { args: "0x" + "cd".repeat(20) };    // 20-byte args -> 53-byte script
  assert.strictEqual(
    claimCellCapacity(joyid) / CKB,
    BigInt(V.capacity.claim_occupied_ckb.joyid_lock_55));
  assert.strictEqual(
    claimCellCapacity(secp) / CKB,
    BigInt(V.capacity.claim_occupied_ckb.secp_lock_53));
  assert.notStrictEqual(claimCellCapacity(joyid), claimCellCapacity(secp),
    "a constant here would hide the difference");
});

test("entry cell capacity is principal plus the fixed overhead", () => {
  const principal = 10000n * CKB;
  assert.strictEqual(
    entryCellCapacity(principal),
    principal + BigInt(V.capacity.entry_cell_overhead_ckb) * CKB);
});

test("the quote totals the demo entry exactly", () => {
  // 10 tickets at 10,000 CKB under a JoyID lock:
  //   principal 100,000 + claims 10 x 222 = 2,220 + entry overhead 237
  const config = { ticketPrice: 10000n * CKB, maximumTickets: 10n, minimumTickets: 5n };
  const schedule = decodeSchedule(unhex(V.prize_schedule_v2.hex));
  const q = quoteEntry({
    config, schedule, lockScript: { args: "0x" + "ab".repeat(22) },
    tickets: 10n, feeShannons: 0n,
  });
  assert.strictEqual(q.principal / CKB, 100000n);
  assert.strictEqual(q.claimCapacity / CKB, 2220n);
  assert.strictEqual(q.entryCellOverhead / CKB, 237n);
  assert.strictEqual(q.total / CKB, 102457n);
  // The payout table the visitor is deciding against.
  assert.strictEqual(q.placesNow, 2, "ten tickets pays two places");
  assert.strictEqual(q.nextThreshold, 20n, "the third place opens at twenty");
});

test("the quote reports when no further place can open", () => {
  const config = { ticketPrice: 10000n * CKB, maximumTickets: 0n, minimumTickets: 1n };
  const schedule = decodeSchedule(unhex(V.prize_schedule_v2.hex));
  const q = quoteEntry({
    config, schedule, lockScript: { args: "0x" + "ab".repeat(20) },
    tickets: 100n, feeShannons: 0n,
  });
  assert.strictEqual(q.placesNow, 5);
  assert.strictEqual(q.nextThreshold, null, "every place is already open");
});

test("selection never exceeds the ticket count", () => {
  // Thresholds [1,1,1] open three places immediately, but a two-ticket round
  // has only two positions to draw. The Rust caps at the ticket count
  // (schedule.rs::selection_never_exceeds_the_ticket_count) and the client
  // must agree, or it would show a payout table the chain will not honour.
  const wire = new Uint8Array(5 + 3 * 16);
  wire[0] = 2;
  new DataView(wire.buffer).setUint32(1, 3, true);
  const view = new DataView(wire.buffer);
  [[40n, 1n], [25n, 1n], [20n, 1n]].forEach(([w, t], i) => {
    view.setBigUint64(5 + i * 16, w, true);
    view.setBigUint64(5 + i * 16 + 8, t, true);
  });
  const s = decodeSchedule(wire);
  assert.deepStrictEqual(s.thresholds.map(Number), [1, 1, 1]);
  assert.strictEqual(placesFor(s, 1n), 1, "one ticket, one place");
  assert.strictEqual(placesFor(s, 2n), 2, "two tickets cannot pay three places");
  assert.strictEqual(placesFor(s, 3n), 3);
  assert.strictEqual(placesFor(s, 9n), 3, "and never more places than the schedule has");
});
