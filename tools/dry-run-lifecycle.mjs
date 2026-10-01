#!/usr/bin/env node
// Drive a round's lifecycle against a LIVE chain, without a wallet.
//
// Written before the operator command on purpose. On the entry path the
// equivalent tool found a seam that every unit test had passed straight
// through — buildEntryTx read config.commitment and the decoder never produced
// it — and it found it on the first run, after discovery, the schedule check
// and the quote had all succeeded. Unit tests see the modules; this sees the
// seams between them.
//
// It NEVER signs and NEVER sends.
//
// Usage:
//   node tools/dry-run-lifecycle.mjs <manifest.json> [--step freeze|genesis|aggregate]
//                                    [--from-tx FILE] [--out FILE]
//
//   --from-tx serves an UNSENT transaction's outputs as though they were live,
//   at the out points they will actually have, so genesis can be dry-run
//   against a freeze that has not been sent yet.

import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { ccc } from "../apps/web/vendor/ccc-joyid.min.mjs";
import { depsProvide, resolveLockDep } from "./lock-deps.mjs";
import { checkFreeze, checkGenesis, checkAggregate, checkClose, checkSeal, checkEntropy } from "./lifecycle-rules.mjs";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const require_ = createRequire(path.join(ROOT, "tools/"));
const { loadManifest } = require_("../apps/web/chain/manifest.js");
const { createRpc } = require_("../apps/web/chain/rpc.js");
const codec = require_("../apps/web/chain/codec.js");
const ledgerCodec = require_("../apps/web/chain/ledger-codec.js");
const { decodeEntryDataV1 } = require_("../apps/web/chain/entry-codec.js");
const { decodeLedgerWitness } = require_("../apps/web/chain/ledger-witness.js");
const { buildFreezeTx } = require_("../apps/web/chain/freeze-tx.js");
const { buildLedgerGenesisTx } = require_("../apps/web/chain/genesis-tx.js");
const { buildAggregateTx } = require_("../apps/web/chain/aggregate-tx.js");
const { buildCloseTx, closableFrom } = require_("../apps/web/chain/close-tx.js");
const { readShardEntries } = require_("../apps/web/chain/shard-history.js");
const sealCodec = require_("../apps/web/chain/seal-codec.js");
const { buildSealTx } = require_("../apps/web/chain/seal-tx.js");
const { buildEntropyTx, entropyHeights } = require_("../apps/web/chain/entropy-tx.js");
const { computeDraw, describeDraw } = require_("../apps/web/chain/draw.js");
const { decodeSchedule } = require_("../apps/web/chain/schedule.js");
const discovery = require_("../apps/web/chain/discovery.js");

const [manifestPath, ...rest] = process.argv.slice(2);
if (!manifestPath) {
  console.error("usage: node tools/dry-run-lifecycle.mjs <manifest.json> [--step ...] [--from-tx FILE]");
  process.exit(2);
}
const flag = (name, fallback = null) => {
  const at = rest.indexOf(name);
  return at === -1 ? fallback : rest[at + 1];
};
const requestedStep = flag("--step");
const fromTx = flag("--from-tx");
const outFile = flag("--out");
const sponsorRef = flag("--sponsor");
const roundPrefix = flag("--round");

const manifest = loadManifest(JSON.parse(fs.readFileSync(manifestPath, "utf8")));
const liveRpc = createRpc(manifest.rpcUrl);
const CKB = 100000000n;
const hexRaw = (b) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
const unhex = (s) => Uint8Array.from((s.startsWith("0x") ? s.slice(2) : s)
  .match(/../g) ?? [], (b) => parseInt(b, 16));

