// The settlement rules, re-derived from a FINISHED transaction.
//
// The companion of lifecycle-rules.mjs for gate 3c: DAO phase one, DAO phase
// two and payout. Each function takes the transaction as it is about to be
// sent, with the cells and headers it names resolved from the chain, and
// returns REASONS. The contracts report every one of these as a bare negative
// code; an operator about to sign needs the rule, not the number.
//
// These walk the same checks the contracts walk (dao-lock main.rs,
// daowow-contracts-common entitlements.rs, settlement-type main.rs) over the
// transaction's own bytes. What they share with the builders is only what is
// pinned to Rust byte for byte: the codecs and deriveEntitlements.

import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ccc } from "../apps/web/vendor/ccc.min.mjs";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const require_ = createRequire(path.join(ROOT, "tools/"));
const core = require_("../apps/web/core.js");
const { scriptHash } = require_("../apps/web/chain/refund-tx.js");
const { decodeBatchCommitment } = require_("../apps/web/chain/ledger-codec.js");
const { decodeEntropyRecord } = require_("../apps/web/chain/seal-codec.js");
const settlementCodec = require_("../apps/web/chain/settlement-codec.js");
const { deriveEntitlements, decodeEntitlementWitness } = require_("../apps/web/chain/entitlements.js");
const { decodeSettlementWitness } = require_("../apps/web/chain/payout-tx.js");
const { maturityOf, withdrawingCellOccupied, accumulatedRate } = require_("../apps/web/chain/dao-tx.js");

const CKB = 100000000n;
const HASH_TYPE_NAME = { 0: "data", 1: "type", 2: "data1", 4: "data2" };
const strip = (s) => String(s ?? "").replace(/^0x/, "").toLowerCase();
const hexRaw = (b) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
const unhex = (s) => Uint8Array.from(strip(s).match(/../g) ?? [], (b) => parseInt(b, 16));
const u64le = (v) => hexRaw(core.u64le(BigInt(v)));
const leToBig = (hex16) => BigInt("0x" + hex16.match(/../g).reverse().join(""));
const sameScript = (a, b) => Boolean(a && b) && strip(a.codeHash) === strip(b.codeHash)
  && a.hashType === b.hashType && strip(a.args) === strip(b.args);
// A script built by one of the round's configured scripts.
const builtBy = (script, ref) => Boolean(script)
  && strip(script.codeHash) === ref.codeHash.toLowerCase()
  && script.hashType === HASH_TYPE_NAME[Number(ref.hashType)];
const occupied = (cell) => {
  const size = (s) => (s ? 33n + BigInt(strip(s.args).length / 2) : 0n);
  return (8n + size(cell.lock) + size(cell.type) + BigInt(strip(cell.data).length / 2)) * CKB;
};
// is_public_settlement_lock: the type's own code, with the single arg byte 0.
const isPublicLock = (lock, type) => Boolean(lock && type)
  && strip(lock.codeHash) === strip(type.codeHash) && lock.hashType === type.hashType
  && strip(lock.args) === "00";

/**
 * absolute_epoch_after_dao_term (epoch.rs): the since must be an absolute
 * epoch at least `periods` whole terms after the deposit, at no earlier a
 * fraction of its epoch. Returns a reason, or null.
 */
export function daoTermReason(since, depositEpochField, periods) {
  const raw = BigInt(since);
  if (raw >> 56n !== 0x20n) {
    return `the since has top byte 0x${(raw >> 56n).toString(16)}; an absolute epoch (0x20) is required`;
  }
  const number = raw & 0xffffffn;
  const index = (raw >> 24n) & 0xffffn;
  const length = (raw >> 40n) & 0xffffn;
  if (!(index < length || (index === 0n && length === 0n))) {
    return "the since names a fraction that is not inside an epoch";
  }
  const d = BigInt(depositEpochField);
  const target = (d & 0xffffffn) + BigInt(periods) * 180n;
  const dIndex = (d >> 24n) & 0xffffn;
  const dLength = ((d >> 40n) & 0xffffn) || 1n;
  if (number < target || (number === target && index * dLength < dIndex * (length || 1n))) {
    return `the since names epoch ${number}, before a full term from the deposit (epoch ${target} at the deposit's fraction)`;
  }
  return null;
}

