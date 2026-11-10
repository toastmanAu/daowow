"use strict";
// Wrapped in an IIFE: loaded as a classic script these files share one
// global scope, so top-level declarations would collide between modules.
(function () {
// What happens around a signature, as a sequence that can be tested.
//
// The rule this file exists for: ONCE A TRANSACTION HAS BEEN BROADCAST, "it
// was not sent" is never true again, whatever the network does next. Watching
// a transaction means polling a public node about a hundred times, and any one
// of those polls can fail. A failed poll is "still on its way", with the
// transaction's id kept in view. Telling the player "nothing has left your
// wallet" at that point invites them to press the button again and pay twice.
//
// The second rule: a screen the player has left must not open their wallet.

const confirmLib = () =>
  typeof require === "function" ? require("../../chain/confirm.js") : window.DaowowConfirm;

const words = (e) => (e && e.message ? e.message : String(e));
const ABANDONED = Symbol("abandoned");

/** confirmed | rejected | pending. Never throws. */
async function watchTransaction({ rpc, txHash, confirm = confirmLib() }) {
  let landed;
  try {
    landed = await confirm.awaitCommitted(rpc, txHash);
  } catch (e) {
    // Only the node's own verdict is a rejection. Anything else is the
    // network failing to answer, which says nothing about the transaction.
    if (e && e.status === "rejected") return { outcome: "rejected", blockNumber: null, detail: words(e) };
    return { outcome: "pending", blockNumber: null, detail: words(e) };
  }
  if (landed.timedOut) return { outcome: "pending", blockNumber: null, detail: null };
  // Committed is committed. The wait for the indexer only decides when a
  // re-read is worth doing; failing it cannot un-confirm anything.
  try { await confirm.awaitIndexer(rpc, landed.blockNumber); } catch { /* re-read may lag */ }
  return { outcome: "confirmed", blockNumber: landed.blockNumber, detail: null };
}

const result = (stage, { txHash = null, message = null, detail = null } = {}) =>
  ({ stage, txHash, message, detail });

// After broadcast: confirmed, rejected, or pending. Never "not sent".
async function settle(txHash, watch) {
  let seen;
  try { seen = await watch(txHash); } catch (e) { seen = { outcome: "pending", detail: words(e) }; }
  return result(seen.outcome, { txHash, detail: seen.detail ?? null });
}

/**
 * Entering a round.
 *   check()                    re-reads the round and judges the offer
 *   isLive()                   false once the player has left this screen
 *   send(row, beforeSign)      builds, signs and broadcasts; must call
 *                              beforeSign() immediately before each signature
 *   watch(txHash)              watchTransaction
 * Stages: refused | abandoned | not-sent | pending | rejected | confirmed.
 */
async function runEntry({ check, isLive, send, watch, say }) {
  say("checking");
  const checked = await check();
  if (!checked.ok) return result("refused", { message: checked.message });
  if (!isLive()) return result("abandoned");
  let txHash;
  try {
    const sent = await send(checked.row, () => { if (!isLive()) throw ABANDONED; });
    txHash = sent.txHash;
  } catch (e) {
    if (e === ABANDONED) return result("abandoned");
    return result("not-sent", { detail: words(e) });
  }
  say("waiting");
  return settle(txHash, watch);
}

/**
 * Refunding an entry.
 *   check()                    re-reads; { ok, row, entry, nowEpoch } or { ok: false, message }
 *   prepare(checked)           builds the refund; { ok, tx } or { ok: false, message, detail }
 *   signer()                   the signing session, or null
 * Stages: refused | no-wallet | abandoned | not-sent | pending | rejected | confirmed.
 */
async function runRefund({ check, prepare, signer, isLive, watch, say }) {
  say("checking");
  const checked = await check();
  if (!checked.ok) return result("refused", { message: checked.message });
  const session = signer();
  if (!session) return result("no-wallet");
  const prepared = await prepare(checked, session);
  if (!prepared.ok) return result("refused", { message: prepared.message, detail: prepared.detail ?? null });
  if (!isLive()) return result("abandoned");
  let txHash;
  try {
    say("approve");
    const signed = await session.signEntry(prepared.tx);
    say("sending");
    txHash = await session.broadcast(signed);
  } catch (e) {
    return result("not-sent", { detail: words(e) });
  }
  say("waiting");
  return settle(txHash, watch);
}

const api = { watchTransaction, runEntry, runRefund };
if (typeof module !== "undefined" && module.exports) module.exports = api;
if (typeof window !== "undefined") window.DaowowSendFlow = api;
})();
