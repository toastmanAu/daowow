"use strict";
// Wrapped in an IIFE: loaded as a classic script these files share one
// global scope, so top-level declarations would collide between modules.
(function () {
// Recovering a shard's FULL entry history.
//
// THE LIVE CELL SET IS NOT THE REPLAY SET, and the difference is not academic:
// the accumulator is append-only, so a frozen shard's root commits to every
// entry it ever took, forever. Spending an entry cell — a refund does exactly
// that — removes it from the indexer's live set while the root keeps counting
// it. Replaying the survivors therefore produces a DIFFERENT tree, and every
// membership proof drawn from it is refused.
//
// That is not a hypothetical. It bit on a live round: the first refund
// succeeded, and the second failed because the first had spent the cell the
// replay needed.
//
// So the history comes from committed TRANSACTIONS instead. Each entry
// transaction consumed the previous shard head at input 0 and carried the
// entry in its append witness, so walking input 0 backwards recovers every
// entry in order regardless of which cells still exist. Freeze, genesis and
// close carry no append witness and are simply walked through.
//
// This is the third shape of the same lesson. The chain stores the
// accumulator's ROOT and nothing else: the peaks come from a witness
// (shard-peaks.js), the proofs from a replay, and now the replay itself from
// witnesses rather than from cells.

const entryCodec =
  typeof require === "function" ? require("./entry-codec.js") : window.DaowowEntryCodec;

const MAX_BATCH_ENTRIES = 32;
// A shard cannot have more transactions in its chain than entries plus the
// handful of lifecycle steps; the bound only has to stop a malformed chain
// from walking forever.
const MAX_WALK = 512;

const unhex = (s) => {
  const body = s.startsWith("0x") ? s.slice(2) : s;
  return Uint8Array.from(body.match(/../g) ?? [], (b) => parseInt(b, 16));
};

/**
 * The entries carried by an MMR append witness, or null if these bytes are not
 * one.
 *
 * Framing, from mmr-witness.js and encode_shard_append_witness_mmr:
 *   u32 LE entry count | count x 132-byte entries
 *   u32 LE old_peaks length | old_peaks
 *   u32 LE new_peaks length | new_peaks
 *
 * Validated STRICTLY — the count bounded and the total length required to
 * match exactly — because the other witnesses in a shard's history are a
 * WitnessArgs (round creation) or empty, and a loose parse that accepted one of
 * those would invent entries.
 */
function entriesFromAppendWitness(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.length < 12) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const count = view.getUint32(0, true);
  if (count === 0 || count > MAX_BATCH_ENTRIES) return null;
  const size = entryCodec.ENTRY_DATA_SIZE;
  let at = 4 + count * size;
  if (at + 4 > bytes.length) return null;
  const oldLen = view.getUint32(at, true);
  at += 4 + oldLen;
  if (at + 4 > bytes.length) return null;
  const newLen = view.getUint32(at, true);
  at += 4 + newLen;
  // Exact: a witness that merely CONTAINS a plausible prefix is not one.
  if (at !== bytes.length) return null;

  const entries = [];
  for (let i = 0; i < count; i++) {
    try {
      entries.push(entryCodec.decodeEntryDataV1(
        bytes.slice(4 + i * size, 4 + (i + 1) * size)));
    } catch {
      return null;
    }
  }
  return entries;
}

/**
 * Every entry the shard ever accepted, in nonce order.
 *
 * `from` is any out point in the shard's lineage — the ledger cell, or the
 * shard head itself. `expectedCount` is the frozen shard's entry_count, and the
 * walk stops once that many entries are recovered.
 */
async function readShardEntries(rpc, from, expectedCount) {
  const want = Number(expectedCount);
  if (want === 0) return [];
  const collected = [];
  let point = { txHash: from.txHash, index: Number(from.index) };

  for (let step = 0; step < MAX_WALK && collected.length < want; step++) {
    const got = await rpc.call("get_transaction", [point.txHash]);
    const tx = got?.transaction;
    if (!tx) {
      throw new Error(
        `the transaction ${point.txHash} is not on this node, so the shard's ` +
        "entry history cannot be recovered",
      );
    }
    const raw = tx.witnesses?.[0];
    if (raw && raw !== "0x") {
      const entries = entriesFromAppendWitness(unhex(raw));
      // Walking BACKWARDS, so earlier transactions are found later: each
      // batch goes in front of what we already have.
      if (entries) collected.unshift(...entries);
    }
    const previous = tx.inputs?.[0]?.previous_output;
    if (!previous) break;
    point = { txHash: previous.tx_hash, index: Number(previous.index) };
  }

  if (collected.length !== want) {
    throw new Error(
      `recovered ${collected.length} of the shard's ${want} entries by walking ` +
      "its transaction history; the walk is incomplete, so a membership proof " +
      "from it would be for a different tree",
    );
  }
  // The nonces must be 0..n-1 in order. If they are not, the walk assembled
  // the wrong set and the root check downstream would be the only thing
  // standing between that and an unexplained -4 on chain.
  collected.forEach((entry, i) => {
    if (Number(entry.entryNonce) !== i) {
      throw new Error(
        `the recovered entry at position ${i} carries nonce ${entry.entryNonce}; ` +
        "the history is out of order",
      );
    }
  });
  return collected;
}

const api = { readShardEntries, entriesFromAppendWitness, MAX_WALK };
if (typeof module !== "undefined" && module.exports) module.exports = api;
if (typeof window !== "undefined") window.DaowowShardHistory = api;
})();
