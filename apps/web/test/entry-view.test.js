"use strict";
// The entry view's job is to make the offer intelligible before anything is
// signed. Its rendering is kept pure so the WORDING and the FIGURES can be
// tested, rather than only that a page loaded.
const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const { describeQuote, describePayout, formatCkb } = require("../dapp/entry-view.js");
const { decodeSchedule } = require("../chain/schedule.js");
const { quoteEntry } = require("../chain/quote.js");

const V = JSON.parse(fs.readFileSync(path.join(
  __dirname, "..", "..", "..", "tests", "vectors", "daowow_core_vectors.json"), "utf8"));
const unhex = (s) => Uint8Array.from(s.match(/../g).map((b) => parseInt(b, 16)));
const CKB = 100000000n;
const schedule = decodeSchedule(unhex(V.prize_schedule_v2.hex));
const config = { ticketPrice: 10000n * CKB, maximumTickets: 10n, minimumTickets: 5n };
const joyid = { args: "0x" + "ab".repeat(22) };

test("amounts render with thousands separators and no false precision", () => {
  assert.strictEqual(formatCkb(102457n * CKB), "102,457");
  assert.strictEqual(formatCkb(222n * CKB), "222");
  // A fractional amount must not be rounded away: a quote that understates
  // what is charged is worse than an ugly one.
  assert.strictEqual(formatCkb(100000001n), "1.00000001");
});

test("the quote names every component, not just the total", () => {
  const q = quoteEntry({ config, schedule, lockScript: joyid, tickets: 10n, feeShannons: 0n });
  const rows = describeQuote(q);
  const labels = rows.map((r) => r.label.toLowerCase()).join(" | ");
  assert.match(labels, /principal/);
  assert.match(labels, /claim/);
  assert.match(labels, /entry cell/);
  assert.match(labels, /total/);
  const total = rows.find((r) => /total/i.test(r.label));
  assert.strictEqual(total.value, "102,457 CKB");
});

test("the quote says the overhead is returned, not spent", () => {
  // The single most misleading reading is that the 2,220 CKB is a fee.
  const q = quoteEntry({ config, schedule, lockScript: joyid, tickets: 10n, feeShannons: 0n });
  const rows = describeQuote(q);
  const claim = rows.find((r) => /claim/i.test(r.label));
  assert.match(claim.note, /return|recover|back/i,
    "the claim capacity is locked, not spent, and must say so");
  const entry = rows.find((r) => /entry cell/i.test(r.label));
  assert.match(entry.note, /return|recover|back/i);
});

test("the payout table shows what the round pays now and what opens next", () => {
  const p = describePayout(schedule, 6n, config.maximumTickets);
  assert.strictEqual(p.placesNow, 1);
  assert.strictEqual(p.nextThreshold, 8n);
  assert.match(p.summary, /1 place/i);
  assert.match(p.summary, /8/, "the next threshold must be stated, not implied");
});

test("the payout table says so when nothing further can open", () => {
  const p = describePayout(schedule, 100n, 0n);
  assert.strictEqual(p.placesNow, 5);
  assert.strictEqual(p.nextThreshold, null);
  assert.doesNotMatch(p.summary, /opens at/i);
});

test("the payout table is capped by the round's own maximum", () => {
  // With a cap of 10 the third place can never open, and implying otherwise
  // would misrepresent the offer.
  const p = describePayout(schedule, 8n, 10n);
  assert.strictEqual(p.placesNow, 2);
  assert.strictEqual(p.nextThreshold, null,
    "a threshold beyond the round's cap is unreachable and must not be advertised");
});