// --- an unsent transaction, served as though committed ---------------------
// The out points are the REAL ones: the hash is computed from the transaction
// rather than invented, so anything built against them is what would be built
// against the committed result.
function servingUnsent(file, live) {
  const doc = JSON.parse(fs.readFileSync(file, "utf8"));
  const raw = doc.transaction ?? doc;
  const tx = ccc.Transaction.from({
    version: Number(raw.version ?? 0),
    cellDeps: raw.cell_deps.map((d) => ({
      outPoint: { txHash: d.out_point.tx_hash, index: Number(d.out_point.index) },
      depType: d.dep_type === "dep_group" ? "depGroup" : "code",
    })),
    headerDeps: raw.header_deps ?? [],
    inputs: raw.inputs.map((i) => ({
      previousOutput: {
        txHash: i.previous_output.tx_hash, index: Number(i.previous_output.index),
      },
      since: BigInt(i.since ?? 0),
    })),
    outputs: raw.outputs.map((o) => ({
      capacity: BigInt(o.capacity),
      lock: { codeHash: o.lock.code_hash, hashType: o.lock.hash_type, args: o.lock.args },
      type: o.type
        ? { codeHash: o.type.code_hash, hashType: o.type.hash_type, args: o.type.args }
        : undefined,
    })),
    outputsData: raw.outputs_data,
    witnesses: raw.witnesses,
  });
  const hash = tx.hash();
  const spent = new Set(raw.inputs.map(
    (i) => `${i.previous_output.tx_hash}:${Number(i.previous_output.index)}`));
  const cells = raw.outputs.map((output, index) => ({
    out_point: { tx_hash: hash, index: "0x" + index.toString(16) },
    output,
    output_data: raw.outputs_data[index],
  }));
  return {
    hash,
    rpc: {
      call: (method, params) => live.call(method, params),
      // The unsent transaction's outputs, PLUS whatever the live chain still
      // shows minus the cells this transaction spends — otherwise the shard it
      // consumed would appear twice.
      async *getCells(query) {
        for (const cell of cells) {
          const script = query.script_type === "type" ? cell.output.type : cell.output.lock;
          if (script && script.code_hash === query.script.code_hash) yield cell;
        }
        for await (const cell of live.getCells(query)) {
          const ref = `${cell.out_point.tx_hash}:${Number(cell.out_point.index)}`;
          if (!spent.has(ref)) yield cell;
        }
      },
    },
  };
}

let rpc = liveRpc;
let unsent = null;
if (fromTx) {
  unsent = servingUnsent(fromTx, liveRpc);
  rpc = unsent.rpc;
}

const tip = await liveRpc.call("get_tip_header", []);
const nowEpoch = BigInt(tip.epoch) & 0xffffffn;
console.log(`node        ${manifest.rpcUrl}  (${manifest.network}, epoch ${nowEpoch})`);
if (unsent) {
  console.log(`source      UNSENT ${fromTx}, outputs at ${unsent.hash.slice(0, 18)}…`);
}

const rounds = await discovery.findRounds(rpc, manifest);
if (rounds.length === 0) {
  console.log("\nNo round on chain.");
  process.exit(1);
}
// More than one round can be on chain, and the indexer's order is not a
// choice anyone made — so a round is picked explicitly when there are several.
let round = rounds[0];
if (roundPrefix) {
  const want = roundPrefix.replace(/^0x/, "").toLowerCase();
  round = rounds.find((r) => r.config.roundId.startsWith(want));
  if (!round) {
    console.log(`\nNo round on chain starts with ${roundPrefix}. On chain: ` +
      rounds.map((r) => r.config.roundId.slice(0, 10)).join(", "));
    process.exit(1);
  }
} else if (rounds.length > 1) {
  console.log(`\n${rounds.length} rounds on chain — pass --round <id prefix>: ` +
    rounds.map((r) => r.config.roundId.slice(0, 10)).join(", "));
  process.exit(1);
}
const config = round.config;
console.log(`round       ${config.roundId.slice(0, 16)}…`);
console.log(`            entry epochs ${config.entryStart}..${config.entryEnd}, ` +
  `aggregate by ${config.aggregationDeadline}`);

