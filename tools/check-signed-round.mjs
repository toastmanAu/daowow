#!/usr/bin/env node
// Check a SIGNED round-creation transaction before it is sent.
//
// The round-type contract reads the prize schedule from WitnessArgs.output_type
// of witness 0 (daowow-contracts-common/src/lib.rs:66). That is the same
// witness the signature goes into. A signer that rebuilds the witness rather
// than filling its lock field in place would drop the schedule, and the
// failure arrives as a contract rejection at send with nothing naming the
// cause — or worse, a round on chain whose schedule nobody can recover.
//
// So this runs between sign-inputs and send. It re-derives everything from the
// signed bytes themselves: the schedule must still be there, it must still
// hash to the commitment the config cell carries, and the signature slot must
// be filled.
//
// It never signs and never sends.
//
// Usage: node tools/check-signed-round.mjs <tx-file.json>

import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { ccc } from "../apps/web/vendor/ccc-joyid.min.mjs";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const require_ = createRequire(path.join(ROOT, "tools/"));
const { decodeRoundConfigV1 } = require_("../apps/web/chain/codec.js");
const { decodeSchedule, placesFor } = require_("../apps/web/chain/schedule.js");

const [file] = process.argv.slice(2);
if (!file) {
  console.error("usage: node tools/check-signed-round.mjs <tx-file.json>");
  process.exit(2);
}

const doc = JSON.parse(fs.readFileSync(file, "utf8"));
const tx = doc.transaction ?? doc;
const fail = [];
const ok = [];

if (!tx.witnesses || tx.witnesses.length === 0) {
  console.error(`REFUSING: ${file} carries no witnesses at all.`);
  console.error("  If you ran `ckb-cli tx init` on it, that OVERWROTE the file");
  console.error("  with an empty skeleton. Regenerate with create-demo-round.mjs.");
  process.exit(1);
}

let args;
try {
  args = ccc.WitnessArgs.fromBytes(ccc.bytesFrom(tx.witnesses[0]));
} catch (e) {
  console.error(`REFUSING: witness 0 is not a WitnessArgs (${e.message}).`);
  process.exit(1);
}

// 1. the signature
const lock = args.lock ? ccc.bytesFrom(args.lock) : null;
if (!lock || lock.length === 0) {
  fail.push("witness 0 has no lock field — the transaction is not signed");
} else if (lock.every((b) => b === 0)) {
  fail.push(`witness 0's lock is still ${lock.length} zero bytes — not signed yet`);
} else {
  ok.push(`signature present, ${lock.length} bytes`);
}

// 2. the schedule survived
if (!args.outputType) {
  fail.push(
    "witness 0 carries NO output_type — the prize schedule was dropped. " +
    "The signer rebuilt the witness instead of filling its lock in place.",
  );
} else {
  const scheduleBytes = ccc.bytesFrom(args.outputType);
  const commitment = ccc
    .hashCkb(ccc.bytesConcat(
      ccc.bytesFrom("DAOWOW_PRIZE_SCHEDULE_V1", "utf8"), scheduleBytes))
    .replace(/^0x/, "");

  // 3. and it still matches what the config cell commits to
  const configData = tx.outputs_data?.[0];
  if (!configData) {
    fail.push("output 0 has no data, so there is no config cell to check against");
  } else {
    const cfg = decodeRoundConfigV1(ccc.bytesFrom(configData));
    if (commitment !== cfg.prizeScheduleHash) {
      fail.push(
        "the schedule in witness 0 does NOT match the config cell's " +
        `prize_schedule_hash (witness ${commitment.slice(0, 16)}…, ` +
        `config ${cfg.prizeScheduleHash.slice(0, 16)}…)`,
      );
    } else {
      const sched = decodeSchedule(scheduleBytes);
      ok.push(`schedule intact: v${sched.version}, ${sched.weights.length} places, ` +
        `thresholds ${sched.thresholds.join(", ")}`);
      ok.push(`commitment matches the config cell`);
      const at = cfg.minimumTickets;
      ok.push(`at the ${at}-ticket minimum this pays ${placesFor(sched, at)} place(s)`);
      ok.push(`round ${cfg.roundId.slice(0, 16)}…, entry epochs ` +
        `${cfg.entryStart}..${cfg.entryEnd}`);
    }
  }
}

for (const line of ok) console.log(`  ok    ${line}`);
for (const line of fail) console.log(`  FAIL  ${line}`);

if (fail.length > 0) {
  console.log(`\nDo NOT send ${file}.`);
  process.exit(1);
}
console.log(`\n${file} is signed and the schedule survived. Safe to send.`);
