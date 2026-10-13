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
// ckb-cli signs in TWO STAGES. `tx sign-inputs --add-signatures` does NOT
// touch witness 0; it records the signature in the file's `signatures` map and
// leaves the witness as written, with its lock still zero-filled. `tx send`
// assembles the final witnesses from that map. So "is it signed" is a question
// about the map, and whether the assembled witness will keep the schedule is a
// question this file answers cryptographically rather than by trust: it
// recomputes the RFC 0019 sighash-all digest over the witness AS STORED — the
// one carrying the schedule — and recovers the public key from the signature.
// If the recovered lock hash matches the signer, the signature commits to the
// schedule, and an assembly step that dropped it would invalidate the
// signature the node checks.
//
// It never signs and never sends.
//
// Usage: node tools/check-signed-round.mjs <tx-file.json> [--lock-arg 0x..]

import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { ccc } from "../apps/web/vendor/ccc-joyid.min.mjs";
import { depsProvide } from "./lock-deps.mjs";
import {
  creationRoundId, entryWindowProblem, validateRoundConfig,
} from "./round-rules.mjs";

// Captured from the decode below so the clock check can use it.
let checkedConfig = null;
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

// 1. the signature, in whichever of the two places it can live
const lockArgAt = process.argv.indexOf("--lock-arg");
const expectedLockArg = (lockArgAt === -1
  ? "0xa776bf02d19cafa3749d906cc2c9ab1cf1e80ff7"
  : process.argv[lockArgAt + 1]).toLowerCase();

const recorded = Object.entries(doc.signatures ?? {})
  .find(([arg]) => arg.toLowerCase() === expectedLockArg);
const lock = args.lock ? ccc.bytesFrom(args.lock) : null;
const witnessSigned = lock && lock.length > 0 && !lock.every((b) => b === 0);

let signature = null;
if (recorded && recorded[1].length > 0) {
  signature = recorded[1][0];
  ok.push(`signature recorded for ${expectedLockArg.slice(0, 12)}… ` +
    "(ckb-cli assembles it into witness 0 at send)");
} else if (witnessSigned) {
  signature = ccc.hexFrom(lock);
  ok.push(`signature already in witness 0, ${lock.length} bytes`);
} else {
  fail.push(
    "no signature anywhere: witness 0's lock is zeros and the signatures map " +
    `has no entry for ${expectedLockArg}. Run tx sign-inputs --add-signatures.`,
  );
}

