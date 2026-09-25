"use strict";
// Wrapped in an IIFE: loaded as a classic script these files share one
// global scope, so top-level declarations would collide between modules.
(function () {
// TX-03 Freeze Shard.
//
// The simplest transaction in the protocol and the gate on every later step:
// nothing can aggregate a shard that is still OPEN, because
// AggregationState::new_bound (lifecycle.rs:99) refuses an input whose state is
// not already FROZEN. That is also why freeze and the ledger genesis CANNOT be
// one transaction — see the gate 3a spec.
//
// Permissionless after the deadline, so whoever pays the fee may do it.
//
// Pure: takes a described chain state, returns a transaction description. No
// CCC, no node, no signing.

const codec = typeof require === "function" ? require("./codec.js") : window.DaowowCodec;
const core = typeof require === "function" ? require("../core.js") : window.DaowowCore;

// RFC 0017: the top byte selects the since metric. Without 0x20 the node reads
// the value as a BLOCK NUMBER, and any plausible epoch number is a block long
// past — the shard would freeze immediately, whatever the entry window says.
const ABSOLUTE_EPOCH_FLAG = 0x2000000000000000n;

const SHARD_STATE_OPEN = 0;
const SHARD_STATE_FROZEN = 1;
const FEE_SHANNONS = 10000000n;   // 0.1 CKB, this repository's convention
const MIN_CELL_CKB = 61n * 100000000n;

const hex = (b) => "0x" + Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
const unhex = (s) => {
  const body = s.startsWith("0x") ? s.slice(2) : s;
  return Uint8Array.from(body.match(/../g) ?? [], (b) => parseInt(b, 16));
};

/**
 * Build the freeze transaction.
 *
 * `shard` is a discovery shard: the decoded EntryShardDataV1 fields plus
 * outPoint, capacity and typeArgs. `sponsor` is a plain cell that pays the fee
 * and receives the change.
 */
function buildFreezeTx({
  manifest, config, shard, nowEpoch, configCellOutPoint, sponsor,
  feeShannons = FEE_SHANNONS,
}) {
  if (shard.state !== SHARD_STATE_OPEN) {
    throw new Error(
      `this shard is already frozen (state ${shard.state}); only an OPEN shard ` +
      "can be frozen",
    );
  }
  // absolute_epoch_at_least(since, cfg.entry_end) — inclusive, so freezing AT
  // entry_end is permitted. A `since` below it is refused on chain as
  // SHARD_ERROR_FROZEN with no indication that timing was the problem.
  const epoch = BigInt(nowEpoch);
  if (epoch < config.entryEnd) {
    throw new Error(
      `the entry window closes at epoch ${config.entryEnd} (entry_end) and it ` +
      `is epoch ${epoch}; a shard cannot be frozen before then`,
    );
  }
  if (!configCellOutPoint || !configCellOutPoint.txHash) {
    throw new Error("the round config cell out point is required as a cell dep");
  }

  const shardScript = manifest.scripts["entry-shard-type"];
  const commitmentBytes = unhex(config.commitment);
  // Derived from the CONFIG, not copied from the head, so the two can disagree
  // — and if they do the head's type script appears in the inputs and vanishes
  // from the outputs, which the contract reports as BadState without saying why.
  const typeArgs = hex(new Uint8Array(
    [...commitmentBytes, ...core.u32le(Number(shard.shardId))]));
  if (shard.typeArgs && shard.typeArgs.toLowerCase() !== typeArgs.toLowerCase()) {
    throw new Error(
      "this shard cell does not belong to this round: its type args are " +
      `${shard.typeArgs} and the round's config commits to ${typeArgs}`,
    );
  }

  // validate_freeze (shard.rs:132) requires every other field to be identical.
  const after = {
    roundId: shard.roundId,
    shardId: shard.shardId,
    state: SHARD_STATE_FROZEN,
    sequence: shard.sequence,
    entryCount: shard.entryCount,
    ticketCount: shard.ticketCount,
    principalTotal: shard.principalTotal,
    accumulatorRoot: shard.accumulatorRoot,
  };

  const change = BigInt(sponsor.capacity) - BigInt(feeShannons);
  if (change < MIN_CELL_CKB) {
    throw new Error(
      `the sponsor holds ${BigInt(sponsor.capacity) / 100000000n} CKB, which ` +
      `cannot cover the ${feeShannons} shannon fee and leave a change cell ` +
      "above the 61 CKB floor",
    );
  }

  return {
    tx: {
      cellDeps: [
        // The shard's type AND its public lock are both entry-shard-type, so
        // one dep serves both scripts.
        { outPoint: shardScript.outPoint, depType: shardScript.depType },
        { outPoint: configCellOutPoint, depType: "code" },
      ],
      headerDeps: [],
      inputs: [
        { previousOutput: shard.outPoint, since: ABSOLUTE_EPOCH_FLAG | epoch },
        { previousOutput: sponsor.outPoint, since: 0n },
      ],
      outputs: [
        {
          capacity: BigInt(shard.capacity),
          lock: {
            codeHash: shardScript.codeHash, hashType: shardScript.hashType, args: "0x00",
          },
          type: {
            codeHash: shardScript.codeHash, hashType: shardScript.hashType, args: typeArgs,
          },
        },
        { capacity: change, lock: sponsor.lock, type: null },
      ],
      outputsData: [hex(codec.encodeEntryShardDataV1(after)), "0x"],
      // No claim cells and nothing to prove: the freeze arm reads no witness.
      // The slots exist so witnesses.length equals inputs.length before the
      // wallet funds anything, which is the splice invariant.
      witnesses: ["0x", "0x"],
    },
    expectedShardAfter: after,
    fee: BigInt(feeShannons),
  };
}

const api = { buildFreezeTx, ABSOLUTE_EPOCH_FLAG, FEE_SHANNONS };
if (typeof module !== "undefined" && module.exports) module.exports = api;
if (typeof window !== "undefined") window.DaowowFreezeTx = api;
})();
