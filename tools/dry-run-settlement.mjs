#!/usr/bin/env node
// Settle a round against a LIVE chain, without a wallet: the three steps that
// return a round's money once its tickets are in the Nervos DAO.
//
//   phase-one   each batch's DAO deposit becomes a withdrawing cell
//   phase-two   a batch's withdrawing cell becomes its settlement cell
//   payout      participants are paid back from a batch's settlement cell
//
// It reads the chain, says where every batch of the round stands, builds the
// next transaction, re-derives the contracts' rules from the built bytes, and
// writes an UNSIGNED ckb-cli tx file. It NEVER signs and NEVER sends.
//
// Usage:
//   node tools/dry-run-settlement.mjs <manifest.json> --round <id prefix>
//        [--step phase-one|phase-two|payout] [--batch N] [--count N]
//        [--sponsor txhash:index] [--out FILE]
//
// Timing, which the contracts fix and this tool only reports:
//   - phase one is refused until a FULL TERM (180 epochs, about 30 days) after
//     the deposit;
//   - the withdrawal then matures at the next 180-epoch boundary counted from
//     the deposit, so phase two comes about 60 days after the deposit;
//   - the last participant of a batch cannot be paid until that batch's
//     prizes are redeemed, unless at least 307 CKB of them are still unclaimed.

import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { ccc } from "../apps/web/vendor/ccc.min.mjs";
import { depsProvide, resolveLockDep, resolveCodeDeps } from "./lock-deps.mjs";
import {
  toRpc, depFromRpc, scriptFromRpc, scriptToRpc, pointFromRpc, pointToRpc, inclusionHeader, checkSettlement,
} from "./settlement-io.mjs";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const require_ = createRequire(path.join(ROOT, "tools/"));
const { loadManifest } = require_("../apps/web/chain/manifest.js");
const { createRpc } = require_("../apps/web/chain/rpc.js");
const discovery = require_("../apps/web/chain/discovery.js");
const sealCodec = require_("../apps/web/chain/seal-codec.js");
const { decodeBatchCommitment } = require_("../apps/web/chain/ledger-codec.js");
const { decodeEntryDataV1 } = require_("../apps/web/chain/entry-codec.js");
const { decodeSchedule } = require_("../apps/web/chain/schedule.js");
const { decodeSettlementFunding } = require_("../apps/web/chain/settlement-codec.js");
const { deriveEntitlements } = require_("../apps/web/chain/entitlements.js");
const { buildDaoPhaseOneTx, buildDaoPhaseTwoTx, phaseOneSince, maturityOf } = require_("../apps/web/chain/dao-tx.js");
const { buildPayoutTx, FUNDING_CELL_CKB } = require_("../apps/web/chain/payout-tx.js");
const { scriptHash } = require_("../apps/web/chain/refund-tx.js");

const [manifestPath, ...rest] = process.argv.slice(2);
if (!manifestPath) {
  console.error("usage: node tools/dry-run-settlement.mjs <manifest.json> --round <id prefix> [--step ...] [--batch N] [--out FILE]");
  process.exit(2);
}
const flag = (name, fallback = null) => {
  const at = rest.indexOf(name);
  return at === -1 ? fallback : rest[at + 1];
};
const requestedStep = flag("--step");
const onlyBatch = flag("--batch") === null ? null : BigInt(flag("--batch"));
const count = flag("--count") === null ? undefined : Number(flag("--count"));
const outFile = flag("--out");
const sponsorRef = flag("--sponsor");
const roundPrefix = flag("--round");

const manifest = loadManifest(JSON.parse(fs.readFileSync(manifestPath, "utf8")));
const rpc = createRpc(manifest.rpcUrl);
const CKB = 100000000n;
const HASH_TYPE_NAME = { 0: "data", 1: "type", 2: "data1", 4: "data2" };
const strip = (s) => String(s ?? "").replace(/^0x/, "").toLowerCase();
const unhex = (s) => Uint8Array.from(strip(s).match(/../g) ?? [], (b) => parseInt(b, 16));
const leToBig = (hex16) => BigInt("0x" + hex16.match(/../g).reverse().join(""));
const epochOf = (field) => BigInt(field) & 0xffffffn;
const days = (epochs) => `about ${(Number(epochs) / 6).toFixed(1)} days`;
const short = (p) => `${p.txHash.slice(0, 18)}…:${p.index}`;
const stop = (message, code = 0) => { console.log(message); process.exit(code); };