// 2. does that signature actually commit to THIS witness, schedule included?
//
// RFC 0019: blake2b("ckb-default-hash") over tx_hash, then each witness of the
// group length-prefixed, with the signing witness's lock zero-filled to its
// final length. One input and one witness here, so the stream is short — and
// the witness as stored already carries a 65-byte zero lock, so it IS the
// zeroed form.
if (signature) {
  const ccctx = ccc.Transaction.from({
    version: Number(tx.version ?? 0),
    cellDeps: tx.cell_deps.map((d) => ({
      outPoint: { txHash: d.out_point.tx_hash, index: Number(d.out_point.index) },
      depType: d.dep_type === "dep_group" ? "depGroup" : "code",
    })),
    headerDeps: tx.header_deps ?? [],
    inputs: tx.inputs.map((i) => ({
      previousOutput: {
        txHash: i.previous_output.tx_hash, index: Number(i.previous_output.index),
      },
      since: BigInt(i.since ?? 0),
    })),
    outputs: tx.outputs.map((o) => ({
      capacity: BigInt(o.capacity),
      lock: { codeHash: o.lock.code_hash, hashType: o.lock.hash_type, args: o.lock.args },
      type: o.type
        ? { codeHash: o.type.code_hash, hashType: o.type.hash_type, args: o.type.args }
        : undefined,
    })),
    outputsData: tx.outputs_data,
    witnesses: tx.witnesses,
  });
  const zeroed = ccc.hexFrom(ccc.WitnessArgs.from({
    lock: "0x" + "00".repeat(65),
    outputType: args.outputType ?? undefined,
    inputType: args.inputType ?? undefined,
  }).toBytes());
  const witnessBytes = ccc.bytesFrom(zeroed);
  const len = new Uint8Array(8);
  new DataView(len.buffer).setBigUint64(0, BigInt(witnessBytes.length), true);
  const digest = ccc.hashCkb(ccc.bytesConcat(
    ccc.bytesFrom(ccctx.hash()), len, witnessBytes));

  try {
    const pubkey = ccc.recoverMessageSecp256k1(digest, signature);
    const recovered = ccc.hashCkb(ccc.bytesFrom(pubkey)).slice(0, 42).toLowerCase();
    if (recovered === expectedLockArg) {
      ok.push("signature VERIFIED against the witness carrying the schedule — " +
        "any assembly that drops it would invalidate this signature");
    } else {
      fail.push(
        `the signature does not recover to ${expectedLockArg} over this ` +
        `witness (got ${recovered}). It was signed over different bytes, so ` +
        "the node will refuse it.",
      );
    }
  } catch (e) {
    fail.push(`could not recover a public key from the signature: ${e.message}`);
  }
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
    checkedConfig = cfg;
    if (commitment !== cfg.prizeScheduleHash) {
      fail.push(
        "the schedule in witness 0 does NOT match the config cell's " +
        `prize_schedule_hash (witness ${commitment.slice(0, 16)}…, ` +
        `config ${cfg.prizeScheduleHash.slice(0, 16)}…)`,
      );
    } else {
      // The creation rules, both reported by the chain as the same -17.
      const configIndex = tx.outputs_data.indexOf(configData);
      const wantId = creationRoundId(tx.inputs[0], configIndex);
      if (cfg.roundId !== wantId) {
        fail.push(
          `the round id is not the creation derivation: config says ` +
          `${cfg.roundId.slice(0, 16)}…, input 0 with config output ` +
          `${configIndex} gives ${wantId.slice(0, 16)}…. round-type refuses ` +
          "this with -17.",
        );
      } else {
        ok.push(`round id matches the creation derivation over input 0`);
      }
      const problems = validateRoundConfig(cfg);
      if (problems.length > 0) {
        for (const why of problems) fail.push(`config invalid: ${why}`);
      } else {
        ok.push("config passes every RoundConfigV1::validate rule");
      }

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

// 4. every input's lock has a cell dep.
//
// A lock only runs on a SPEND, so nothing before broadcast exercises this and
// the node's answer is a bare `ScriptNotFound` naming a code hash. Checking it
// needs a node, so it is skipped rather than guessed at when one is not
// reachable — a check that silently passes when it could not run is worse than
// no check.
const rpcUrl = process.env.CKB_URL ?? "http://192.168.68.134:8114";
const rpc = { call: async (m, prm) => {
  const r = await fetch(rpcUrl, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id: 1, jsonrpc: "2.0", method: m, params: prm }),
  });
  const b = await r.json();
  if (b.error) throw new Error(JSON.stringify(b.error));
  return b.result;
} };
try {
  for (const [i, input] of (tx.inputs ?? []).entries()) {
    const cell = await rpc.call("get_live_cell", [input.previous_output, false]);
    if (cell.status !== "live") {
      fail.push(`input ${i} is ${cell.status}, not live — something already spent it`);
      continue;
    }
    const lockScript = cell.cell.output.lock;
    if (await depsProvide(rpc, tx.cell_deps ?? [], lockScript)) {
      ok.push(`input ${i}'s lock has a cell dep providing it`);
    } else {
      fail.push(
        `input ${i}'s lock (code_hash ${lockScript.code_hash.slice(0, 18)}…) has ` +
        "NO cell dep providing it; the node will refuse this with " +
        `ScriptNotFound on Inputs[${i}].Lock`,
      );
    }
  }
} catch (e) {
  ok.push(`cell-dep check SKIPPED: could not reach ${rpcUrl} (${e.message})`);
}

// 5. the entry window is still open NOW. A signed round file can sit unsent
// for days; round 0x7000bce2 did, and went on chain already expired. Unlike
// the dep check this does not degrade to a skip: a round sent without knowing
// the clock is exactly the failure being prevented.
if (checkedConfig) {
  try {
    const tip = await rpc.call("get_tip_header", []);
    const nowEpoch = BigInt(tip.epoch) & 0xffffffn;
    const why = entryWindowProblem(checkedConfig, nowEpoch);
    if (why) fail.push(why);
    else ok.push(`entry window open: epoch ${nowEpoch}, closes at ${checkedConfig.entryEnd}`);
  } catch (e) {
    fail.push(`could not read the chain's epoch from ${rpcUrl} (${e.message}); ` +
      "refusing rather than sending a round whose window may already be closed");
  }
}

for (const line of ok) console.log(`  ok    ${line}`);
for (const line of fail) console.log(`  FAIL  ${line}`);

if (fail.length > 0) {
  console.log(`\nDo NOT send ${file}.`);
  process.exit(1);
}
console.log(`\n${file} is signed and the schedule survived. Safe to send.`);
