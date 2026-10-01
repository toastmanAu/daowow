"use strict";
// Wrapped in an IIFE: loaded as a classic script these files share one
// global scope, so top-level declarations would collide between modules.
(function () {
// Entropy finalisation: the seal becomes an EntropyRecord that fixes the draw.
//
// Rules from contracts/entry-shard-type/src/entropy.rs. There is no reveal
// transaction and no operator-chosen seed: the draw falls out of four block
// hashes fixed before anyone could know them — the seal's own inclusion block
// and the blocks 64, 128 and 192 after it.
//
// Two rules here have NO PRECEDENT elsewhere in this protocol, and both fail
// on chain with codes that say nothing about the cause:
//
//   1. THE SINCE IS A RELATIVE BLOCK NUMBER. entropy.rs:52 requires the top
//      byte to be exactly 0x80 and the low bits >= 256. Every other since in
//      DAOWOW is an absolute epoch with 0x20; reaching for the familiar form
//      fails as SHARD_ERROR_STATE.
//   2. EXACTLY FOUR HEADER DEPS, in order. A fifth is refused outright
//      (entropy.rs:72 requires load_header(4, HeaderDep) to be out of bounds).
//
// The record cell is 349 bytes against the seal's 212, so it occupies 460 CKB
// against 323 — a 137 CKB top-up, more than genesis and seal combined. That
// was not in the plan as first written; the Rust vector exposed it.

const sealCodec = () =>
  typeof require === "function" ? require("./seal-codec.js") : window.DaowowSealCodec;
const core = () => typeof require === "function" ? require("../core.js") : window.DaowowCore;

const CKB = 100000000n;
const FEE_SHANNONS = 10000000n;
const MIN_CELL_CKB = 61n * CKB;

// RFC 0017: bit 63 is the relative flag and bits 61-62 select the metric, 00
// being block number. So 0x80 in the top byte is "relative, in blocks".
const RELATIVE_BLOCK_FLAG = 0x8000000000000000n;
const MIN_RELATIVE_BLOCKS = 256n;

// 8 + 349 + 34 + 69 at one shard.
const RECORD_CELL_CKB = 8n + 349n + 34n + 69n;

const hex0x = (b) => "0x" + Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
const unhex = (s) => {
  const body = s.startsWith("0x") ? s.slice(2) : s;
  return Uint8Array.from(body.match(/../g) ?? [], (b) => parseInt(b, 16));
};
const stripped = (h) => String(h).replace(/^0x/, "").toLowerCase();

/**
 * The three entropy heights, then the earliest height the finalising
 * transaction can be sent at (seal.rs:159). BigInt throughout: heights past
 * 2^53 would round silently as Numbers.
 */
function entropyHeights(inclusionHeight) {
  const h = BigInt(inclusionHeight);
  return [h + 64n, h + 128n, h + 192n, h + 256n];
}

/**
 * A relative-block-number since. The flag and the >= 256 bound are ONE `if`
 * in the contract and two guards here, so each can be pinned without the
 * other hiding it.
 */
function relativeBlockSince(blocks) {
  const n = BigInt(blocks);
  if (n < MIN_RELATIVE_BLOCKS) {
    throw new Error(
      `the entropy since must be at least 256 blocks after the seal; ${n} is ` +
      "too few, and the contract refuses it",
    );
  }
  return RELATIVE_BLOCK_FLAG | n;
}

function buildEntropyTx({
  manifest, config, sealCell, inclusionHeader, entropyHeaders,
  configCellOutPoint, sponsor, feeShannons = FEE_SHANNONS,
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
    throw new Error("the entropy transaction must carry no entry-lock inputs (no_entry_inputs)");
  }

  // entropy.rs:31 — the input must be a SEAL. A ledger or a record here is a
  // different lifecycle step.
  const sealBytes = unhex(sealCell.data);
  if (sealBytes[0] !== sealCodec().SEAL_VERSION) {
    throw new Error(
      `the input cell is not a seal (first byte ${sealBytes[0]}, expected ` +
      `${sealCodec().SEAL_VERSION}); seal the closed ledger first`,
    );
  }
  const seal = sealCodec().decodeRoundSeal(sealBytes, config.entryShardCount);

  const commitmentBytes = unhex(config.commitment);
  const typeArgs = hex0x(new Uint8Array([...commitmentBytes, ...core().u32le(0)]));
  if (sealCell.typeArgs && sealCell.typeArgs.toLowerCase() !== typeArgs.toLowerCase()) {
    throw new Error(
      "this seal cell does not belong to this round: its type args are " +
      `${sealCell.typeArgs} and the round's config commits to ${typeArgs}`,
    );
  }

  if (!Array.isArray(entropyHeaders) || entropyHeaders.length !== 3) {
    throw new Error(
      "exactly three entropy headers are required — the blocks at +64, +128 and " +
      "+192 — alongside the seal's own inclusion header",
    );
  }
  const inclusionHeight = BigInt(inclusionHeader.number);
  const [h64, h128, h192, earliest] = entropyHeights(inclusionHeight);
  // Checked by NUMBER, slot by slot, because the contract checks each header
  // dep's number against the schedule and a swapped pair fails on chain as an
  // unexplained SHARD_ERROR_DATA.
  [[h64, "+64"], [h128, "+128"], [h192, "+192"]].forEach(([want, label], i) => {
    const got = BigInt(entropyHeaders[i].number);
    if (got !== want) {
      throw new Error(
        `entropy header ${i + 1} must be the block at ${label} (height ${want}); ` +
        `got height ${got}`,
      );
    }
  });

  const record = {
    version: sealCodec().RECORD_VERSION,
    seal,
    inclusionHeight,
    inclusionHash: stripped(inclusionHeader.hash),
    // The HEADER HASHES of the scheduled blocks, which is what the contract
    // computes with calc_header_hash. A header hash is the node's to report, so
    // these are taken as supplied rather than recomputed locally.
    entropyHashes: entropyHeaders.map((h) => stripped(h.hash)),
  };
  const recordBytes = sealCodec().encodeEntropyRecord(record);

  const floor = (8n + BigInt(recordBytes.length) + 34n + 69n) * CKB;
  const inCap = BigInt(sealCell.capacity);
  const recordCapacity = floor > inCap ? floor : inCap;
  const topUp = recordCapacity - inCap;

  const change = BigInt(sponsor.capacity) - topUp - BigInt(feeShannons);
  if (change < MIN_CELL_CKB) {
    throw new Error(
      `the sponsor holds ${BigInt(sponsor.capacity) / CKB} CKB, which cannot cover ` +
      `the ${topUp / CKB} CKB record top-up plus the fee and leave a change cell ` +
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
        sponsor.lockDep,
      ],
      // EXACTLY four, in this order. A fifth is refused.
      headerDeps: [inclusionHeader.hash, ...entropyHeaders.map((h) => h.hash)],
      inputs: [
        // The seal must be at least 256 blocks deep. That is the binding wait:
        // the +192 header exists before this is satisfied.
        { previousOutput: sealCell.outPoint, since: relativeBlockSince(MIN_RELATIVE_BLOCKS) },
        { previousOutput: sponsor.outPoint, since: 0n },
      ],
      outputs: [
        {
          capacity: recordCapacity,
          lock: publicLock,
          type: {
            codeHash: shardScript.codeHash, hashType: shardScript.hashType, args: typeArgs,
          },
        },
        { capacity: change, lock: sponsor.lock, type: null },
      ],
      outputsData: [hex0x(recordBytes), "0x"],
      witnesses: ["0x", "0x"],
    },
    expectedRecord: record,
    earliestHeight: earliest,
    topUp,
    fee: BigInt(feeShannons),
  };
}

const api = {
  buildEntropyTx, entropyHeights, relativeBlockSince,
  RELATIVE_BLOCK_FLAG, MIN_RELATIVE_BLOCKS, RECORD_CELL_CKB, FEE_SHANNONS,
};
if (typeof module !== "undefined" && module.exports) module.exports = api;
if (typeof window !== "undefined") window.DaowowEntropyTx = api;
})();
