#!/usr/bin/env node
// Check a SIGNED lifecycle transaction before it is sent.
//
// Runs between `tx sign-inputs` and `tx send`, and re-derives everything from
// the signed bytes rather than trusting what built them. Four distinct
// failures were found this way on the round-creation transaction alone — a
// wiped file, an unclassifiable output lock, a missing cell dep, and an
// invented round id — and each is a guard here or in its sibling.
//
// It never signs and never sends.
//
// Usage: node tools/check-signed-lifecycle.mjs <manifest.json> <tx-file.json>

import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { ccc } from "../apps/web/vendor/ccc-joyid.min.mjs";
import { depsProvide } from "./lock-deps.mjs";
import { checkFreeze, checkGenesis, checkAggregate, checkClose, checkSeal, checkEntropy } from "./lifecycle-rules.mjs";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const require_ = createRequire(path.join(ROOT, "tools/"));
const { loadManifest } = require_("../apps/web/chain/manifest.js");
const { createRpc } = require_("../apps/web/chain/rpc.js");
const codec = require_("../apps/web/chain/codec.js");
const ledgerCodec = require_("../apps/web/chain/ledger-codec.js");
const { decodeEntryDataV1 } = require_("../apps/web/chain/entry-codec.js");
const { decodeLedgerWitness } = require_("../apps/web/chain/ledger-witness.js");
const sealCodec = require_("../apps/web/chain/seal-codec.js");
const { entropyHeights } = require_("../apps/web/chain/entropy-tx.js");

const [manifestPath, file] = process.argv.slice(2);
if (!manifestPath || !file) {
  console.error("usage: node tools/check-signed-lifecycle.mjs <manifest.json> <tx-file.json>");
  process.exit(2);
}

const manifest = loadManifest(JSON.parse(fs.readFileSync(manifestPath, "utf8")));
const rpc = createRpc(manifest.rpcUrl);
const doc = JSON.parse(fs.readFileSync(file, "utf8"));
const tx = doc.transaction ?? doc;
const ok = [];
const fail = [];
const CKB = 100000000n;
const unhex = (s) => Uint8Array.from((s.startsWith("0x") ? s.slice(2) : s)
  .match(/../g) ?? [], (b) => parseInt(b, 16));

if (!tx.inputs || tx.inputs.length === 0) {
  console.error(`REFUSING: ${file} has no inputs.`);
  console.error("  If you ran `ckb-cli tx init` on it, that OVERWROTE the file");
  console.error("  with an empty skeleton. Rebuild it with dry-run-lifecycle.mjs.");
  process.exit(1);
}

// --- resolve every input off chain ----------------------------------------
const resolved = [];
for (const [i, input] of tx.inputs.entries()) {
  const got = await rpc.call("get_live_cell", [input.previous_output, true]);
  if (got.status !== "live") {
    fail.push(`input ${i} is ${got.status}, not live — something already spent it`);
    resolved.push(null);
    continue;
  }
  resolved.push(got.cell);
}
if (resolved.some((c) => c === null)) {
  for (const line of fail) console.log(`  FAIL  ${line}`);
  console.log(`\nDo NOT send ${file}.`);
  process.exit(1);
}

// --- the signature, and the cell deps -------------------------------------
const OPERATOR = Object.keys(doc.signatures ?? {})[0];
if (OPERATOR && (doc.signatures[OPERATOR] ?? []).length > 0) {
  ok.push(`signature recorded for ${OPERATOR.slice(0, 12)}… ` +
    "(ckb-cli assembles it into the witness at send)");
} else {
  const anySigned = (tx.witnesses ?? []).some((w, i) => {
    if (i === 0) return false;           // index 0 may be a raw proof witness
    return w && w !== "0x" && !/^0x0+$/.test(w);
  });
  if (!anySigned) {
    fail.push(
      "no signature anywhere: the signatures map is empty and no witness " +
      "carries one. Run tx sign-inputs --add-signatures.",
    );
  } else {
    ok.push("a signature is present in the witnesses");
  }
}

