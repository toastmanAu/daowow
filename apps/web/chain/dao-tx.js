"use strict";
// Wrapped in an IIFE: loaded as a classic script these files share one
// global scope, so top-level declarations would collide between modules.
(function () {
// The Nervos DAO side of settlement: turning a batch's deposit into a
// withdrawing cell (phase one), and that into the batch's settlement cell
// (phase two). Rules from contracts/dao-lock/src/main.rs and RFC 0023.
//
// Four facts that are easy to get wrong:
//
//  1. Phase one is INDEX FOR INDEX. For the deposit at absolute input index i,
//     output i must be the same cell — same capacity, same lock, the native
//     DAO type — with its data changed to the deposit's block number. The
//     sponsor therefore comes after every deposit, on both sides.
//  2. The lock reads cell deps BY POSITION and accepts only plain code deps,
//     each named once. A dep group anywhere in the transaction fails it. The
//     system lock usually arrives as a dep group, so the sponsor's lock deps
//     must be given expanded: its code cell and the data cell it loads.
//  3. dao-lock refuses phase one until a FULL TERM after the deposit
//     (absolute_epoch_after_dao_term). The native DAO then rounds the stay up
//     to whole 180-epoch cycles, so the withdrawal matures at the NEXT cycle
//     boundary: deposit + 180 x (periods + 1). One term is about sixty days
//     from deposit to payout, not thirty.
//  4. Every epoch here is measured from the DEPOSIT's block, never from the
//     withdrawing cell's own.

const refundTx = () =>
  typeof require === "function" ? require("./refund-tx.js") : window.DaowowRefundTx;

const CKB = 100000000n;
const FEE_SHANNONS = 10000000n;
const MIN_CELL_CKB = 61n * CKB;
const ABSOLUTE_EPOCH_FLAG = 0x2000000000000000n;
const EPOCHS_PER_TERM = 180n;
const HASH_TYPE_NAME = { 0: "data", 1: "type", 2: "data1", 4: "data2" };

const strip = (s) => (s.startsWith("0x") ? s.slice(2) : s).toLowerCase();
const u64leHex = (v) => {
  const b = new Uint8Array(8);
  new DataView(b.buffer).setBigUint64(0, BigInt(v), true);
  return "0x" + Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
};
const epochNumber = (field) => BigInt(field) & 0xffffffn;
const pointKey = (p) => `${strip(p.txHash)}:${Number(p.index)}`;

/**
 * The `since` for a deposit's phase one: the first whole epoch after a full
 * term. With no fraction it clears dao-lock's fraction comparison whatever
 * fraction of its epoch the deposit landed at.
 */
function phaseOneSince(depositEpochField, periods) {
  return ABSOLUTE_EPOCH_FLAG
    | (epochNumber(depositEpochField) + EPOCHS_PER_TERM * BigInt(periods) + 1n);
}

// Every dep a plain code dep, each cell named once: what the lock demands of
// the whole transaction, not only of the deps it reads.
function checkedDeps(deps) {
  const seen = new Set();
  for (const dep of deps) {
    if (dep.depType !== "code") {
      throw new Error(
        "a dep group cannot be used in this transaction: the DAOWOW lock reads " +
        "cell deps by position and refuses anything but plain code deps. Give " +
        "the lock's code cell and its data cell separately",
      );
    }
    const key = pointKey(dep.outPoint);
    if (seen.has(key)) {
      throw new Error(`cell ${key} is named twice as a cell dep, which the DAOWOW lock refuses`);
    }
    seen.add(key);
  }
  return deps.map((dep) => ({ outPoint: dep.outPoint, depType: dep.depType }));
}

function requireDaoType(config, daoTypeDep) {
  const script = daoTypeDep && daoTypeDep.script;
  if (!daoTypeDep || !daoTypeDep.outPoint || !script || typeof script.codeHash !== "string") {
    throw new Error(
      "the native DAO type's cell dep and script are required (daoTypeDep, " +
      "daoTypeDep.script): the config holds only the script's hash",
    );
  }
  if (refundTx().scriptHash(script) !== config.daoType.codeHash.toLowerCase()) {
    throw new Error("daoTypeDep.script is not the native DAO type this round's config commits to");
  }
  return script;
}

// One deposit's lock, checked the way dao-lock checks its own script and args.
function checkDepositLock(config, deposit) {
  const lock = deposit.lock;
  if (strip(lock.codeHash) !== config.daoLock.codeHash.toLowerCase()
    || lock.hashType !== HASH_TYPE_NAME[Number(config.daoLock.hashType)]) {
    throw new Error("this deposit is not under the round's DAOWOW lock");
  }
  const args = strip(lock.args);
  if (args.length !== 208) {
    throw new Error(`DAOWOW lock args must be 104 bytes; this deposit's are ${args.length / 2}`);
  }
  if (args.slice(0, 64) !== config.roundId.toLowerCase()
    || args.slice(80, 144) !== config.commitment.toLowerCase()) {
    throw new Error("this deposit belongs to a different round or a different round config");
  }
}

function requireSponsor(sponsor, feeShannons) {
  if (!Array.isArray(sponsor.lockDeps) || sponsor.lockDeps.length === 0) {
    throw new Error(
      "the sponsor's lock cell deps are required (sponsor.lockDeps), as plain " +
      "code deps: without them the node refuses the transaction with ScriptNotFound",
    );
  }
  const change = BigInt(sponsor.capacity) - BigInt(feeShannons);
  if (change < MIN_CELL_CKB) {
    throw new Error(
      `the sponsor holds ${BigInt(sponsor.capacity) / CKB} CKB, which cannot pay ` +
      "the fee and leave a change cell above the 61 CKB floor",
    );
  }
  return change;
}

/**
 * Phase one for any number of batches of one round. `deposits[i]` is
 * { outPoint, receiptOutPoint, capacity, lock, type }; `depositHeaders[i]` is
 * the header of the block that deposit was committed in.
 */
function buildDaoPhaseOneTx({
  manifest, config, deposits, depositHeaders, configCellOutPoint, daoTypeDep, sponsor,
  feeShannons = FEE_SHANNONS,
}) {
  if (!Array.isArray(deposits) || deposits.length === 0) {
    throw new Error("phase one needs at least one deposit");
  }
  if (!Array.isArray(depositHeaders) || depositHeaders.length !== deposits.length) {
    throw new Error("phase one needs the header for each deposit, in the same order");
  }
  if (!configCellOutPoint || !configCellOutPoint.txHash) {
    throw new Error("the round config cell out point is required as a cell dep");
  }
  const daoType = requireDaoType(config, daoTypeDep);
  const daoTypeHash = refundTx().scriptHash(daoType);
  const change = requireSponsor(sponsor, feeShannons);

  const locks = new Set();
  for (const deposit of deposits) {
    checkDepositLock(config, deposit);
    // phase_one: a lock group of more than one input is refused outright.
    const key = strip(deposit.lock.args);
    if (locks.has(key)) {
      throw new Error("two deposits share a lock: each DAOWOW lock may spend one cell per transaction");
    }
    locks.add(key);
    if (!deposit.type || refundTx().scriptHash(deposit.type) !== daoTypeHash) {
      throw new Error("this deposit is not a native DAO cell of the type the round commits to");
    }
    if (!deposit.receiptOutPoint || !deposit.receiptOutPoint.txHash) {
      throw new Error("each deposit needs its batch receipt as a cell dep (receiptOutPoint)");
    }
    // authenticated_deposit_receipt: dep.tx_hash == input.tx_hash.
    if (strip(deposit.receiptOutPoint.txHash) !== strip(deposit.outPoint.txHash)) {
      throw new Error("a deposit and its receipt must come from the same transaction");
    }
  }

  const lockScript = manifest.scripts["dao-lock"];
  const periods = Number(config.daoTermPeriods);
  const sinces = depositHeaders.map((h) => phaseOneSince(h.epoch, periods));
  const headerDeps = [...new Set(depositHeaders.map((h) => h.hash))];

  return {
    tx: {
      cellDeps: checkedDeps([
        { outPoint: lockScript.outPoint, depType: lockScript.depType },
        { outPoint: configCellOutPoint, depType: "code" },
        daoTypeDep,
        ...deposits.map((d) => ({ outPoint: d.receiptOutPoint, depType: "code" })),
        ...sponsor.lockDeps,
      ]),
      headerDeps,
      inputs: [
        ...deposits.map((d, i) => ({ previousOutput: d.outPoint, since: sinces[i] })),
        { previousOutput: sponsor.outPoint, since: 0n },
      ],
      outputs: [
        ...deposits.map((d) => ({ capacity: BigInt(d.capacity), lock: d.lock, type: daoType })),
        { capacity: change, lock: sponsor.lock, type: null },
      ],
      outputsData: [...depositHeaders.map((h) => u64leHex(BigInt(h.number))), "0x"],
      witnesses: [...deposits.map(() => "0x"), "0x"],
    },
    // The chain must reach this epoch before the node will take the transaction.
    sinceEpochs: sinces.map((s) => s & 0xffffffn),
    // When phase two becomes possible for each deposit.
    maturityEpochs: depositHeaders.map(
      (h) => epochNumber(h.epoch) + EPOCHS_PER_TERM * BigInt(periods + 1)),
    fee: BigInt(feeShannons),
  };
}

const api = { buildDaoPhaseOneTx, phaseOneSince, checkedDeps, EPOCHS_PER_TERM, FEE_SHANNONS };
if (typeof module !== "undefined" && module.exports) module.exports = api;
if (typeof window !== "undefined") window.DaowowDaoTx = api;
})();