// --- where in the lifecycle is this round? --------------------------------
// The shard cell and the ledger cell share a type script and its args, so they
// are told apart by DATA LENGTH, exactly as the contract's own dispatch does.
const shardType = manifest.scripts["entry-shard-type"];
const commitment = config.commitment;
let shardCell = null;
let ledgerCell = null;
// The same cell, further along: a seal (first byte 3) and then an entropy
// record (first byte 4), told apart by length and first byte exactly as the
// contract's own dispatch does.
let sealCell = null;
let recordCell = null;
for await (const cell of rpc.getCells({
  script: { code_hash: shardType.codeHash, hash_type: shardType.hashType, args: "0x" },
  script_type: "type", script_search_mode: "prefix",
})) {
  const args = (cell.output.type?.args ?? "").replace(/^0x/, "");
  if (args.length !== 72 || args.slice(0, 64) !== commitment) continue;
  const data = unhex(cell.output_data ?? "0x");
  if (data.length === 101) {
    shardCell = { cell, shard: codec.decodeEntryShardDataV1(data) };
  } else if (data.length === ledgerCodec.AGGREGATION_STATE_SIZE) {
    ledgerCell = { cell, state: ledgerCodec.decodeAggregationState(data) };
  } else if (data[0] === sealCodec.SEAL_VERSION
             && data.length === sealCodec.sealSize(config.entryShardCount)) {
    sealCell = { cell, seal: sealCodec.decodeRoundSeal(data, config.entryShardCount) };
  } else if (data[0] === sealCodec.RECORD_VERSION
             && data.length === sealCodec.recordSize(config.entryShardCount)) {
    recordCell = { cell, record: sealCodec.decodeEntropyRecord(data, config.entryShardCount) };
  }
}

const outPointOf = (cell) => ({
  txHash: cell.out_point.tx_hash, index: Number(cell.out_point.index),
});

// The committed prize schedule travels in the round-creation transaction's
// witness, and is verified against the config before anything uses it.
async function committedSchedule() {
  const created = await liveRpc.call("get_transaction", [round.outPoint.txHash]);
  const args = ccc.WitnessArgs.fromBytes(ccc.bytesFrom(created.transaction.witnesses[0]));
  const bytes = ccc.bytesFrom(args.outputType);
  const sched = decodeSchedule(bytes);
  return sched;
}

// The block a cell's creating transaction was committed in.
async function inclusionOf(cell) {
  const tx = await liveRpc.call("get_transaction", [cell.out_point.tx_hash]);
  const header = await liveRpc.call("get_header", [tx.tx_status.block_hash]);
  return { number: header.number, hash: header.hash };
}