// The lock rejects the whole transaction on any dep that is not a plain code
// dep, or that is named twice (authenticated_deposit_receipt).
function depShapeReasons(tx) {
  const bad = [];
  const seen = new Set();
  tx.cellDeps.forEach((dep, i) => {
    if (dep.depType !== "code") bad.push(`cell dep ${i} is a dep group; the DAOWOW lock accepts only plain code deps`);
    const key = `${strip(dep.outPoint.txHash)}:${Number(dep.outPoint.index)}`;
    if (seen.has(key)) bad.push(`cell dep ${i} names a cell already named; the DAOWOW lock refuses a repeat`);
    seen.add(key);
  });
  return bad;
}

// The batch receipts among the cell deps that belong to this DAO lock.
function receiptsFor(config, tx, depCells, lockArgs) {
  const batch = lockArgs.slice(64, 80);
  const shard = Number(leToBig(batch) >> 56n);
  const want = "02" + config.commitment.toLowerCase() + hexRaw(core.u32le(shard)) + batch + lockArgs.slice(144);
  const found = [];
  depCells.forEach((cell, i) => {
    if (cell && builtBy(cell.type, config.entryShardType) && strip(cell.type.args) === want) {
      found.push({ cell, dep: tx.cellDeps[i] });
    }
  });
  return found;
}

function lockArgsReasons(config, args, label) {
  if (args.length !== 208) return [`${label}: DAOWOW lock args must be 104 bytes`];
  const bad = [];
  if (args.slice(0, 64) !== config.roundId.toLowerCase()) bad.push(`${label} belongs to a different round`);
  if (args.slice(80, 144) !== config.commitment.toLowerCase()) bad.push(`${label} is bound to a different round config`);
  return bad;
}

/**
 * DAO phase one. `inputCells[i]` is the cell input i spends ({ capacity,
 * lock, type, data }), `inputHeaders[i]` the header of the block it was
 * committed in, and `depCells[i]` the cell that cell dep i names.
 */
export function checkDaoPhaseOne({ config, tx, inputCells, inputHeaders, depCells }) {
  const bad = [...depShapeReasons(tx)];
  const mine = inputCells.map((c, i) => ({ c, i })).filter(({ c }) => builtBy(c.lock, config.daoLock));
  if (mine.length === 0) return ["no input is under this round's DAOWOW lock"];
  const groups = new Map();
  for (const { c } of mine) groups.set(strip(c.lock.args), (groups.get(strip(c.lock.args)) ?? 0) + 1);

  for (const { c, i } of mine) {
    const label = `input ${i}`;
    const args = strip(c.lock.args);
    bad.push(...lockArgsReasons(config, args, label));
    if (groups.get(args) !== 1) bad.push(`${label} shares its lock with another input; each lock may spend one cell`);
    if (strip(c.data) !== "00".repeat(8)) {
      bad.push(`${label} is not a deposit (its data is not eight zero bytes); phase one has already happened`);
      continue;
    }
    if (!c.type || scriptHash(c.type) !== config.daoType.codeHash.toLowerCase()) {
      bad.push(`${label} is not a native DAO cell`);
    }
    const out = tx.outputs[i];
    if (!out) {
      bad.push(`there is no output ${i} to pair with ${label}; phase one is index for index`);
      continue;
    }
    if (BigInt(out.capacity) !== BigInt(c.capacity)) {
      bad.push(`output ${i} holds ${BigInt(out.capacity)} shannons, not ${label}'s ${BigInt(c.capacity)}`);
    }
    if (!out.type || scriptHash(out.type) !== config.daoType.codeHash.toLowerCase()) {
      bad.push(`output ${i} is not a native DAO cell`);
    }
    if (!sameScript(out.lock, c.lock)) bad.push(`output ${i} is not under ${label}'s own lock: no lock substitution`);

    const header = inputHeaders[i];
    if (!header) {
      bad.push(`the block ${label} was committed in is unknown`);
      continue;
    }
    if (!tx.headerDeps.map(strip).includes(strip(header.hash))) {
      bad.push(`${label}'s deposit block is not among the header deps`);
    }
    const term = daoTermReason(tx.inputs[i].since, header.epoch, config.daoTermPeriods);
    if (term) bad.push(`${label}: ${term}`);
    if (strip(tx.outputsData[i]) !== u64le(BigInt(header.number))) {
      bad.push(`output ${i}'s data is not ${label}'s deposit block number`);
    }

    const receipts = receiptsFor(config, tx, depCells, args);
    if (receipts.length !== 1) {
      bad.push(`${label} needs exactly one batch receipt among the cell deps; found ${receipts.length}`);
      continue;
    }
    const [{ cell, dep }] = receipts;
    if (strip(dep.outPoint.txHash) !== strip(tx.inputs[i].previousOutput.txHash)) {
      bad.push(`${label}'s receipt was not created by the transaction that made the deposit`);
    }
    if (!isPublicLock(cell.lock, cell.type)) bad.push(`${label}'s receipt is not under the public lock`);
    try {
      const receipt = decodeBatchCommitment(unhex(cell.data));
      if (receipt.digest !== args.slice(144)) bad.push(`${label}'s receipt records a different batch digest`);
      if (BigInt(receipt.inputCapacity) !== BigInt(c.capacity)) {
        bad.push(`${label}'s capacity is not the capacity its receipt records`);
      }
    } catch (e) {
      bad.push(`${label}'s receipt does not decode: ${e.message}`);
    }
  }
  return bad;
}

