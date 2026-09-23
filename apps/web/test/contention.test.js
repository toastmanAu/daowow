"use strict";
// Gate 1 fixed the beta at one entry shard, so every entrant competes for one
// cell. A loser's transaction is rejected at BROADCAST — after they approved
// it in their wallet — so losing has to be a flow with an explanation, not a
// generic failure.
const { test } = require("node:test");
const assert = require("node:assert");
const {
  classifyBroadcastError, submitEntryWithRetry, MAX_ATTEMPTS,
} = require("../chain/contention.js");

// Error strings taken from this repository's own devnet assertions, which
// match on "Unknown|Dead|Resolve" for an input another transaction took.
const DEAD = new Error(
  "TransactionFailedToResolve: Resolve(Dead(OutPoint(0xabc...:0)))");
const UNKNOWN = new Error(
  "TransactionFailedToResolve: Resolve(Unknown([OutPoint(0xabc...:0)]))");
const SCRIPT = new Error(
  "TransactionFailedToVerify: Verification failed Script(... error code -33 ...)");
const FEE = new Error("PoolRejectedTransactionByMinFeeRate: ...");

test("a taken input is recognised as contention, not as a rejection", () => {
  assert.strictEqual(classifyBroadcastError(DEAD), "contention");
  assert.strictEqual(classifyBroadcastError(UNKNOWN), "contention");
});

test("a script rejection is NOT treated as contention", () => {
  // Retrying a script failure would loop forever asking the visitor to sign
  // something the chain will never accept.
  assert.strictEqual(classifyBroadcastError(SCRIPT), "rejected");
  assert.strictEqual(classifyBroadcastError(FEE), "rejected");
});

function harness({ failures, headSequence }) {
  const calls = [];
  let attempt = 0;
  return {
    calls,
    readHead: async () => {
      const head = headSequence[Math.min(attempt, headSequence.length - 1)];
      calls.push({ phase: "read", head: head.ticketCount });
      return head;
    },
    buildAndSign: async (head) => {
      calls.push({ phase: "build", against: head.ticketCount });
      return { signed: head.ticketCount };
    },
    broadcast: async (tx) => {
      calls.push({ phase: "broadcast", tx: tx.signed });
      if (attempt++ < failures) throw DEAD;
      return "0xdeadbeef";
    },
  };
}

test("a lost race rebuilds against the NEW head, not the stale one", async () => {
  // The rebuild is a different entry: the shard's ticket count and entry
  // count have moved, so position_base and entry_nonce move with them
  // (shard.rs:46). Resubmitting the same bytes could never work.
  const h = harness({
    failures: 1,
    headSequence: [{ ticketCount: 3n }, { ticketCount: 5n }],
  });
  const result = await submitEntryWithRetry(h);
  assert.strictEqual(result.txHash, "0xdeadbeef");
  assert.strictEqual(result.attempts, 2);
  const builds = h.calls.filter((c) => c.phase === "build").map((c) => c.against);
  assert.deepStrictEqual(builds, [3n, 5n], "the second build used the new head");
});

test("the head is read immediately before each build, never cached", async () => {
  const h = harness({ failures: 2, headSequence: [{ ticketCount: 1n }, { ticketCount: 2n }, { ticketCount: 3n }] });
  await submitEntryWithRetry(h);
  const phases = h.calls.map((c) => c.phase);
  for (let i = 0; i < phases.length; i += 3) {
    assert.deepStrictEqual(phases.slice(i, i + 3), ["read", "build", "broadcast"]);
  }
});

test("retries are bounded and end with an explanation, not a loop", async () => {
  const h = harness({ failures: 99, headSequence: [{ ticketCount: 1n }] });
  await assert.rejects(() => submitEntryWithRetry(h), (e) => {
    assert.match(e.message, /another entry took the shard/i);
    assert.match(e.message, new RegExp(`${MAX_ATTEMPTS}`));
    return true;
  });
  assert.strictEqual(
    h.calls.filter((c) => c.phase === "broadcast").length, MAX_ATTEMPTS,
    "it stops at the cap rather than retrying forever");
});

test("a script rejection stops immediately and is reported as itself", async () => {
  const calls = [];
  const h = {
    readHead: async () => ({ ticketCount: 1n }),
    buildAndSign: async () => ({ signed: 1n }),
    broadcast: async () => { calls.push("broadcast"); throw SCRIPT; },
  };
  await assert.rejects(() => submitEntryWithRetry(h), /error code -33/);
  assert.strictEqual(calls.length, 1, "no retry for a rejection");
});
