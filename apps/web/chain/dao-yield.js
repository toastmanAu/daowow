"use strict";
// Wrapped in an IIFE: loaded as a classic script these files share one
// global scope, so top-level declarations would collide between modules.
(function () {
// What a round's Nervos DAO deposit has earned so far.
//
// A round's tickets are pooled into one DAO deposit per batch (aggregate-tx.js,
// output 1). The contract's prize pool is what the DAO returns minus that
// deposit's capacity (entitlements.rs), so the interest earned to date IS the
// pool so far, with nothing else deducted.
//
// The maths is the Nervos DAO's own, read from the `dao` field of two block
// headers. It reports what has ACCRUED. It never projects forward.

const refundTx = () =>
  typeof require === "function" ? require("./refund-tx.js") : window.DaowowRefundTx;

const CKB = 100000000n;
const strip = (s) => String(s ?? "").replace(/^0x/, "").toLowerCase();
const byteLength = (hexString) => BigInt(strip(hexString).length / 2);
const HASH_TYPE_NAME = { 0: "data", 1: "type", 2: "data1", 4: "data2" };

/** The accumulated rate: little-endian u64 at bytes 8..16 of a header's dao field. */
function accumulatedRate(header) {
  const hexField = strip(header.dao);
  if (hexField.length !== 64) throw new Error("a header's dao field is 32 bytes");
  let value = 0n;
  for (let i = 15; i >= 8; i--) value = (value << 8n) | BigInt(parseInt(hexField.substr(i * 2, 2), 16));
  return value;
}

/**
 * Occupied capacity in shannons. CKB counts a script as code hash + hash type
 * + args, never its molecule serialization.
 */
function occupiedCapacity(cell) {
  const scriptSize = (s) => (s ? 33n + byteLength(s.args) : 0n);
  return (8n + scriptSize(cell.output.lock) + scriptSize(cell.output.type)
    + byteLength(cell.output_data)) * CKB;
}

/** What the DAO would return now. Interest accrues on the FREE capacity only. */
function maximumWithdraw({ capacity, occupied, depositAr, currentAr }) {
  const free = BigInt(capacity) - BigInt(occupied);
  return BigInt(occupied) + (free * BigInt(currentAr)) / BigInt(depositAr);
}

/** The round's live DAO deposits. dao_lock args: round id ‖ batch id ‖ commitment ‖ digest. */
async function findDaoDeposits(rpc, config) {
  const deposits = [];
  const hashType = HASH_TYPE_NAME[Number(config.daoLock.hashType)];
  if (!hashType) throw new Error(`unknown hash type ${config.daoLock.hashType}`);
  for await (const cell of rpc.getCells({
    script: {
      code_hash: "0x" + strip(config.daoLock.codeHash),
      hash_type: hashType,
      args: "0x" + strip(config.roundId),
    },
    script_type: "lock",
    script_search_mode: "prefix",
  })) {
    const args = strip(cell.output.lock.args);
    if (args.length !== 208 || args.slice(80, 144) !== strip(config.commitment)) continue;
    // The config commits the DAO type's SCRIPT hash (the 2026-10-05 trap).
    const type = cell.output.type;
    if (!type) continue;
    const typeHash = refundTx().scriptHash({
      codeHash: type.code_hash, hashType: type.hash_type, args: type.args,
    });
    if (typeHash !== strip(config.daoType.codeHash)) continue;
    // Eight zero bytes mark a deposit. Anything else is a withdrawal under
    // way, whose interest has stopped and is no longer "so far".
    if (strip(cell.output_data) !== "0000000000000000") continue;
    deposits.push(Object.freeze({
      capacity: BigInt(cell.output.capacity),
      occupied: occupiedCapacity(cell),
      blockNumber: BigInt(cell.block_number),
      outPoint: Object.freeze({
        txHash: cell.out_point.tx_hash, index: Number(cell.out_point.index),
      }),
    }));
  }
  return deposits;
}

/** Interest earned to date across the round's deposits, or null with none. */
async function readPoolSoFar(rpc, config, tipHeader) {
  const deposits = await findDaoDeposits(rpc, config);
  if (deposits.length === 0) return null;
  const currentAr = accumulatedRate(tipHeader);
  let pool = 0n;
  for (const d of deposits) {
    const header = await rpc.call("get_header_by_number", ["0x" + d.blockNumber.toString(16)]);
    if (!header) throw new Error("the deposit's block header is not available");
    const now = maximumWithdraw({
      capacity: d.capacity, occupied: d.occupied,
      depositAr: accumulatedRate(header), currentAr,
    });
    if (now > d.capacity) pool += now - d.capacity;
  }
  return pool;
}

const api = { accumulatedRate, occupiedCapacity, maximumWithdraw, findDaoDeposits, readPoolSoFar };
if (typeof module !== "undefined" && module.exports) module.exports = api;
if (typeof window !== "undefined") window.DaowowDaoYield = api;
})();
