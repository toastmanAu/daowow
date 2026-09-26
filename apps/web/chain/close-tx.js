"use strict";
// Wrapped in an IIFE: loaded as a classic script these files share one
// global scope, so top-level declarations would collide between modules.
(function () {
// Closing the aggregation ledger.
//
// The step that was missing from the gate 3a plan, and it is not optional
// bookkeeping: an entry can only be REFUNDED once the ledger is closed.
// entry-lock's refund branch calls excluded_membership, which returns false
// unless a canonical ledger cell is a cell dep AND `state.is_closed()` AND the
// entry's nonce sits at or beyond the accepted prefix. So without this
// transaction an unaccepted entry's capacity is stranded — the aggregation
// deadline passing is necessary and nowhere near sufficient.
//
// Closing fixes the accepted prefix permanently: `close` sets one boolean and
// changes nothing else, and no entry beyond that prefix can ever become a draw
// participant afterwards.

const ledgerCodec =
  typeof require === "function" ? require("./ledger-codec.js") : window.DaowowLedgerCodec;
const core = typeof require === "function" ? require("../core.js") : window.DaowowCore;

const ABSOLUTE_EPOCH_FLAG = 0x2000000000000000n;
const CKB = 100000000n;
const FEE_SHANNONS = 10000000n;
const MIN_CELL_CKB = 61n * CKB;

const hex0x = (b) => "0x" + Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
const unhex = (s) => {
  const body = s.startsWith("0x") ? s.slice(2) : s;
  return Uint8Array.from(body.match(/../g) ?? [], (b) => parseInt(b, 16));
};

/**
 * The epoch from which this ledger may be closed (lifecycle.rs:341).
 *
 * TWO different deadlines, and the distinction is deliberate rather than
 * incidental: a ledger that has accepted EVERY entry has nothing left to wait
 * for, so it may close from `entry_end`. One that has not must wait for
 * `aggregation_deadline`, because until then a keeper might still take the
 * entries it skipped.
 */
function closableFrom(config, state) {
  return state.acceptedEntries === state.frozen.entryCount
    ? config.entryEnd
    : config.aggregationDeadline;
}

/** Mirrors AggregationState::close (lifecycle.rs:338), refusals included. */
function closedState(config, state, nowEpoch) {
  if (state.closed) {
    throw new Error("this ledger is already closed");
  }
  if (config.commitment !== state.configCommitment) {
    throw new Error("the ledger was created against a different round config");
  }
  const from = closableFrom(config, state);
  if (BigInt(nowEpoch) < from) {
    const why = state.acceptedEntries === state.frozen.entryCount
      ? "every entry is accepted, so entry_end governs"
      : `${state.frozen.entryCount - state.acceptedEntries} entr(ies) are still ` +
        "unaccepted, so the aggregation deadline governs";
    throw new Error(
      `this ledger cannot be closed until epoch ${from} (${why}); it is epoch ${nowEpoch}`,
    );
  }
  // One boolean. Everything else is preserved, which is what makes the
  // accepted prefix permanent.
  return { ...state, closed: true };
}

function buildCloseTx({
  manifest, config, ledger, nowEpoch, configCellOutPoint, sponsor,
  feeShannons = FEE_SHANNONS,
}) {
  if (!configCellOutPoint || !configCellOutPoint.txHash) {
    throw new Error("the round config cell out point is required as a cell dep");
  }
  if (!sponsor.lockDep || !sponsor.lockDep.outPoint) {
    throw new Error(
      "the sponsor's lock cell dep is required (sponsor.lockDep); without it " +
      "the node refuses the transaction with ScriptNotFound on that input",
    );
  }
  const shardScript = manifest.scripts["entry-shard-type"];
  const entryLock = manifest.scripts["entry-lock"];
  // The closing transaction carries no entry cells: ledger.rs checks
  // no_entry_inputs on this branch too, so closing and accepting cannot be
  // combined any more than genesis and accepting can.
  if (sponsor.lock && sponsor.lock.codeHash === entryLock.codeHash) {
    throw new Error(
      "the closing transaction must carry no entry-lock inputs (no_entry_inputs)",
    );
  }

  const state = ledger.state;
  const after = closedState(config, state, nowEpoch);
  const from = closableFrom(config, state);

  const commitmentBytes = unhex(config.commitment);
  const typeArgs = hex0x(new Uint8Array(
    [...commitmentBytes, ...core.u32le(Number(state.frozen.shardId))]));
  if (ledger.typeArgs && ledger.typeArgs.toLowerCase() !== typeArgs.toLowerCase()) {
    throw new Error(
      "this ledger cell does not belong to this round: its type args are " +
      `${ledger.typeArgs} and the round's config commits to ${typeArgs}`,
    );
  }

  const change = BigInt(sponsor.capacity) - BigInt(feeShannons);
  if (change < MIN_CELL_CKB) {
    throw new Error(
      `the sponsor holds ${BigInt(sponsor.capacity) / CKB} CKB, which cannot ` +
      "cover the fee and leave a change cell above the 61 CKB floor",
    );
  }

  return {
    tx: {
      cellDeps: [
        { outPoint: shardScript.outPoint, depType: shardScript.depType },
        { outPoint: configCellOutPoint, depType: "code" },
        sponsor.lockDep,
      ],
      headerDeps: [],
      inputs: [
        // The since is what the contract reads to decide whether closing is
        // permitted, so it names the epoch that authorises it rather than the
        // current one.
        { previousOutput: ledger.outPoint, since: ABSOLUTE_EPOCH_FLAG | BigInt(nowEpoch) },
        { previousOutput: sponsor.outPoint, since: 0n },
      ],
      outputs: [
        {
          capacity: BigInt(ledger.capacity),
          lock: {
            codeHash: shardScript.codeHash, hashType: shardScript.hashType, args: "0x00",
          },
          type: {
            codeHash: shardScript.codeHash, hashType: shardScript.hashType, args: typeArgs,
          },
        },
        { capacity: change, lock: sponsor.lock, type: null },
      ],
      outputsData: [hex0x(ledgerCodec.encodeAggregationState(after)), "0x"],
      witnesses: ["0x", "0x"],
    },
    expectedLedgerAfter: after,
    closableFrom: from,
    fee: BigInt(feeShannons),
  };
}

const api = { buildCloseTx, closedState, closableFrom, ABSOLUTE_EPOCH_FLAG };
if (typeof module !== "undefined" && module.exports) module.exports = api;
if (typeof window !== "undefined") window.DaowowCloseTx = api;
})();