const tip = await rpc.call("get_tip_header", []);
const nowEpoch = epochOf(tip.epoch);
console.log(`node        ${manifest.rpcUrl}  (${manifest.network}, epoch ${nowEpoch})`);

// --- the round -------------------------------------------------------------
const rounds = await discovery.findRounds(rpc, manifest);
if (!roundPrefix) {
  stop("Pass --round <id prefix>. On chain: " + rounds.map((r) => r.config.roundId.slice(0, 10)).join(", "), 1);
}
const matching = rounds.filter((r) => r.config.roundId.startsWith(strip(roundPrefix)));
if (matching.length === 0) stop(`No round on chain starts with ${roundPrefix}.`, 1);
if (matching.length > 1) {
  stop(`${matching.length} rounds start with ${roundPrefix}; give more of the id: ` +
    matching.map((r) => r.config.roundId.slice(0, 16)).join(", "), 1);
}
const [round] = matching;
const config = round.config;
const commitment = config.commitment.toLowerCase();
console.log(`round       ${config.roundId.slice(0, 16)}…  (${config.daoTermPeriods} term(s) committed)`);

const named = (ref) => ({ code_hash: "0x" + ref.codeHash, hash_type: HASH_TYPE_NAME[Number(ref.hashType)] });
async function scan(ref, scriptType, argsPrefix) {
  const found = [];
  for await (const cell of rpc.getCells({
    script: { ...named(ref), args: "0x" + argsPrefix }, script_type: scriptType, script_search_mode: "prefix",
  })) found.push(cell);
  return found;
}
const shaped = (cell) => ({
  outPoint: pointFromRpc(cell.out_point), capacity: BigInt(cell.output.capacity),
  lock: scriptFromRpc(cell.output.lock), type: scriptFromRpc(cell.output.type), data: cell.output_data ?? "0x",
});

// --- what the chain holds for this round -------------------------------------
// The recorded result, the batch receipts (which never move, so they are the
// list of batches), the DAO cells and the settlement cells.
let recordCell = null;
const receipts = new Map();
for (const cell of await scan(config.entryShardType, "type", commitment)) {
  const args = strip(cell.output.type.args);
  const data = unhex(cell.output_data ?? "0x");
  if (args.length === 72 && data[0] === sealCodec.RECORD_VERSION
    && data.length === sealCodec.recordSize(config.entryShardCount)) {
    recordCell = { ...shaped(cell), record: sealCodec.decodeEntropyRecord(data, config.entryShardCount) };
  }
}
for (const cell of await scan(config.entryShardType, "type", "02" + commitment)) {
  const args = strip(cell.output.type.args);
  if (args.length !== 154) continue;
  receipts.set(leToBig(args.slice(74, 90)), {
    ...shaped(cell), digest: args.slice(90), receipt: decodeBatchCommitment(unhex(cell.output_data)),
  });
}
// Anyone can create a cell under a batch's DAOWOW lock: a lock's args are not
// checked when a cell is made. So a cell counts as the batch's DAO cell only
// if it is a native DAO cell and, while still a deposit, was created by the
// same transaction as the batch's receipt. (A withdrawing cell can only come
// from spending the real deposit, which the lock guards.) Two candidates for
// one batch is something to stop and look at, not to choose between.
const daoCells = new Map();
for (const cell of await scan(config.daoLock, "lock", config.roundId)) {
  const args = strip(cell.output.lock.args);
  if (args.length !== 208 || args.slice(80, 144) !== commitment) continue;
  const id = leToBig(args.slice(64, 80));
  const receipt = receipts.get(id);
  const type = scriptFromRpc(cell.output.type);
  if (!receipt || receipt.digest !== args.slice(144)) continue;
  if (!type || scriptHash(type) !== config.daoType.codeHash.toLowerCase()) continue;
  const isDeposit = strip(cell.output_data ?? "0x") === "00".repeat(8);
  if (isDeposit && cell.out_point.tx_hash.toLowerCase() !== receipt.outPoint.txHash.toLowerCase()) continue;
  if (daoCells.has(id)) stop(`Batch ${id} has more than one DAO cell that looks genuine. Stopping: look at both before going on.`, 1);
  daoCells.set(id, shaped(cell));
}
const fundingCells = new Map();
for (const cell of await scan(config.settlementType, "type", commitment)) {
  const args = strip(cell.output.type.args);
  if (args.length !== 144) continue;
  fundingCells.set(leToBig(args.slice(64, 80)), { ...shaped(cell), state: decodeSettlementFunding(unhex(cell.output_data)) });
}

