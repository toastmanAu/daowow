"use strict";
// What a batch's settlement cell must hold when it is created. The contract
// derives this itself and compares byte for byte (daowow-contracts-common
// entitlements.rs, daowow-core entitlements.rs), so these are pinned to
// Rust-derived vectors: a viable round, the same round with one holder, and a
// round that fell short of its minimum.
const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const core = require("../core.js");
const { deriveEntitlements, encodeEntitlementWitness, locatePosition, allocatePrizes } =
  require("../chain/entitlements.js");
const { decodeSettlementFunding, encodeSettlementFunding } = require("../chain/settlement-codec.js");
const { decodeRoundConfigV1 } = require("../chain/codec.js");
const { decodeEntropyRecord } = require("../chain/seal-codec.js");
const { decodeBatchCommitment } = require("../chain/ledger-codec.js");
const { decodeEntryDataV1, ticketId } = require("../chain/entry-codec.js");
const { decodeSchedule } = require("../chain/schedule.js");

const V = JSON.parse(fs.readFileSync(path.join(
  __dirname, "..", "..", "..", "tests", "vectors", "daowow_core_vectors.json"), "utf8"));
const unhex = (s) => Uint8Array.from(s.match(/../g) ?? [], (b) => parseInt(b, 16));
const hex = (b) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");

const inputs = (vector) => {
  const e = vector.entitlements;
  return {
    config: decodeRoundConfigV1(unhex(vector.config)),
    record: decodeEntropyRecord(unhex(vector.record), 1),
    schedule: decodeSchedule(unhex(vector.schedule)),
    batchId: BigInt(e.batch_id),
    receipt: decodeBatchCommitment(unhex(e.receipt)),
    entries: e.entries.map((h) => decodeEntryDataV1(unhex(h))),
    capacities: e.capacities.map(BigInt),
    realizedTotal: BigInt(e.realized_total),
  };
};
const CASES = {
  viable: V.computed_draw, oneHolder: V.computed_draw_one_holder, failed: V.computed_draw_failed,
};
const derive = (name, over = {}) => deriveEntitlements({ ...inputs(CASES[name]), ...over });

for (const [name, vector] of Object.entries(CASES)) {
  test(`${name}: the funding data is byte for byte what Rust derives`, () => {
    const { funding } = derive(name);
    assert.strictEqual(hex(encodeSettlementFunding(funding)), vector.entitlements.funding);
  });

  test(`${name}: the liabilities are Rust's, in Rust's order`, () => {
    const { liabilities } = derive(name);
    assert.deepStrictEqual(
      liabilities.map((l) => ({
        participant_lock_hash: l.participantLockHash, principal: String(l.principal), prize: String(l.prize),
      })),
      vector.entitlements.liabilities);
  });

  test(`${name}: the prizes are Rust's, sorted by ticket`, () => {
    const { prizes } = derive(name);
    assert.deepStrictEqual(
      prizes.map((p) => ({ amount: String(p.amount), ticket: p.ticket })),
      vector.entitlements.prizes.map((p) => ({ amount: p.amount, ticket: p.ticket })));
  });

  test(`${name}: the witness payload is Rust's`, () => {
    const i = inputs(vector);
    assert.strictEqual(
      hex(encodeEntitlementWitness(i.schedule, i.entries, i.capacities)), vector.entitlements.witness);
  });

  test(`${name}: everything realised is owed to someone`, () => {
    const { funding, liabilities, prizes } = derive(name);
    const owed = liabilities.reduce((s, l) => s + l.principal + l.prize, 0n)
      + prizes.reduce((s, p) => s + p.amount, 0n);
    assert.strictEqual(owed, funding.realizedTotal);
    assert.strictEqual(funding.payoutCursor, 0n);
    assert.strictEqual(funding.prizePaid, 0n);
  });
}

