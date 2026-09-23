#!/usr/bin/env node
// Create the demo round.
//
// ===========================================================================
// THIS IS A STAND-IN, NOT THE OPERATOR FLOW.
//
// Round creation belongs to gate 3, which covers operator setup and keeper
// progression properly. Gate 2b cannot be demonstrated without a round to
// enter, so this exists to produce exactly one, at exactly the demo's shape,
// and nothing else. Do not build on it or treat it as the operator interface.
// ===========================================================================
//
// It does NOT sign. It prints the transaction for review and writes it where
// ckb-cli can pick it up, the same division as every other transaction in this
// repository: Phill signs, no key material comes near this code.
//
// Usage:
//   node tools/create-demo-round.mjs <manifest.json> <funding-outpoint>
//       [--out FILE] [--epochs N]
//     funding-outpoint is txhash:index, a plain cell under the operator lock
//     big enough to cover the round's cells plus a fee.
//     --epochs is how many epochs the entry window stays open (default 6,
//     roughly a day on testnet). It is NOT part of the approved round shape;
//     it exists so a demo is not run against a clock. Aggregation is always
//     given two further epochs.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ccc } from "../apps/web/vendor/ccc-joyid.min.mjs";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const require_ = (p) => {
  const url = path.join(ROOT, p);
  return JSON.parse(fs.readFileSync(url, "utf8"));
};

// The demo round, per docs/superpowers/specs/2026-09-19-dapp-entry-design.md
// D3 and the prize schedule v2 spec's D5. Approved in conversation; a
// different round is a different config, not a code change.
const DEMO = Object.freeze({
  ticketPriceCkb: 10000n,
  maximumTickets: 10n,
  minimumTickets: 5n,
  entryShardCount: 1,
  daoTermPeriods: 1,
  // weights and the ticket threshold at which each place starts paying
  weights: [40n, 25n, 20n, 10n, 5n],
  thresholds: [1n, 8n, 20n, 50n, 100n],
});

const CKB = 100000000n;
const SHARD_STATE_OPEN = 0;
const ACC_MMR = 1;
const HASH_TYPE = { data: 0, type: 1, data1: 2, data2: 4 };

const [manifestPath, fundingRef, ...rest] = process.argv.slice(2);
if (!manifestPath || !fundingRef) {
  console.error(
    "usage: node tools/create-demo-round.mjs <manifest.json> <txhash:index> [--out FILE]",
  );
  process.exit(2);
}
const outAt = rest.indexOf("--out");
const outFile = outAt === -1 ? "create-round.json" : rest[outAt + 1];
const epochsAt = rest.indexOf("--epochs");
const entryEpochs = epochsAt === -1 ? 6n : BigInt(rest[epochsAt + 1]);
if (entryEpochs < 1n) throw new Error("--epochs must be at least 1");

const manifest = require_(path.relative(ROOT, manifestPath));
const scripts = manifest.scripts;

// --- the committed prize schedule (v2 wire) --------------------------------
// version 2 | u32 count | count x (u64 weight, u64 min_tickets)
const schedule = new Uint8Array(5 + DEMO.weights.length * 16);
{
  const view = new DataView(schedule.buffer);
  schedule[0] = 2;
  view.setUint32(1, DEMO.weights.length, true);
  DEMO.weights.forEach((weight, i) => {
    view.setBigUint64(5 + i * 16, weight, true);
    view.setBigUint64(5 + i * 16 + 8, DEMO.thresholds[i], true);
  });
}
const scheduleCommitment = ccc.hashCkb(
  ccc.bytesConcat(ccc.bytesFrom("DAOWOW_PRIZE_SCHEDULE_V1", "utf8"), schedule),
);

// --- timing ----------------------------------------------------------------
// `since` on an entry is a lower bound only, so entry_start must already have
// passed for anyone to enter. Open the round at the current epoch.
const rpc = async (method, params) => {
  const res = await fetch(manifest.rpcUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id: 1, jsonrpc: "2.0", method, params }),
  });
  const body = await res.json();
  if (body.error) throw new Error(`${method}: ${JSON.stringify(body.error)}`);
  return body.result;
};

const tip = await rpc("get_tip_header", []);
// RFC 0017 packs index and length into the epoch field; the low 24 bits are
// the epoch NUMBER.
const nowEpoch = BigInt(tip.epoch) & 0xffffffn;
const entryStart = nowEpoch;
const entryEnd = nowEpoch + entryEpochs;
const aggregationDeadline = entryEnd + 2n;

