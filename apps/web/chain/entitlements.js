"use strict";
// Wrapped in an IIFE: loaded as a classic script these files share one
// global scope, so top-level declarations would collide between modules.
(function () {
// What one batch owes, and to whom: the initial state of its settlement cell.
//
// A port of InitialEntitlements::derive and validate_batch
// (crates/daowow-core/src/entitlements.rs). The settlement type derives the
// same thing on chain from the same evidence and compares the cell's data
// byte for byte, so nothing computed here is trusted: a wrong value is simply
// refused. It is computed anyway, because the chain's refusal is one error
// code that names no rule.
//
// Two domains, kept apart:
//   liabilities  one per PARTICIPANT lock hash, ascending: the capacity of
//                their entry cells (their principal). On a round that drew,
//                the prize part is zero.
//   prizes       one per WINNING TICKET, ascending by ticket id. Paid to
//                whoever holds the claim, by redemption, not by payout.
// On a round that did not draw there are no prizes and the pool is shared
// among participants by principal.

const lib = (path, name) => (typeof require === "function" ? require(path) : window[name]);
const core = () => lib("../core.js", "DaowowCore");
const drawLib = () => lib("./draw.js", "DaowowDraw");
const scheduleLib = () => lib("./schedule.js", "DaowowSchedule");
const entryCodec = () => lib("./entry-codec.js", "DaowowEntryCodec");
const ledgerCodec = () => lib("./ledger-codec.js", "DaowowLedgerCodec");

const MAX_BATCH_ENTRIES = 32;
const ENTITLEMENT_WIRE_VERSION = 2;
const MAX_ENTITLEMENT_BYTES = 160 * 1024;
const ORDINAL_MASK = (1n << 56n) - 1n;

const hex = (b) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
const unhex = (s) => {
  const body = s.startsWith("0x") ? s.slice(2) : s;
  return Uint8Array.from(body.match(/../g) ?? [], (b) => parseInt(b, 16));
};
const text = (s) => new TextEncoder().encode(s);

/** allocate_prizes_complete (accounting.rs): floor shares, dust to index 0. */
function allocatePrizes(weights, pool) {
  if (weights.length === 0 || weights.some((w) => BigInt(w) === 0n)) {
    throw new Error("prize weights must be present and positive");
  }
  const total = weights.reduce((a, w) => a + BigInt(w), 0n);
  const amounts = weights.map((w) => (BigInt(pool) * BigInt(w)) / total);
  amounts[0] += BigInt(pool) - amounts.reduce((a, b) => a + b, 0n);
  return amounts;
}

/** ComputedDraw::locate: a global draw position to (shard, shard-local position). */
function locatePosition(ledgers, globalPosition) {
  const position = BigInt(globalPosition);
  const offsets = [];
  let total = 0n;
  for (const ledger of ledgers) {
    offsets.push(total);
    total += BigInt(ledger.acceptedTickets);
  }
  if (position >= total) throw new Error(`position ${position} is not a ticket of this round`);
  for (let id = offsets.length - 1; id >= 0; id -= 1) {
    if (position >= offsets[id]) return { shardId: id, position: position - offsets[id] };
  }
  throw new Error(`position ${position} is not a ticket of this round`);
}

// validate_batch: the entries and capacities must be exactly the batch the
// on-chain receipt commits to, and a batch the sealed ledger accepted.
function checkBatch({ config, record, batchId, receipt, entries, capacities }) {
  if (entries.length === 0) throw new Error("a batch has at least one entry");
  if (entries.length > MAX_BATCH_ENTRIES) throw new Error(`a batch holds at most ${MAX_BATCH_ENTRIES} entries`);
  if (entries.length !== capacities.length) throw new Error("a batch needs the cell capacity for each entry");
  const shard = Number(BigInt(batchId) >> 56n);
  const ordinal = BigInt(batchId) & ORDINAL_MASK;
  const ledger = record.seal.ledgers[shard];
  if (!ledger) throw new Error(`batch ${batchId} names shard ${shard}, which this round does not have`);
  const firstNonce = BigInt(receipt.firstNonce);
  if (ordinal >= BigInt(ledger.acceptedBatches)
    || firstNonce < ordinal
    || firstNonce > ordinal * BigInt(MAX_BATCH_ENTRIES)
    || firstNonce + BigInt(entries.length) > BigInt(ledger.acceptedEntries)) {
    throw new Error(`batch ${batchId} is not a batch this round accepted`);
  }
  const parts = [
    text("DAOWOW_ENTRY_BATCH_V2"), unhex(config.commitment),
    core().u32le(shard), core().u32le(entries.length),
  ];
  const ticketPrice = BigInt(config.ticketPrice);
  let position = BigInt(entries[0].positionBase);
  if (ordinal === 0n && position !== 0n) throw new Error("the first batch must start at position zero");
  let tickets = 0n;
  let principal = 0n;
  let inputCapacity = 0n;
  entries.forEach((entry, i) => {
    const capacity = BigInt(capacities[i]);
    if (hex(entry.roundId) !== config.roundId) throw new Error(`entry ${i} belongs to a different round`);
    if (Number(entry.shardId) !== shard) throw new Error(`entry ${i} belongs to shard ${entry.shardId}`);
    if (BigInt(entry.entryNonce) !== firstNonce + BigInt(i)) {
      throw new Error(`entry ${i} is out of place: a batch lists its entries in strict nonce order`);
    }
    if (BigInt(entry.positionBase) !== position) throw new Error(`entry ${i} does not continue the positions`);
    if (BigInt(entry.ticketCount) === 0n
      || BigInt(entry.ticketCount) * ticketPrice !== BigInt(entry.principal)) {
      throw new Error(`entry ${i}'s principal is not its tickets at the round's price`);
    }
    if (capacity < BigInt(entry.principal)) throw new Error(`entry ${i}'s cell held less than its principal`);
    position += BigInt(entry.ticketCount);
    if (position > BigInt(ledger.acceptedTickets)) throw new Error(`entry ${i} runs past the accepted tickets`);
    tickets += BigInt(entry.ticketCount);
    principal += BigInt(entry.principal);
    inputCapacity += capacity;
    parts.push(entryCodec().encodeEntryDataV1(entry), core().u64le(capacity));
  });
  const digest = hex(core().ckbHash256(parts));
  if (digest !== receipt.digest
    || BigInt(receipt.entryCount) !== BigInt(entries.length)
    || BigInt(receipt.ticketCount) !== tickets
    || BigInt(receipt.principal) !== principal
    || BigInt(receipt.inputCapacity) !== inputCapacity) {
    throw new Error("these entries and capacities are not the batch its on-chain receipt commits to");
  }
}

/**
 * `record` is the decoded entropy record, `schedule` the decoded prize
 * schedule, `receipt` the decoded batch commitment, `entries` the batch's
 * decoded entries in nonce order and `capacities` their cells' capacities.
 * `realizedTotal` is what the DAO pays out for this batch's deposit.
 */
function deriveEntitlements({
  config, record, schedule, batchId, receipt, entries, capacities, realizedTotal,
}) {
  // Refuses a schedule the config does not commit to, and a malformed seal.
  const draw = drawLib().computeDraw({ config, record, schedule });
  checkBatch({ config, record, batchId, receipt, entries, capacities });

  const principalTotal = BigInt(receipt.inputCapacity);
  const realized = BigInt(realizedTotal);
  if (realized < principalTotal) {
    throw new Error("the DAO returned less than was deposited, which cannot be settled");
  }
  const prizePool = realized - principalTotal;

  // Consolidated by participant, ascending by lock hash: Rust's BTreeMap order.
  const owed = new Map();
  entries.forEach((entry, i) => {
    const who = hex(entry.participantLockHash);
    const item = owed.get(who) ?? { principal: 0n, prize: 0n };
    item.principal += BigInt(capacities[i]);
    owed.set(who, item);
  });
  const participants = [...owed.keys()].sort();

  const prizes = [];
  if (draw.viable) {
    const open = scheduleLib().placesFor(schedule, draw.tickets);
    const amounts = allocatePrizes(schedule.weights.slice(0, open), prizePool);
    if (amounts.length !== draw.positions.length) throw new Error("the draw and the schedule disagree on the places");
    draw.positions.forEach((p, i) => {
      if (BigInt(p.prizeIndex) !== BigInt(i)) throw new Error("the draw's places are out of order");
      // A zero prize can never be redeemed, and this batch's settlement cell
      // can never be created without it: the deposit would be stranded.
      if (amounts[i] === 0n) {
        throw new Error(
          `this batch's prize pool of ${prizePool} shannons leaves place ${i + 1} at zero. ` +
          "The contract refuses to create the settlement cell, so this batch's deposit " +
          "cannot be withdrawn as things stand",
        );
      }
      const where = locatePosition(record.seal.ledgers, p.position);
      prizes.push({
        ticket: hex(entryCodec().ticketId(unhex(config.commitment), where.shardId, where.position)),
        amount: amounts[i],
      });
    });
    prizes.sort((a, b) => (a.ticket < b.ticket ? -1 : a.ticket > b.ticket ? 1 : 0));
    if (prizes.some((p, i) => i > 0 && prizes[i - 1].ticket === p.ticket)) {
      throw new Error("one ticket was drawn for two places");
    }
  } else {
    // Consolidated BEFORE dividing, so splitting an entry cannot bias the dust.
    let assigned = 0n;
    for (const who of participants) {
      const item = owed.get(who);
      item.prize = (prizePool * item.principal) / principalTotal;
      assigned += item.prize;
    }
    const residual = prizePool - assigned;
    if (residual >= BigInt(participants.length)) throw new Error("the pool does not divide among the participants");
    participants.slice(0, Number(residual)).forEach((who) => { owed.get(who).prize += 1n; });
  }

  const liabilityTree = new (core().MmrHost)();
  const liabilities = participants.map((who) => {
    const { principal, prize } = owed.get(who);
    if (principal + prize === 0n) throw new Error("a participant is owed nothing");
    liabilityTree.append(core().liabilityLeaf(unhex(who), principal, prize));
    return { participantLockHash: who, principal, prize };
  });
  const prizeTree = new (core().MmrHost)();
  for (const p of prizes) {
    prizeTree.append(core().H("DAOWOW_PRIZE_LEAF_V1", unhex(p.ticket), core().u64le(p.amount)));
  }
  const total = liabilities.reduce((s, l) => s + l.principal + l.prize, 0n)
    + prizes.reduce((s, p) => s + p.amount, 0n);
  if (total !== realized) throw new Error("what is owed does not add up to what was realised");

  return {
    funding: Object.freeze({
      roundId: config.roundId,
      batchId: BigInt(batchId),
      realizedTotal: realized,
      principalLiability: principalTotal,
      prizePool,
      payoutCursor: 0n,
      liabilityCount: BigInt(liabilities.length),
      liabilitiesRoot: hex(liabilityTree.root()),
      prizeCount: BigInt(prizes.length),
      prizeRoot: prizes.length === 0 ? "00".repeat(32) : hex(prizeTree.root()),
      prizePaid: 0n,
    }),
    liabilities, prizes, liabilityTree, prizeTree, draw,
  };
}

/**
 * EntitlementWitness::encode: version 2, the schedule, then each entry with
 * its cell capacity. This is the evidence the contract derives from.
 */
function encodeEntitlementWitness(schedule, entries, capacities) {
  if (entries.length === 0 || entries.length > MAX_BATCH_ENTRIES || entries.length !== capacities.length) {
    throw new Error("an entitlement witness lists 1 to 32 entries, each with its capacity");
  }
  const scheduleBytes = drawLib().encodeSchedule(schedule);
  const parts = [
    new Uint8Array([ENTITLEMENT_WIRE_VERSION]),
    core().u32le(scheduleBytes.length), scheduleBytes, core().u32le(entries.length),
  ];
  entries.forEach((entry, i) => {
    parts.push(entryCodec().encodeEntryDataV1(entry), core().u64le(BigInt(capacities[i])));
  });
  const out = core().concat(parts);
  if (out.length > MAX_ENTITLEMENT_BYTES) throw new Error("the entitlement witness is too large");
  return out;
}

/** EntitlementWitness::decode, refusals included: what the contract will read. */
function decodeEntitlementWitness(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.length > MAX_ENTITLEMENT_BYTES) {
    throw new Error("the entitlement witness is too large");
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let at = 0;
  const need = (n) => {
    if (at + n > bytes.length) throw new Error("the entitlement witness is cut short");
  };
  need(1);
  if (bytes[0] !== ENTITLEMENT_WIRE_VERSION) {
    throw new Error(`entitlement witness version ${bytes[0]} is not ${ENTITLEMENT_WIRE_VERSION}`);
  }
  at = 1;
  need(4);
  const scheduleLength = view.getUint32(at, true);
  at += 4;
  need(scheduleLength);
  const schedule = scheduleLib().decodeSchedule(bytes.slice(at, at + scheduleLength));
  at += scheduleLength;
  need(4);
  const count = view.getUint32(at, true);
  at += 4;
  if (count === 0 || count > MAX_BATCH_ENTRIES) {
    throw new Error(`an entitlement witness lists 1 to ${MAX_BATCH_ENTRIES} entries; this lists ${count}`);
  }
  const size = entryCodec().ENTRY_DATA_SIZE;
  const entries = [];
  const capacities = [];
  for (let i = 0; i < count; i += 1) {
    need(size + 8);
    entries.push(entryCodec().decodeEntryDataV1(bytes.slice(at, at + size)));
    capacities.push(view.getBigUint64(at + size, true));
    at += size + 8;
  }
  if (at !== bytes.length) throw new Error("the entitlement witness has trailing bytes");
  return { schedule, entries, capacities };
}

const api = {
  deriveEntitlements, encodeEntitlementWitness, decodeEntitlementWitness, locatePosition, allocatePrizes, checkBatch,
  MAX_BATCH_ENTRIES, MAX_ENTITLEMENT_BYTES,
};
if (typeof module !== "undefined" && module.exports) module.exports = api;
if (typeof window !== "undefined") window.DaowowEntitlements = api;
})();
