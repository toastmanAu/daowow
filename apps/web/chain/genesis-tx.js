"use strict";
// Wrapped in an IIFE: loaded as a classic script these files share one
// global scope, so top-level declarations would collide between modules.
(function () {
// The ledger genesis: a FROZEN shard becomes the AggregationState that batches
// are accepted into.
//
// The frozen shard and the ledger SHARE a type script and its args, so this is
// one script group in which a 101-byte cell becomes a 207-byte one. ledger.rs
// tells them apart by decoding the input data: if it parses as
// EntryShardDataV1 this is the genesis, and the output must equal
// AggregationState::new(cfg, frozen) exactly.
//
// That is also why freeze and genesis CANNOT be one transaction.
// AggregationState::new_bound (lifecycle.rs:99) refuses an input shard whose
// state is not already FROZEN, and only a prior transaction can have set it.
//
// The client computes the genesis state so it can be CHECKED locally, not
// because it is trusted: the contract recomputes it and compares.

const codec = typeof require === "function" ? require("./codec.js") : window.DaowowCodec;
const ledgerCodec =
  typeof require === "function" ? require("./ledger-codec.js") : window.DaowowLedgerCodec;
const core = typeof require === "function" ? require("../core.js") : window.DaowowCore;

const SHARD_STATE_FROZEN = 1;
const CKB = 100000000n;
const FEE_SHANNONS = 10000000n;
const MIN_CELL_CKB = 61n * CKB;

// The ledger cell's occupied capacity, in CKB:
//   8 capacity + 207 data + 34 lock (32 code hash + 1 hash type + 1 arg)
//   + 69 type (32 + 1 + 36 args)
// The shard cell it replaces occupies 212 by the same arithmetic, and
// create-demo-round.mjs mints it at 312 — so the genesis is SIX CKB short of
// its own floor and needs a top-up. Computed rather than assumed, because a
// shard minted with different slack changes the answer.
const LEDGER_CELL_CKB = 8n + 207n + 34n + 69n;

const hex = (b) => "0x" + Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
const unhex = (s) => {
  const body = s.startsWith("0x") ? s.slice(2) : s;
  return Uint8Array.from(body.match(/../g) ?? [], (b) => parseInt(b, 16));
};

/**
 * The AggregationState a freshly consumed frozen shard becomes. Mirrors
 * AggregationState::new_bound (lifecycle.rs:95) including its refusals, so a
 * shard the contract would reject is rejected here with a reason.
 */
function genesisState(config, frozen) {
  if (frozen.state !== SHARD_STATE_FROZEN) {
    throw new Error(
      `the shard must be frozen before a ledger can be created from it ` +
      `(state is ${frozen.state}, not ${SHARD_STATE_FROZEN}); freeze it first — ` +
      "the two cannot be one transaction",
    );
  }
  if (frozen.roundId !== config.roundId) {
    throw new Error("this shard belongs to a different round");
  }
  if (frozen.sequence !== frozen.entryCount) {
    throw new Error(
      `the shard's sequence (${frozen.sequence}) must equal its entry count ` +
      `(${frozen.entryCount})`,
    );
  }
  if (frozen.ticketCount * BigInt(config.ticketPrice) !== frozen.principalTotal) {
    throw new Error(
      "the shard's principal does not equal ticket count times ticket price",
    );
  }
  if ((frozen.entryCount === 0n) !== (frozen.ticketCount === 0n)) {
    throw new Error("entry count and ticket count disagree about emptiness");
  }
  if (frozen.ticketCount < frozen.entryCount) {
    throw new Error("a shard cannot hold fewer tickets than entries");
  }

  // The empty batch ledger root is a specific hash, not zeros.
  const batchesRoot = core.ckbHash256([
    new TextEncoder().encode("DAOWOW_BATCH_LEDGER_EMPTY_V2"),
    unhex(config.commitment),
    core.u32le(Number(frozen.shardId)),
  ]);
  return {
    version: 2,
    frozen: {
      roundId: frozen.roundId, shardId: frozen.shardId, state: frozen.state,
      sequence: frozen.sequence, entryCount: frozen.entryCount,
      ticketCount: frozen.ticketCount, principalTotal: frozen.principalTotal,
      accumulatorRoot: frozen.accumulatorRoot,
    },
    configCommitment: config.commitment,
    acceptedEntries: 0n,
    acceptedTickets: 0n,
    acceptedPrincipal: 0n,
    acceptedCapacity: 0n,
    acceptedBatches: 0n,
    batchesRoot: core.hex(batchesRoot).replace(/^0x/, ""),
    closed: false,
  };
}

function buildLedgerGenesisTx({
  manifest, config, frozenShard, configCellOutPoint, sponsor,
  feeShannons = FEE_SHANNONS,
}) {
  if (!configCellOutPoint || !configCellOutPoint.txHash) {
    throw new Error("the round config cell out point is required as a cell dep");
  }
  // The SPONSOR'S OWN LOCK needs a dep too. A lock runs when its cell is
  // spent, and the node wants that lock's code as an explicit cell dep even
  // when nothing else about it is interesting — omitting it is ScriptNotFound
  // on that input at broadcast. This cost two signing rounds on the round
  // creation transaction and is required here rather than resolved, so a
  // caller cannot forget it.
  if (!sponsor.lockDep || !sponsor.lockDep.outPoint) {
    throw new Error(
      "the sponsor's lock cell dep is required (sponsor.lockDep); without it " +
      "the node refuses the transaction with ScriptNotFound on that input",
    );
  }
  const shardScript = manifest.scripts["entry-shard-type"];
  const entryLock = manifest.scripts["entry-lock"];

  // ledger.rs:26 no_entry_inputs. Genesis and acceptance are separate
  // transactions by construction, and this is the rule that makes them so.
  if (sponsor.lock && sponsor.lock.codeHash === entryLock.codeHash) {
    throw new Error(
      "the genesis transaction must carry no entry-lock inputs; an entry cell " +
      "here is refused (no_entry_inputs)",
    );
  }

  const state = genesisState(config, frozenShard);

  const commitmentBytes = unhex(config.commitment);
  const typeArgs = hex(new Uint8Array(
    [...commitmentBytes, ...core.u32le(Number(frozenShard.shardId))]));
  if (frozenShard.typeArgs &&
      frozenShard.typeArgs.toLowerCase() !== typeArgs.toLowerCase()) {
    throw new Error(
      "this shard cell does not belong to this round: its type args are " +
      `${frozenShard.typeArgs} and the round's config commits to ${typeArgs}`,
    );
  }

  // Both bounds, and the larger wins: the cell's own occupied floor, and
  // ledger.rs:54's independent out_cap >= in_cap.
  const floor = LEDGER_CELL_CKB * CKB;
  const inCap = BigInt(frozenShard.capacity);
  const ledgerCapacity = floor > inCap ? floor : inCap;
  const topUp = ledgerCapacity - inCap;

  const change = BigInt(sponsor.capacity) - topUp - BigInt(feeShannons);
  if (change < MIN_CELL_CKB) {
    throw new Error(
      `the sponsor holds ${BigInt(sponsor.capacity) / CKB} CKB, which cannot ` +
      `cover the ${topUp / CKB} CKB ledger top-up plus the fee and still leave ` +
      "a change cell above the 61 CKB floor",
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
        // The ledger's predecessor at index 0, matching every other lifecycle
        // transaction so the witness layout is predictable.
        { previousOutput: frozenShard.outPoint, since: 0n },
        { previousOutput: sponsor.outPoint, since: 0n },
      ],
      outputs: [
        {
          capacity: ledgerCapacity,
          lock: {
            codeHash: shardScript.codeHash, hashType: shardScript.hashType, args: "0x00",
          },
          type: {
            codeHash: shardScript.codeHash, hashType: shardScript.hashType, args: typeArgs,
          },
        },
        { capacity: change, lock: sponsor.lock, type: null },
      ],
      outputsData: [hex(ledgerCodec.encodeAggregationState(state)), "0x"],
      witnesses: ["0x", "0x"],
    },
    expectedLedger: state,
    topUp,
    fee: BigInt(feeShannons),
  };
}

const api = { buildLedgerGenesisTx, genesisState, LEDGER_CELL_CKB, FEE_SHANNONS };
if (typeof module !== "undefined" && module.exports) module.exports = api;
if (typeof window !== "undefined") window.DaowowGenesisTx = api;
})();