let step;
let entropyInputs = null;
if (recordCell) {
  // Terminal for 3b. The draw is derived, never stored: compute it and say so.
  const draw = computeDraw({ config, record: recordCell.record, schedule: await committedSchedule() });
  const text = describeDraw(draw);
  console.log(`record      entropy FINALISED at seal height ${recordCell.record.inclusionHeight}`);
  console.log(`\nTHE DRAW    seed ${draw.seed.slice(0, 16)}…`);
  console.log(`            ${text.summary}`);
  for (const w of text.winners) console.log(`            place ${w.place}: ticket position ${w.ticket}`);
  console.log(`\n            ${text.method}`);
  console.log(`\n            header hashes: ${recordCell.record.inclusionHash.slice(0, 16)}…, ` +
    recordCell.record.entropyHashes.map((h) => h.slice(0, 16) + "…").join(", "));
  process.exit(0);
} else if (sealCell) {
  step = "entropy";
  const inclusion = await inclusionOf(sealCell.cell);
  const height = BigInt(inclusion.number);
  const [h64, h128, h192, earliest] = entropyHeights(height);
  const tipNow = BigInt((await liveRpc.call("get_tip_header", [])).number);
  console.log(`seal        committed at block ${height}`);
  console.log(`            entropy sendable from ${earliest} (256 blocks, ~34 min)`);
  // A WAIT, not a failure — and a keeper who does not know that will read it
  // as one. The +192 header exists before the since is satisfied, so the
  // since is the binding constraint.
  if (tipNow < earliest) {
    console.log(`\nNEXT STEP   entropy, but not until block ${earliest}; it is ${tipNow}, ` +
      `so ${earliest - tipNow} block(s) to go.`);
    process.exit(0);
  }
  const fetchByNumber = async (n) => {
    const h = await liveRpc.call("get_header_by_number", ["0x" + n.toString(16)]);
    if (!h) throw new Error(`the node has no header at height ${n}`);
    return { number: h.number, hash: h.hash };
  };
  entropyInputs = {
    inclusionHeader: inclusion,
    entropyHeaders: [await fetchByNumber(h64), await fetchByNumber(h128), await fetchByNumber(h192)],
  };
} else if (ledgerCell) {
  const st = ledgerCell.state;
  console.log(`ledger      ${st.acceptedEntries} of ${st.frozen.entryCount} entries ` +
    `accepted, ${st.acceptedBatches} batch(es), ${st.closed ? "CLOSED" : "open"}`);
  if (st.closed) {
    // Closed: unaccepted entries are refundable, and the round proceeds to the
    // seal — which freezes the entry universe the draw is taken over.
    step = "seal";
  }
  // An entry can only be REFUNDED once the ledger is closed, so closing is not
  // an afterthought: it is what releases the capacity of everything the round
  // did not accept.
  const everythingAccepted = st.acceptedEntries === st.frozen.entryCount;
  const past = nowEpoch >= config.aggregationDeadline;
  if (!st.closed) step = (everythingAccepted || past) ? "close" : "aggregate";
  if (step === "close") {
    const from = closableFrom(config, st);
    console.log(`            closable from epoch ${from}` +
      (everythingAccepted ? " (every entry accepted, so entry_end governs)"
                          : " (the aggregation deadline has passed)"));
    if (nowEpoch < from) {
      console.log(`\nNEXT STEP   close, but not until epoch ${from}; it is ${nowEpoch}.`);
      process.exit(0);
    }
  }
} else if (shardCell && shardCell.shard.state === 1) {
  step = "genesis";
  console.log(`shard       FROZEN, ${shardCell.shard.entryCount} entries, ` +
    `${shardCell.shard.ticketCount} tickets`);
} else if (shardCell) {
  step = "freeze";
  const ready = nowEpoch >= config.entryEnd;
  console.log(`shard       OPEN, ${shardCell.shard.entryCount} entries, ` +
    `${shardCell.shard.ticketCount} tickets`);
  if (!ready) {
    console.log(`\nNEXT STEP   freeze, but not until epoch ${config.entryEnd} ` +
      `(entry_end); it is ${nowEpoch}, so ${config.entryEnd - nowEpoch} epoch(s) to wait.`);
    process.exit(0);
  }
} else {
  console.log("\nNo shard or ledger cell for this round.");
  process.exit(1);
}
if (requestedStep && requestedStep !== step) {
  console.log(`\nAsked for ${requestedStep}, but this round's next step is ${step}.`);
  process.exit(1);
}
console.log(`\nNEXT STEP   ${step}`);

