"use strict";
// Paying participants back from a batch's settlement cell.
// Rules from contracts/settlement-type/src/main.rs (the payout branch).
const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const core = require("../core.js");
const {
  buildPayoutTx, encodeSettlementWitness, payoutWitnessBound, FUNDING_CELL_CKB, MAX_PAYOUTS_PER_TX,
} = require("../chain/payout-tx.js");
const { decodeSettlementFunding, encodeSettlementFunding, IMMUTABLE_FIELDS } = require("../chain/settlement-codec.js");
const { scriptHash } = require("../chain/refund-tx.js");
const { loadManifest } = require("../chain/manifest.js");

const V = JSON.parse(fs.readFileSync(path.join(
  __dirname, "..", "..", "..", "tests", "vectors", "daowow_core_vectors.json"), "utf8"));
const MANIFEST = loadManifest(JSON.parse(fs.readFileSync(path.join(
  __dirname, "..", "..", "..", "deployments", "dev-testnet-manifest.json"), "utf8")));
const unhex = (s) => Uint8Array.from((s.startsWith("0x") ? s.slice(2) : s).match(/../g) ?? [], (b) => parseInt(b, 16));
const hex = (b) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
const CKB = 100000000n;
const ST = MANIFEST.scripts["settlement-type"];

// ---- the witness, against Rust ---------------------------------------------
const E = V.computed_draw.entitlements;
test("the payout witness is byte for byte Rust's", () => {
  const rows = E.liabilities.map((l, i) => ({
    lock: { codeHash: "0x" + (0xc0 + i).toString(16).repeat(32), hashType: "type", args: "0x" + hex(new Uint8Array(20 + i).fill(i + 1)) },
    item: { participantLockHash: l.participant_lock_hash, principal: BigInt(l.principal), prize: BigInt(l.prize) },
    proof: unhex(E.payout_proofs[i]),
  }));
  assert.strictEqual(hex(encodeSettlementWitness(rows)), E.payout_witness);
});

test("the proofs our tree produces are the proofs Rust's tree produces", () => {
  const tree = new core.MmrHost();
  for (const l of E.liabilities) {
    tree.append(core.liabilityLeaf(unhex(l.participant_lock_hash), BigInt(l.principal), BigInt(l.prize)));
  }
  assert.deepStrictEqual([0, 1].map((i) => hex(tree.membershipProof(i))), E.payout_proofs);
});

test("a hash type is written as its on-chain byte", () => {
  const row = (hashType) => ({
    lock: { codeHash: "0x" + "c0".repeat(32), hashType, args: "0x" },
    item: { participantLockHash: "aa".repeat(32), principal: 1n, prize: 0n }, proof: new Uint8Array(0),
  });
  const byteAt = (hashType) => encodeSettlementWitness([row(hashType)])[4 + 1 + 32];
  assert.deepStrictEqual(["data", "type", "data1", "data2"].map(byteAt), [0, 1, 2, 4]);
  assert.throws(() => encodeSettlementWitness([row("nope")]), /hash type/);
});

// ---- the transaction ---------------------------------------------------------
// Four participants with real lock scripts, so each liability's hash is the
// hash of a script that can be put on an output.
const lockOf = (n) => ({ codeHash: "0x" + "9b".repeat(32), hashType: "type", args: "0x" + String(n).repeat(40) });
const people = [1, 2, 3, 4].map(lockOf)
  .map((lock) => ({ lock, hash: scriptHash(lock) }))
  .sort((a, b) => (a.hash < b.hash ? -1 : 1));