if (receipts.size === 0) stop("\nThis round has no batch in the DAO: nothing to settle.");
console.log(recordCell
  ? `result      recorded at ${short(recordCell.outPoint)}`
  : "result      NOT recorded yet: seal the round and record its result before phase two");

// Where each batch stands, and when it can move.
const batches = [];
for (const id of [...receipts.keys()].sort((a, b) => (a < b ? -1 : 1))) {
  const receipt = receipts.get(id);
  const batch = { id, receipt, stage: "settled", cell: null };
  const funding = fundingCells.get(id);
  // A settlement cell can only be created by the contract, from the batch's
  // real withdrawal. Once it exists, nothing under the DAO lock matters.
  const dao = funding ? null : daoCells.get(id);
  if (dao && strip(dao.data) === "00".repeat(8)) {
    batch.stage = "deposit";
    batch.cell = dao;
    batch.depositHeader = await inclusionHeader(rpc, dao.outPoint.txHash);
    batch.sendableEpoch = epochOf(phaseOneSince(batch.depositHeader.epoch, Number(config.daoTermPeriods)));
  } else if (dao) {
    batch.stage = "withdrawing";
    batch.cell = dao;
    batch.depositHeader = await rpc.call("get_header_by_number", ["0x" + leToBig(strip(dao.data)).toString(16)]);
    batch.withdrawHeader = await inclusionHeader(rpc, dao.outPoint.txHash);
    batch.maturity = maturityOf(batch.depositHeader.epoch, batch.withdrawHeader.epoch);
  } else if (funding) {
    batch.stage = "settlement";
    batch.cell = funding;
  }
  batches.push(batch);
}
console.log("\nbatches");
for (const b of batches) {
  const size = `${b.receipt.receipt.entryCount} entr(ies), ${b.receipt.receipt.inputCapacity / CKB} CKB`;
  if (b.stage === "deposit") {
    const wait = b.sendableEpoch > nowEpoch ? `in ${b.sendableEpoch - nowEpoch} epochs, ${days(b.sendableEpoch - nowEpoch)}` : "NOW";
    console.log(`  ${b.id}  in the DAO since epoch ${epochOf(b.depositHeader.epoch)}  (${size})`);
    console.log(`       phase one from epoch ${b.sendableEpoch}: ${wait}`);
  } else if (b.stage === "withdrawing") {
    const wait = b.maturity.epoch > nowEpoch ? `in ${b.maturity.epoch - nowEpoch} epochs, ${days(b.maturity.epoch - nowEpoch)}` : "NOW";
    console.log(`  ${b.id}  withdrawing  (${size})`);
    console.log(`       matures at epoch ${b.maturity.epoch}: ${wait}`);
  } else if (b.stage === "settlement") {
    const s = b.cell.state;
    console.log(`  ${b.id}  settlement cell: ${s.payoutCursor} of ${s.liabilityCount} participant(s) paid, ` +
      `prizes ${s.prizePaid} of ${s.prizePool} shannons redeemed`);
  } else {
    console.log(`  ${b.id}  settled: no DAO cell and no settlement cell remain  (${size})`);
  }
}

// --- which step ------------------------------------------------------------
const wanted = (b) => onlyBatch === null || b.id === onlyBatch;
const inStage = (stage) => batches.filter((b) => b.stage === stage && wanted(b));
const step = requestedStep ?? (
  inStage("settlement").some((b) => b.cell.state.payoutCursor < b.cell.state.liabilityCount) ? "payout"
    : inStage("withdrawing").some((b) => b.maturity.epoch <= nowEpoch) ? "phase-two"
      : inStage("deposit").some((b) => b.sendableEpoch <= nowEpoch) ? "phase-one"
        : null);
if (!step) stop("\nNEXT STEP   nothing can be sent yet. The dates above are when each batch can move.");
console.log(`\nNEXT STEP   ${step}`);