/**
 * DAO phase two. As above, plus `headers`, the header deps resolved by hash.
 * The settlement cell is re-derived from the witness's own evidence, the
 * receipt and result among the cell deps, and the two headers.
 */
export function checkDaoPhaseTwo({ config, tx, inputCells, inputHeaders, depCells, headers }) {
  const bad = [];
  const mine = inputCells.map((c, i) => ({ c, i })).filter(({ c }) => builtBy(c.lock, config.daoLock));
  if (mine.length !== 1) return [`phase two spends exactly one DAOWOW cell; this spends ${mine.length}`];
  const [{ c, i }] = mine;
  const args = strip(c.lock.args);
  bad.push(...lockArgsReasons(config, args, `input ${i}`));
  if (bad.length > 0) return bad;
  const daoHash = config.daoType.codeHash.toLowerCase();
  // Nothing below can be worked out for a cell that is not a DAO cell.
  if (!c.type || scriptHash(c.type) !== daoHash) return [...bad, `input ${i} is not a native DAO cell`];
  const data = strip(c.data);
  if (data.length !== 16 || data === "00".repeat(8)) {
    return [...bad, `input ${i} is still a deposit; phase one must be committed first`];
  }

  // The native DAO's witness: input_type is the deposit header's index.
  let witness;
  try {
    witness = ccc.WitnessArgs.fromBytes(ccc.bytesFrom(tx.witnesses[i]));
  } catch (e) {
    return [...bad, `witness ${i} is not a WitnessArgs: ${e.message}`];
  }
  const indexBytes = strip(witness.inputType ?? "");
  if (indexBytes.length !== 16) return [...bad, `witness ${i} does not name the deposit header's index`];
  const depositHeader = headers[strip(tx.headerDeps[Number(leToBig(indexBytes))] ?? "")];
  const withdrawHeader = inputHeaders[i];
  if (!depositHeader) return [...bad, "the deposit header the witness points at is not among the header deps"];
  if (!withdrawHeader) return [...bad, `the block input ${i} was committed in is unknown`];
  if (u64le(BigInt(depositHeader.number)) !== data) {
    bad.push("the header the witness points at is not the deposit block the withdrawing cell names");
  }
  if (!tx.headerDeps.map(strip).includes(strip(withdrawHeader.hash))) {
    bad.push("the withdrawal's own block is not among the header deps");
  }

  // Maturity, measured from the DEPOSIT.
  const maturity = maturityOf(depositHeader.epoch, withdrawHeader.epoch);
  const since = BigInt(tx.inputs[i].since);
  const sinceLength = ((since >> 40n) & 0xffffn) || 1n;
  const mLength = ((maturity.since >> 40n) & 0xffffn) || 1n;
  const early = (since & 0xffffffn) < maturity.epoch || ((since & 0xffffffn) === maturity.epoch
    && ((since >> 24n) & 0xffffn) * mLength < ((maturity.since >> 24n) & 0xffffn) * sinceLength);
  if (since >> 56n !== 0x20n) bad.push("the DAO input's since is not an absolute epoch");
  else if (early) {
    bad.push(`the DAO input's since is before maturity: the cell matures at epoch ${maturity.epoch}, counted from the DEPOSIT`);
  }

  const depositAr = accumulatedRate(depositHeader);
  const withdrawAr = accumulatedRate(withdrawHeader);
  if (depositAr === 0n || withdrawAr < depositAr) return [...bad, "the withdrawal's accumulated rate is below the deposit's"];
  const floor = withdrawingCellOccupied(c);
  const realized = floor + ((BigInt(c.capacity) - floor) * withdrawAr) / depositAr;

  // The receipt and the recorded result, from the cell deps.
  const receipts = receiptsFor(config, tx, depCells, args);
  if (receipts.length !== 1) return [...bad, `exactly one batch receipt is needed among the cell deps; found ${receipts.length}`];
  if (!isPublicLock(receipts[0].cell.lock, receipts[0].cell.type)) bad.push("the receipt is not under the public lock");
  const recordArgs = config.commitment.toLowerCase() + "00000000";
  const records = depCells.filter((cell) => cell && builtBy(cell.type, config.entryShardType)
    && strip(cell.type.args) === recordArgs);
  if (records.length !== 1) {
    return [...bad, `the round's recorded result must be among the cell deps exactly once; found ${records.length}`];
  }
  if (!isPublicLock(records[0].lock, records[0].type)) bad.push("the recorded result is not under the public lock");

  let expected;
  try {
    const receipt = decodeBatchCommitment(unhex(receipts[0].cell.data));
    if (receipt.digest !== args.slice(144)) bad.push("the receipt records a different batch digest");
    if (BigInt(receipt.inputCapacity) !== BigInt(c.capacity)) bad.push("the DAO cell's capacity is not what its receipt records");
    const record = decodeEntropyRecord(unhex(records[0].data), Number(config.entryShardCount));
    const payload = unhex(witness.outputType ?? "");
    if (payload[0] === 0) return [...bad, "the witness carries a detached evidence reference, which these tools do not build or check"];
    const evidence = decodeEntitlementWitness(payload);
    expected = deriveEntitlements({
      config, record, receipt, batchId: leToBig(args.slice(64, 80)), realizedTotal: realized, ...evidence,
    });
  } catch (e) {
    return [...bad, `the settlement cell cannot be derived from this transaction's evidence: ${e.message}`];
  }

  // Outputs: no DAO cell, and exactly one settlement cell holding what was derived.
  const wantType = config.commitment.toLowerCase() + args.slice(64, 80) + args.slice(144);
  const isFunding = (s) => builtBy(s, config.settlementType) && strip(s.args) === wantType;
  if (inputCells.some((cell) => isFunding(cell.type))) bad.push("a settlement cell for this batch is among the inputs: it already exists");
  let found = 0;
  tx.outputs.forEach((out, n) => {
    if (out.type && scriptHash(out.type) === daoHash) bad.push(`output ${n} is a native DAO cell; phase two may create none`);
    if (!isFunding(out.type)) return;
    found += 1;
    if (!isPublicLock(out.lock, out.type)) bad.push(`output ${n}, the settlement cell, is not under the public settlement lock`);
    if (BigInt(out.capacity) !== realized) {
      bad.push(`the settlement cell holds ${BigInt(out.capacity)} shannons; the DAO pays exactly ${realized}`);
    }
    if (strip(tx.outputsData[n]) !== hexRaw(settlementCodec.encodeSettlementFunding(expected.funding))) {
      bad.push("the settlement cell's data is not what the contract derives from this evidence");
    }
  });
  if (found !== 1) bad.push(`exactly one settlement cell for this batch must be created; found ${found}`);
  return bad;
}