const PRINCIPALS = [50237n * CKB, 10237n * CKB, 20237n * CKB, 30237n * CKB];
const liabilities = people.map((p, i) => ({ participantLockHash: p.hash, principal: PRINCIPALS[i], prize: 0n }));
const locks = Object.fromEntries(people.map((p) => [p.hash, p.lock]));
const tree = new core.MmrHost();
for (const l of liabilities) tree.append(core.liabilityLeaf(unhex(l.participantLockHash), l.principal, l.prize));
const PRINCIPAL = PRINCIPALS.reduce((a, b) => a + b, 0n);
const stateWith = (over = {}) => ({
  roundId: "11".repeat(32), batchId: 0n, realizedTotal: PRINCIPAL + 900n * CKB,
  principalLiability: PRINCIPAL, prizePool: 900n * CKB, payoutCursor: 0n, liabilityCount: 4n,
  liabilitiesRoot: hex(tree.root()), prizeCount: 2n, prizeRoot: "77".repeat(32), prizePaid: 0n, ...over,
});
const fundingWith = (state, capacity) => ({
  outPoint: { txHash: "0x" + "f1".repeat(32), index: 0 },
  capacity: capacity ?? (state.realizedTotal - state.prizePaid
    - liabilities.slice(0, Number(state.payoutCursor)).reduce((s, l) => s + l.principal + l.prize, 0n)),
  lock: { codeHash: ST.codeHash, hashType: ST.hashType, args: "0x00" },
  type: { codeHash: ST.codeHash, hashType: ST.hashType, args: "0x" + "cc".repeat(32) + "00".repeat(8) + "dd".repeat(32) },
  state,
});
const sponsor = {
  outPoint: { txHash: "0x" + "55".repeat(32), index: 1 },
  capacity: 1000n * CKB,
  lock: { codeHash: "0x" + "22".repeat(32), hashType: "type", args: "0x" + "ab".repeat(20) },
  lockDeps: [{ outPoint: { txHash: "0x" + "77".repeat(32), index: 0 }, depType: "depGroup" }],
};
const base = (over = {}) => {
  const state = over.state ?? stateWith();
  return { manifest: MANIFEST, funding: fundingWith(state, over.capacity), liabilities, locks, sponsor, ...over };
};

test("the settlement cell's occupied floor is 307 CKB", () => {
  // 8 capacity + 160 data + 34 lock (33 + 1) + 105 type (33 + 72).
  assert.strictEqual(FUNDING_CELL_CKB, 307n);
});

test("each participant is paid exactly what they are owed, to their own lock", () => {
  const { tx, paid } = buildPayoutTx(base({ count: 3 }));
  assert.strictEqual(paid.length, 3);
  [0, 1, 2].forEach((i) => {
    const out = tx.outputs[1 + i];
    assert.deepStrictEqual(out.lock, people[i].lock);
    assert.strictEqual(out.type, null, "an ordinary cell");
    assert.strictEqual(tx.outputsData[1 + i], "0x", "with no data");
    assert.strictEqual(BigInt(out.capacity), PRINCIPALS[i]);
  });
});

test("the cursor advances once per participant paid, and nothing immutable moves", () => {
  const before = stateWith();
  const { tx } = buildPayoutTx(base({ count: 3 }));
  const after = decodeSettlementFunding(unhex(tx.outputsData[0]));
  assert.strictEqual(after.payoutCursor, 3n);
  assert.strictEqual(after.prizePaid, before.prizePaid);
  for (const field of IMMUTABLE_FIELDS) assert.strictEqual(after[field], before[field], field);
});

test("the settlement cell keeps its lock and type, and exactly what is left", () => {
  const input = base({ count: 3 });
  const { tx } = buildPayoutTx(input);
  assert.deepStrictEqual(tx.outputs[0].lock, input.funding.lock);
  assert.deepStrictEqual(tx.outputs[0].type, input.funding.type);
  const paidOut = PRINCIPALS.slice(0, 3).reduce((a, b) => a + b, 0n);
  assert.strictEqual(BigInt(tx.outputs[0].capacity), input.funding.capacity - paidOut);
});

test("the sponsor pays the fee and nothing else moves value", () => {
  const input = base({ count: 3 });
  const { tx, fee } = buildPayoutTx(input);
  const last = tx.outputs[tx.outputs.length - 1];
  assert.deepStrictEqual(last.lock, sponsor.lock);
  assert.strictEqual(BigInt(last.capacity), sponsor.capacity - fee);
  const totalIn = input.funding.capacity + sponsor.capacity;
  assert.strictEqual(totalIn - tx.outputs.reduce((s, o) => s + BigInt(o.capacity), 0n), fee);
  assert.deepStrictEqual(tx.inputs.map((i) => i.previousOutput), [input.funding.outPoint, sponsor.outPoint]);
});