// --- the sponsor ----------------------------------------------------------
const OPERATOR_LOCK_ARG = "0xa776bf02d19cafa3749d906cc2c9ab1cf1e80ff7";
const SECP = {
  codeHash: "0x9bd7e06f3ecf4be0f2fcd2188b23f1b9fcc88e5d4b65a8637b17723bbda3cce8",
  hashType: "type",
  args: OPERATOR_LOCK_ARG,
};
async function findSponsor() {
  if (sponsorRef) {
    const [tx_hash, idx] = sponsorRef.split(":");
    const got = await liveRpc.call("get_live_cell", [
      { tx_hash, index: "0x" + Number(idx).toString(16) }, false]);
    if (got.status !== "live") throw new Error(`sponsor cell is ${got.status}`);
    return {
      outPoint: { txHash: tx_hash, index: Number(idx) },
      capacity: BigInt(got.cell.output.capacity),
      lock: SECP,
    };
  }
  // Small pages and stop at the FIRST adequate cell rather than scanning for
  // the largest. The operator lock holds well over a hundred cells and a full
  // scan makes the indexer answer `Invalid params Indexer request timeout`,
  // which reads like a malformed query and is not one.
  const NEED = 2000n * CKB;   // comfortably over any lifecycle step's needs
  let best = null;
  let seen = 0;
  for await (const cell of liveRpc.getCells({
    script: { code_hash: SECP.codeHash, hash_type: SECP.hashType, args: SECP.args },
    script_type: "lock",
  }, { limit: 20 })) {
    seen += 1;
    if (cell.output.type) continue;
    if ((cell.output_data ?? "0x") !== "0x") continue;
    const capacity = BigInt(cell.output.capacity);
    if (capacity >= NEED) {
      return { outPoint: outPointOf(cell), capacity, lock: SECP };
    }
    if (!best || capacity > best.capacity) {
      best = { outPoint: outPointOf(cell), capacity, lock: SECP };
    }
    if (seen >= 200) break;
  }
  if (!best) {
    throw new Error(
      "no plain sponsor cell found under the operator lock; pass --sponsor txhash:index",
    );
  }
  return best;
}
const sponsor = await findSponsor();
// Resolved from chain, preferring the dep GROUP: secp256k1_blake160_sighash_all
// also loads the secp256k1_data table from a second cell, and bundling both is
// what the group is for.
const sponsorDep = await resolveLockDep(liveRpc, {
  code_hash: SECP.codeHash, hash_type: SECP.hashType, args: SECP.args,
});
if (!sponsorDep) throw new Error("no cell dep on this chain provides the sponsor's lock");
sponsor.lockDep = {
  outPoint: {
    txHash: sponsorDep.out_point.tx_hash,
    index: Number(sponsorDep.out_point.index),
  },
  depType: sponsorDep.dep_type === "dep_group" ? "depGroup" : "code",
};
console.log(`sponsor     ${sponsor.outPoint.txHash.slice(0, 18)}…:${sponsor.outPoint.index}` +
  `  ${sponsor.capacity / CKB} CKB`);
console.log(`  lock dep  ${sponsor.lockDep.outPoint.txHash.slice(0, 18)}…:` +
  `${sponsor.lockDep.outPoint.index} (${sponsor.lockDep.depType})`);

// --- build it -------------------------------------------------------------
const configCellOutPoint = round.outPoint;
let built;
let reasons = [];

