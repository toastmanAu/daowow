"use strict";
// Wrapped in an IIFE: loaded as a classic script these files share one
// global scope, so top-level declarations would collide between modules.
(function () {
// TX-04: refund an entry the round never accepted.
//
// entry-lock has exactly two spend paths and no operator path. The refund one
// requires, from contracts/entry-lock/src/main.rs:
//
//   - an input `since` that is an ABSOLUTE EPOCH at or after the round's
//     aggregation_deadline;
//   - the FULL entry capacity returning to the participant lock committed in
//     the entry itself, as a plain cell: no type script and empty data;
//   - no output under the round's dao-lock.
//
// Because the whole capacity must return, THE FEE CANNOT COME OUT OF THE
// REFUND. The signing adapter funds it from another input, which is why this
// builder emits the refund output at exactly the entry's capacity and leaves
// fee completion alone.
//
// Refundability is derived from chain state on every read. The beta plan
// forbids keeping an irreversible local "refunded" flag, because a reorg can
// reverse the fact and a cached answer would then be wrong in the direction
// that loses money.

const core = typeof require === "function" ? require("../core.js") : window.DaowowCore;

// RFC-0017: an absolute epoch only when the top byte is exactly 0x20.
const ABSOLUTE_EPOCH_FLAG = 0x2000000000000000n;

function isRefundable({ config, nowEpoch }) {
  // Inclusive: the contract checks `>= aggregation_deadline`.
  return BigInt(nowEpoch) >= BigInt(config.aggregationDeadline);
}

function buildRefundTx({
  manifest, config, entryCell, participantLock, nowEpoch, configCellOutPoint,
  participantLockHash,
}) {
  if (!isRefundable({ config, nowEpoch })) {
    throw new Error(
      `a refund is only permitted from epoch ${config.aggregationDeadline} ` +
      "(the round's aggregation deadline)",
    );
  }
  if (!configCellOutPoint || !configCellOutPoint.txHash) {
    throw new Error("the round config cell out point is required as a cell dep");
  }

  // The destination is not a choice. entry-lock compares the output lock's
  // hash to the one committed in the entry, so a refund anywhere else is
  // refused on chain; refuse it here rather than after the visitor signs.
  const committed = participantLockHash ?? entryCell.participantLockHash;
  const destination = scriptHash(participantLock);
  if (committed && destination !== committed) {
    throw new Error(
      "this entry's participant lock does not match the connected wallet; " +
      "only the original depositor can be refunded",
    );
  }

  const entryLock = manifest.scripts["entry-lock"];
  return {
    tx: {
      cellDeps: [
        { outPoint: entryLock.outPoint, depType: entryLock.depType },
        { outPoint: configCellOutPoint, depType: "code" },
      ],
      headerDeps: [],
      inputs: [{
        previousOutput: entryCell.outPoint,
        since: ABSOLUTE_EPOCH_FLAG | BigInt(nowEpoch),
      }],
      // Exactly the entry's capacity, as a plain cell. Deducting a fee here
      // would fail with ENTRY_ERROR_REFUND_DESTINATION.
      outputs: [{ capacity: entryCell.capacity, lock: participantLock, type: null }],
      outputsData: [""],
      witnesses: [],
    },
    refunded: entryCell.capacity,
  };
}

// CKB script hash: blake2b over the molecule Script. Delegated to core's
// CKB-personalised hash; the caller supplies a hash directly in tests where
// no real script is to hand.
function scriptHash(script) {
  if (!script || typeof script.codeHash !== "string") return null;
  const hashType = { data: 0, type: 1, data1: 2, data2: 4 }[script.hashType];
  if (hashType === undefined) throw new Error(`unknown hashType ${script.hashType}`);
  const args = script.args.startsWith("0x") ? script.args.slice(2) : script.args;
  const argsBytes = Uint8Array.from(args.match(/../g) ?? [], (b) => parseInt(b, 16));
  const code = Uint8Array.from(
    script.codeHash.slice(2).match(/../g), (b) => parseInt(b, 16));
  // Script molecule: u32 full size | 3 u32 offsets | code_hash | hash_type |
  // u32 args length | args.
  const full = 4 + 12 + 32 + 1 + 4 + argsBytes.length;
  const out = new Uint8Array(full);
  const view = new DataView(out.buffer);
  view.setUint32(0, full, true);
  view.setUint32(4, 16, true);
  view.setUint32(8, 48, true);
  view.setUint32(12, 49, true);
  out.set(code, 16);
  out[48] = hashType;
  view.setUint32(49, argsBytes.length, true);
  out.set(argsBytes, 53);
  return Array.from(core.ckbHash256([out]), (x) => x.toString(16).padStart(2, "0")).join("");
}

const api = { buildRefundTx, isRefundable, scriptHash, ABSOLUTE_EPOCH_FLAG };
if (typeof module !== "undefined" && module.exports) module.exports = api;
if (typeof window !== "undefined") window.DaowowRefundTx = api;
})();
