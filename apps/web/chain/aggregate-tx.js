"use strict";
// Wrapped in an IIFE: loaded as a classic script these files share one
// global scope, so top-level declarations would collide between modules.
(function () {
// TX-05 Aggregate a batch into a native Nervos DAO deposit.
//
// The batch arithmetic is separated from transaction assembly so it can be
// pinned to the Rust oracle with no chain anywhere near it. `acceptBatch`
// mirrors AggregationState::accept (lifecycle.rs:229) field for field,
// INCLUDING its refusals — every one of them is reported by the chain as a
// state error that says nothing about which rule broke.
//
// Three facts about this transaction are easy to get wrong and expensive to
// discover:
//
//  1. The DAO deposit's capacity is the SUMMED CELL CAPACITY of the batch's
//     entry inputs, not their principal, and it must match exactly. The
//     sponsor funds the receipt from its own input, never by shaving the
//     deposit.
//  2. Entries are accepted in STRICT NONCE ORDER. Batch n continues exactly
//     where n-1 stopped; there is no way to accept entry 3 before entry 2.
//  3. The proof witness sits at the LEDGER INPUT's own index, as raw bytes.
//     The ledger goes at input 0 so that index is 0 and the sponsor's
//     signature gets its own slot in its own script group.

const ledgerCodec =
  typeof require === "function" ? require("./ledger-codec.js") : window.DaowowLedgerCodec;
const ledgerWitness =
  typeof require === "function" ? require("./ledger-witness.js") : window.DaowowLedgerWitness;
const core = typeof require === "function" ? require("../core.js") : window.DaowowCore;

const CKB = 100000000n;
const FEE_SHANNONS = 10000000n;
const MIN_CELL_CKB = 61n * CKB;
const MAX_BATCH_ENTRIES = 32;

// The receipt cell's occupied capacity, in CKB:
//   8 capacity + 0 data + 34 lock (32 + 1 + 1) + 110 type (32 + 1 + 77 args)
const RECEIPT_CELL_CKB = 8n + 34n + 110n;

const hex0x = (b) => "0x" + Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
const hexRaw = (b) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
const unhex = (s) => {
  const body = s.startsWith("0x") ? s.slice(2) : s;
  return Uint8Array.from(body.match(/../g) ?? [], (b) => parseInt(b, 16));
};
const u64le = (v) => {
  const b = new Uint8Array(8);
  new DataView(b.buffer).setBigUint64(0, BigInt(v), true);
  return b;
};

/**
 * Accept a batch of entries into the ledger. Pure; mirrors
 * AggregationState::accept (lifecycle.rs:229).
 *
 * Returns `{next, batch}` — the successor state and the BatchCommitment whose
 * digest both the dao_lock args and the receipt args commit to.
 */
function acceptBatch(config, state, entries, capacities) {
  if (state.closed) {
    throw new Error("this ledger is closed and can accept no further batches");
  }
  if (config.commitment !== state.configCommitment) {
    throw new Error("the ledger was created against a different round config");
  }
  if (!Array.isArray(entries) || entries.length === 0) {
    throw new Error("a batch needs at least one entry");
  }
  if (entries.length > MAX_BATCH_ENTRIES) {
    throw new Error(
      `a batch cannot exceed ${MAX_BATCH_ENTRIES} entries; got ${entries.length}`,
    );
  }
  if (entries.length !== capacities.length) {
    throw new Error("every entry needs its cell's capacity");
  }

  const frozen = state.frozen;
  const ticketPrice = BigInt(config.ticketPrice);
  let acceptedEntries = state.acceptedEntries;
  let acceptedTickets = state.acceptedTickets;
  let acceptedPrincipal = state.acceptedPrincipal;
  let acceptedCapacity = state.acceptedCapacity;

  const parts = [
    new TextEncoder().encode("DAOWOW_ENTRY_BATCH_V2"),
    unhex(state.configCommitment),
    core.u32le(Number(frozen.shardId)),
    core.u32le(entries.length),
  ];

  const firstNonce = state.acceptedEntries;
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    const capacity = BigInt(capacities[i]);
    if (hexRaw(entry.roundId) !== config.roundId) {
      throw new Error(`entry ${i} belongs to a different round`);
    }
    if (Number(entry.shardId) !== Number(frozen.shardId)) {
      throw new Error(`entry ${i} belongs to shard ${entry.shardId}, not ${frozen.shardId}`);
    }
    // Strict order. The contract requires each entry's nonce to equal the
    // running accepted count, so a batch continues exactly where the last
    // stopped and reordering is impossible.
    if (entry.entryNonce !== acceptedEntries) {
      throw new Error(
        `entry ${i} has nonce ${entry.entryNonce} but the ledger expects ` +
        `${acceptedEntries}; entries are accepted in strict nonce order`,
      );
    }
    if (entry.positionBase !== acceptedTickets) {
      throw new Error(
        `entry ${i} has position_base ${entry.positionBase} but the ledger ` +
        `expects ${acceptedTickets}`,
      );
    }
    if (entry.ticketCount === 0n) {
      throw new Error(`entry ${i} holds no tickets`);
    }
    if (entry.ticketCount * ticketPrice !== entry.principal) {
      throw new Error(`entry ${i}'s principal is not its ticket count times the price`);
    }
    if (capacity < entry.principal) {
      throw new Error(
        `entry ${i}'s cell capacity is ${capacity} shannons, below the ` +
        `${entry.principal} principal it claims; the DAO deposit takes the ` +
        "cell's capacity, so such a cell would under-fund the round",
      );
    }

    acceptedEntries += 1n;
    acceptedTickets += entry.ticketCount;
    acceptedPrincipal += entry.principal;
    acceptedCapacity += capacity;
    if (acceptedEntries > frozen.entryCount
        || acceptedTickets > frozen.ticketCount
        || acceptedPrincipal > frozen.principalTotal) {
      throw new Error(
        "this batch would accept more than the frozen shard recorded, which " +
        "conservation forbids",
      );
    }

    parts.push(
      require_entryCodec().encodeEntryDataV1(entry),
      u64le(capacity),
    );
  }

  const digest = core.ckbHash256(parts);
  const batch = {
    version: 2,
    digest: hexRaw(digest),
    firstNonce,
    entryCount: BigInt(entries.length),
    ticketCount: acceptedTickets - state.acceptedTickets,
    principal: acceptedPrincipal - state.acceptedPrincipal,
    inputCapacity: acceptedCapacity - state.acceptedCapacity,
  };
  const next = {
    ...state,
    acceptedEntries, acceptedTickets, acceptedPrincipal, acceptedCapacity,
    acceptedBatches: state.acceptedBatches + 1n,
    batchesRoot: hexRaw(core.ckbHash256([
      new TextEncoder().encode("DAOWOW_BATCH_LEDGER_APPEND_V2"),
      unhex(state.batchesRoot),
      digest,
    ])),
  };
  return { next, batch };
}

// Resolved lazily so the IIFE ordering in the browser does not matter.
function require_entryCodec() {
  return typeof require === "function"
    ? require("./entry-codec.js")
    : window.DaowowEntryCodec;
}

/** dao_lock args: round_id ‖ batch_id LE ‖ commitment ‖ digest. 104 bytes. */
function daoLockArgs(config, id, batch) {
  return hex0x(new Uint8Array([
    ...unhex(config.roundId),
    ...u64le(id),
    ...unhex(config.commitment),
    ...unhex(batch.digest),
  ]));
}

/** receipt args: 2 ‖ commitment ‖ shard_id LE ‖ batch_id LE ‖ digest. 77 bytes. */
function receiptArgs(config, shardId, id, batch) {
  return hex0x(new Uint8Array([
    2,
    ...unhex(config.commitment),
    ...core.u32le(Number(shardId)),
    ...u64le(id),
    ...unhex(batch.digest),
  ]));
}

/**
 * Build the aggregate transaction.
 *
 * `allEntries` is every entry of the shard in nonce order — the proofs are
 * generated by replaying it, because the peaks and the proof paths are not on
 * chain. `entryCells` is the subset being batched now.
 */
function buildAggregateTx({
  manifest, config, ledger, entryCells, allEntries, configCellOutPoint, sponsor,
  daoTypeDep, feeShannons = FEE_SHANNONS,
}) {
  // The native DAO deposit is an OUTPUT carrying the DAO type script, and a
  // type script runs on every cell that carries it — so its code cell must be
  // a dep. Found reading the first live aggregate before it was signed: it was
  // missing, every dry-run check was green (they looked only at input locks),
  // and the node would have answered ScriptNotFound on Outputs[1].Type.
  // Required rather than resolved here, so a caller cannot forget it.
  if (!daoTypeDep || !daoTypeDep.outPoint) {
    throw new Error(
      "the native DAO type's cell dep is required (daoTypeDep); the deposit " +
      "output carries that type script and the node refuses it without the code",
    );
  }
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
  const state = ledger.state;
  const frozen = state.frozen;

  // Replay the shard to rebuild the tree the proofs are taken from. If the
  // replay does not reproduce the shard's committed root the proofs are for a
  // different tree and every one of them fails on chain as -4.
  const host = new core.MmrHost();
  for (const entry of allEntries) host.append(core.entryLeaf(entry));
  if (hexRaw(host.root()) !== frozen.accumulatorRoot) {
    throw new Error(
      "replaying these entries does not reproduce the shard's committed " +
      "accumulator root, so their membership proofs would be for a different " +
      "tree; the replay set is wrong or incomplete",
    );
  }

  const entries = entryCells.map((c) => c.entry);
  const capacities = entryCells.map((c) => BigInt(c.capacity));
  const { next, batch } = acceptBatch(config, state, entries, capacities);
  const id = ledgerCodec.batchId(Number(frozen.shardId), state.acceptedBatches);

  // Proofs, positioned against the entry cells' input indices. The ledger is
  // input 0, so the entry cells start at 1.
  const records = entryCells.map((cell, i) => {
    const nonce = Number(cell.entry.entryNonce);
    if (nonce >= allEntries.length) {
      throw new Error(
        `entry nonce ${nonce} is outside the replay set of ${allEntries.length} ` +
        "entries, so no membership proof can be generated for it",
      );
    }
    return { inputIndex: i + 1, proof: host.membershipProof(nonce) };
  });

  const commitmentBytes = unhex(config.commitment);
  const typeArgs = hex0x(new Uint8Array(
    [...commitmentBytes, ...core.u32le(Number(frozen.shardId))]));
  if (ledger.typeArgs && ledger.typeArgs.toLowerCase() !== typeArgs.toLowerCase()) {
    throw new Error(
      "this ledger cell does not belong to this round: its type args are " +
      `${ledger.typeArgs} and the round's config commits to ${typeArgs}`,
    );
  }

  const receiptCapacity = RECEIPT_CELL_CKB * CKB;
  const change = BigInt(sponsor.capacity) - receiptCapacity - BigInt(feeShannons);
  if (change < MIN_CELL_CKB) {
    throw new Error(
      `the sponsor holds ${BigInt(sponsor.capacity) / CKB} CKB, which cannot ` +
      `cover the ${RECEIPT_CELL_CKB} CKB receipt cell plus the fee and still ` +
      "leave a change cell above the 61 CKB floor",
    );
  }

  const publicLock = {
    codeHash: shardScript.codeHash, hashType: shardScript.hashType, args: "0x00",
  };

  return {
    tx: {
      cellDeps: [
        { outPoint: shardScript.outPoint, depType: shardScript.depType },
        // The entry cells' own lock runs when they are spent, so its code cell
        // is required even though nothing else about it is interesting here.
        // Omitting it is ScriptNotFound on those inputs, and nothing local
        // catches it.
        { outPoint: entryLock.outPoint, depType: entryLock.depType },
        { outPoint: configCellOutPoint, depType: "code" },
        sponsor.lockDep,
        daoTypeDep,
      ],
      headerDeps: [],
      inputs: [
        { previousOutput: ledger.outPoint, since: 0n },
        ...entryCells.map((c) => ({ previousOutput: c.outPoint, since: 0n })),
        { previousOutput: sponsor.outPoint, since: 0n },
      ],
      outputs: [
        // 0: the ledger successor.
        {
          capacity: BigInt(ledger.capacity),
          lock: publicLock,
          type: {
            codeHash: shardScript.codeHash, hashType: shardScript.hashType, args: typeArgs,
          },
        },
        // 1: the native DAO deposit. Its capacity is the summed ENTRY CELL
        // capacity, exactly — not the principal.
        {
          capacity: batch.inputCapacity,
          lock: {
            codeHash: "0x" + config.daoLock.codeHash,
            hashType: hashTypeName(config.daoLock.hashType),
            args: daoLockArgs(config, id, batch),
          },
          type: {
            codeHash: "0x" + config.daoType.codeHash,
            hashType: hashTypeName(config.daoType.hashType),
            args: "0x",
          },
        },
        // 2: the receipt, which is what a participant's entitlement is proved
        // against later.
        {
          capacity: receiptCapacity,
          lock: publicLock,
          type: {
            codeHash: shardScript.codeHash,
            hashType: shardScript.hashType,
            args: receiptArgs(config, frozen.shardId, id, batch),
          },
        },
        { capacity: change, lock: sponsor.lock, type: null },
      ],
      outputsData: [
        hex0x(ledgerCodec.encodeAggregationState(next)),
        "0x" + "00".repeat(8),   // the native DAO's deposit-block-number slot
        "0x",
        "0x",
      ],
      // The proofs go at the LEDGER input's index, which is 0. The remaining
      // slots keep witnesses.length equal to inputs.length so funding appends
      // rather than displacing.
      witnesses: [
        hex0x(ledgerWitness.encodeLedgerWitness(records)),
        ...entryCells.map(() => "0x"),
        "0x",
      ],
    },
    expectedLedgerAfter: next,
    batch,
    batchId: id,
    fee: BigInt(feeShannons),
  };
}

// ScriptRef stores the hash type as the on-chain byte; cell JSON wants a name.
function hashTypeName(value) {
  return ({ 0: "data", 1: "type", 2: "data1", 4: "data2" })[Number(value)] ?? "type";
}

const api = {
  acceptBatch, buildAggregateTx, daoLockArgs, receiptArgs,
  RECEIPT_CELL_CKB, MAX_BATCH_ENTRIES, FEE_SHANNONS,
};
if (typeof module !== "undefined" && module.exports) module.exports = api;
if (typeof window !== "undefined") window.DaowowAggregateTx = api;
})();
