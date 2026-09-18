"use strict";
// Decoders for the on-chain cell payloads round discovery reads.
//
// Byte layouts mirror crates/daowow-core/src/encoding.rs. They are pinned
// field by field to Rust-generated vectors in ../test/codec.test.js: a length
// check alone would not catch an offset four bytes out, because the
// neighbouring field still decodes to a plausible number.
//
// u64 fields are returned as BigInt. Shannon amounts exceed 2^53, so Number
// would silently round them.

const ROUND_CONFIG_SIZE = 358;
const SHARD_DATA_SIZE = 101;

// Mirrors SHARD_STATE_OPEN / SHARD_STATE_FROZEN in daowow-core.
const SHARD_STATE = Object.freeze({ OPEN: 0, FROZEN: 1 });

const hex = (b, o, n) =>
  Array.from(b.slice(o, o + n), (x) => x.toString(16).padStart(2, "0")).join("");

const view = (b) => new DataView(b.buffer, b.byteOffset, b.byteLength);

// A ScriptRef is 33 bytes: 32-byte code hash then a one-byte hash type
// (0 data, 1 type, 2 data1, 4 data2).
const scriptRef = (b, off) => ({ codeHash: hex(b, off, 32), hashType: b[off + 32] });

function decodeRoundConfigV1(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.length !== ROUND_CONFIG_SIZE) {
    throw new Error(`round config must be exactly ${ROUND_CONFIG_SIZE} bytes`);
  }
  const d = view(bytes);
  return Object.freeze({
    version: d.getUint32(0, true),
    roundId: hex(bytes, 4, 32),
    ticketPrice: d.getBigUint64(36, true),
    minimumTickets: d.getBigUint64(44, true),
    maximumTickets: d.getBigUint64(52, true), // 0 means uncapped
    entryStart: d.getBigUint64(60, true), // absolute epoch numbers
    entryEnd: d.getBigUint64(68, true),
    aggregationDeadline: d.getBigUint64(76, true),
    daoTermPeriods: d.getUint32(84, true),
    entryShardCount: d.getUint32(88, true),
    prizeScheduleHash: hex(bytes, 92, 32),
    feePolicyHash: hex(bytes, 124, 32),
    keeperPolicyHash: hex(bytes, 156, 32),
    flags: d.getUint32(188, true),
    accumulatorId: bytes[192],
    entryLock: scriptRef(bytes, 193),
    daoLock: scriptRef(bytes, 226),
    settlementType: scriptRef(bytes, 259),
    entryShardType: scriptRef(bytes, 292),
    daoType: scriptRef(bytes, 325),
  });
}

function decodeEntryShardDataV1(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.length !== SHARD_DATA_SIZE) {
    throw new Error(`shard data must be exactly ${SHARD_DATA_SIZE} bytes`);
  }
  const d = view(bytes);
  return Object.freeze({
    roundId: hex(bytes, 0, 32),
    shardId: d.getUint32(32, true),
    state: bytes[36],
    sequence: d.getBigUint64(37, true),
    entryCount: d.getBigUint64(45, true),
    ticketCount: d.getBigUint64(53, true),
    principalTotal: d.getBigUint64(61, true),
    accumulatorRoot: hex(bytes, 69, 32),
  });
}

const api = {
  decodeRoundConfigV1,
  decodeEntryShardDataV1,
  SHARD_STATE,
  ROUND_CONFIG_SIZE,
  SHARD_DATA_SIZE,
};
if (typeof module !== "undefined" && module.exports) module.exports = api;
if (typeof window !== "undefined") window.DaowowCodec = api;
