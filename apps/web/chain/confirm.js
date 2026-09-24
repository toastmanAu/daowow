"use strict";
// Wrapped in an IIFE: loaded as a classic script these files share one
// global scope, so top-level declarations would collide between modules.
(function () {
// Waiting for an entry to actually land.
//
// A send returns when the node ACCEPTS a transaction into its pool. That is
// not the same as the transaction being in a block, and it is emphatically not
// the same as the indexer being able to find the cells it created. A page that
// re-reads the round the moment a send returns shows the OLD ticket count and
// looks broken.
//
// Two waits, because they are two different things:
//
//   1. the transaction reaching `committed`, which the node reports directly
//   2. the INDEXER catching up to that block, which it does on its own
//      schedule — `get_cells` against a tip it has not reached yet returns the
//      pre-transaction world with no error at all
//
// Skipping the second is how a client renders stale state and blames itself.

const DEFAULTS = Object.freeze({ pollMs: 1500, timeoutMs: 180000 });

// `pending` and `proposed` are both "still on its way". `rejected` is final
// and is reported as such rather than waited out.
async function awaitCommitted(rpc, txHash, options = {}) {
  const { pollMs, timeoutMs } = { ...DEFAULTS, ...options };
  const onStatus = options.onStatus ?? (() => {});
  const sleep = options.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  const now = options.now ?? (() => Date.now());
  const started = now();

  for (;;) {
    const result = await rpc.call("get_transaction", [txHash]);
    const status = result?.tx_status?.status ?? "unknown";
    onStatus(status);
    if (status === "committed") {
      const header = await rpc.call("get_header", [result.tx_status.block_hash]);
      return { status, blockNumber: BigInt(header.number) };
    }
    if (status === "rejected") {
      // Final. The node will not change its mind, so waiting is dishonest.
      const reason = result.tx_status.reason ?? "no reason given";
      const error = new Error(`the node rejected the transaction: ${reason}`);
      error.status = status;
      throw error;
    }
    if (now() - started >= timeoutMs) {
      // NOT a failure. The transaction may still commit; we simply stopped
      // watching, and saying otherwise would assert something untrue.
      return { status, blockNumber: null, timedOut: true };
    }
    await sleep(pollMs);
  }
}

// The indexer trails the chain. Until it reaches `blockNumber`, get_cells
// answers about a world in which this transaction never happened.
async function awaitIndexer(rpc, blockNumber, options = {}) {
  const { pollMs, timeoutMs } = { ...DEFAULTS, ...options };
  const sleep = options.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  const now = options.now ?? (() => Date.now());
  const started = now();

  for (;;) {
    const tip = await rpc.call("get_indexer_tip", []);
    if (tip && BigInt(tip.block_number) >= BigInt(blockNumber)) return true;
    if (now() - started >= timeoutMs) return false;
    await sleep(pollMs);
  }
}

const api = { awaitCommitted, awaitIndexer, DEFAULTS };
if (typeof module !== "undefined" && module.exports) module.exports = api;
if (typeof window !== "undefined") window.DaowowConfirm = api;
})();
