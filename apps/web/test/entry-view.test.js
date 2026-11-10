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

test("the summary names every part, in plain words, and the total", () => {
  const q = quoteEntry({ config, schedule, lockScript: joyid, tickets: 10n, feeShannons: 0n });
  const rows = describeQuote(q, { term: "about 30 days" });
  assert.deepStrictEqual(rows.map((r) => r.label), [
    "Your tickets (10)", "Ticket deposit (10)", "Storage deposit", "Network fee",
    "Total leaving your wallet now",
  ]);
  const total = rows.find((r) => /total/i.test(r.label));
  assert.strictEqual(total.value, "102,457 CKB");
  assert.match(total.note, /about 30 days/);
});

test("the summary says each deposit is returned, and the fee is not", () => {
  // The single most misleading reading is that the 2,220 CKB is a fee.
  const q = quoteEntry({ config, schedule, lockScript: joyid, tickets: 10n, feeShannons: 0n });
  const rows = describeQuote(q, { term: "about 30 days" });
  for (const label of ["Your tickets (10)", "Ticket deposit (10)", "Storage deposit"]) {
    assert.match(rows.find((r) => r.label === label).note, /returned/i, label);
  }
  const fee = rows.find((r) => r.label === "Network fee");
  assert.strictEqual(fee.value, "under 0.01 CKB");
  assert.match(fee.note, /not returned/i);
});

test("the total row is the sum of the deposits above it", () => {
  const q = quoteEntry({ config, schedule, lockScript: joyid, tickets: 3n, feeShannons: 0n });
  const rows = describeQuote(q, { term: "about 30 days" });
  const amount = (label) => BigInt(rows.find((r) => r.label === label).value.replace(/[^0-9]/g, ""));
  assert.strictEqual(
    amount("Your tickets (3)") + amount("Ticket deposit (3)") + amount("Storage deposit"),
    amount("Total leaving your wallet now"));
});

test("a known fee is shown exactly", () => {
  const q = quoteEntry({ config, schedule, lockScript: joyid, tickets: 1n, feeShannons: 100000n });
  const fee = describeQuote(q, { term: "about 30 days" }).find((r) => r.label === "Network fee");
  assert.strictEqual(fee.value, "0.00100000 CKB");
});

test("no summary row uses a banned word", () => {
  const banned = /\b(epochs?|shards?|cells?|ledgers?|freez\w*|frozen|genesis|aggregat\w*|commitments?|out ?points?|lock hash\w*|witness\w*|NFTs?|principal)\b/i;
  const q = quoteEntry({ config, schedule, lockScript: joyid, tickets: 2n, feeShannons: 0n });
  for (const r of describeQuote(q, { term: "about 30 days" })) {
    assert.doesNotMatch(`${r.label} ${r.note}`, banned);
  }
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

// --- what the visitor asked for -------------------------------------------
// The full-round case was found on a live round the moment its last ticket
// sold: the page said "only 0 tickets remain in this round", which is
// arithmetic rather than English, and it is the sentence shown at exactly the
// point the round is most interesting.
const { describeTicketRequest } = require("../dapp/entry-view.js");

test("a servable request comes back with its ticket count and no complaint", () => {
  const r = describeTicketRequest({ value: "3", ticketsSold: 5n, cap: 10n });
  assert.strictEqual(r.tickets, 3n);
  assert.strictEqual(r.note, "");
  assert.strictEqual(r.full, false);
});

test("a full round says so in words, not as zero remaining", () => {
  const r = describeTicketRequest({ value: "1", ticketsSold: 10n, cap: 10n });
  assert.strictEqual(r.tickets, null);
  assert.strictEqual(r.full, true);
  assert.match(r.note, /full/);
  assert.doesNotMatch(r.note, /\b0 tickets\b/, "never phrase a full round as zero remaining");
});

test("asking for more than remains names how many there are", () => {
  assert.match(
    describeTicketRequest({ value: "5", ticketsSold: 8n, cap: 10n }).note,
    /Only 2 tickets remain/);
});

test("the last single ticket is singular", () => {
  // "Only 1 tickets remain" is the kind of thing that makes a money page look
  // unattended.
  assert.match(
    describeTicketRequest({ value: "2", ticketsSold: 9n, cap: 10n }).note,
    /Only 1 ticket remains/);
});

test("zero, blank and nonsense are each refused with a usable sentence", () => {
  for (const value of ["0", "", "   ", "abc", "1.5", "-2"]) {
    const r = describeTicketRequest({ value, ticketsSold: 0n, cap: 10n });
    assert.strictEqual(r.tickets, null, `${JSON.stringify(value)} must not parse`);
    assert.ok(r.note.length > 0 && /[.!]$/.test(r.note),
      `${JSON.stringify(value)} needs a sentence, got ${JSON.stringify(r.note)}`);
  }
});

test("an uncapped round never reports itself full", () => {
  const r = describeTicketRequest({ value: "1000", ticketsSold: 99999n, cap: 0n });
  assert.strictEqual(r.tickets, 1000n);
  assert.strictEqual(r.full, false);
});