for (const [i, cell] of resolved.entries()) {
  const provided = await depsProvide(rpc, tx.cell_deps ?? [], cell.output.lock);
  if (provided) {
    ok.push(`input ${i}'s lock has a cell dep providing it`);
  } else {
    fail.push(
      `input ${i}'s lock (code_hash ${cell.output.lock.code_hash.slice(0, 18)}…) ` +
      `has NO cell dep; the node will refuse this with ScriptNotFound on ` +
      `Inputs[${i}].Lock`,
    );
  }
}

// --- which step is this, and does it obey its rules? ----------------------
// Told apart by DATA LENGTH, exactly as the contract's own dispatch does.
const shardType = manifest.scripts["entry-shard-type"];
const isShardTyped = (cell) =>
  cell.type && cell.type.code_hash === shardType.codeHash;

const inData = resolved.map((c, i) => unhex(tx.witnesses ? (c.data?.content ?? "0x") : "0x"));
const protocolIn = resolved
  .map((cell, i) => ({ i, cell, data: unhex(cell.data?.content ?? "0x") }))
  .filter((x) => isShardTyped(x.cell.output));
const protocolOut = tx.outputs
  .map((o, i) => ({ i, o, data: unhex(tx.outputs_data[i] ?? "0x") }))
  .filter((x) => x.o.type && x.o.type.code_hash === shardType.codeHash);

// The round config travels as a cell dep; read it from there.
let config = null;
for (const dep of tx.cell_deps ?? []) {
  const got = await rpc.call("get_live_cell", [dep.out_point, true]);
  if (got.status !== "live") continue;
  const data = unhex(got.cell.data?.content ?? "0x");
  if (data.length === 358) { config = codec.decodeRoundConfigV1(data); break; }
}
if (!config) {
  fail.push("no round config cell among the cell deps; the contract reads it from there");
}

