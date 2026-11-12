"use strict";
// Wrapped in an IIFE: loaded as a classic script these files share one
// global scope, so top-level declarations would collide between modules.
(function () {
// Paying participants back from a batch's settlement cell.
//
// Rules from contracts/settlement-type/src/main.rs, payout branch:
//
//  - Each item pays the NEXT unpaid liability: the witness proves, against
//    the cell's immutable liability root, that this participant sits at the
//    cursor's position. Nobody can be skipped.
//  - The payment is an ordinary cell (no type, no data) under the
//    participant's own lock, holding at least what they are owed and at
//    least its own floor. Only the owed amount leaves the settlement cell;
//    any top-up to reach the floor is the sponsor's gift.
//  - The contract finds a participant's payment by scanning outputs for the
//    FIRST one under their lock. Payments therefore sit before the sponsor's
//    change, so a sponsor who is also a participant cannot shadow their own
//    payment.
//  - What stays behind must be exact: capacity in = owed + capacity out.
//
// One rule orders the whole settlement. While prizes are unredeemed the cell
// must survive every payout AND every redemption but the last, and a cell
// cannot hold less than its own 307 CKB floor. A payout is therefore allowed
// only if it leaves the cell in a state that can still be finished:
//
//   - it closes the cell (everyone paid, no prize outstanding); or
//   - at least 307 CKB of PRINCIPAL is still unpaid, so each winner can
//     redeem alone and the cell stays alive; or
//   - everyone is paid and at least 307 CKB of prizes remain to be redeemed.
//
// What it must never leave is a little unpaid principal next to a little
// unredeemed prize, each below the floor: then neither the last payout nor
// the last redemption could ever be made. So the tail of a batch waits until
// that batch's prizes are redeemed, and the builder says so.

const lib = (path, name) => (typeof require === "function" ? require(path) : window[name]);
const core = () => lib("../core.js", "DaowowCore");
const refundTx = () => lib("./refund-tx.js", "DaowowRefundTx");
const settlementCodec = () => lib("./settlement-codec.js", "DaowowSettlementCodec");

const CKB = 100000000n;
const FEE_SHANNONS = 10000000n;
const MIN_CELL_CKB = 61n * CKB;
// 8 capacity + 160 data + 34 lock (33 + 1 arg byte) + 105 type (33 + 72).
const FUNDING_CELL_CKB = 8n + 160n + 34n + 105n;
// A batch holds at most 32 entries, so a settlement cell has at most 32
// liabilities. The witness decoder's own ceiling is 128.
const MAX_PAYOUTS_PER_TX = 32;
const HASH_TYPE_BYTE = { data: 0, type: 1, data1: 2, data2: 4 };

const strip = (s) => (s.startsWith("0x") ? s.slice(2) : s).toLowerCase();
const hex = (b) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
const unhex = (s) => Uint8Array.from(strip(s).match(/../g) ?? [], (b) => parseInt(b, 16));
const owedOf = (l) => BigInt(l.principal) + BigInt(l.prize);
const sameScript = (a, b) => a && b && strip(a.codeHash) === strip(b.codeHash)
  && a.hashType === b.hashType && strip(a.args) === strip(b.args);

/**
 * The largest a payout witness for `count` items can be: the count, then per
 * item the lock (u8 length, up to 255 bytes of args, code hash, hash type),
 * the 48-byte item, and a length-prefixed proof. A proof among at most 32
 * leaves is a path of at most 5 siblings and at most 6 peaks.
 */
function payoutWitnessBound(count) {
  const proof = 1 + 5 * 32 + 1 + 1 + 6 * 32;
  return 4 + count * (1 + 255 + 32 + 1 + 48 + 4 + proof);
}

/** encode_settlement_witness (witness.rs). Rows are { lock, item, proof }. */
function encodeSettlementWitness(rows) {
  const parts = [core().u32le(rows.length)];
  for (const { lock, item, proof } of rows) {
    const args = unhex(lock.args);
    if (args.length > 255) throw new Error("a lock with more than 255 bytes of args cannot be paid this way");
    const hashType = HASH_TYPE_BYTE[lock.hashType];
    if (hashType === undefined) throw new Error(`unknown hash type ${lock.hashType}`);
    parts.push(
      new Uint8Array([args.length]), args, unhex(lock.codeHash), new Uint8Array([hashType]),
      core().encodePayoutItem({
        participantLockHash: unhex(item.participantLockHash),
        principal: BigInt(item.principal), prize: BigInt(item.prize),
      }),
      core().u32le(proof.length), proof,
    );
  }
  return core().concat(parts);
}

const HASH_TYPE_OF_BYTE = { 0: "data", 1: "type", 2: "data1", 4: "data2" };

/** decode_settlement_witness (witness.rs), refusals included. */
function decodeSettlementWitness(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.length < 4) throw new Error("a payout witness is at least 4 bytes");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const count = view.getUint32(0, true);
  if (count > 128) throw new Error(`a payout witness lists at most 128 items; this claims ${count}`);
  let at = 4;
  const take = (n) => {
    if (at + n > bytes.length) throw new Error("the payout witness is cut short");
    const part = bytes.slice(at, at + n);
    at += n;
    return part;
  };
  const rows = [];
  for (let i = 0; i < count; i += 1) {
    const args = take(take(1)[0]);
    const codeHash = take(32);
    const hashType = HASH_TYPE_OF_BYTE[take(1)[0]];
    if (hashType === undefined) throw new Error(`payout item ${i} names an unknown hash type`);
    const item = take(48);
    const itemView = new DataView(item.buffer);
    const proof = take(new DataView(take(4).buffer).getUint32(0, true));
    rows.push({
      lock: { codeHash: "0x" + hex(codeHash), hashType, args: "0x" + hex(args) },
      item: {
        participantLockHash: hex(item.slice(0, 32)),
        principal: itemView.getBigUint64(32, true), prize: itemView.getBigUint64(40, true),
      },
      proof,
    });
  }
  if (at !== bytes.length) throw new Error("the payout witness has trailing bytes");
  return rows;
}

/**
 * `funding` is { outPoint, capacity, lock, type, state } with `state` the
 * decoded settlement data. `liabilities` is the batch's COMPLETE list in
 * order (deriveEntitlements gives it); `locks` maps a participant's lock hash
 * to their lock script. `count` is how many to pay; left out, as many as the
 * rules allow.
 */
function buildPayoutTx({ manifest, funding, liabilities, locks, sponsor, count, feeShannons = FEE_SHANNONS }) {
  const script = manifest.scripts["settlement-type"];
  const publicLock = { codeHash: script.codeHash, hashType: script.hashType, args: "0x00" };
  if (!sameScript(funding.lock, publicLock)
    || strip(funding.type.codeHash) !== strip(script.codeHash)
    || funding.type.hashType !== script.hashType
    || strip(funding.type.args).length !== 144) {
    throw new Error("this is not a settlement cell of this deployment");
  }
  if (!Array.isArray(sponsor.lockDeps) || sponsor.lockDeps.length === 0) {
    throw new Error("the sponsor's lock cell deps are required (sponsor.lockDeps)");
  }

  const state = funding.state;
  const total = Number(state.liabilityCount);
  // The whole list is rebuilt and compared with the cell's root: a proof from
  // any other list would fail on chain as an unexplained proof error.
  const tree = new (core().MmrHost)();
  for (const l of liabilities) {
    tree.append(core().liabilityLeaf(unhex(l.participantLockHash), BigInt(l.principal), BigInt(l.prize)));
  }
  // (A list of the wrong length has a different root: the root covers the count.)
  if (hex(tree.root()) !== state.liabilitiesRoot) {
    throw new Error("these are not the liabilities this settlement cell commits to");
  }

  const cursor = Number(state.payoutCursor);
  const remaining = total - cursor;
  if (remaining === 0) throw new Error("every participant of this batch has already been paid");
  if (count !== undefined && count < 1) throw new Error("a payout pays at least one participant");
  if (count !== undefined && count > remaining) {
    throw new Error(`only ${remaining} participant(s) remain to be paid in this batch`);
  }

  const inCap = BigInt(funding.capacity);
  const prizesOutstanding = state.prizeCount !== 0n && state.prizePaid !== state.prizePool;
  const floor = FUNDING_CELL_CKB * CKB;
  // What paying `n` more would leave, and whether the rules allow it.
  const leftAfter = (n) =>
    inCap - liabilities.slice(cursor, cursor + n).reduce((s, l) => s + owedOf(l), 0n);
  const closes = (n) => cursor + n === total && !prizesOutstanding;
  const unpaidAfter = (n) => liabilities.slice(cursor + n).reduce((s, l) => s + owedOf(l), 0n);
  const allowed = (n) => {
    if (closes(n)) return true;
    if (leftAfter(n) < floor) return false;
    // With no prize outstanding the cell holds only unpaid principal, so the
    // floor check above has already settled it.
    if (!prizesOutstanding) return true;
    const unpaid = unpaidAfter(n);
    return unpaid === 0n || unpaid >= floor;
  };
  const waiting = !prizesOutstanding
    ? "that would leave the settlement cell holding less than its own " +
      `${FUNDING_CELL_CKB} CKB floor without closing it: pay the remaining participants together`
    : "the last participant(s) of this batch cannot be paid yet: the settlement cell must stay " +
    "open and finishable until its prizes are redeemed, and what would be left is below the " +
    `cell's own ${FUNDING_CELL_CKB} CKB floor. Once this batch's prizes have been redeemed, pay again`;

  let n = Math.min(count ?? remaining, MAX_PAYOUTS_PER_TX);
  if (count === undefined) while (n > 0 && !allowed(n)) n -= 1;
  if (n === 0 || !allowed(n)) throw new Error(waiting);

  const final = closes(n);
  const left = leftAfter(n);
  if (final && left !== 0n) {
    throw new Error(
      "this settlement cell does not hold exactly what its last participants are owed, " +
      "so it cannot be closed",
    );
  }

  const paid = liabilities.slice(cursor, cursor + n);
  let gift = 0n;
  const rows = [];
  const payments = paid.map((item, i) => {
    const lock = locks[item.participantLockHash];
    if (!lock) throw new Error(`the lock script for participant ${item.participantLockHash} is required`);
    if (refundTx().scriptHash(lock) !== item.participantLockHash) {
      throw new Error(`the lock given for participant ${item.participantLockHash} does not hash to it`);
    }
    const owed = owedOf(item);
    const cellFloor = (8n + 33n + BigInt(strip(lock.args).length / 2)) * CKB;
    const capacity = owed > cellFloor ? owed : cellFloor;
    gift += capacity - owed;
    rows.push({ lock, item, proof: tree.membershipProof(cursor + i) });
    return { capacity, lock, type: null };
  });

  const change = BigInt(sponsor.capacity) - gift - BigInt(feeShannons);
  if (change < MIN_CELL_CKB) {
    throw new Error(
      `the sponsor holds ${BigInt(sponsor.capacity) / CKB} CKB, which cannot cover the fee` +
      (gift > 0n ? ` and ${gift / CKB} CKB of top-ups` : "") +
      " and leave a change cell above the 61 CKB floor",
    );
  }

  const successor = final ? [] : [{ capacity: left, lock: funding.lock, type: funding.type }];
  const successorData = final ? [] : ["0x" + hex(settlementCodec().encodeSettlementFunding(
    settlementCodec().advanceFunding(state, { payoutCursor: BigInt(cursor + n) })))];

  return {
    tx: {
      cellDeps: [{ outPoint: script.outPoint, depType: script.depType }, ...sponsor.lockDeps],
      headerDeps: [],
      inputs: [
        { previousOutput: funding.outPoint, since: 0n },
        { previousOutput: sponsor.outPoint, since: 0n },
      ],
      // Payments FIRST: the contract takes the first output under a
      // participant's lock as their payment, so nothing that could share a
      // lock with one (the settlement cell's public lock, the sponsor's
      // change) may come before them. The contract finds the settlement
      // cell's successor by its type, at any index.
      outputs: [...payments, ...successor, { capacity: change, lock: sponsor.lock, type: null }],
      outputsData: [...payments.map(() => "0x"), ...successorData, "0x"],
      // Raw bytes at the settlement cell's own input index, not a WitnessArgs.
      witnesses: ["0x" + hex(encodeSettlementWitness(rows)), "0x"],
    },
    paid,
    // Participants still unpaid after this transaction that it could not take.
    held: remaining - n,
    final, gift,
    fee: BigInt(feeShannons),
  };
}

const api = {
  buildPayoutTx, encodeSettlementWitness, decodeSettlementWitness, payoutWitnessBound,
  FUNDING_CELL_CKB, MAX_PAYOUTS_PER_TX, FEE_SHANNONS,
};
if (typeof module !== "undefined" && module.exports) module.exports = api;
if (typeof window !== "undefined") window.DaowowPayoutTx = api;
})();