// --- the round id and config ----------------------------------------------
const roundId = ccc.hashCkb(
  ccc.bytesFrom(`daowow-demo-round-${nowEpoch}-${fundingRef}`, "utf8"),
);

const fundingCell = await rpc("get_live_cell", [
  {
    tx_hash: fundingRef.split(":")[0],
    index: "0x" + Number(fundingRef.split(":")[1]).toString(16),
  },
  true,
]);
if (fundingCell.status !== "live") {
  throw new Error(`funding cell is ${fundingCell.status}, not live`);
}
const operatorLock = fundingCell.cell.output.lock;
const fundingCapacity = BigInt(fundingCell.cell.output.capacity);

const ref = (name) => ({
  codeHash: scripts[name].codeHash,
  hashType: HASH_TYPE[scripts[name].hashType],
});
// The native Nervos DAO type script, which the round config pins so deposits
// cannot be redirected to an impostor.
const daoTypeHash = (await rpc("get_consensus", [])).dao_type_hash;

const config = {
  version: 1,
  roundId: roundId.replace(/^0x/, ""),
  ticketPrice: DEMO.ticketPriceCkb * CKB,
  minimumTickets: DEMO.minimumTickets,
  maximumTickets: DEMO.maximumTickets,
  entryStart,
  entryEnd,
  aggregationDeadline,
  daoTermPeriods: DEMO.daoTermPeriods,
  entryShardCount: DEMO.entryShardCount,
  prizeScheduleHash: scheduleCommitment.replace(/^0x/, ""),
  feePolicyHash: "00".repeat(32),
  keeperPolicyHash: "00".repeat(32),
  flags: 0,
  accumulatorId: ACC_MMR,
  entryLock: ref("entry-lock"),
  daoLock: ref("dao-lock"),
  settlementType: ref("settlement-type"),
  entryShardType: ref("entry-shard-type"),
  daoType: { codeHash: daoTypeHash.replace(/^0x/, ""), hashType: HASH_TYPE.type },
};

const codec = await import("../apps/web/chain/codec.js").then((m) => m.default ?? m);
const configBytes = codec.encodeRoundConfigV1(config);
const commitment = ccc.hashCkb(
  ccc.bytesConcat(ccc.bytesFrom("DAOWOW_CONFIG_V2", "utf8"), configBytes),
);

// --- cells -----------------------------------------------------------------
const hex = (b) => "0x" + Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
const u32le = (n) => {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, n, true);
  return b;
};
const script = (name, args) => ({
  code_hash: scripts[name].codeHash,
  hash_type: scripts[name].hashType,
  args,
});

// An MMR shard's empty accumulator root is bag_peaks of NO peaks, which is a
// specific hash rather than zeros. Taken from core.js, which is checked
// against the Rust vectors — reimplementing it here got it wrong once
// already: bag_peaks hashes only the USED prefix of its buffer, so an empty
// list hashes just the 4-byte count, not 2,052 bytes of zeros.
const core = await import("../apps/web/core.js").then((m) => m.default ?? m);
const emptyMmrRoot =
  Array.from(core.MMR.bagPeaks([]), (x) => x.toString(16).padStart(2, "0")).join("");

const shardData = codec.encodeEntryShardDataV1({
  roundId: config.roundId,
  shardId: 0,
  state: SHARD_STATE_OPEN,
  sequence: 0n,
  entryCount: 0n,
  ticketCount: 0n,
  principalTotal: 0n,
  accumulatorRoot: emptyMmrRoot,
});

const CONFIG_CELL_CKB = 8n + 358n + 33n + 32n;   // capacity + data + lock + args
const SHARD_CELL_CKB = 8n + 101n + 33n + 1n + 33n + 36n;
const configCapacity = (CONFIG_CELL_CKB + 100n) * CKB;
const shardCapacity = (SHARD_CELL_CKB + 100n) * CKB;
const fee = 10000000n; // 0.1 CKB
const change = fundingCapacity - configCapacity - shardCapacity - fee;
if (change < 61n * CKB) {
  throw new Error(
    `funding cell holds ${fundingCapacity / CKB} CKB; the round needs ` +
    `${(configCapacity + shardCapacity + fee) / CKB} CKB plus a change cell above the 61 CKB floor`,
  );
}