test("the vectors cover what they claim to", () => {
  // If these ever stop holding, the cases above no longer exercise the rule
  // they are named for.
  assert.strictEqual(V.computed_draw.entitlements.liabilities.length, 2);
  assert.strictEqual(V.computed_draw.entitlements.prizes.length, 2);
  assert.strictEqual(V.computed_draw_one_holder.entitlements.liabilities.length, 1);
  assert.strictEqual(V.computed_draw_failed.entitlements.prizes.length, 0);
  const failed = V.computed_draw_failed.entitlements.liabilities.map((l) => BigInt(l.prize));
  assert.strictEqual(failed[0] - failed[1], 1n, "an odd pool, so the dust rule is visible");
  assert.notStrictEqual(V.computed_draw.entitlements.funding, V.computed_draw_one_holder.entitlements.funding);
});

test("a viable round owes prizes to tickets and only principal to depositors", () => {
  const { liabilities, prizes, funding } = derive("viable");
  for (const l of liabilities) assert.strictEqual(l.prize, 0n);
  assert.strictEqual(funding.prizeCount, 2n);
  assert.strictEqual(prizes.reduce((s, p) => s + p.amount, 0n), funding.prizePool);
});

test("each prize names the ticket at its drawn position", () => {
  const i = inputs(V.computed_draw);
  const { prizes, draw } = derive("viable");
  const expected = draw.positions.map((p) =>
    hex(ticketId(unhex(i.config.commitment), 0, BigInt(p.position)))).sort();
  assert.deepStrictEqual(prizes.map((p) => p.ticket), expected);
});

test("a failed round shares the pool by principal, dust to the lowest lock hashes", () => {
  const { liabilities, prizes, funding } = derive("failed");
  assert.deepStrictEqual(prizes, []);
  assert.strictEqual(funding.prizeCount, 0n);
  assert.strictEqual(funding.prizeRoot, "00".repeat(32));
  assert.strictEqual(liabilities.reduce((s, l) => s + l.prize, 0n), funding.prizePool);
  assert.ok(liabilities[0].participantLockHash < liabilities[1].participantLockHash);
  assert.strictEqual(liabilities[0].prize, liabilities[1].prize + 1n);
});

test("the principal owed is the entry CELL's capacity, not the ticket price paid", () => {
  const i = inputs(V.computed_draw);
  const { liabilities, funding } = derive("viable");
  assert.strictEqual(funding.principalLiability, i.receipt.inputCapacity);
  assert.strictEqual(liabilities.reduce((s, l) => s + l.principal, 0n), i.capacities.reduce((a, b) => a + b, 0n));
  assert.ok(i.capacities[0] > i.entries[0].principal);
});

test("the liabilities root is the root payouts are proven against", () => {
  const { liabilities, funding, liabilityTree } = derive("viable");
  assert.strictEqual(hex(liabilityTree.root()), funding.liabilitiesRoot);
  const leaf = core.liabilityLeaf(unhex(liabilities[1].participantLockHash), liabilities[1].principal, liabilities[1].prize);
  const root = unhex(funding.liabilitiesRoot);
  assert.strictEqual(core.mmrVerifyMembership(root, 2, 1, leaf, liabilityTree.membershipProof(1)), true);
  assert.strictEqual(core.mmrVerifyMembership(root, 2, 0, leaf, liabilityTree.membershipProof(1)), false);
});

// ---- refusals: InitialEntitlements::derive and validate_batch ---------------
test("a realised total below what went in is refused", () => {
  const i = inputs(V.computed_draw);
  assert.throws(() => derive("viable", { realizedTotal: i.receipt.inputCapacity - 1n }), /less than was deposited/);
});

test("a viable round whose pool leaves a prize at zero is refused, and says the batch would be stranded", () => {
  const i = inputs(V.computed_draw);
  assert.throws(() => derive("viable", { realizedTotal: i.receipt.inputCapacity }), /zero/);
  assert.throws(() => derive("viable", { realizedTotal: i.receipt.inputCapacity + 1n }), /zero/);
});