if (step === "freeze") {
  built = buildFreezeTx({
    manifest, config,
    shard: {
      ...shardCell.shard, outPoint: outPointOf(shardCell.cell),
      capacity: BigInt(shardCell.cell.output.capacity),
      typeArgs: shardCell.cell.output.type.args,
    },
    nowEpoch, configCellOutPoint, sponsor,
  });
  reasons = checkFreeze({
    config, before: shardCell.shard,
    after: codec.decodeEntryShardDataV1(unhex(built.tx.outputsData[0])),
    since: built.tx.inputs[0].since,
  });
} else if (step === "genesis") {
  built = buildLedgerGenesisTx({
    manifest, config,
    frozenShard: {
      ...shardCell.shard, outPoint: outPointOf(shardCell.cell),
      capacity: BigInt(shardCell.cell.output.capacity),
      typeArgs: shardCell.cell.output.type.args,
    },
    configCellOutPoint, sponsor,
  });
  console.log(`top-up      ${built.topUp / CKB} CKB ` +
    `(the shard holds ${BigInt(shardCell.cell.output.capacity) / CKB}, ` +
    "the ledger's floor is 318)");
  reasons = checkGenesis({
    config, frozen: shardCell.shard,
    state: ledgerCodec.decodeAggregationState(unhex(built.tx.outputsData[0])),
    inCapacity: BigInt(shardCell.cell.output.capacity),
    outCapacity: BigInt(built.tx.outputs[0].capacity),
    entryInputCount: 0,
  });
} else if (step === "seal") {
  built = buildSealTx({
    manifest, config,
    ledger: {
      outPoint: outPointOf(ledgerCell.cell),
      capacity: BigInt(ledgerCell.cell.output.capacity),
      state: ledgerCell.state, typeArgs: ledgerCell.cell.output.type.args,
    },
    configCellOutPoint, sponsor,
  });
  console.log(`top-up      ${built.topUp / CKB} CKB (the ledger holds ` +
    `${BigInt(ledgerCell.cell.output.capacity) / CKB}, the seal's floor is ` +
    `${8 + sealCodec.sealSize(config.entryShardCount) + 34 + 69})`);
  reasons = checkSeal({
    config, before: ledgerCell.state, after: built.expectedSeal, shardId: 0,
    inCapacity: BigInt(ledgerCell.cell.output.capacity),
    outCapacity: BigInt(built.tx.outputs[0].capacity), entryInputCount: 0,
  });
} else if (step === "entropy") {
  built = buildEntropyTx({
    manifest, config,
    sealCell: {
      outPoint: outPointOf(sealCell.cell),
      capacity: BigInt(sealCell.cell.output.capacity),
      data: sealCell.cell.output_data,
      typeArgs: sealCell.cell.output.type.args,
    },
    ...entropyInputs,
    configCellOutPoint, sponsor,
  });
  console.log(`top-up      ${built.topUp / CKB} CKB (the seal holds ` +
    `${BigInt(sealCell.cell.output.capacity) / CKB}, the record's floor is ` +
    `${8 + sealCodec.recordSize(config.entryShardCount) + 34 + 69})`);
  console.log(`headers     ${entropyInputs.inclusionHeader.hash.slice(0, 14)}… @${BigInt(entropyInputs.inclusionHeader.number)}` +
    entropyInputs.entropyHeaders.map((h) => `, ${h.hash.slice(0, 14)}… @${BigInt(h.number)}`).join(""));
  reasons = checkEntropy({
    config, seal: sealCell.seal, record: built.expectedRecord,
    since: built.tx.inputs[0].since, headerDeps: built.tx.headerDeps,
    ...entropyInputs,
    inCapacity: BigInt(sealCell.cell.output.capacity),
    outCapacity: BigInt(built.tx.outputs[0].capacity), entryInputCount: 0,
  });
} else if (step === "close") {
  built = buildCloseTx({
    manifest, config,
    ledger: {
      outPoint: outPointOf(ledgerCell.cell),
      capacity: BigInt(ledgerCell.cell.output.capacity),
      state: ledgerCell.state, typeArgs: ledgerCell.cell.output.type.args,
    },
    nowEpoch, configCellOutPoint, sponsor,
  });
  const after = ledgerCodec.decodeAggregationState(unhex(built.tx.outputsData[0]));
  if (!after.closed) reasons.push("the successor ledger is not closed");
  const before = ledgerCell.state;
  for (const f of ["acceptedEntries", "acceptedTickets", "acceptedPrincipal",
                   "acceptedCapacity", "acceptedBatches", "batchesRoot"]) {
    if (String(after[f]) !== String(before[f])) {
      reasons.push(`closing must change only the closed flag, but ${f} also moved`);
    }
  }
  const unaccepted = before.frozen.entryCount - before.acceptedEntries;
  console.log(`            closing fixes the accepted prefix at ` +
    `${before.acceptedEntries}; ${unaccepted} entr(ies) become refundable`);
} else {
  // The entry CELLS available to batch now.
  const entryLock = manifest.scripts["entry-lock"];
  const found = [];
  for await (const cell of rpc.getCells({
    script: { code_hash: entryLock.codeHash, hash_type: entryLock.hashType, args: "0x" },
    script_type: "lock", script_search_mode: "prefix",
  })) {
    const args = (cell.output.lock.args ?? "").replace(/^0x/, "");
    if (args.length !== 128 || args.slice(64) !== commitment) continue;
    const data = unhex(cell.output_data ?? "0x");
    if (data.length !== 132) continue;
    found.push({ outPoint: outPointOf(cell), capacity: BigInt(cell.output.capacity),
                 entry: decodeEntryDataV1(data) });
  }
  found.sort((a, b) => Number(a.entry.entryNonce - b.entry.entryNonce));
  console.log(`entry cells ${found.length} live, nonces ` +
    `${found.map((c) => c.entry.entryNonce).join(", ")}`);

  // And the shard's FULL history for the replay, which is NOT the live set:
  // the accumulator is append-only, so a refunded entry leaves the live set
  // while the frozen root still counts it. Replaying the survivors builds a
  // different tree and every membership proof from it is refused.
  const replaySet = await readShardEntries(
    rpc, outPointOf(ledgerCell.cell), ledgerCell.state.frozen.entryCount);
  console.log(`history     ${replaySet.length} entries recovered from the ` +
    "shard's transaction chain for the accumulator replay");

  const state = ledgerCell.state;
  const pending = found.filter((c) => c.entry.entryNonce >= state.acceptedEntries);
  if (pending.length === 0) {
    console.log("\nEvery entry is already accepted; the ledger has nothing to take.");
    process.exit(0);
  }
  const batchCells = pending.slice(0, ledgerCodec.MAX_BATCH_ENTRIES);
  built = buildAggregateTx({
    manifest, config,
    ledger: {
      outPoint: outPointOf(ledgerCell.cell),
      capacity: BigInt(ledgerCell.cell.output.capacity),
      state, typeArgs: ledgerCell.cell.output.type.args,
    },
    entryCells: batchCells,
    allEntries: replaySet,
    configCellOutPoint, sponsor,
  });
  console.log(`batch       ${batchCells.length} entr(ies), id ${built.batchId}, ` +
    `digest ${built.batch.digest.slice(0, 16)}…`);
  console.log(`DAO deposit ${built.batch.inputCapacity / CKB} CKB ` +
    `(principal ${built.batch.principal / CKB}, so ` +
    `${(built.batch.inputCapacity - built.batch.principal) / CKB} CKB of cell overhead)`);
  reasons = checkAggregate({
    config, before: state,
    after: ledgerCodec.decodeAggregationState(unhex(built.tx.outputsData[0])),
    entries: batchCells.map((c) => c.entry),
    capacities: batchCells.map((c) => c.capacity),
    ledgerInCapacity: BigInt(ledgerCell.cell.output.capacity),
    ledgerOutCapacity: BigInt(built.tx.outputs[0].capacity),
    daoOutput: built.tx.outputs[1],
    daoData: built.tx.outputsData[1],
    receiptOutput: built.tx.outputs[2],
    proofs: decodeLedgerWitness(unhex(built.tx.witnesses[0])).map((r) => r.proof),
  });
}

