#!/usr/bin/env node
// Build an entry against a LIVE round, without a wallet.
//
// This is the instrument for validating the dApp's entry path. Everything the
// browser does up to the signature happens here against a real node: round
// discovery, shard discovery, recovering the accumulator peaks, quoting, and
// building the append transaction. The only step it cannot perform is the
// wallet signature, which is deliberately the only step a human does.
//
// It NEVER signs and NEVER sends. Its output is a report and, optionally, the
// unsigned transaction description.
//
// Usage:
//   node tools/dry-run-entry.mjs <manifest.json> [--tickets N] [--lock-arg 0x..]
//       [--from-tx FILE] [--out FILE]
//     --lock-arg is the 20-byte args of the lock that would enter. Defaults to
//     the operator's, which is fine for shaping a transaction but is NOT who
//     would enter in the browser.
//     --from-tx answers the question worth asking BEFORE anyone signs: will
//     the dApp be able to enter the round this UNSENT transaction creates?
//     It serves that transaction's outputs as though they were already live,
//     at the out points they will actually have (the hash is computed, not
//     guessed), and runs the identical pipeline against them.

import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { depsProvide } from "./lock-deps.mjs";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const require_ = createRequire(path.join(ROOT, "tools/"));
const { loadManifest } = require_("../apps/web/chain/manifest.js");
const { createRpc } = require_("../apps/web/chain/rpc.js");
const discovery = require_("../apps/web/chain/discovery.js");
const schedule = require_("../apps/web/chain/schedule.js");
const quote = require_("../apps/web/chain/quote.js");
const entryTx = require_("../apps/web/chain/entry-tx.js");
const shardPeaks = require_("../apps/web/chain/shard-peaks.js");
const refundTx = require_("../apps/web/chain/refund-tx.js");
const entryView = require_("../apps/web/dapp/entry-view.js");

const [manifestPath, ...rest] = process.argv.slice(2);
if (!manifestPath) {
  console.error("usage: node tools/dry-run-entry.mjs <manifest.json> [--tickets N] [--lock-arg 0x..]");
  process.exit(2);
}
const flag = (name, fallback) => {
  const at = rest.indexOf(name);
  return at === -1 ? fallback : rest[at + 1];
};
const tickets = BigInt(flag("--tickets", "1"));
const lockArg = flag("--lock-arg", "0xa776bf02d19cafa3749d906cc2c9ab1cf1e80ff7");
const outFile = flag("--out", null);

const SECP = {
  codeHash: "0x9bd7e06f3ecf4be0f2fcd2188b23f1b9fcc88e5d4b65a8637b17723bbda3cce8",
  hashType: "type",
  args: lockArg,
};

const manifest = loadManifest(JSON.parse(fs.readFileSync(manifestPath, "utf8")));
const fromTx = flag("--from-tx", null);

const { ccc } = await import("../apps/web/vendor/ccc-joyid.min.mjs");

// A node that knows about exactly one transaction: the one not sent yet. Its
// out points are the real ones — the hash is computed from the transaction
// itself rather than invented — so anything the pipeline builds against them
// is what it would build against the committed round.
function rpcServingUnsentTx(file, tipEpoch) {
  const doc = JSON.parse(fs.readFileSync(file, "utf8"));
  // create-demo-round.mjs writes ckb-cli's wrapper; a bare transaction also works.
  const raw = doc.transaction ?? doc;
  const txHash = ccc.Transaction.fromLumosSkeleton
    ? null : null; // not a lumos skeleton; build from the ckb-cli shape below
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
  const cells = raw.outputs.map((output, index) => ({
    out_point: { tx_hash: hash, index: "0x" + index.toString(16) },
    output,
    output_data: raw.outputs_data[index],
  }));
  return {
    txHash: hash,
    rpc: {
      async call(method, params) {
        if (method === "get_tip_header") {
          return { epoch: "0x" + tipEpoch.toString(16) };
        }
        if (method === "get_transaction") {
          if (params[0] !== hash) throw new Error(`unknown transaction ${params[0]}`);
          return { transaction: { hash, witnesses: raw.witnesses } };
        }
        throw new Error(`the unsent-transaction node does not serve ${method}`);
      },
      // Matches on code hash the way the real indexer does in prefix mode.
      async *getCells(query) {
        for (const cell of cells) {
          const script = query.script_type === "type" ? cell.output.type : cell.output.lock;
          if (script && script.code_hash === query.script.code_hash) yield cell;
        }
      },
    },
  };
}

let rpc;
let unsent = null;
if (fromTx) {
  // The tip still comes from the real node: the entry window is in absolute
  // epochs, so a made-up epoch would prove nothing about whether the round is
  // enterable now.
  const liveTip = await createRpc(manifest.rpcUrl).call("get_tip_header", []);
  unsent = rpcServingUnsentTx(fromTx, BigInt(liveTip.epoch) & 0xffffffn);
  rpc = unsent.rpc;
} else {
  rpc = createRpc(manifest.rpcUrl);
}

const tip = await rpc.call("get_tip_header", []);
const nowEpoch = BigInt(tip.epoch) & 0xffffffn;
console.log(`node        ${manifest.rpcUrl}  (${manifest.network}, epoch ${nowEpoch})`);
if (unsent) {
  console.log(`source      UNSENT transaction ${fromTx}`);
  console.log(`            its outputs will live at ${unsent.txHash.slice(0, 18)}…`);
}