test("entries that are not the batch the receipt commits to are refused", () => {
  const i = inputs(V.computed_draw);
  const bump = (n) => i.capacities.map((c, k) => (k === n ? c + 1n : c));
  assert.throws(() => derive("viable", { capacities: bump(0) }), /receipt/);
  assert.throws(() => derive("viable", { entries: [i.entries[0]], capacities: [i.capacities[0]] }), /receipt/);
  assert.throws(() => derive("viable", { entries: [i.entries[1], i.entries[0]] }), /position zero/);
  const misnumbered = [i.entries[0], { ...i.entries[1], entryNonce: 5n }];
  assert.throws(() => derive("viable", { entries: misnumbered }), /nonce order/);
  const gap = [i.entries[0], { ...i.entries[1], positionBase: 6n }];
  assert.throws(() => derive("viable", { entries: gap }), /continue the positions/);
  const mispriced = [{ ...i.entries[0], principal: i.entries[0].principal - 1n }, i.entries[1]];
  assert.throws(() => derive("viable", { entries: mispriced }), /price/);
  const otherRound = [{ ...i.entries[0], roundId: new Uint8Array(32) }, i.entries[1]];
  assert.throws(() => derive("viable", { entries: otherRound }), /different round/);
  assert.throws(() => derive("viable", { capacities: [i.capacities[0]] }), /capacity for each entry/);
  assert.throws(() => derive("viable", { entries: [], capacities: [] }), /at least one entry/);
});

test("a batch the seal never accepted is refused", () => {
  assert.throws(() => derive("viable", { batchId: 1n }), /not a batch this round accepted/);
  assert.throws(() => derive("viable", { batchId: 1n << 56n }), /shard/);
});

test("a schedule the config does not commit to is refused", () => {
  const i = inputs(V.computed_draw);
  const other = { ...i.schedule, weights: i.schedule.weights.map((w, k) => (k === 0 ? w + 1n : w)) };
  assert.throws(() => derive("viable", { schedule: other }), /commits to/);
});

test("prize allocation floors each share and gives the dust to first place", () => {
  assert.deepStrictEqual(allocatePrizes([3n, 7n], 3n), [1n, 2n]);
  assert.deepStrictEqual(allocatePrizes([60n, 40n], 101n), [61n, 40n]);
  assert.throws(() => allocatePrizes([], 5n), /weights/);
  assert.throws(() => allocatePrizes([1n, 0n], 5n), /weights/);
});

test("a drawn position is found in the shard that holds it", () => {
  // computed_draw.rs locate: the search runs from the last shard backwards,
  // so an empty shard never claims a position.
  const ledgers = [{ acceptedTickets: 3n }, { acceptedTickets: 0n }, { acceptedTickets: 4n }];
  assert.deepStrictEqual(locatePosition(ledgers, 0n), { shardId: 0, position: 0n });
  assert.deepStrictEqual(locatePosition(ledgers, 2n), { shardId: 0, position: 2n });
  assert.deepStrictEqual(locatePosition(ledgers, 3n), { shardId: 2, position: 0n });
  assert.deepStrictEqual(locatePosition(ledgers, 6n), { shardId: 2, position: 3n });
  assert.throws(() => locatePosition(ledgers, 7n), /not a ticket/);
});

// ---- each receipt field, and each acceptance bound, on its own --------------
const { checkBatch } = require("../chain/entitlements.js");

test("the receipt's digest, counts and capacity are each checked on their own", () => {
  const i = inputs(V.computed_draw);
  const off = (change) => () => checkBatch({ ...i, receipt: { ...i.receipt, ...change } });
  assert.doesNotThrow(() => checkBatch(i));
  assert.throws(off({ digest: "ab".repeat(32) }), /receipt commits to/);
  assert.throws(off({ inputCapacity: i.receipt.inputCapacity + 1n }), /receipt commits to/);
  assert.throws(off({ entryCount: 3n }), /receipt commits to/);
  assert.throws(off({ ticketCount: i.receipt.ticketCount + 1n }), /receipt commits to/);
  assert.throws(off({ principal: i.receipt.principal + 1n }), /receipt commits to/);
});