test("the witness sits at the settlement cell's own input and proves each position in turn", () => {
  const { tx } = buildPayoutTx(base({ count: 3 }));
  const rows = [0, 1, 2].map((i) => ({ lock: people[i].lock, item: liabilities[i], proof: tree.membershipProof(i) }));
  assert.strictEqual(tx.witnesses[0], "0x" + hex(encodeSettlementWitness(rows)));
  assert.strictEqual(tx.witnesses.length, 2);
  const root = unhex(stateWith().liabilitiesRoot);
  rows.forEach((r, i) => {
    const leaf = core.liabilityLeaf(unhex(r.item.participantLockHash), r.item.principal, r.item.prize);
    assert.strictEqual(core.mmrVerifyMembership(root, 4, i, leaf, r.proof), true);
  });
});

test("payment resumes from the cursor, never from the start", () => {
  const state = stateWith({ payoutCursor: 2n });
  const { tx, paid } = buildPayoutTx(base({ state, count: 1 }));
  assert.deepStrictEqual(paid.map((p) => p.participantLockHash), [people[2].hash]);
  assert.deepStrictEqual(tx.outputs[1].lock, people[2].lock);
  assert.strictEqual(decodeSettlementFunding(unhex(tx.outputsData[0])).payoutCursor, 3n);
  // The proof is for position 2 of the tree, not position 0 of this payout.
  const row = { lock: people[2].lock, item: liabilities[2], proof: tree.membershipProof(2) };
  assert.strictEqual(tx.witnesses[0], "0x" + hex(encodeSettlementWitness([row])));
  assert.notDeepStrictEqual(tree.membershipProof(2), tree.membershipProof(0));
});

test("the cell deps are the settlement script and the sponsor's lock", () => {
  const { tx } = buildPayoutTx(base({ count: 1 }));
  assert.deepStrictEqual(tx.cellDeps, [{ outPoint: ST.outPoint, depType: ST.depType }, ...sponsor.lockDeps]);
  assert.deepStrictEqual(tx.headerDeps, []);
});

// ---- the floor that orders settlement ---------------------------------------
test("with prizes unredeemed, the last participant waits unless 307 CKB of prizes remain", () => {
  // After the last payout only unredeemed prizes are left in the cell, and a
  // cell cannot hold less than its own 307 CKB floor. 900 CKB remain: fine.
  const all = buildPayoutTx(base());
  assert.strictEqual(all.paid.length, 4);
  assert.strictEqual(all.final, false, "the cell stays open for the prizes");
  assert.strictEqual(BigInt(all.tx.outputs[0].capacity), 900n * CKB);
});

test("with too little left to keep the cell alive, the builder pays everyone but the last", () => {
  const state = stateWith({ realizedTotal: PRINCIPAL + 306n * CKB, prizePool: 306n * CKB });
  const { paid, held, tx } = buildPayoutTx(base({ state }));
  assert.strictEqual(paid.length, 3);
  assert.strictEqual(held, 1);
  assert.strictEqual(BigInt(tx.outputs[0].capacity), PRINCIPALS[3] + 306n * CKB);
  // Asking for all four by name is refused, and says what has to happen first.
  assert.throws(() => buildPayoutTx(base({ state, count: 4 })), /prizes.*redeemed/s);
  const exactly = stateWith({ realizedTotal: PRINCIPAL + 307n * CKB, prizePool: 307n * CKB });
  assert.strictEqual(buildPayoutTx(base({ state: exactly })).paid.length, 4);
});

test("when only the last participant is left and prizes are unredeemed below the floor, nothing can be paid", () => {
  const state = stateWith({ realizedTotal: PRINCIPAL + 306n * CKB, prizePool: 306n * CKB, payoutCursor: 3n });
  assert.throws(() => buildPayoutTx(base({ state })), /prizes.*redeemed/s);
});

test("once every prize is redeemed the last payout empties and closes the cell", () => {
  const state = stateWith({ prizePaid: 900n * CKB, payoutCursor: 3n });
  const { tx, final, paid } = buildPayoutTx(base({ state }));
  assert.strictEqual(final, true);
  assert.strictEqual(paid.length, 1);
  assert.strictEqual(tx.outputs.length, 2, "the payment and the sponsor's change: no settlement cell");
  assert.deepStrictEqual(tx.outputs[0].lock, people[3].lock);
  assert.strictEqual(BigInt(tx.outputs[0].capacity), PRINCIPALS[3]);
  assert.deepStrictEqual(tx.outputsData, ["0x", "0x"]);
});