const rounds = await discovery.findRounds(rpc, manifest);
console.log(`rounds      ${rounds.length}`);
if (rounds.length === 0) {
  console.log("\nNo round on chain. Create one before dry-running an entry.");
  process.exit(1);
}

const round = rounds[0];
const shards = await discovery.findShards(rpc, manifest, round.config.roundId);
const state = discovery.deriveRoundState(round.config, shards, nowEpoch);
console.log(`round       ${round.config.roundId.slice(0, 16)}…  ${state.state}`);
console.log(`            ticket price ${round.config.ticketPrice / 100000000n} CKB, ` +
  `min ${round.config.minimumTickets}, max ${round.config.maximumTickets}`);
console.log(`            entry epochs ${round.config.entryStart}..${round.config.entryEnd}`);
console.log(`shards      ${shards.length}, ${state.ticketsSold} tickets sold`);
if (shards.length === 0) throw new Error("the round has no entry shard on chain");

// The schedule the client renders: recovered from the creation witness and
// verified against the config's commitment, exactly as the page does it.
const created = await rpc.call("get_transaction", [round.outPoint.txHash]);
const witnessArgs = ccc.WitnessArgs.fromBytes(ccc.bytesFrom(created.transaction.witnesses[0]));
const scheduleBytes = ccc.bytesFrom(witnessArgs.outputType);
const commitment = ccc
  .hashCkb(ccc.bytesConcat(ccc.bytesFrom("DAOWOW_PRIZE_SCHEDULE_V1", "utf8"), scheduleBytes))
  .replace(/^0x/, "");
if (commitment !== round.config.prizeScheduleHash) {
  throw new Error("the published schedule does not match the round's commitment");
}
const sched = schedule.decodeSchedule(scheduleBytes);
console.log(`schedule    v${sched.version}, ${sched.weights.length} places, ` +
  `thresholds ${sched.thresholds.join(", ")}  [commitment verified]`);

const head = shards[0];
const peaks = await shardPeaks.readShardPeaks(rpc, head);
console.log(`peaks       ${peaks.length} recovered and bagged to the committed root`);

const q = quote.quoteEntry({
  config: round.config, schedule: sched, lockScript: SECP, tickets, feeShannons: 0n,
});
console.log("\n--- the quote the page would show ---");
for (const row of entryView.describeQuote(q)) {
  console.log(`  ${row.label.padEnd(22)} ${row.value}`);
}
const payout = entryView.describePayout(sched, state.ticketsSold + tickets, round.config.maximumTickets);
console.log(`\n  ${payout.summary}`);

const built = entryTx.buildEntryTx({
  manifest, config: round.config, schedule: sched, shard: { ...head, peaks },
  lock: SECP, participantLockHash: refundTx.scriptHash(SECP),
  tickets, nowEpoch, configCellOutPoint: round.outPoint,
});

const total = built.tx.outputs.reduce((sum, o) => sum + BigInt(o.capacity), 0n);
console.log("\n--- the transaction the wallet would be asked to sign ---");
console.log(`  cell deps   ${built.tx.cellDeps.length}`);
console.log(`  inputs      ${built.tx.inputs.length} (the shard head)`);
console.log(`  outputs     ${built.tx.outputs.length} = shard successor + entry cell + ${built.claims.length} claim(s)`);
console.log(`  witnesses   ${built.tx.witnesses.length}, append witness ${(built.tx.witnesses[0].length - 2) / 2} bytes`);
console.log(`  capacity    ${total / 100000000n} CKB across outputs, before the wallet funds the difference`);
console.log(`  new root    ${built.expectedShardAfter.accumulatorRoot.slice(0, 16)}…`);
for (const claim of built.claims) {
  console.log(`  ticket ${String(claim.position).padStart(3)}  ${claim.ticketId}`);
}

// The invariant the CCC adapter asserts before sending. Checking it here means
// a violation is found without asking anyone to open their wallet.
if (built.tx.witnesses.length !== built.tx.inputs.length) {
  throw new Error(
    `witnesses (${built.tx.witnesses.length}) and inputs (${built.tx.inputs.length}) ` +
    "are unbalanced; the append witness would be displaced during funding",
  );
}
console.log("\n  witness/input balance holds — funding will append, not displace");

// The shard head's own LOCK needs a dep, and buildEntryTx owns that one. (The
// entrant's lock dep comes from the wallet's prepareTransaction, so it cannot
// be checked here.) A missing lock dep is ScriptNotFound at broadcast and
// nothing local catches it — the round-creation transaction was refused for
// exactly this, on its own funding cell.
if (!unsent) {
  const asRpcShape = built.tx.cellDeps.map((d) => ({
    out_point: {
      tx_hash: d.outPoint.txHash,
      index: "0x" + Number(d.outPoint.index).toString(16),
    },
    dep_type: d.depType === "depGroup" ? "dep_group" : "code",
  }));
  const headCell = await rpc.call("get_live_cell", [
    { tx_hash: head.outPoint.txHash, index: "0x" + head.outPoint.index.toString(16) },
    false,
  ]);
  const provided = await depsProvide(rpc, asRpcShape, headCell.cell.output.lock);
  console.log(provided
    ? "  the shard head's lock has a cell dep — no ScriptNotFound on input 0"
    : "  WARNING: the shard head's lock has NO cell dep; this would be refused");
}

if (outFile) {
  fs.writeFileSync(outFile, JSON.stringify(built, (_, v) =>
    typeof v === "bigint" ? v.toString() : v, 2));
  console.log(`\nwrote ${outFile} (unsigned, and this tool never signs)`);
}