// --- report ---------------------------------------------------------------
console.log(`\n--- the transaction ---`);
console.log(`  cell deps   ${built.tx.cellDeps.length}`);
console.log(`  inputs      ${built.tx.inputs.length}`);
console.log(`  outputs     ${built.tx.outputs.length}`);
built.tx.outputs.forEach((o, i) => {
  const kind = o.type ? `type ${o.type.args.length === 2 + 77 * 2 ? "receipt" : "…"}` : "plain";
  console.log(`    ${i}  ${String(BigInt(o.capacity) / CKB).padStart(8)} CKB  ${kind}`);
});
console.log(`  witnesses   ${built.tx.witnesses.length}` +
  (step === "aggregate" ? `, proofs ${(built.tx.witnesses[0].length - 2) / 2} bytes at index 0` : ""));

// The two checks the unit tests structurally cannot make.
if (built.tx.witnesses.length !== built.tx.inputs.length) {
  console.log(`  FAIL  witnesses (${built.tx.witnesses.length}) and inputs ` +
    `(${built.tx.inputs.length}) are unbalanced; funding would displace the witness`);
} else {
  console.log("  ok    witness/input balance holds — funding appends, not displaces");
}
const asRpcShape = built.tx.cellDeps.map((d) => ({
  out_point: { tx_hash: d.outPoint.txHash, index: "0x" + Number(d.outPoint.index).toString(16) },
  dep_type: d.depType === "depGroup" ? "dep_group" : "code",
}));
for (const [i, input] of built.tx.inputs.entries()) {
  const got = await liveRpc.call("get_live_cell", [
    { tx_hash: input.previousOutput.txHash,
      index: "0x" + Number(input.previousOutput.index).toString(16) }, false]);
  if (got.status !== "live") {
    // Expected for a chained step: the predecessor's outputs are not on chain
    // until it is sent.
    console.log(`  note  input ${i} is ${got.status} on the live chain` +
      (unsent ? " (it comes from the unsent transaction)" : ""));
    continue;
  }
  const provided = await depsProvide(liveRpc, asRpcShape, got.cell.output.lock);
  console.log(provided
    ? `  ok    input ${i}'s lock has a cell dep providing it`
    : `  FAIL  input ${i}'s lock has NO cell dep; ScriptNotFound on Inputs[${i}].Lock`);
}

