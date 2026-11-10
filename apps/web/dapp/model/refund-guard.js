"use strict";
// Wrapped in an IIFE: loaded as a classic script these files share one
// global scope, so top-level declarations would collide between modules.
(function () {
// Preparing a refund transaction.
//
// THE LIVE CELL SET IS NOT THE REPLAY SET. The round's accumulator is
// append-only, so the frozen root commits to every entry the shard ever took —
// but a refund SPENDS a cell, so the live set shrinks while the root does not.
// Replaying the survivors builds a different tree and every proof from it is
// refused. Found on a live round: the first refund worked and the second
// failed because the first had spent the cell the replay needed.
//
// So the proof is built from the shard's transaction HISTORY, and if that
// history does not come back whole, no refund is offered at all.

const lib = (path, name) => (typeof require === "function" ? require(path) : window[name]);
const copy = () => lib("./copy.js", "DaowowCopy");
const defaults = () => ({
  readShardEntries: lib("../../chain/shard-history.js", "DaowowShardHistory").readShardEntries,
  buildRefundTx: lib("../../chain/refund-tx.js", "DaowowRefundTx").buildRefundTx,
});

async function prepareRefund({ rpc, manifest, row, entry, session, nowEpoch, readers = defaults() }) {
  const words = copy().text.refund;
  const { config, ledger, outPoint } = row.snapshot;
  if (!ledger) return { ok: false, message: words.unavailable, detail: null };
  try {
    const want = ledger.state.frozen.entryCount;
    const replay = await readers.readShardEntries(rpc, ledger.outPoint, want);
    if (replay.length !== Number(want)) {
      return {
        ok: false, message: words.history,
        detail: `recovered ${replay.length} of ${want} entries`,
      };
    }
    const built = readers.buildRefundTx({
      manifest, config,
      entryCell: entry,
      participantLock: session.lockScript,
      participantLockHash: entry.participantLockHash,
      nowEpoch,
      configCellOutPoint: outPoint,
      ledgerCell: ledger,
      allEntries: replay,
      // No sponsor: the wallet funds the fee and its change lands under this
      // same lock, which is what keeps entry-lock's `returned >= required`
      // satisfied.
    });
    return { ok: true, tx: built.tx };
  } catch (e) {
    // The builder's own reasons use the protocol's words. They are kept for
    // the details disclosure, never shown as the headline.
    return { ok: false, message: words.unavailable, detail: e && e.message ? e.message : String(e) };
  }
}

const sameOutPoint = (a, b) =>
  Boolean(a && b) && a.txHash === b.txHash && Number(a.index) === Number(b.index);

/**
 * Reads the round again before a refund is signed, and hands back the FRESH
 * round and entry. A failed re-read leaves the old data in memory, so the
 * status is checked: building on a ledger that has since moved produces a
 * transaction the chain refuses.
 */
async function checkBeforeRefund({ store, roundId, outPoint }) {
  await store.refresh();
  if (store.state.status !== "ready") {
    return { ok: false, message: copy().errors.network };
  }
  if (store.state.lagging) return { ok: false, message: copy().errors.lagging };
  const row = store.findRound(roundId);
  const card = (store.state.mine ?? []).find((c) => c.roundId === roundId);
  const entry = card ? card.refundable.find((e) => sameOutPoint(e.outPoint, outPoint)) : null;
  if (!row || !entry) return { ok: false, message: copy().text.refund.unavailable };
  return { ok: true, row, entry, nowEpoch: store.state.tip.epoch.number };
}

const api = { prepareRefund, checkBeforeRefund };
if (typeof module !== "undefined" && module.exports) module.exports = api;
if (typeof window !== "undefined") window.DaowowRefundGuard = api;
})();
