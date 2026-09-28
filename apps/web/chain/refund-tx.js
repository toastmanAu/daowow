"use strict";
// Wrapped in an IIFE: loaded as a classic script these files share one
// global scope, so top-level declarations would collide between modules.
(function () {
// TX-04: refund an entry the round never accepted.
//
// entry-lock has exactly two spend paths and no operator path. The refund one
// requires, from contracts/entry-lock/src/main.rs:
//
//   - a CLOSED aggregation ledger for the entry's shard, carried as a CELL DEP,
//     with the entry's nonce at or beyond its accepted prefix;
//   - a membership proof in the witness AT THE ENTRY'S OWN INPUT INDEX, showing
//     the entry really is in the frozen accumulator;
//   - an input `since` that is an ABSOLUTE EPOCH at or after the round's
//     aggregation_deadline;
//   - the FULL entry capacity returning to the participant lock committed in
//     the entry itself, as a plain cell: no type script and empty data;
//   - no output under the round's dao-lock.
//
// THE FIRST TWO WERE MISSING and are the reason this path had never worked. A
// passing aggregation deadline makes an entry ELIGIBLE; it does not make it
// refundable. The round must be frozen, its ledger created, and that ledger
// CLOSED — three keeper transactions — before any entry can be released. Until
// then `excluded_membership` returns false and the spend is refused with
// ENTRY_ERROR_REFUND_CONDITION, which says nothing about a missing cell dep.
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

// The aggregation witness: a u32 LE length then the proof
// (witness.rs:168). Raw bytes at the entry's input index, not a WitnessArgs.
function encodeAggregationWitness(proof) {
  if (!(proof instanceof Uint8Array) || proof.length === 0) {
    throw new Error("an aggregation witness needs a membership proof");
  }
  const out = new Uint8Array(4 + proof.length);
  new DataView(out.buffer).setUint32(0, proof.length, true);
  out.set(proof, 4);
  return out;
}

/**
 * Why this entry cannot be refunded yet, or null when it can be.
 *
 * A reason rather than a boolean, because "not yet" has four distinct causes
 * and the chain reports one code for all of them. `ledger` is the decoded
 * AggregationState of the entry's shard, or null when none exists on chain.
 */
function refundBlocker({ config, nowEpoch, ledger, entryNonce }) {
  // Inclusive: the contract checks `>= aggregation_deadline`.
  if (BigInt(nowEpoch) < BigInt(config.aggregationDeadline)) {
    return `the round's aggregation deadline is epoch ${config.aggregationDeadline} ` +
      `and it is ${nowEpoch}; no entry can be refunded before then`;
  }
  if (!ledger) {
    return "this round has no aggregation ledger on chain yet. The shard must be " +
      "frozen and its ledger created and closed before any entry can be " +
      "refunded — a passed deadline is not enough on its own";
  }
  if (!ledger.closed) {
    return "this round's aggregation ledger is still open. It must be CLOSED " +
      "before an unaccepted entry can be released";
  }
  if (BigInt(entryNonce) < ledger.acceptedEntries) {
    return `this entry was accepted into the round (nonce ${entryNonce} is below ` +
      `the closed prefix of ${ledger.acceptedEntries}); it takes part in the ` +
      "draw and cannot be refunded";
  }
  return null;
}

// Kept for callers that only want the answer. The blocker carries the reason.
function isRefundable(args) {
  return refundBlocker(args) === null;
}

function buildRefundTx({
  manifest, config, entryCell, participantLock, nowEpoch, configCellOutPoint,
  participantLockHash, ledgerCell, allEntries, sponsor,
}) {
  const blocker = refundBlocker({
    config, nowEpoch,
    ledger: ledgerCell ? ledgerCell.state : null,
    entryNonce: entryCell.entry ? entryCell.entry.entryNonce : entryCell.entryNonce,
  });
  if (blocker) throw new Error(blocker);
  if (!configCellOutPoint || !configCellOutPoint.txHash) {
    throw new Error("the round config cell out point is required as a cell dep");
  }
  if (!ledgerCell.outPoint || !ledgerCell.outPoint.txHash) {
    throw new Error(
      "the closed ledger cell's out point is required as a cell dep; the " +
      "contract reads the accepted prefix from there and refuses without it",
    );
  }
  // TWO funding modes. With an explicit sponsor the transaction is complete and
  // a CLI can sign it as-is. Without one the WALLET funds it: CCC adds an input
  // and a change output, and prepareTransaction adds that lock's own cell dep.
  //
  // Omitting the sponsor is safe here for a reason specific to refunds: the
  // change lands under the participant's own lock, which is the same lock the
  // refund pays, so entry-lock's `returned >= required` still holds. It would
  // NOT be safe for a transaction whose change went anywhere else.
  if (sponsor && !sponsor.lockDep) {
    throw new Error(
      "the sponsor's lock cell dep is required (sponsor.lockDep); without it " +
      "the node refuses the transaction with ScriptNotFound on that input",
    );
  }

  // The destination is not a choice. entry-lock compares the output lock's
  // hash to the one committed in the entry, so a refund anywhere else is
  // refused on chain; refuse it here rather than after the visitor signs.
  const entry = entryCell.entry ?? entryCell;
  const committed = participantLockHash ?? entryCell.participantLockHash;
  const destination = scriptHash(participantLock);
  if (committed && destination !== committed) {
    throw new Error(
      "this entry's participant lock does not match the connected wallet; " +
      "only the original depositor can be refunded",
    );
  }

  // The exclusion proof. Replaying the shard is the only way to obtain it: the
  // accumulator's root is on chain and its proof paths are not — the third
  // place this client pays that cost, after the peaks on entry and the proofs
  // on aggregation.
  const frozen = ledgerCell.state.frozen;
  const host = new core.MmrHost();
  for (const e of allEntries) host.append(core.entryLeaf(e));
  if (core.hex(host.root()).replace(/^0x/, "") !== frozen.accumulatorRoot) {
    throw new Error(
      "replaying these entries does not reproduce the shard's committed " +
      "accumulator root, so the exclusion proof would be for a different tree",
    );
  }
  const nonce = Number(entry.entryNonce);
  if (nonce >= allEntries.length) {
    throw new Error(
      `entry nonce ${nonce} is outside the replay set of ${allEntries.length} entries`,
    );
  }
  const proof = host.membershipProof(nonce);

  const entryLock = manifest.scripts["entry-lock"];
  let fee = 0n;
  let change = 0n;
  if (sponsor) {
    fee = BigInt(sponsor.feeShannons ?? 10000000n);
    change = BigInt(sponsor.capacity) - fee;
    if (change < 61n * 100000000n) {
      throw new Error(
        `the sponsor holds ${BigInt(sponsor.capacity) / 100000000n} CKB, which ` +
        "cannot cover the fee and leave a change cell above the 61 CKB floor",
      );
    }
  }

  return {
    tx: {
      cellDeps: [
        { outPoint: entryLock.outPoint, depType: entryLock.depType },
        { outPoint: configCellOutPoint, depType: "code" },
        // The closed ledger. Without it excluded_membership returns false and
        // the spend is refused with no hint that a dep is missing.
        { outPoint: ledgerCell.outPoint, depType: "code" },
        ...(sponsor ? [sponsor.lockDep] : []),
      ],
      headerDeps: [],
      inputs: [
        {
          previousOutput: entryCell.outPoint,
          since: ABSOLUTE_EPOCH_FLAG | BigInt(nowEpoch),
        },
        ...(sponsor ? [{ previousOutput: sponsor.outPoint, since: 0n }] : []),
      ],
      // Exactly the entry's capacity, as a plain cell. Deducting a fee here
      // would fail with ENTRY_ERROR_REFUND_DESTINATION.
      outputs: [
        { capacity: BigInt(entryCell.capacity), lock: participantLock, type: null },
        ...(sponsor ? [{ capacity: change, lock: sponsor.lock, type: null }] : []),
      ],
      outputsData: sponsor ? ["0x", "0x"] : ["0x"],
      // The proof goes at the ENTRY's input index, which is 0.
      witnesses: [
        "0x" + Array.from(encodeAggregationWitness(proof),
          (x) => x.toString(16).padStart(2, "0")).join(""),
        ...(sponsor ? ["0x"] : []),
      ],
    },
    refunded: BigInt(entryCell.capacity),
    fee,
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

const api = {
  buildRefundTx, isRefundable, refundBlocker, encodeAggregationWitness,
  scriptHash, ABSOLUTE_EPOCH_FLAG,
};
if (typeof module !== "undefined" && module.exports) module.exports = api;
if (typeof window !== "undefined") window.DaowowRefundTx = api;
})();
