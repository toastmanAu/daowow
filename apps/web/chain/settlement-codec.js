"use strict";
// Wrapped in an IIFE: loaded as a classic script these files share one
// global scope, so top-level declarations would collide between modules.
(function () {
// SettlementFundingDataV3: the state of one batch's settlement cell.
//
// 160 fixed bytes (encoding.rs: SettlementFundingDataV3):
//
//     0  round_id             32
//    32  batch_id              8  LE
//    40  realized_total        8     what the DAO returned for this batch
//    48  principal_liability   8     what must go back to participants
//    56  prize_pool            8     realized_total - principal_liability
//    64  payout_cursor         8     index of the next liability to pay
//    72  liability_count       8     immutable, never zero
//    80  liabilities_root     32     immutable
//   112  prize_count           8     immutable, zero on a failed round
//   120  prize_root           32     immutable
//   152  prize_paid            8     sum of prizes redeemed so far
//
// settlement-type refuses any change to nine of these across an update. Only
// payout_cursor (a payout) and prize_paid (a redemption) ever advance.

const SETTLEMENT_FUNDING_SIZE = 160;
const ZERO_HASH = "00".repeat(32);
const IMMUTABLE_FIELDS = Object.freeze([
  "roundId", "batchId", "realizedTotal", "principalLiability", "prizePool",
  "liabilityCount", "liabilitiesRoot", "prizeCount", "prizeRoot",
]);

const hexOf = (b, o, n) =>
  Array.from(b.slice(o, o + n), (x) => x.toString(16).padStart(2, "0")).join("");
const unhex = (s) => {
  const body = s.startsWith("0x") ? s.slice(2) : s;
  return Uint8Array.from(body.match(/../g) ?? [], (b) => parseInt(b, 16));
};

// The refusals of SettlementFundingDataV3::decode, in its order.
function validate(f) {
  if (f.liabilityCount === 0n) throw new Error("a settlement cell with no liabilities is not valid");
  if (f.payoutCursor > f.liabilityCount) {
    throw new Error(`the payout cursor ${f.payoutCursor} is past the last liability (${f.liabilityCount})`);
  }
  if (f.prizePaid > f.prizePool) {
    throw new Error(`prizes paid (${f.prizePaid}) exceed the prize pool (${f.prizePool})`);
  }
  if ((f.prizeCount === 0n) !== (f.prizeRoot === ZERO_HASH)) {
    throw new Error("a prize count and a prize root must be both present or both absent");
  }
  if (f.prizeCount === 0n && f.prizePaid !== 0n) {
    throw new Error("prizes paid on a batch with no prize root");
  }
  return f;
}

function decodeSettlementFunding(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.length !== SETTLEMENT_FUNDING_SIZE) {
    throw new Error(
      `settlement funding data must be exactly ${SETTLEMENT_FUNDING_SIZE} bytes; got ${bytes?.length}`);
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const u64 = (at) => view.getBigUint64(at, true);
  return Object.freeze(validate({
    roundId: hexOf(bytes, 0, 32),
    batchId: u64(32),
    realizedTotal: u64(40),
    principalLiability: u64(48),
    prizePool: u64(56),
    payoutCursor: u64(64),
    liabilityCount: u64(72),
    liabilitiesRoot: hexOf(bytes, 80, 32),
    prizeCount: u64(112),
    prizeRoot: hexOf(bytes, 120, 32),
    prizePaid: u64(152),
  }));
}

/** `unchecked` exists for tests that need bytes the decoder must refuse. */
function encodeSettlementFunding(f, { unchecked = false } = {}) {
  if (!unchecked) validate(f);
  const out = new Uint8Array(SETTLEMENT_FUNDING_SIZE);
  const view = new DataView(out.buffer);
  const hash = (value, at, name) => {
    const bytes = unhex(value);
    if (bytes.length !== 32) throw new Error(`${name} must be 32 bytes`);
    out.set(bytes, at);
  };
  hash(f.roundId, 0, "round id");
  view.setBigUint64(32, BigInt(f.batchId), true);
  view.setBigUint64(40, BigInt(f.realizedTotal), true);
  view.setBigUint64(48, BigInt(f.principalLiability), true);
  view.setBigUint64(56, BigInt(f.prizePool), true);
  view.setBigUint64(64, BigInt(f.payoutCursor), true);
  view.setBigUint64(72, BigInt(f.liabilityCount), true);
  hash(f.liabilitiesRoot, 80, "liabilities root");
  view.setBigUint64(112, BigInt(f.prizeCount), true);
  hash(f.prizeRoot, 120, "prize root");
  view.setBigUint64(152, BigInt(f.prizePaid), true);
  return out;
}

/**
 * The successor state after a payout or a redemption. The only way a builder
 * should produce one: it cannot move a field the contract holds fixed.
 */
function advanceFunding(before, change) {
  for (const field of Object.keys(change)) {
    if (IMMUTABLE_FIELDS.includes(field)) {
      throw new Error(`${field} is immutable once the settlement cell exists`);
    }
    if (field !== "payoutCursor" && field !== "prizePaid") {
      throw new Error(`${field} is not a settlement field that can advance`);
    }
    if (BigInt(change[field]) < before[field]) throw new Error(`${field} cannot go backwards`);
  }
  return Object.freeze(validate({
    ...before,
    payoutCursor: change.payoutCursor === undefined ? before.payoutCursor : BigInt(change.payoutCursor),
    prizePaid: change.prizePaid === undefined ? before.prizePaid : BigInt(change.prizePaid),
  }));
}

const api = {
  decodeSettlementFunding, encodeSettlementFunding, advanceFunding,
  SETTLEMENT_FUNDING_SIZE, IMMUTABLE_FIELDS,
};
if (typeof module !== "undefined" && module.exports) module.exports = api;
if (typeof window !== "undefined") window.DaowowSettlementCodec = api;
})();