test("a round with no prizes closes on its last payout", () => {
  const state = stateWith({ prizeCount: 0n, prizeRoot: "00".repeat(32), prizePool: 0n, realizedTotal: PRINCIPAL });
  const { final, paid } = buildPayoutTx(base({ state }));
  assert.strictEqual(final, true);
  assert.strictEqual(paid.length, 4);
});

test("a closing payout that would leave shannons behind is refused", () => {
  const state = stateWith({ prizePaid: 900n * CKB, payoutCursor: 3n });
  assert.throws(() => buildPayoutTx(base({ state, capacity: PRINCIPALS[3] + 1n })), /does not hold exactly/);
});

// ---- refusals ----------------------------------------------------------------
test("liabilities that are not the ones the cell commits to are refused", () => {
  const forged = liabilities.map((l, i) => (i === 0 ? { ...l, principal: l.principal + 1n } : l));
  assert.throws(() => buildPayoutTx(base({ liabilities: forged })), /commits to/);
  assert.throws(() => buildPayoutTx(base({ liabilities: liabilities.slice(0, 3) })), /commits to/);
});

test("a lock that does not hash to its participant is refused", () => {
  assert.throws(() => buildPayoutTx(base({ locks: { ...locks, [people[0].hash]: people[1].lock } })), /does not hash/);
  const { [people[0].hash]: gone, ...missing } = locks;
  assert.throws(() => buildPayoutTx(base({ locks: missing })), /lock script/);
});

test("nothing left to pay is refused", () => {
  const state = stateWith({ payoutCursor: 4n });
  assert.throws(() => buildPayoutTx(base({ state })), /every participant.*paid/s);
  assert.throws(() => buildPayoutTx(base({ count: 0 })), /at least one/);
  assert.throws(() => buildPayoutTx(base({ count: 5 })), /only 4/);
});

test("a cell that is not a settlement cell is refused", () => {
  const input = base();
  const wrongLock = { ...input.funding, lock: { ...input.funding.lock, args: "0x01" } };
  assert.throws(() => buildPayoutTx({ ...input, funding: wrongLock }), /settlement/);
  const typed = (change) => ({ ...input, funding: { ...input.funding, type: { ...input.funding.type, ...change } } });
  assert.throws(() => buildPayoutTx(typed({ codeHash: "0x" + "ee".repeat(32) })), /settlement/);
  assert.throws(() => buildPayoutTx(typed({ hashType: "type" })), /settlement/);
  // The same script with one-byte args is the public LOCK, not a batch's type.
  assert.throws(() => buildPayoutTx(typed({ args: "0x00" })), /settlement/);
});

test("a sponsor that cannot pay the fee and keep a cell is refused", () => {
  assert.throws(() => buildPayoutTx(base({ sponsor: { ...sponsor, capacity: 61n * CKB } })), /61 CKB/);
  const { lockDeps, ...bare } = sponsor;
  assert.throws(() => buildPayoutTx(base({ sponsor: bare })), /are required/);
  assert.throws(() => buildPayoutTx(base({ sponsor: { ...sponsor, lockDeps: [] } })), /are required/);
});

test("a payment below its own cell's floor is topped up by the sponsor, never by the settlement cell", () => {
  // settlement-type: the cell needs capacity >= owed AND >= its own floor, and
  // only the owed amount leaves the settlement cell.
  const tiny = [{ participantLockHash: people[0].hash, principal: 10n * CKB, prize: 0n }];
  const small = new core.MmrHost();
  small.append(core.liabilityLeaf(unhex(tiny[0].participantLockHash), 10n * CKB, 0n));
  const state = stateWith({
    liabilityCount: 1n, liabilitiesRoot: hex(small.root()), principalLiability: 10n * CKB,
    realizedTotal: 910n * CKB,
  });
  const input = base({ state, liabilities: tiny, capacity: 910n * CKB });
  const { tx, fee, gift } = buildPayoutTx(input);
  const floor = (8n + 33n + 20n) * CKB;
  assert.strictEqual(BigInt(tx.outputs[1].capacity), floor);
  assert.strictEqual(gift, floor - 10n * CKB);
  assert.strictEqual(BigInt(tx.outputs[0].capacity), 900n * CKB, "only the 10 CKB owed left the cell");
  assert.strictEqual(BigInt(tx.outputs[2].capacity), sponsor.capacity - fee - gift);
});