// --- the sponsor -----------------------------------------------------------
const OPERATOR_LOCK_ARG = "0xa776bf02d19cafa3749d906cc2c9ab1cf1e80ff7";
const SECP = {
  codeHash: "0x9bd7e06f3ecf4be0f2fcd2188b23f1b9fcc88e5d4b65a8637b17723bbda3cce8", hashType: "type", args: OPERATOR_LOCK_ARG,
};
async function findSponsor() {
  if (sponsorRef) {
    const [tx_hash, idx] = sponsorRef.split(":");
    const got = await rpc.call("get_live_cell", [{ tx_hash, index: "0x" + Number(idx).toString(16) }, true]);
    if (got.status !== "live") throw new Error(`sponsor cell is ${got.status}`);
    if (got.cell.output.type || (got.cell.data?.content ?? "0x") !== "0x") {
      throw new Error("that sponsor cell carries a type script or data; a sponsor must be a plain cell");
    }
    if (scriptHash(scriptFromRpc(got.cell.output.lock)) !== scriptHash(SECP)) {
      throw new Error("that sponsor cell is not under the operator's lock");
    }
    return { outPoint: { txHash: tx_hash, index: Number(idx) }, capacity: BigInt(got.cell.output.capacity), lock: SECP };
  }
  // Small pages, and the first adequate cell: a full scan of the operator's
  // cells makes the indexer time out.
  let best = null;
  let seen = 0;
  for await (const cell of rpc.getCells({ script: scriptToRpc(SECP), script_type: "lock" }, { limit: 20 })) {
    seen += 1;
    if (cell.output.type || (cell.output_data ?? "0x") !== "0x") continue;
    const capacity = BigInt(cell.output.capacity);
    if (capacity >= 500n * CKB) return { outPoint: pointFromRpc(cell.out_point), capacity, lock: SECP };
    if (!best || capacity > best.capacity) best = { outPoint: pointFromRpc(cell.out_point), capacity, lock: SECP };
    if (seen >= 200) break;
  }
  if (!best) throw new Error("no plain sponsor cell found under the operator lock; pass --sponsor txhash:index");
  return best;
}
const sponsor = await findSponsor();
// As PLAIN CODE deps: the DAOWOW lock refuses a dep group anywhere in a DAO
// transaction, so the system lock's group is opened into its two cells.
const lockDeps = await resolveCodeDeps(rpc, scriptToRpc(SECP));
if (!lockDeps) throw new Error("no cell dep on this chain provides the sponsor's lock");
sponsor.lockDeps = lockDeps.map(depFromRpc);
console.log(`sponsor     ${short(sponsor.outPoint)}  ${sponsor.capacity / CKB} CKB, lock deps ${sponsor.lockDeps.length} (plain code)`);

async function nativeDaoDep() {
  const codeHash = (await rpc.call("get_consensus", [])).dao_type_hash;
  const script = { codeHash, hashType: "type", args: "0x" };
  const deps = await resolveCodeDeps(rpc, scriptToRpc(script));
  if (!deps || deps.length !== 1) throw new Error("no single code cell on this chain provides the native DAO type");
  return { ...depFromRpc(deps[0]), script };
}

// A batch's evidence, read back from the chain: the schedule from the round's
// creation witness, and the entries with their cells' capacities from the
// cells the aggregate transaction spent.
async function batchEvidence(batch) {
  const created = await rpc.call("get_transaction", [round.outPoint.txHash]);
  const witness = ccc.WitnessArgs.fromBytes(ccc.bytesFrom(created.transaction.witnesses[0]));
  const schedule = decodeSchedule(ccc.bytesFrom(witness.outputType));
  const aggregate = await rpc.call("get_transaction", [batch.receipt.outPoint.txHash]);
  const entryLock = "0x" + config.entryLock.codeHash;
  const entries = [];
  const capacities = [];
  const entryTxs = [];
  for (const input of aggregate.transaction.inputs) {
    const source = await rpc.call("get_transaction", [input.previous_output.tx_hash]);
    const index = Number(BigInt(input.previous_output.index));
    const output = source.transaction.outputs[index];
    if (output.lock.code_hash !== entryLock) continue;
    entries.push(decodeEntryDataV1(unhex(source.transaction.outputs_data[index])));
    capacities.push(BigInt(output.capacity));
    entryTxs.push(source.transaction);
  }
  return { schedule, entries, capacities, entryTxs, receipt: batch.receipt.receipt };
}