const tx = {
  version: "0x0",
  cell_deps: [
    { out_point: { tx_hash: scripts["round-type"].cellDep.outPoint.txHash,
                   index: "0x" + scripts["round-type"].cellDep.outPoint.index.toString(16) },
      dep_type: "code" },
    { out_point: { tx_hash: scripts["entry-shard-type"].cellDep.outPoint.txHash,
                   index: "0x" + scripts["entry-shard-type"].cellDep.outPoint.index.toString(16) },
      dep_type: "code" },
  ],
  header_deps: [],
  inputs: [{
    previous_output: {
      tx_hash: fundingRef.split(":")[0],
      index: "0x" + Number(fundingRef.split(":")[1]).toString(16),
    },
    since: "0x0",
  }],
  outputs: [
    { capacity: "0x" + configCapacity.toString(16), lock: operatorLock,
      type: script("round-type", "0x" + config.roundId) },
    { capacity: "0x" + shardCapacity.toString(16),
      lock: script("entry-shard-type", "0x00"),
      type: script("entry-shard-type",
        hex(new Uint8Array([...ccc.bytesFrom(commitment), ...u32le(0)]))) },
    { capacity: "0x" + change.toString(16), lock: operatorLock, type: null },
  ],
  outputs_data: [hex(configBytes), hex(shardData), "0x"],
  // creation_schedule loads witness 0 and reads WitnessArgs.output_type
  // (daowow-contracts-common/src/lib.rs:66).
  //
  // That is the SAME witness the signature goes in, so this carries a 65-byte
  // zero lock placeholder alongside the schedule — exactly the shape the
  // integration harness builds (tests/integration/tests/common/mod.rs:171).
  // Signing writes the real signature into that slot under RFC 0019, which
  // sizes the digest against a zero-filled lock of the final length. Omitting
  // the placeholder leaves a signer to invent the field and, with it, the
  // chance of rebuilding the witness from scratch and dropping the schedule.
  witnesses: [ccc.hexFrom(ccc.WitnessArgs.from({
    lock: "0x" + "00".repeat(65),
    outputType: hex(schedule),
  }).toBytes())],
};

// ckb-cli's own tx-file format. NOT a bare transaction: `ckb-cli tx init`
// CREATES an empty file and would overwrite this one, so the flow goes
// straight to sign-inputs. Writing the wrapper here is what makes that safe.
fs.writeFileSync(outFile, JSON.stringify({
  transaction: tx,
  multisig_configs: {},
  signatures: {},
}, null, 2));

console.log("STAND-IN for gate 3's operator flow. Nothing has been signed.\n");
console.log(`round id            ${roundId}`);
console.log(`config commitment   ${commitment}`);
console.log(`schedule commitment ${scheduleCommitment}`);
console.log(`ticket price        ${DEMO.ticketPriceCkb} CKB`);
console.log(`tickets             min ${DEMO.minimumTickets}, max ${DEMO.maximumTickets}, ${DEMO.entryShardCount} shard`);
console.log(`payout thresholds   ${DEMO.thresholds.join(", ")}`);
console.log(`entry window        epoch ${entryStart} to ${entryEnd}, aggregate by ${aggregationDeadline}`);
console.log(`\ncapacity            config ${configCapacity / CKB} + shard ${shardCapacity / CKB} + fee 0.1, change ${change / CKB} CKB`);
console.log(`\nwrote ${outFile} in ckb-cli's tx-file format. Do NOT run \`tx init\`:`);
console.log("it creates an EMPTY file and overwrites this one.\n");
console.log("  # 1. review");
console.log(`  ckb-cli --url ${manifest.rpcUrl} tx info --tx-file ${outFile}`);
console.log("  # 2. sign (prompts for your password)");
console.log(`  ckb-cli --url ${manifest.rpcUrl} tx sign-inputs --tx-file ${outFile} \\`);
console.log("      --from-account 0xa776bf02d19cafa3749d906cc2c9ab1cf1e80ff7 --add-signatures");
console.log("  # 3. CHECK THE SCHEDULE SURVIVED SIGNING, then send");
console.log(`  node tools/check-signed-round.mjs ${outFile}`);
console.log(`  ckb-cli --url ${manifest.rpcUrl} tx send --tx-file ${outFile}`);