test("the batch bound is computed, and a whole batch fits one witness many times over", () => {
  // A batch holds at most 32 entries, so at most 32 liabilities. Worst case
  // per item: 255 bytes of lock args and a full proof for 32 leaves.
  assert.strictEqual(MAX_PAYOUTS_PER_TX, 32);
  const bound = payoutWitnessBound(32);
  assert.strictEqual(bound, 4 + 32 * (1 + 255 + 32 + 1 + 48 + 4 + (1 + 5 * 32 + 1 + 1 + 6 * 32)));
  assert.ok(bound < (512 * 1024) / 8, "under an eighth of the script's 512 KiB heap");
  assert.throws(() => buildPayoutTx(base({ count: 33 })), /only 4|at most 32/);
});

test("on a round that did not draw, each participant is paid principal AND their share", () => {
  const shared = liabilities.map((l, i) => ({ ...l, prize: BigInt(i + 1) * 7n * CKB }));
  const t = new core.MmrHost();
  for (const l of shared) t.append(core.liabilityLeaf(unhex(l.participantLockHash), l.principal, l.prize));
  const pool = 70n * CKB;
  const state = stateWith({
    liabilitiesRoot: hex(t.root()), prizeCount: 0n, prizeRoot: "00".repeat(32),
    prizePool: pool, realizedTotal: PRINCIPAL + pool,
  });
  const { tx, final } = buildPayoutTx(base({ state, liabilities: shared, capacity: PRINCIPAL + pool, count: 2 }));
  assert.strictEqual(BigInt(tx.outputs[1].capacity), PRINCIPALS[0] + 7n * CKB);
  assert.strictEqual(BigInt(tx.outputs[2].capacity), PRINCIPALS[1] + 14n * CKB);
  assert.strictEqual(BigInt(tx.outputs[0].capacity), PRINCIPALS[2] + PRINCIPALS[3] + 49n * CKB);
  assert.strictEqual(final, false);
  assert.strictEqual(buildPayoutTx(base({ state, liabilities: shared, capacity: PRINCIPAL + pool })).final, true);
});

test("a lock whose args do not fit the witness's one-byte length is refused", () => {
  const long = { codeHash: "0x" + "9b".repeat(32), hashType: "type", args: "0x" + "ab".repeat(256) };
  const item = { participantLockHash: scriptHash(long), principal: 500n * CKB, prize: 0n };
  assert.throws(() => encodeSettlementWitness([{ lock: long, item, proof: new Uint8Array(0) }]), /255 bytes/);
  const fits = { ...long, args: "0x" + "ab".repeat(255) };
  assert.doesNotThrow(() => encodeSettlementWitness([{ lock: fits, item, proof: new Uint8Array(0) }]));
});

// ---- reading a witness back -------------------------------------------------
const { decodeSettlementWitness } = require("../chain/payout-tx.js");

test("a payout witness reads back to what was written, Rust's bytes included", () => {
  const rows = decodeSettlementWitness(unhex(E.payout_witness));
  assert.strictEqual(rows.length, 2);
  assert.deepStrictEqual(rows.map((r) => r.item.participantLockHash), E.liabilities.map((l) => l.participant_lock_hash));
  assert.deepStrictEqual(rows.map((r) => String(r.item.principal)), E.liabilities.map((l) => l.principal));
  assert.deepStrictEqual(rows.map((r) => hex(r.proof)), E.payout_proofs);
  assert.strictEqual(rows[1].lock.args, "0x" + "02".repeat(21));
  assert.strictEqual(rows[1].lock.codeHash, "0x" + "c1".repeat(32));
  assert.strictEqual(rows[1].lock.hashType, "type");
  assert.strictEqual(hex(encodeSettlementWitness(rows)), E.payout_witness);
});

test("a malformed payout witness is refused the way the contract refuses it", () => {
  const good = unhex(E.payout_witness);
  assert.throws(() => decodeSettlementWitness(good.slice(0, 3)), /at least 4/);
  assert.throws(() => decodeSettlementWitness(good.slice(0, good.length - 1)), /cut short/);
  assert.throws(() => decodeSettlementWitness(Uint8Array.from([...good, 0])), /trailing/);
  const many = Uint8Array.from(good); many[0] = 129;
  assert.throws(() => decodeSettlementWitness(many), /at most 128/);
});