// --- build -----------------------------------------------------------------
const configCellOutPoint = round.outPoint;
let built;
if (step === "phase-one") {
  const ripe = inStage("deposit").filter((b) => b.sendableEpoch <= nowEpoch);
  const early = inStage("deposit").filter((b) => b.sendableEpoch > nowEpoch);
  // Built even when early, so the transaction can be inspected ahead of time;
  // the node will not take it before the epoch named.
  const chosen = ripe.length > 0 ? ripe : early;
  if (chosen.length === 0) stop("No batch of this round is still a DAO deposit.");
  if (ripe.length === 0) {
    console.log(`            NOT SENDABLE YET: the node refuses this until epoch ` +
      `${chosen.reduce((m, b) => (b.sendableEpoch > m ? b.sendableEpoch : m), 0n)}. Built for inspection only.`);
  }
  built = buildDaoPhaseOneTx({
    manifest, config, sponsor, configCellOutPoint, daoTypeDep: await nativeDaoDep(),
    deposits: chosen.map((b) => ({ ...b.cell, receiptOutPoint: b.receipt.outPoint })),
    depositHeaders: chosen.map((b) => b.depositHeader),
  });
  chosen.forEach((b, i) => {
    console.log(`  batch ${b.id}  withdrawal matures at epoch ${built.maturityEpochs[i]} ` +
      `(${days(built.maturityEpochs[i] - nowEpoch)} from now), if this is committed before then`);
  });
} else if (step === "phase-two") {
  if (!recordCell) stop("Phase two needs the round's result recorded on chain first.", 1);
  const [batch] = inStage("withdrawing").sort((a, b) => (a.maturity.epoch < b.maturity.epoch ? -1 : 1));
  if (!batch) stop("No batch of this round is a withdrawing cell.");
  if (batch.maturity.epoch > nowEpoch) {
    console.log(`            NOT SENDABLE YET: matures at epoch ${batch.maturity.epoch}. Built for inspection only.`);
  }
  const evidence = await batchEvidence(batch);
  built = buildDaoPhaseTwoTx({
    manifest, config, sponsor, configCellOutPoint, daoTypeDep: await nativeDaoDep(),
    withdrawing: { ...batch.cell, receiptOutPoint: batch.receipt.outPoint },
    depositHeader: batch.depositHeader, withdrawHeader: batch.withdrawHeader,
    record: recordCell.record, recordOutPoint: recordCell.outPoint,
    schedule: evidence.schedule, receipt: evidence.receipt, entries: evidence.entries, capacities: evidence.capacities,
  });
  const f = built.entitlements.funding;
  console.log(`  batch ${batch.id}  the DAO pays ${built.realized} shannons: ${f.principalLiability / CKB} CKB of ` +
    `deposits and ${f.prizePool} shannons of interest`);
  console.log(`            ${f.liabilityCount} participant(s) to repay, ${f.prizeCount} prize(s) for ticket holders to redeem`);
} else if (step === "payout") {
  if (!recordCell) stop("A payout needs the round's recorded result to re-derive who is owed what.", 1);
  const candidates = inStage("settlement").filter((b) => b.cell.state.payoutCursor < b.cell.state.liabilityCount);
  if (candidates.length === 0) stop("No settlement cell of this round has anyone left to pay.");
  // The first batch that can pay. One waiting on its prizes must not hide
  // another that is ready.
  let batch = null;
  const waiting = [];
  for (const candidate of candidates) {
    const evidence = await batchEvidence(candidate);
    const state = candidate.cell.state;
    const { liabilities } = deriveEntitlements({
      config, record: recordCell.record, batchId: state.batchId, realizedTotal: state.realizedTotal,
      schedule: evidence.schedule, receipt: evidence.receipt, entries: evidence.entries, capacities: evidence.capacities,
    });
    // A participant's lock script is not in their entry, only its hash. It is
    // on the transaction that made the entry: their tickets were minted under it.
    const locks = {};
    for (const entryTx of evidence.entryTxs) {
      for (const output of entryTx.outputs) {
        const lock = scriptFromRpc(output.lock);
        locks[scriptHash(lock)] = lock;
      }
    }
    try {
      built = buildPayoutTx({ manifest, funding: candidate.cell, liabilities, locks, sponsor, count });
      batch = candidate;
      break;
    } catch (e) {
      waiting.push(`  batch ${candidate.id}: ${e.message}`);
    }
  }
  if (!batch) stop("No batch can pay anyone right now.\n" + waiting.join("\n"), 1);
  for (const line of waiting) console.log(line);
  console.log(`  batch ${batch.id}  paying ${built.paid.length} participant(s)` +
    (built.final ? ", which closes the settlement cell" : ""));
  if (built.held > 0 && count === undefined) {
    console.log(`            ${built.held} more cannot be paid yet: the cell must stay above its ` +
      `${FUNDING_CELL_CKB} CKB floor until this batch's prizes are redeemed`);
  }
  if (built.gift > 0n) console.log(`            the sponsor tops up small payments by ${built.gift} shannons`);
} else {
  stop(`unknown step ${step}`, 2);
}

