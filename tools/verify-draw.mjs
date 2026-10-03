#!/usr/bin/env node
// Check the dApp's draw against the Rust ComputedDraw, on a LIVE round.
//
// The JavaScript draw is pinned to gen_vectors, but a port checked only
// against fixtures has never been checked against the round it is actually
// reporting on. This reads the real bytes off chain — the config cell, the
// committed schedule from the creation witness, the entropy record — and runs
// both implementations over them.
//
// Usage:
//   node tools/verify-draw.mjs <manifest.json> --round <id prefix>
//   node tools/verify-draw.mjs --vector computed_draw     (positive control)

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { ccc } from "../apps/web/vendor/ccc-joyid.min.mjs";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const require_ = createRequire(path.join(ROOT, "tools/"));
const codec = require_("../apps/web/chain/codec.js");
const sealCodec = require_("../apps/web/chain/seal-codec.js");
const { decodeSchedule } = require_("../apps/web/chain/schedule.js");
const { computeDraw } = require_("../apps/web/chain/draw.js");

const args = process.argv.slice(2);
const flag = (n) => { const i = args.indexOf(n); return i === -1 ? null : args[i + 1]; };
const unhex = (s) => Uint8Array.from(s.replace(/^0x/, "").match(/../g) ?? [], (b) => parseInt(b, 16));
const strip = (s) => s.replace(/^0x/, "");

let configHex, scheduleHex, recordHex, label;
if (flag("--vector")) {
  // The positive control: a VIABLE draw with real positions, so agreement here
  // shows the comparison can see positions, not merely that two empty lists
  // are equal.
  const V = JSON.parse(fs.readFileSync(path.join(ROOT, "tests/vectors/daowow_core_vectors.json"), "utf8"));
  const v = V[flag("--vector")];
  [configHex, scheduleHex, recordHex, label] = [v.config, v.schedule, v.record, `vector ${flag("--vector")}`];
} else {
  const { loadManifest } = require_("../apps/web/chain/manifest.js");
  const { createRpc } = require_("../apps/web/chain/rpc.js");
  const discovery = require_("../apps/web/chain/discovery.js");
  const manifest = loadManifest(JSON.parse(fs.readFileSync(args[0], "utf8")));
  const rpc = createRpc(manifest.rpcUrl);
  const want = (flag("--round") ?? "").replace(/^0x/, "");
  const round = (await discovery.findRounds(rpc, manifest)).find((r) => r.config.roundId.startsWith(want));
  if (!round) throw new Error(`no round starts with ${want}`);
  const cfgCell = await rpc.call("get_live_cell", [
    { tx_hash: round.outPoint.txHash, index: "0x" + round.outPoint.index.toString(16) }, true]);
  configHex = strip(cfgCell.cell.data.content);
  const created = await rpc.call("get_transaction", [round.outPoint.txHash]);
  scheduleHex = strip(ccc.hexFrom(ccc.WitnessArgs.fromBytes(
    ccc.bytesFrom(created.transaction.witnesses[0])).outputType));
  const shardType = manifest.scripts["entry-shard-type"];
  for await (const cell of rpc.getCells({
    script: { code_hash: shardType.codeHash, hash_type: shardType.hashType, args: "0x" },
    script_type: "type", script_search_mode: "prefix",
  })) {
    const a = strip(cell.output.type?.args ?? "");
    const d = unhex(cell.output_data ?? "0x");
    if (a.slice(0, 64) === round.config.commitment && d[0] === sealCodec.RECORD_VERSION
        && d.length === sealCodec.recordSize(round.config.entryShardCount)) {
      recordHex = strip(cell.output_data);
    }
  }
  if (!recordHex) throw new Error("this round has no entropy record on chain yet");
  label = `round ${round.config.roundId.slice(0, 16)}…`;
}

// JavaScript.
const config = codec.decodeRoundConfigV1(unhex(configHex));
const js = computeDraw({
  config,
  schedule: decodeSchedule(unhex(scheduleHex)),
  record: sealCodec.decodeEntropyRecord(unhex(recordHex), config.entryShardCount),
});
const jsLines = [
  `seed ${js.seed}`, `total ${js.tickets}`, `success ${js.viable}`,
  ...js.positions.map((p) => `position ${p.prizeIndex} ${p.position}`),
];

// Rust — built first, because a stale example binary is an oracle that lies
// (the 2026-09-17 freshness lesson).
execFileSync("cargo", ["build", "-q", "-p", "daowow-core", "--example", "draw_oracle"],
  { cwd: ROOT, stdio: "inherit" });
const rust = execFileSync(path.join(ROOT, "target/debug/examples/draw_oracle"),
  [configHex, scheduleHex, recordHex], { encoding: "utf8" }).trim().split("\n");

console.log(label);
let agree = jsLines.length === rust.length;
const n = Math.max(jsLines.length, rust.length);
for (let i = 0; i < n; i++) {
  const same = jsLines[i] === rust[i];
  agree &&= same;
  console.log(`  ${same ? "ok  " : "DIFF"}  js   ${jsLines[i] ?? "(missing)"}`);
  if (!same) console.log(`        rust ${rust[i] ?? "(missing)"}`);
}
console.log(agree ? "\nThe dApp's draw matches ComputedDraw exactly."
                  : "\nDISAGREEMENT: do not publish this draw.");
process.exit(agree ? 0 : 1);
