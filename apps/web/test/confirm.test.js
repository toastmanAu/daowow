"use strict";
// Time is injected so these run instantly and deterministically. A test that
// actually sleeps is a test nobody runs.
const { test } = require("node:test");
const assert = require("node:assert");
const { awaitCommitted, awaitIndexer } = require("../chain/confirm.js");

// A clock the test drives, so a timeout is reached by the code asking for it
// rather than by the suite waiting.
function fakeClock() {
  let t = 0;
  return { now: () => t, sleep: async (ms) => { t += ms; } };
}

const rpcReturning = (statuses, header = { number: "0x64" }) => {
  let i = 0;
  return { call: async (method) => {
    if (method === "get_header") return header;
    const status = statuses[Math.min(i++, statuses.length - 1)];
    return { tx_status: typeof status === "string"
      ? { status, block_hash: "0x" + "aa".repeat(32) }
      : status };
  } };
};

test("a transaction that commits immediately reports its block", async () => {
  const r = await awaitCommitted(rpcReturning(["committed"]), "0xab", fakeClock());
  assert.strictEqual(r.status, "committed");
  assert.strictEqual(r.blockNumber, 100n);
});

test("pending and proposed are waited through, not treated as failures", async () => {
  const seen = [];
  const clock = fakeClock();
  const r = await awaitCommitted(
    rpcReturning(["pending", "pending", "proposed", "committed"]),
    "0xab", { ...clock, onStatus: (s) => seen.push(s) });
  assert.strictEqual(r.status, "committed");
  assert.deepStrictEqual(seen, ["pending", "pending", "proposed", "committed"]);
});

test("a rejection is final and raises rather than being waited out", async () => {
  // The node will not change its mind. Polling on would leave a visitor
  // watching a spinner over a transaction that is never going to land.
  await assert.rejects(
    () => awaitCommitted(
      rpcReturning([{ status: "rejected", reason: "Resolve(Dead(OutPoint(0x..)))" }]),
      "0xab", fakeClock()),
    /rejected the transaction: Resolve\(Dead/);
});

test("a timeout says it stopped watching, it does not claim failure", async () => {
  // The transaction may still commit. Reporting it as failed would assert
  // something untrue about the chain.
  const r = await awaitCommitted(rpcReturning(["pending"]), "0xab",
    { ...fakeClock(), timeoutMs: 5000, pollMs: 1000 });
  assert.strictEqual(r.timedOut, true);
  assert.strictEqual(r.status, "pending");
  assert.strictEqual(r.blockNumber, null);
});

test("the indexer wait returns only once the tip reaches the block", async () => {
  // The trap this exists for: get_cells against a tip the indexer has not
  // reached answers about a world without this transaction, with no error.
  let n = 0;
  const tips = ["0x62", "0x63", "0x64"];
  const rpc = { call: async () => ({ block_number: tips[Math.min(n++, 2)] }) };
  assert.strictEqual(await awaitIndexer(rpc, 100n, fakeClock()), true);
  assert.strictEqual(n, 3, "it polled until the tip caught up");
});

test("the indexer wait gives up rather than hanging forever", async () => {
  const rpc = { call: async () => ({ block_number: "0x1" }) };
  assert.strictEqual(
    await awaitIndexer(rpc, 100n, { ...fakeClock(), timeoutMs: 3000, pollMs: 1000 }),
    false);
});