// --- report and check ------------------------------------------------------
const tx = built.tx;
console.log("\n--- the transaction ---");
console.log(`  cell deps ${tx.cellDeps.length}, header deps ${tx.headerDeps.length}, inputs ${tx.inputs.length}, ` +
  `outputs ${tx.outputs.length}, witnesses ${tx.witnesses.length}`);
tx.outputs.forEach((o, i) => {
  console.log(`    ${i}  ${String(BigInt(o.capacity) / CKB).padStart(10)} CKB  ${o.type ? "typed" : "plain"}`);
});
const problems = [];
if (tx.witnesses.length !== tx.inputs.length) problems.push("witnesses and inputs are unbalanced");

// Every script that will run needs its code among the cell deps.
const depsRpc = toRpc(tx).cell_deps;
for (const [i, input] of tx.inputs.entries()) {
  const got = await rpc.call("get_live_cell", [pointToRpc(input.previousOutput), false]);
  if (got.status !== "live") { problems.push(`input ${i} is ${got.status} on the live chain`); continue; }
  if (!(await depsProvide(rpc, depsRpc, got.cell.output.lock))) problems.push(`input ${i}'s lock has no cell dep providing it`);
  if (got.cell.output.type && !(await depsProvide(rpc, depsRpc, got.cell.output.type))) {
    problems.push(`input ${i}'s type has no cell dep providing it`);
  }
}
for (const [i, o] of tx.outputs.entries()) {
  if (o.type && !(await depsProvide(rpc, depsRpc, scriptToRpc(o.type)))) problems.push(`output ${i}'s type has no cell dep providing it`);
}
const { step: seen, reasons } = await checkSettlement(rpc, config, tx);
if (seen !== step) problems.push(`built as ${step} but it reads as ${seen ?? "nothing recognisable"}`);
problems.push(...reasons);

if (problems.length === 0) {
  console.log("  ok    every script has its code among the cell deps");
  console.log("  ok    every settlement rule re-derived from the built bytes passes");
} else {
  for (const why of problems) console.log(`  FAIL  ${why}`);
}

if (outFile && problems.length === 0) {
  fs.writeFileSync(outFile, JSON.stringify({ transaction: toRpc(tx), multisig_configs: {}, signatures: {} }, null, 2));
  console.log(`\nwrote ${outFile} in ckb-cli's tx-file format (unsigned; this tool never signs).`);
  console.log("Do NOT run `tx init` — it writes an EMPTY file over this one.\n");
  console.log("  # 1. sign (--skip-check is required: ckb-cli cannot classify the DAOWOW locks)");
  console.log(`  ckb-cli --url ${manifest.rpcUrl} tx sign-inputs --tx-file ${outFile} \\`);
  console.log(`      --from-account ${OPERATOR_LOCK_ARG} --add-signatures --skip-check`);
  console.log("  # 2. check the signed file");
  console.log(`  node tools/check-signed-lifecycle.mjs ${manifestPath} ${outFile}`);
  console.log("  # 3. send");
  console.log(`  ckb-cli --url ${manifest.rpcUrl} tx send --tx-file ${outFile} --skip-check`);
} else if (outFile) {
  console.log(`\nNOT writing ${outFile}: the transaction above would be refused.`);
}
if (problems.length > 0) process.exit(1);