test("a batch number at or past the accepted count is refused on that ground alone", () => {
  // Batch 1 holding only the second entry is otherwise well-formed, so the
  // ledger's accepted-batch count is the only thing that can refuse it.
  const i = inputs(V.computed_draw);
  const withBatches = (n) => ({
    ...i.record,
    seal: { ...i.record.seal, ledgers: [{ ...i.record.seal.ledgers[0], acceptedBatches: n }] },
  });
  const second = {
    ...i, batchId: 1n, entries: [i.entries[1]], capacities: [i.capacities[1]],
    receipt: { ...i.receipt, firstNonce: 1n },
  };
  assert.throws(() => checkBatch({ ...second, record: withBatches(1n) }), /not a batch this round accepted/);
  // With two accepted batches the same input gets past that bound and is
  // refused for a different reason further on.
  assert.throws(() => checkBatch({ ...second, record: withBatches(2n) }), /receipt commits to/);
});

test("an entry cell that held less than its principal is refused", () => {
  const i = inputs(V.computed_draw);
  assert.throws(
    () => checkBatch({ ...i, capacities: [i.entries[0].principal - 1n, i.capacities[1]] }),
    /less than its principal/);
});

test("prizes are ordered by ticket id whatever order the draw produced them in", () => {
  // The prize tree is built in ticket order, and a root built in draw order
  // would be refused. Try other block hashes until the draw's own order is
  // NOT ticket order, so the sort is what is being tested.
  const i = inputs(V.computed_draw);
  let tested = 0;
  for (let n = 1; n < 40 && tested < 3; n += 1) {
    const record = { ...i.record, entropyHashes: i.record.entropyHashes.map((h, k) => (k === 0 ? String(n).padStart(2, "0").repeat(32) : h)) };
    const { prizes, draw } = deriveEntitlements({ ...i, record });
    const inDrawOrder = draw.positions.map((p) =>
      hex(ticketId(unhex(i.config.commitment), 0, BigInt(p.position))));
    if (inDrawOrder[0] < inDrawOrder[1]) continue;
    tested += 1;
    assert.deepStrictEqual(prizes.map((p) => p.ticket), [...inDrawOrder].sort());
    // First place is still paid first place's amount, wherever it sorts to.
    const first = prizes.find((p) => p.ticket === inDrawOrder[0]);
    assert.ok(first.amount > prizes.find((p) => p.ticket === inDrawOrder[1]).amount);
  }
  assert.ok(tested > 0, "no draw in the sample came out of ticket order");
});

test("each bound on where a batch may start is checked on its own", () => {
  const i = inputs(V.computed_draw);
  const ledgerWith = (change) => ({
    ...i.record,
    seal: { ...i.record.seal, ledgers: [{ ...i.record.seal.ledgers[0], ...change }] },
  });
  // Batch 1 cannot start before entry 1: each earlier batch took at least one.
  assert.throws(
    () => checkBatch({ ...i, batchId: 1n, record: ledgerWith({ acceptedBatches: 2n }) }),
    /not a batch this round accepted/);
  // Batch 0 cannot start after entry 0: no earlier batch exists to hold it.
  assert.throws(() => checkBatch({
    ...i, entries: [i.entries[1]], capacities: [i.capacities[1]],
    receipt: { ...i.receipt, firstNonce: 1n },
  }), /not a batch this round accepted/);
  // A batch cannot run past the entries the round accepted.
  assert.throws(
    () => checkBatch({ ...i, record: ledgerWith({ acceptedEntries: 1n }) }),
    /not a batch this round accepted/);
});
