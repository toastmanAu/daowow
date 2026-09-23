"use strict";
// Wrapped in an IIFE: loaded as a classic script these files share one
// global scope, so top-level declarations would collide between modules.
(function () {
// Losing the race for the shard head.
//
// Gate 1 fixed the beta at one entry shard, so every entrant competes for one
// cell and docs/transaction-templates.md says so outright: "retry required if
// competing transaction consumes the chosen shard head first."
//
// A loser finds out at BROADCAST, after approving in their wallet. So this is
// a flow with an explanation, not error handling: read the head, build, sign,
// send, and on a lost race read the NEW head and build again. The rebuild is
// genuinely a different entry — the shard's ticket and entry counts have
// moved, so position_base and entry_nonce move with them (shard.rs:46) — and
// resubmitting the same bytes could never work.

// Bounded deliberately. Each attempt costs the visitor another signature
// prompt, so looping silently would be worse than stopping and saying why.
const MAX_ATTEMPTS = 3;

// The node's words for "another transaction already took that input". Taken
// from this repository's own devnet assertions, which match on
// "Unknown|Dead|Resolve" for exactly this case.
const CONTENTION = /\b(Dead|Unknown|Resolve)\b/;

function classifyBroadcastError(error) {
  const message = String((error && error.message) || error || "");
  // Order matters: a verification failure can mention nothing about inputs,
  // and must never be retried — the chain will never accept it, so retrying
  // only asks the visitor to sign the same doomed transaction again.
  if (/Verification failed|PoolRejected|error code -/.test(message)) {
    return "rejected";
  }
  if (CONTENTION.test(message)) return "contention";
  return "unknown";
}

async function submitEntryWithRetry({ readHead, buildAndSign, broadcast }, options = {}) {
  const maxAttempts = options.maxAttempts ?? MAX_ATTEMPTS;
  let lastError = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    // Read the head immediately before building. A cached round view is
    // exactly how a client builds against a shard that has already moved.
    const head = await readHead();
    const tx = await buildAndSign(head);
    try {
      const txHash = await broadcast(tx);
      return { txHash, attempts: attempt };
    } catch (error) {
      const kind = classifyBroadcastError(error);
      if (kind !== "contention") throw error;
      lastError = error;
    }
  }
  const explained = new Error(
    `another entry took the shard head ${maxAttempts} times in a row. ` +
    "The round is busy; your funds have not moved and nothing was committed. " +
    "Try again in a moment.",
  );
  explained.cause = lastError;
  throw explained;
}

const api = { classifyBroadcastError, submitEntryWithRetry, MAX_ATTEMPTS };
if (typeof module !== "undefined" && module.exports) module.exports = api;
if (typeof window !== "undefined") window.DaowowContention = api;
})();
