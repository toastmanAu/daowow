"use strict";
// Wrapped in an IIFE: loaded as a classic script these files share one
// global scope, so top-level declarations would collide between modules.
(function () {
// Encoders for the cells and identities an entry transaction creates.
//
// Byte layouts mirror crates/daowow-core/src/{encoding,claim,ticket}.rs and
// crates/daowow-core/src/redemption.rs. Each is pinned byte-for-byte to
// Rust-generated vectors in ../test/entry-codec.test.js, because the browser
// builds this transaction itself and a codec that agrees only with its own
// tests is worthless.

// core.js already carries the CKB blake2b, the entry encoder and u64 helpers,
// and passes the Rust vectors. Resolved the dual way these modules export
// themselves: require() under node, window in the browser.
const core =
  typeof require === "function" ? require("../core.js") : window.DaowowCore;

const ENTRY_DATA_SIZE = 132;
const CLAIM_ARGS_SIZE = 45;
const CLAIM_DATA_SIZE = 81;
// ClaimArgs' first byte. Tag 5 is the claim mode of entry-shard-type; the
// memento is 6. A wrong tag is a different script mode, not a malformed cell.
const CLAIM_TAG = 5;

const need32 = (value, what) => {
  if (!(value instanceof Uint8Array) || value.length !== 32) {
    throw new Error(`${what} must be exactly 32 bytes`);
  }
  return value;
};

function encodeEntryDataV1(entry) {
  need32(entry.roundId, "roundId");
  need32(entry.participantLockHash, "participantLockHash");
  need32(entry.entropyCommitment, "entropyCommitment");
  // core.js's encoder is already vector-checked through the entry_leaf
  // vector; this validates its inputs and re-checks the bytes directly.
  const out = core.encodeEntry({
    roundId: entry.roundId,
    shardId: Number(entry.shardId),
    participantLockHash: entry.participantLockHash,
    ticketCount: entry.ticketCount,
    principal: entry.principal,
    positionBase: entry.positionBase,
    entryNonce: entry.entryNonce,
    entropyCommitment: entry.entropyCommitment,
  });
  if (out.length !== ENTRY_DATA_SIZE) {
    throw new Error(`entry must encode to ${ENTRY_DATA_SIZE} bytes`);
  }
  return out;
}

// Reading an entry cell back off chain, which aggregation must do: a batch is
// assembled from the entry cells' own data, and every field is checked against
// the ledger's position before the contract sees it.
//
// Offsets mirror core.js's encodeEntry (core.js:196), the same function
// encodeEntryDataV1 delegates to, so the pair cannot drift apart.
function decodeEntryDataV1(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.length !== ENTRY_DATA_SIZE) {
    throw new Error(`an entry must be exactly ${ENTRY_DATA_SIZE} bytes`);
  }
  const d = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return Object.freeze({
    roundId: bytes.slice(0, 32),
    shardId: d.getUint32(32, true),
    participantLockHash: bytes.slice(36, 68),
    ticketCount: d.getBigUint64(68, true),
    principal: d.getBigUint64(76, true),
    positionBase: d.getBigUint64(84, true),
    entryNonce: d.getBigUint64(92, true),
    entropyCommitment: bytes.slice(100, 132),
  });
}

// blake2b("DAOWOW_TICKET_ID_V1", commitment, shard_id LE, position LE).
// Stable across holder and redemption progress: it is the ticket's identity,
// not its state.
function ticketId(commitment, shardId, position) {
  need32(commitment, "commitment");
  return core.H(
    "DAOWOW_TICKET_ID_V1",
    commitment,
    core.u32le(Number(shardId)),
    core.u64le(BigInt(position)),
  );
}

function encodeClaimArgs({ commitment, shardId, position }) {
  need32(commitment, "commitment");
  const out = new Uint8Array(CLAIM_ARGS_SIZE);
  out[0] = CLAIM_TAG;
  out.set(commitment, 1);
  new DataView(out.buffer).setUint32(33, Number(shardId), true);
  out.set(core.u64le(BigInt(position)), 37);
  return out;
}

// The only data a freshly minted claim may carry: its ticket identity and an
// empty paid set. The contract refuses a mint carrying anything else, and
// refuses replacing an existing claim's state with this value.
function initialClaimState(args) {
  const out = new Uint8Array(CLAIM_DATA_SIZE);
  out[0] = 1; // version
  out.set(ticketId(args.commitment, args.shardId, args.position), 1);
  // bytes 33..65 paid_root, 65..73 paid_count, 73..81 paid_total: all zero.
  return out;
}

const api = {
  decodeEntryDataV1,
  encodeEntryDataV1, ticketId, encodeClaimArgs, initialClaimState,
  ENTRY_DATA_SIZE, CLAIM_ARGS_SIZE, CLAIM_DATA_SIZE, CLAIM_TAG,
};
if (typeof module !== "undefined" && module.exports) module.exports = api;
if (typeof window !== "undefined") window.DaowowEntryCodec = api;
})();
