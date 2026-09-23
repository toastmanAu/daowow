"use strict";
// Wrapped in an IIFE: loaded as a classic script these files share one
// global scope, so top-level declarations would collide between modules.
(function () {
// TX-02: enter the round.
//
// Deliberately PURE. It returns a plain transaction description — no CCC, no
// network — so the shape can be tested exhaustively in node. The signing
// adapter converts it and lets the wallet complete fees and add its own lock's
// cell deps.
//
// The shape, from docs/transaction-templates.md:
//   inputs   0  the OPEN shard head, spent with an absolute-epoch `since`
//            1+ the entrant's funding (added by the signing adapter)
//   outputs  0  the shard successor, counters and root advanced
//            1  the entry cell, principal plus its overhead, under entry-lock
//            2..N one claim per ticket, under the entrant's own lock
//            N+1 change (added by the signing adapter)
//   witness  0  the accumulator append witness

const codec = typeof require === "function" ? require("./codec.js") : window.DaowowCodec;
const entryCodec =
  typeof require === "function" ? require("./entry-codec.js") : window.DaowowEntryCodec;
const mmr =
  typeof require === "function" ? require("./mmr-witness.js") : window.DaowowMmrWitness;
const quote = typeof require === "function" ? require("./quote.js") : window.DaowowQuote;
const core = typeof require === "function" ? require("../core.js") : window.DaowowCore;

// RFC-0017: `since` is an absolute EPOCH number only when its top byte is
// exactly 0x20. A bare block number is not read as an epoch — it is refused
// with SHARD_ERROR_NOT_OPEN (-39).
const ABSOLUTE_EPOCH_FLAG = 0x2000000000000000n;

const popcount = (value) => {
  let n = BigInt(value);
  let bits = 0;
  while (n > 0n) { bits += Number(n & 1n); n >>= 1n; }
  return bits;
};

// Rebuild a shard's accumulator peaks by replaying its entries in order. The
// chain commits only to the root, so this is the only way to obtain the peak
// list an append witness must carry.
function derivePeaks(entriesInOrder) {
  const host = new core.MmrHost();
  for (const entry of entriesInOrder) host.append(core.entryLeaf(entry));
  return host.peaks.map((peak) =>
    Array.from(peak, (x) => x.toString(16).padStart(2, "0")).join(""));
}

const hex = (b) => "0x" + Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
const unhex = (s) => {
  const body = s.startsWith("0x") ? s.slice(2) : s;
  return Uint8Array.from(body.match(/../g).map((b) => parseInt(b, 16)));
};

function buildEntryTx({
  manifest, config, schedule, shard, lock, participantLockHash, tickets,
  nowEpoch, entropyCommitment, configCellOutPoint,
}) {
  const n = BigInt(tickets);
  if (config.maximumTickets !== 0n && shard.ticketCount + n > config.maximumTickets) {
    throw new Error("that would take the round past its cap");
  }
  if (BigInt(nowEpoch) < config.entryStart) {
    throw new Error(`the round opens at epoch ${config.entryStart} (entry_start)`);
  }

  const shardScript = manifest.scripts["entry-shard-type"];
  const entryLock = manifest.scripts["entry-lock"];
  const commitmentBytes = unhex(config.commitment);

  // One entry covering every ticket. `position_base` continues from the
  // shard's current ticket count, and `entry_nonce` must equal
  // first_nonce_in_tx + index (shard.rs:46) — with one entry that is the
  // shard's current entry_count.
  const entry = {
    roundId: unhex(config.roundId),
    shardId: Number(shard.shardId),
    participantLockHash: unhex(participantLockHash),
    ticketCount: n,
    principal: n * BigInt(config.ticketPrice),
    positionBase: shard.ticketCount,
    entryNonce: shard.entryCount,
    entropyCommitment: entropyCommitment
      ? unhex(entropyCommitment)
      : new Uint8Array(32),
  };

  // The append, replayed locally so the successor's root is the one the
  // contract will derive from the peaks in the witness.
  //
  // THE PEAKS ARE NOT ON CHAIN. A shard cell commits only to its accumulator
  // ROOT, so an entrant appending to a shard that already holds entries must
  // rebuild the peak list by replaying every prior entry of that shard — see
  // derivePeaks below. This is the real client-side cost of the accumulator,
  // and it is cheap for MMR (at most 64 peaks, and the replay is a hash per
  // entry) where the SMT equivalent would be a proof path per entry.
  const host = new core.MmrHost();
  const suppliedPeaks = shard.peaks ?? [];
  const expectedPeaks = popcount(shard.entryCount);
  if (suppliedPeaks.length !== expectedPeaks) {
    throw new Error(
      `this shard holds ${shard.entryCount} entries, so it needs ` +
      `${expectedPeaks} accumulator peak(s) and ${suppliedPeaks.length} were given; ` +
      `rebuild them with derivePeaks over the shard's prior entries`,
    );
  }
  for (const peak of suppliedPeaks) host.peaks.push(unhex(peak));
  host.count = Number(shard.entryCount);
  // A supplied peak list that does not bag to the shard's committed root is
  // wrong, and the contract would refuse it with an opaque -33. Say so here.
  if (expectedPeaks > 0) {
    const bagged = hex(core.MMR.bagPeaks(host.peaks)).slice(2);
    if (bagged !== shard.accumulatorRoot) {
      throw new Error(
        "the supplied peaks do not match the shard's committed accumulator root",
      );
    }
  }
  const oldPeaks = mmr.encodePeaks(host.peaks);
  host.append(core.entryLeaf(entry));
  const newPeaks = mmr.encodePeaks(host.peaks);

  const after = {
    roundId: config.roundId,
    shardId: shard.shardId,
    state: shard.state,
    sequence: shard.sequence + 1n,
    entryCount: shard.entryCount + 1n,
    ticketCount: shard.ticketCount + n,
    principalTotal: shard.principalTotal + entry.principal,
    accumulatorRoot: hex(host.root()).slice(2),
  };

  const outputs = [];
  const outputsData = [];

  // 0: the shard successor, keeping its own type script and public lock.
  //
  // The args are derived from the CONFIG, not copied from the head. That is
  // deliberate — the config is the authenticated source — but it means the two
  // can disagree, and if they do the head's type script appears in the inputs
  // and vanishes from the outputs, which the contract reports as BadState
  // without saying why. When the head tells us its own args, check them.
  const successorTypeArgs = hex(new Uint8Array(
    [...commitmentBytes, ...core.u32le(Number(shard.shardId))]));
  if (shard.typeArgs && shard.typeArgs.toLowerCase() !== successorTypeArgs.toLowerCase()) {
    throw new Error(
      "this shard cell does not belong to this round: its type args are " +
      `${shard.typeArgs} and the round's config commits to ${successorTypeArgs}`,
    );
  }
  outputs.push({
    capacity: shard.capacity,
    lock: { codeHash: shardScript.codeHash, hashType: shardScript.hashType, args: "0x00" },
    type: {
      codeHash: shardScript.codeHash,
      hashType: shardScript.hashType,
      args: successorTypeArgs,
    },
  });
  outputsData.push(hex(codec.encodeEntryShardDataV1(after)).slice(2));

  // 1: the entry cell. entry-lock args are the participant's lock hash then
  // the config commitment, which is how a refund proves its destination.
  outputs.push({
    capacity: quote.entryCellCapacity(entry.principal),
    lock: {
      codeHash: entryLock.codeHash,
      hashType: entryLock.hashType,
      args: hex(new Uint8Array([...unhex(participantLockHash), ...commitmentBytes])),
    },
    type: null,
  });
  outputsData.push(hex(codec.encodeEntryShardDataV1 && entryCodec.encodeEntryDataV1(entry)).slice(2));

  // 2..N: one claim per ticket, locked to the entrant.
  const claims = [];
  const claimCapacity = quote.claimCellCapacity(lock);
  for (let i = 0n; i < n; i++) {
    const position = shard.ticketCount + i;
    const args = { commitment: commitmentBytes, shardId: Number(shard.shardId), position };
    claims.push({ position, ticketId: hex(entryCodec.ticketId(commitmentBytes, shard.shardId, position)) });
    outputs.push({
      capacity: claimCapacity,
      lock,
      type: {
        codeHash: shardScript.codeHash,
        hashType: shardScript.hashType,
        args: hex(entryCodec.encodeClaimArgs(args)),
      },
    });
    outputsData.push(hex(entryCodec.initialClaimState(args)).slice(2));
  }

  // Every script that RUNS needs its code cell as a dep: the shard's type,
  // the shard's lock and every claim's type are all entry-shard-type. The
  // entrant's own lock dep is added by the signing adapter, which is the only
  // part that knows which wallet signed. A missing dep is ScriptNotFound at
  // broadcast and nothing local can catch it.
  if (!configCellOutPoint || !configCellOutPoint.txHash) {
    // Not optional: the contract reads the authenticated round config from a
    // cell dep, and without it every append is refused. Making this optional
    // would move a guaranteed broadcast failure into a silent omission.
    throw new Error("the round config cell out point is required as a cell dep");
  }
  const cellDeps = [
    { outPoint: shardScript.outPoint, depType: shardScript.depType },
    { outPoint: configCellOutPoint, depType: "code" },
  ];

  return {
    tx: {
      cellDeps,
      headerDeps: [],
      inputs: [{
        previousOutput: shard.outPoint,
        since: ABSOLUTE_EPOCH_FLAG | BigInt(nowEpoch),
      }],
      outputs,
      outputsData,
      witnesses: [hex(mmr.encodeAppendWitnessMmr([entry], oldPeaks, newPeaks))],
    },
    expectedShardAfter: after,
    entry,
    claims,
  };
}

const api = { buildEntryTx, derivePeaks, ABSOLUTE_EPOCH_FLAG };
if (typeof module !== "undefined" && module.exports) module.exports = api;
if (typeof window !== "undefined") window.DaowowEntryTx = api;
})();
