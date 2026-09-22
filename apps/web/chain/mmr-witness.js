"use strict";
// Wrapped in an IIFE: loaded as a classic script these files share one
// global scope, so top-level declarations would collide between modules.
(function () {
// The MMR append witness — what authorises an entry against the shard.
//
// Framing mirrors daowow_core::witness::encode_shard_append_witness_mmr and is
// pinned byte-for-byte in ../test/mmr-witness.test.js:
//
//   u32 LE entry count | each entry's 132 bytes
//   u32 LE old_peaks length | old_peaks
//   u32 LE new_peaks length | new_peaks
//
// A peak list is one byte of count then 32 bytes per peak. An EMPTY shard's
// list is therefore the single byte 0x00, not an absent field — the contract
// reads the count byte either way, and that is the case a client's first
// entry always hits.
//
// The contract re-derives the transition itself: it checks
// bag_peaks(old_peaks) equals the shard's committed root and that the old peak
// count equals before.entry_count.count_ones(), replays the appends, and
// requires the result to equal the peaks sent AND bag_peaks of them to equal
// the successor's root. Sending peaks inconsistent with the root fails; there
// is nothing to be gained by guessing.

const codec =
  typeof require === "function" ? require("./entry-codec.js") : window.DaowowEntryCodec;

const PEAK_SIZE = 32;
const MAX_PEAKS = 64; // a u64 leaf count has at most 64 set bits

function encodePeaks(peaks) {
  if (!Array.isArray(peaks)) throw new Error("peaks must be an array");
  if (peaks.length > MAX_PEAKS) {
    throw new Error(`a peak list cannot exceed ${MAX_PEAKS} peaks`);
  }
  const out = new Uint8Array(1 + peaks.length * PEAK_SIZE);
  out[0] = peaks.length;
  peaks.forEach((peak, i) => {
    if (!(peak instanceof Uint8Array) || peak.length !== PEAK_SIZE) {
      throw new Error(`peak ${i} must be exactly ${PEAK_SIZE} bytes`);
    }
    out.set(peak, 1 + i * PEAK_SIZE);
  });
  return out;
}

function encodeAppendWitnessMmr(entries, oldPeaks, newPeaks) {
  if (!Array.isArray(entries) || entries.length === 0) {
    throw new Error("an append witness needs at least one entry");
  }
  const encoded = entries.map((e) => codec.encodeEntryDataV1(e));
  const size =
    4 + encoded.length * codec.ENTRY_DATA_SIZE +
    4 + oldPeaks.length + 4 + newPeaks.length;
  const out = new Uint8Array(size);
  const view = new DataView(out.buffer);
  let at = 0;
  view.setUint32(at, encoded.length, true);
  at += 4;
  for (const bytes of encoded) {
    out.set(bytes, at);
    at += codec.ENTRY_DATA_SIZE;
  }
  view.setUint32(at, oldPeaks.length, true);
  at += 4;
  out.set(oldPeaks, at);
  at += oldPeaks.length;
  view.setUint32(at, newPeaks.length, true);
  at += 4;
  out.set(newPeaks, at);
  return out;
}

const api = { encodePeaks, encodeAppendWitnessMmr, PEAK_SIZE, MAX_PEAKS };
if (typeof module !== "undefined" && module.exports) module.exports = api;
if (typeof window !== "undefined") window.DaowowMmrWitness = api;
})();