/** Payout. Walks settlement-type's payout branch over the transaction. */
export function checkPayout({ config, tx, inputCells }) {
  const bad = [];
  const mine = inputCells.map((c, i) => ({ c, i }))
    .filter(({ c }) => builtBy(c.type, config.settlementType) && strip(c.type.args).length === 144);
  if (mine.length !== 1) return [`a payout spends exactly one settlement cell; this spends ${mine.length}`];
  const [{ c, i }] = mine;
  if (!isPublicLock(c.lock, c.type)) bad.push("the settlement cell is not under the public settlement lock");

  let before;
  let rows;
  try {
    before = settlementCodec.decodeSettlementFunding(unhex(c.data));
    rows = decodeSettlementWitness(unhex(tx.witnesses[i]));
  } catch (e) {
    return [...bad, e.message];
  }
  if (rows.length === 0) return [...bad, "the payout witness lists nobody"];

  const successors = tx.outputs.map((o, n) => ({ o, n })).filter(({ o }) => sameScript(o.type, c.type));
  if (successors.length > 1) return [...bad, "more than one settlement cell for this batch among the outputs"];
  const final = successors.length === 0;
  let after = null;
  let newCapacity = 0n;
  if (!final) {
    const [{ o, n }] = successors;
    newCapacity = BigInt(o.capacity);
    if (!sameScript(o.lock, c.lock)) bad.push("the settlement cell's lock changed");
    if (newCapacity < occupied({ lock: o.lock, type: o.type, data: tx.outputsData[n] })) {
      bad.push(`the settlement cell would hold ${newCapacity / CKB} CKB, below its own floor: ` +
        "the last participant must wait until this batch's prizes are redeemed");
    }
    try {
      after = settlementCodec.decodeSettlementFunding(unhex(tx.outputsData[n]));
    } catch (e) {
      return [...bad, `the settlement cell's new data does not decode: ${e.message}`];
    }
    for (const field of settlementCodec.IMMUTABLE_FIELDS) {
      if (after[field] !== before[field]) bad.push(`the settlement cell's ${field} changed; it is fixed for the life of the cell`);
    }
  }

  let cursor = before.payoutCursor;
  let sum = 0n;
  let previous = null;
  const root = unhex(before.liabilitiesRoot);
  rows.forEach(({ lock, item, proof }, k) => {
    const who = item.participantLockHash;
    if (previous !== null && who <= previous) bad.push(`payout ${k} is out of order: participants are paid in ascending lock-hash order`);
    previous = who;
    const leaf = core.liabilityLeaf(unhex(who), item.principal, item.prize);
    if (!core.mmrVerifyMembership(root, Number(before.liabilityCount), Number(cursor), leaf, proof)) {
      bad.push(`payout ${k} is not the liability at position ${cursor}: its proof does not verify against the cell's root`);
    }
    const owed = item.principal + item.prize;
    const at = tx.outputs.findIndex((o) => scriptHash(o.lock) === who);
    if (at === -1) {
      bad.push(`payout ${k}: no output is under that participant's lock`);
    } else {
      const out = tx.outputs[at];
      if (!sameScript(out.lock, lock)) bad.push(`payout ${k}: the witness declares a different lock from output ${at}'s`);
      if (out.type || strip(tx.outputsData[at]) !== "") {
        bad.push(`payout ${k}: the FIRST output under that lock (output ${at}) is not an ordinary empty cell`);
      }
      if (BigInt(out.capacity) < owed) bad.push(`payout ${k}: output ${at} holds less than the ${owed} shannons owed`);
      if (BigInt(out.capacity) < occupied({ lock: out.lock, type: null, data: "0x" })) {
        bad.push(`payout ${k}: output ${at} is below its own cell floor`);
      }
    }
    sum += owed;
    cursor += 1n;
  });

  if (sum + newCapacity !== BigInt(c.capacity)) {
    bad.push(`conservation: the cell held ${BigInt(c.capacity)}, the payouts take ${sum} and ${newCapacity} stays; these must be equal`);
  }
  if (cursor > before.liabilityCount) bad.push("more participants are paid than the batch has");
  const prizesOutstanding = before.prizeCount !== 0n && before.prizePaid !== before.prizePool;
  if (final) {
    if (cursor !== before.liabilityCount) bad.push("the settlement cell is closed before every participant is paid");
    if (prizesOutstanding) bad.push("the settlement cell is closed while prizes are still unredeemed");
  } else {
    if (after.payoutCursor !== cursor) bad.push(`the cursor must advance to ${cursor}; the new cell says ${after.payoutCursor}`);
    if (after.prizePaid !== before.prizePaid) bad.push("a payout must not change the prizes paid");
    if (cursor === before.liabilityCount && !prizesOutstanding) {
      bad.push("everyone is paid and no prize is outstanding: the settlement cell must be closed, not kept");
    }
  }
  return bad;
}