if (config && protocolIn.length === 1 && protocolOut.length >= 1) {
  const src = protocolIn[0];
  const dst = protocolOut[0];
  if (src.data.length === 101 && dst.data.length === 101) {
    const reasons = checkFreeze({
      config,
      before: codec.decodeEntryShardDataV1(src.data),
      after: codec.decodeEntryShardDataV1(dst.data),
      since: BigInt(tx.inputs[src.i].since),
    });
    reasons.length ? reasons.forEach((r) => fail.push(`freeze: ${r}`))
                   : ok.push("freeze: every rule passes");
  } else if (src.data.length === 101 && dst.data.length === 207) {
    const entryLock = manifest.scripts["entry-lock"];
    const entryInputCount = resolved.filter(
      (c) => c.output.lock.code_hash === entryLock.codeHash).length;
    const reasons = checkGenesis({
      config,
      frozen: codec.decodeEntryShardDataV1(src.data),
      state: ledgerCodec.decodeAggregationState(dst.data),
      inCapacity: BigInt(src.cell.output.capacity),
      outCapacity: BigInt(dst.o.capacity),
      entryInputCount,
    });
    reasons.length ? reasons.forEach((r) => fail.push(`genesis: ${r}`))
                   : ok.push("genesis: every rule passes");
  } else if (src.data.length === 207 && dst.data[0] === sealCodec.SEAL_VERSION) {
    // 207 to a seal: sealing the closed ledger.
    const entryLock = manifest.scripts["entry-lock"];
    // A seal the decoder refuses is a verdict, not a crash. A thrown error here
    // would end the run with a stack trace and no "Do NOT send" — which reads
    // as "not caught" and is worse than a wrong answer.
    let after;
    try {
      after = sealCodec.decodeRoundSeal(dst.data, config.entryShardCount);
    } catch (e) {
      fail.push(`seal: the seal cell's data does not decode: ${e.message}`);
      reportAndExit();
    }
    const reasons = checkSeal({
      config,
      before: ledgerCodec.decodeAggregationState(src.data),
      after,
      shardId: parseInt((src.cell.output.type.args ?? "").slice(-8).match(/../g).reverse().join(""), 16),
      inCapacity: BigInt(src.cell.output.capacity),
      outCapacity: BigInt(dst.o.capacity),
      entryInputCount: resolved.filter((c) => c.output.lock.code_hash === entryLock.codeHash).length,
    });
    reasons.length ? reasons.forEach((r) => fail.push(`seal: ${r}`))
                   : ok.push("seal: every rule passes");
  } else if (src.data[0] === sealCodec.SEAL_VERSION && dst.data[0] === sealCodec.RECORD_VERSION) {
    // A seal to a record: entropy finalisation.
    //
    // The headers are derived INDEPENDENTLY of what the transaction lists — the
    // seal input's real inclusion block from its creating transaction, and the
    // scheduled blocks by NUMBER from the node — then compared against the
    // header deps the transaction carries. Taking them from the header deps
    // themselves would make the check circular: it would confirm the
    // transaction agrees with itself.
    const entryLock = manifest.scripts["entry-lock"];
    const created = await rpc.call("get_transaction", [tx.inputs[src.i].previous_output.tx_hash]);
    const incHeader = await rpc.call("get_header", [created.tx_status.block_hash]);
    const inclusionHeader = { number: incHeader.number, hash: incHeader.hash };
    const [h64, h128, h192] = entropyHeights(BigInt(incHeader.number));
    const entropyHeaders = [];
    for (const n of [h64, h128, h192]) {
      const h = await rpc.call("get_header_by_number", ["0x" + n.toString(16)]);
      if (!h) {
        fail.push(`entropy: the node has no header at height ${n} yet; the draw is not ready`);
        reportAndExit();
      }
      entropyHeaders.push({ number: h.number, hash: h.hash });
    }
    let record;
    try {
      record = sealCodec.decodeEntropyRecord(dst.data, config.entryShardCount);
    } catch (e) {
      fail.push(`entropy: the record cell's data does not decode: ${e.message}`);
      reportAndExit();
    }
    const reasons = checkEntropy({
      config,
      seal: sealCodec.decodeRoundSeal(src.data, config.entryShardCount),
      record,
      since: BigInt(tx.inputs[src.i].since),
      headerDeps: tx.header_deps ?? [],
      inclusionHeader, entropyHeaders,
      inCapacity: BigInt(src.cell.output.capacity),
      outCapacity: BigInt(dst.o.capacity),
      entryInputCount: resolved.filter((c) => c.output.lock.code_hash === entryLock.codeHash).length,
    });
    reasons.length ? reasons.forEach((r) => fail.push(`entropy: ${r}`))
                   : ok.push("entropy: every rule passes");
    // The binding wait, stated so a premature send is understood as early, not broken.
    const tipNow = BigInt((await rpc.call("get_tip_header", [])).number);
    const earliest = BigInt(incHeader.number) + 256n;
    if (tipNow < earliest) {
      fail.push(
        `entropy: the seal is only ${tipNow - BigInt(incHeader.number)} blocks deep; ` +
        `the node will refuse this until block ${earliest} (${earliest - tipNow} to go)`,
      );
    }
  } else if (src.data.length === 207 && dst.data.length === 207) {
    const entryLock = manifest.scripts["entry-lock"];
    const beforeState = ledgerCodec.decodeAggregationState(src.data);
    const afterState = ledgerCodec.decodeAggregationState(dst.data);
    // A close and a batch are both 207 to 207. Told apart by what MOVED: a
    // close flips the closed flag and carries no entry inputs; a batch leaves
    // it false and carries them.
    if (!beforeState.closed && afterState.closed) {
      const count = resolved.filter(
        (c) => c.output.lock.code_hash === entryLock.codeHash).length;
      const reasons = checkClose({
        config, before: beforeState, after: afterState,
        since: BigInt(tx.inputs[src.i].since), entryInputCount: count,
      });
      reasons.length ? reasons.forEach((r) => fail.push(`close: ${r}`))
                     : ok.push("close: every rule passes");
      const unaccepted = beforeState.frozen.entryCount - beforeState.acceptedEntries;
      ok.push(`close: fixes the accepted prefix at ${beforeState.acceptedEntries}; ` +
        `${unaccepted} entr(ies) become refundable`);
      reportAndExit();
    }
    const entryInputs = resolved
      .map((c, i) => ({ c, i }))
      .filter((x) => x.c.output.lock.code_hash === entryLock.codeHash);
    // A 207-to-207 transition that neither flips `closed` nor carries entry
    // cells changes nothing. The contract refuses it, and reaching the batch
    // path with no entries would crash on a witness that is not there — which
    // is how this case was found, as a crash instead of a verdict.
    if (entryInputs.length === 0) {
      if (beforeState.closed) {
        fail.push("this ledger is already closed; it can only be passed through unchanged");
      } else {
        fail.push(
          "this transition changes nothing: the ledger is not closed, stays " +
          "open, and no entry cells are being accepted",
        );
      }
      reportAndExit();
    }
    const before = beforeState;
    const daoIdx = tx.outputs.findIndex(
      (o) => o.lock.code_hash.replace(/^0x/, "") === config.daoLock.codeHash);
    const receiptIdx = tx.outputs.findIndex(
      (o) => o.type && o.type.code_hash === shardType.codeHash
             && (o.type.args ?? "").length === 2 + 77 * 2);
    const camel = (o) => o && ({
      capacity: BigInt(o.capacity),
      lock: { codeHash: o.lock.code_hash, hashType: o.lock.hash_type, args: o.lock.args },
      type: o.type
        ? { codeHash: o.type.code_hash, hashType: o.type.hash_type, args: o.type.args }
        : null,
    });
    const reasons = checkAggregate({
      config, before,
      after: ledgerCodec.decodeAggregationState(dst.data),
      entries: entryInputs.map((x) => decodeEntryDataV1(unhex(x.c.data.content))),
      capacities: entryInputs.map((x) => BigInt(x.c.output.capacity)),
      ledgerInCapacity: BigInt(src.cell.output.capacity),
      ledgerOutCapacity: BigInt(dst.o.capacity),
      daoOutput: daoIdx === -1 ? null : camel(tx.outputs[daoIdx]),
      daoData: daoIdx === -1 ? null : tx.outputs_data[daoIdx],
      receiptOutput: receiptIdx === -1 ? null : camel(tx.outputs[receiptIdx]),
      proofs: decodeLedgerWitness(unhex(tx.witnesses[src.i])).map((r) => r.proof),
    });
    reasons.length ? reasons.forEach((r) => fail.push(`aggregate: ${r}`))
                   : ok.push("aggregate: every rule passes");
    // The witness must sit at the LEDGER input's own index.
    if (src.i !== 0) {
      fail.push(`the ledger input is at index ${src.i}, not 0; its proof witness moved with it`);
    } else {
      ok.push("the proof witness sits at the ledger input's index");
    }
  } else {
    fail.push(
      `unrecognised transition: ${src.data.length}-byte input to ` +
      `${dst.data.length}-byte output`,
    );
  }
} else if (config) {
  fail.push(
    `expected one shard-typed input and at least one shard-typed output; ` +
    `found ${protocolIn.length} and ${protocolOut.length}`,
  );
}

// --- capacity conservation ------------------------------------------------
function reportAndExit() {
  const inCap = resolved.reduce((s, c) => s + BigInt(c.output.capacity), 0n);
  const outCap = tx.outputs.reduce((s, o) => s + BigInt(o.capacity), 0n);
  if (outCap > inCap) {
    fail.push(`outputs exceed inputs by ${outCap - inCap} shannons`);
  } else if (inCap === outCap) {
    fail.push("the fee is zero; the pool refuses such a transaction before any script runs");
  } else {
    ok.push(`fee ${inCap - outCap} shannons`);
  }
  for (const line of ok) console.log(`  ok    ${line}`);
  for (const line of fail) console.log(`  FAIL  ${line}`);
  if (fail.length > 0) {
    console.log(`\nDo NOT send ${file}.`);
    process.exit(1);
  }
  console.log(`\n${file} passes every check. Safe to send with --skip-check.`);
  process.exit(0);
}

reportAndExit();