if (reasons.length === 0) {
  console.log("  ok    every lifecycle rule re-derived from the built bytes passes");
} else {
  for (const why of reasons) console.log(`  FAIL  ${why}`);
}

if (outFile) {
  const toRpc = (tx) => ({
    version: "0x0",
    cell_deps: tx.cellDeps.map((d) => ({
      out_point: { tx_hash: d.outPoint.txHash,
                   index: "0x" + Number(d.outPoint.index).toString(16) },
      dep_type: d.depType === "depGroup" ? "dep_group" : "code",
    })),
    header_deps: tx.headerDeps ?? [],
    inputs: tx.inputs.map((i) => ({
      previous_output: { tx_hash: i.previousOutput.txHash,
                         index: "0x" + Number(i.previousOutput.index).toString(16) },
      since: "0x" + BigInt(i.since).toString(16),
    })),
    outputs: tx.outputs.map((o) => ({
      capacity: "0x" + BigInt(o.capacity).toString(16),
      lock: { code_hash: o.lock.codeHash, hash_type: o.lock.hashType, args: o.lock.args },
      type: o.type
        ? { code_hash: o.type.codeHash, hash_type: o.type.hashType, args: o.type.args }
        : null,
    })),
    outputs_data: tx.outputsData,
    witnesses: tx.witnesses,
  });
  fs.writeFileSync(outFile, JSON.stringify(
    { transaction: toRpc(built.tx), multisig_configs: {}, signatures: {} }, null, 2));
  console.log(`\nwrote ${outFile} in ckb-cli's tx-file format (unsigned; this`);
  console.log("tool never signs). Do NOT run `tx init` — it writes an EMPTY");
  console.log("file over this one.\n");
  console.log("  # 1. sign. --skip-check is REQUIRED on sign-inputs too, not just");
  console.log("  #    on send: ckb-cli cannot classify the shard/ledger public lock");
  console.log("  #    (one byte of args) and REFUSES TO SIGN AT ALL without it,");
  console.log("  #    leaving the witness empty. Sending that gets -2 ERROR_ENCODING");
  console.log("  #    from the secp lock reading a witness with no signature in it.");
  console.log(`  ckb-cli --url ${manifest.rpcUrl} tx sign-inputs --tx-file ${outFile} \\`);
  console.log(`      --from-account ${OPERATOR_LOCK_ARG} --add-signatures --skip-check`);
  console.log("  # 2. verify the signature and every lifecycle rule");
  console.log(`  node tools/check-signed-lifecycle.mjs ${manifestPath} ${outFile}`);
  console.log("  # 3. send. --skip-check is required: ckb-cli cannot classify");
  console.log("  #    the shard/ledger public lock and refuses what it cannot name.");
  console.log(`  ckb-cli --url ${manifest.rpcUrl} tx send --tx-file ${outFile} --skip-check`);
}
if (reasons.length > 0) process.exit(1);
