"use strict";
// Wrapped in an IIFE: loaded as a classic script these files share one
// global scope, so top-level declarations would collide between modules.
(function () {
// Sealing the round: the CLOSED ledger of shard zero becomes the RoundSeal.
//
// Rules from contracts/entry-shard-type/src/seal.rs. The input is shard zero's
// closed ledger — args[32..] must be zero, and the input data must be exactly a
// ledger's size so a seal cannot re-seal itself. The output carries EVERY
// shard's closed ledger; the others arrive as cell deps. No entry inputs,
// public lock on both sides, out_cap >= in_cap.
//
// The contract re-derives the seal and compares, so the client computes
// nothing it is trusted on. It computes it anyway, to refuse locally what the
// chain would refuse as an unexplained SHARD_ERROR_DATA.

const sealCodec = () =>
  typeof require === "function" ? require("./seal-codec.js") : window.DaowowSealCodec;
const core = () => typeof require === "function" ? require("../core.js") : window.DaowowCore;

const CKB = 100000000n;
const FEE_SHANNONS = 10000000n;
const MIN_CELL_CKB = 61n * CKB;

// The seal cell's occupied capacity at one shard, in CKB:
//   8 capacity + 212 data + 34 lock (32 + 1 + 1) + 69 type (32 + 1 + 36)
// Against the ledger's 318 this is a 5 CKB top-up — the second lifecycle step,
// after genesis, to grow its own cell.
const SEAL_CELL_CKB = 8n + 212n + 34n + 69n;

const hex0x = (b) => "0x" + Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
const unhex = (s) => {
  const body = s.startsWith("0x") ? s.slice(2) : s;
  return Uint8Array.from(body.match(/../g) ?? [], (b) => parseInt(b, 16));
};

/**
 * The seal a set of closed ledgers becomes. Mirrors RoundSeal::new
 * (seal.rs:85), refusals included.
 */
function sealOf(config, ledgers) {
  if (ledgers.length !== Number(config.entryShardCount)) {
    throw new Error(
      `a round of ${config.entryShardCount} shard(s) needs every other shard's ` +
      `closed ledger as a cell dep; ${ledgers.length} supplied`,
    );
  }
  ledgers.forEach((ledger, id) => {
    if (ledger.configCommitment !== config.commitment) {
      throw new Error(`the ledger for shard ${id} belongs to a different round config`);
    }
    if (!ledger.closed) {
      throw new Error(
        `the ledger for shard ${id} is still open; only a closed ledger can be ` +
        "sealed, because closing is what fixes the accepted prefix",
      );
    }
    if (Number(ledger.frozen.shardId) !== id) {
      throw new Error(`ledger ${id} names shard ${ledger.frozen.shardId}; they must be in order`);
    }
  });
  return { version: 3, ledgers };
}

function buildSealTx({
  manifest, config, ledger, otherLedgers = [], configCellOutPoint, sponsor,
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
  if (sponsor.lock && sponsor.lock.codeHash === entryLock.codeHash) {
    throw new Error("the sealing transaction must carry no entry-lock inputs (no_entry_inputs)");
  }

  const state = ledger.state;
  // seal.rs:17: args[32..] must be zero. Shard zero carries the seal for the
  // whole round; every other shard's ledger is a cell dep.
  if (Number(state.frozen.shardId) !== 0) {
    throw new Error(
      `only shard zero's ledger can become the seal; this is shard ${state.frozen.shardId}`,
    );
  }

  const commitmentBytes = unhex(config.commitment);
  const typeArgs = hex0x(new Uint8Array([...commitmentBytes, ...core().u32le(0)]));
  if (ledger.typeArgs && ledger.typeArgs.toLowerCase() !== typeArgs.toLowerCase()) {
    throw new Error(
      "this ledger cell does not belong to this round: its type args are " +
      `${ledger.typeArgs} and the round's config commits to ${typeArgs}`,
    );
  }

  const ledgers = [state, ...otherLedgers.map((l) => l.state)];
  const seal = sealOf(config, ledgers);
  const sealBytes = sealCodec().encodeRoundSeal(seal);

  // Both bounds, the larger wins: the cell's own floor, and seal.rs's
  // independent out_cap >= in_cap.
  const floor = (8n + BigInt(sealBytes.length) + 34n + 69n) * CKB;
  const inCap = BigInt(ledger.capacity);
  const sealCapacity = floor > inCap ? floor : inCap;
  const topUp = sealCapacity - inCap;

  const change = BigInt(sponsor.capacity) - topUp - BigInt(feeShannons);
  if (change < MIN_CELL_CKB) {
    throw new Error(
      `the sponsor holds ${BigInt(sponsor.capacity) / CKB} CKB, which cannot cover ` +
      `the ${topUp / CKB} CKB seal top-up plus the fee and leave a change cell ` +
      "above the 61 CKB floor",
    );
  }

  const publicLock = {
    codeHash: shardScript.codeHash, hashType: shardScript.hashType, args: "0x00",
  };
  return {
    tx: {
      cellDeps: [
        { outPoint: shardScript.outPoint, depType: shardScript.depType },
        { outPoint: configCellOutPoint, depType: "code" },
        // Every other shard's closed ledger. Empty for the one-shard beta.
        ...otherLedgers.map((l) => ({ outPoint: l.outPoint, depType: "code" })),
        sponsor.lockDep,
      ],
      headerDeps: [],
      inputs: [
        { previousOutput: ledger.outPoint, since: 0n },
        { previousOutput: sponsor.outPoint, since: 0n },
      ],
      outputs: [
        {
          capacity: sealCapacity,
          lock: publicLock,
          type: {
            codeHash: shardScript.codeHash, hashType: shardScript.hashType, args: typeArgs,
          },
        },
        { capacity: change, lock: sponsor.lock, type: null },
      ],
      outputsData: [hex0x(sealBytes), "0x"],
      witnesses: ["0x", "0x"],
    },
    expectedSeal: seal,
    topUp,
    fee: BigInt(feeShannons),
  };
}

const api = { buildSealTx, sealOf, SEAL_CELL_CKB, FEE_SHANNONS };
if (typeof module !== "undefined" && module.exports) module.exports = api;
if (typeof window !== "undefined") window.DaowowSealTx = api;
})();
