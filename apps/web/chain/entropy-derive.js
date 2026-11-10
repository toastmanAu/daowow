"use strict";
// Wrapped in an IIFE: loaded as a classic script these files share one
// global scope, so top-level declarations would collide between modules.
(function () {
// Deriving the entropy record in the browser.
//
// The record that fixes the draw is the seal plus four block hashes: the
// seal's own block and the blocks 64, 128 and 192 after it. Nothing in it is
// the operator's to choose, so once the +192 block exists anyone can build the
// record — the operator's transaction only writes it down, 64 blocks later.
// That is what lets the page count down to a real moment and then show the
// result itself, and what lets it CHECK the operator's record when it lands.
//
// Header hashes are taken as the node reports them, exactly as entropy-tx.js
// takes them: a header hash is the node's to report.

const sealCodec = () =>
  typeof require === "function" ? require("./seal-codec.js") : window.DaowowSealCodec;

const stripped = (h) => String(h).replace(/^0x/, "").toLowerCase();

/** The four blocks the record is built from. BigInt: heights pass 2^53. */
function entropyBlockHeights(inclusionHeight) {
  const h = BigInt(inclusionHeight);
  return [h, h + 64n, h + 128n, h + 192n];
}

/** The block whose arrival fixes the result. */
function lastEntropyHeight(inclusionHeight) {
  return BigInt(inclusionHeight) + 192n;
}

function deriveEntropyRecord({ seal, inclusionHeader, entropyHeaders }) {
  if (!Array.isArray(entropyHeaders) || entropyHeaders.length !== 3) {
    throw new Error("exactly three entropy headers are required: the blocks at +64, +128 and +192");
  }
  const inclusionHeight = BigInt(inclusionHeader.number);
  const want = entropyBlockHeights(inclusionHeight).slice(1);
  // Checked slot by slot. A swapped pair would still be three real hashes and
  // would produce a confident, well-formed, wrong list of winners.
  ["+64", "+128", "+192"].forEach((label, i) => {
    const got = BigInt(entropyHeaders[i].number);
    if (got !== want[i]) {
      throw new Error(
        `entropy header ${i + 1} must be the block at ${label} (height ${want[i]}); got height ${got}`);
    }
  });
  return {
    version: sealCodec().RECORD_VERSION,
    seal,
    inclusionHeight,
    inclusionHash: stripped(inclusionHeader.hash),
    entropyHashes: entropyHeaders.map((h) => stripped(h.hash)),
  };
}

/** Byte equality of the two records' canonical encodings. */
function recordsAgree(a, b) {
  const x = sealCodec().encodeEntropyRecord(a);
  const y = sealCodec().encodeEntropyRecord(b);
  if (x.length !== y.length) return false;
  for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return false;
  return true;
}

/** The four headers, or null while any of them is still to be mined. */
async function readEntropyHeaders(rpc, inclusionHeight) {
  const headers = [];
  for (const height of entropyBlockHeights(inclusionHeight)) {
    const header = await rpc.call("get_header_by_number", ["0x" + height.toString(16)]);
    if (!header) return null;
    // The node is asked for a height and must answer for THAT height. A run
    // shifted by one block is still four real hashes and would name winners.
    if (BigInt(header.number) !== height) {
      throw new Error(`asked for block ${height} and was given block ${BigInt(header.number)}`);
    }
    headers.push({ number: header.number, hash: header.hash });
  }
  return { inclusionHeader: headers[0], entropyHeaders: headers.slice(1) };
}

const api = {
  entropyBlockHeights, lastEntropyHeight, deriveEntropyRecord, recordsAgree, readEntropyHeaders,
};
if (typeof module !== "undefined" && module.exports) module.exports = api;
if (typeof window !== "undefined") window.DaowowEntropyDerive = api;
})();
