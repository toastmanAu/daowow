"use strict";
// Wrapped in an IIFE: loaded as a classic script these files share one
// global scope, so top-level declarations would collide between modules.
(function () {
// Recovering a shard's MMR peak list.
//
// THE PEAKS ARE NOT ON CHAIN. A shard cell commits to its accumulator ROOT and
// nothing else, so a client appending to a shard that already holds entries
// has to obtain the peak list from somewhere before it can build a witness.
//
// Two ways exist. Replay every prior entry of the shard, or read the peaks out
// of the append witness that last moved the shard head — which already carries
// new_peaks, the exact list the contract validated. This takes the second: one
// RPC call instead of a walk, and the same bytes the chain accepted.
//
// Reading the node's copy is safe for a structural reason rather than a
// trusting one: a peak list must bag to the root the cell commits to, and that
// check runs HERE, locally, against the cell we already read. A node serving a
// stale or invented witness fails it. Nothing is taken on the node's word.

const mmr =
  typeof require === "function" ? require("./mmr-witness.js") : window.DaowowMmrWitness;
const core = typeof require === "function" ? require("../core.js") : window.DaowowCore;
const entryCodec =
  typeof require === "function" ? require("./entry-codec.js") : window.DaowowEntryCodec;

const hex = (b) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
const unhex = (s) => {
  const body = s.startsWith("0x") ? s.slice(2) : s;
  return Uint8Array.from(body.match(/../g) ?? [], (b) => parseInt(b, 16));
};

const popcount = (value) => {
  let n = BigInt(value);
  let bits = 0;
  while (n > 0n) { bits += Number(n & 1n); n >>= 1n; }
  return bits;
};

// One byte of count, then 32 bytes per peak. A short buffer is an ERROR, not a
// short list: silently returning the peaks that happen to fit yields a list
// that bags to something plausible but wrong.
function decodePeaks(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.length < 1) {
    throw new Error("a peak list needs at least its count byte");
  }
  const count = bytes[0];
  const need = 1 + count * mmr.PEAK_SIZE;
  if (bytes.length < need) {
    throw new Error(
      `peak list is truncated: ${count} peaks need ${need} bytes, got ${bytes.length}`,
    );
  }
  const peaks = [];
  for (let i = 0; i < count; i++) {
    peaks.push(bytes.subarray(1 + i * mmr.PEAK_SIZE, 1 + (i + 1) * mmr.PEAK_SIZE));
  }
  return peaks;
}

// The framing encodeAppendWitnessMmr writes, read back. Only new_peaks is
// wanted, but the leading fields have to be walked to find it.
function newPeaksFromAppendWitness(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let at = 0;
  const read32 = () => {
    if (at + 4 > bytes.length) throw new Error("append witness is truncated");
    const v = view.getUint32(at, true);
    at += 4;
    return v;
  };
  const entries = read32();
  at += entries * entryCodec.ENTRY_DATA_SIZE;
  const oldLen = read32();
  at += oldLen;
  const newLen = read32();
  if (at + newLen > bytes.length) throw new Error("append witness is truncated");
  return decodePeaks(bytes.subarray(at, at + newLen));
}

/**
 * The shard's current peak list, as hex strings, verified against the root the
 * cell commits to. `shard` is a discovery shard: entryCount, accumulatorRoot
 * and outPoint.
 */
async function readShardPeaks(rpc, shard) {
  const expected = popcount(shard.entryCount);
  // An empty shard was created by the ROUND CREATION transaction, whose
  // witness carries the prize schedule rather than an append. Parsing that as
  // an append witness would misread it; entry_count says not to try.
  if (expected === 0) return [];

  const created = await rpc.call("get_transaction", [shard.outPoint.txHash]);
  const raw = created?.transaction?.witnesses?.[0];
  if (!raw) {
    throw new Error(
      "the transaction that last moved this shard carries no witness, so its " +
      "accumulator peaks cannot be recovered",
    );
  }
  const peaks = newPeaksFromAppendWitness(unhex(raw));
  if (peaks.length !== expected) {
    throw new Error(
      `this shard holds ${shard.entryCount} entries, so it needs ${expected} ` +
      `accumulator peak(s); the witness carries ${peaks.length}`,
    );
  }
  if (hex(core.MMR.bagPeaks(peaks)) !== shard.accumulatorRoot) {
    throw new Error(
      "the peaks in the shard's last transaction do not bag to the shard's " +
      "committed accumulator root",
    );
  }
  return peaks.map(hex);
}

const api = { readShardPeaks, decodePeaks, newPeaksFromAppendWitness };
if (typeof module !== "undefined" && module.exports) module.exports = api;
if (typeof window !== "undefined") window.DaowowShardPeaks = api;
})();
