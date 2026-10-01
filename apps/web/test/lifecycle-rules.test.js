"use strict";
// The checker's rules, one failing case per Rust rule, each citing the line it
// came from. Every one of these is reported by the chain as a bare
// SHARD_ERROR_* code that covers several distinct causes, which is the whole
// reason for checking locally and returning reasons rather than a boolean.
const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const { decodeRoundConfigV1, decodeEntryShardDataV1 } = require("../chain/codec.js");
const { decodeAggregationState } = require("../chain/ledger-codec.js");
const { decodeEntryDataV1 } = require("../chain/entry-codec.js");
const { daoLockArgs, receiptArgs, acceptBatch } = require("../chain/aggregate-tx.js");
const { batchId } = require("../chain/ledger-codec.js");
const core = require("../core.js");

const load = () => import("../../../tools/lifecycle-rules.mjs");
const V = JSON.parse(fs.readFileSync(path.join(
  __dirname, "..", "..", "..", "tests", "vectors", "daowow_core_vectors.json"), "utf8"));
const unhex = (s) => Uint8Array.from(s.match(/../g).map((b) => parseInt(b, 16)));
const CKB = 100000000n;
const A = V.aggregation_state;
const CONFIG = decodeRoundConfigV1(unhex(A.config.hex));
const FROZEN = decodeEntryShardDataV1(unhex(A.frozen.hex));
const OPEN = { ...FROZEN, state: 0 };
const GENESIS = decodeAggregationState(unhex(A.genesis.hex));
const AFTER = decodeAggregationState(unhex(A.after_batch.hex));
const entries = A.entries.map((e) => decodeEntryDataV1(unhex(e.hex)));
const capacities = A.entries.map((e) => BigInt(e.capacity));
const FLAG = 0x2000000000000000n;

// --- freeze, shard.rs:132 and main.rs:262 ---------------------------------

const freezeBase = () => ({
  config: CONFIG, before: OPEN, after: FROZEN, since: FLAG | CONFIG.entryEnd,
});

test("a correct freeze reports no reasons", async () => {
  const { checkFreeze } = await load();
  assert.deepStrictEqual(checkFreeze(freezeBase()), []);
});

const freezeCases = [
  ["the input must be OPEN (main.rs:257)",
   { before: FROZEN }, /not OPEN/],
  ["the successor must be FROZEN (shard.rs:136)",
   { after: OPEN }, /not FROZEN/],
  ["sequence must be preserved (shard.rs:141)",
   { after: { ...FROZEN, sequence: 9n } }, /only the state/],
  ["entry_count must be preserved (shard.rs:142)",
   { after: { ...FROZEN, entryCount: 9n } }, /only the state/],
  ["ticket_count must be preserved (shard.rs:143)",
   { after: { ...FROZEN, ticketCount: 9n } }, /only the state/],
  ["principal_total must be preserved (shard.rs:144)",
   { after: { ...FROZEN, principalTotal: 9n } }, /only the state/],
  ["the accumulator root must be preserved (shard.rs:145)",
   { after: { ...FROZEN, accumulatorRoot: "ff".repeat(32) } }, /only the state/],
  ["since needs the absolute-epoch flag (RFC 0017)",
   { since: CONFIG.entryEnd }, /absolute-epoch flag/],
  ["since must reach entry_end (main.rs:268)",
   { since: FLAG | (CONFIG.entryEnd - 1n) }, /before the round's entry_end/],
];

for (const [name, patch, pattern] of freezeCases) {
  test(`freeze: ${name}`, async () => {
    const { checkFreeze } = await load();
    const reasons = checkFreeze({ ...freezeBase(), ...patch });
    assert.ok(reasons.length > 0, "expected a reason");
    assert.ok(reasons.some((r) => pattern.test(r)),
      `no reason matched ${pattern}; got ${JSON.stringify(reasons)}`);
  });
}

test("freeze: at entry_end exactly is permitted, one epoch before is not", async () => {
  // absolute_epoch_at_least is inclusive; an off-by-one here would make a
  // shard unfreezable for a whole epoch.
  const { checkFreeze } = await load();
  assert.deepStrictEqual(
    checkFreeze({ ...freezeBase(), since: FLAG | CONFIG.entryEnd }), []);
  assert.ok(
    checkFreeze({ ...freezeBase(), since: FLAG | (CONFIG.entryEnd - 1n) }).length > 0);
});

// --- genesis, lifecycle.rs:99 and ledger.rs:26/54 -------------------------

const genesisBase = () => ({
  config: CONFIG, frozen: FROZEN, state: GENESIS,
  inCapacity: 312n * CKB, outCapacity: 318n * CKB, entryInputCount: 0,
});

test("a correct genesis reports no reasons", async () => {
  const { checkGenesis } = await load();
  assert.deepStrictEqual(checkGenesis(genesisBase()), []);
});

const genesisCases = [
  ["the shard must already be FROZEN (lifecycle.rs:99)",
   { frozen: OPEN }, /frozen/i],
  ["sequence must equal entry_count (lifecycle.rs:102)",
   { frozen: { ...FROZEN, sequence: 5n } }, /sequence/],
  ["principal must be tickets times price (lifecycle.rs:103)",
   { frozen: { ...FROZEN, principalTotal: 1n } }, /principal/],
  ["the output must equal AggregationState::new (ledger.rs:60)",
   { state: AFTER }, /AggregationState::new/],
  ["out_cap must not fall below in_cap (ledger.rs:54)",
   { inCapacity: 400n * CKB, outCapacity: 318n * CKB }, /less than/],
  ["the cell must clear its own 318 CKB floor",
   { inCapacity: 100n * CKB, outCapacity: 200n * CKB }, /occupied floor/],
  ["no entry-lock inputs are permitted (ledger.rs:26)",
   { entryInputCount: 1 }, /no_entry_inputs/],
];

for (const [name, patch, pattern] of genesisCases) {
  test(`genesis: ${name}`, async () => {
    const { checkGenesis } = await load();
    const reasons = checkGenesis({ ...genesisBase(), ...patch });
    assert.ok(reasons.length > 0, "expected a reason");
    assert.ok(reasons.some((r) => pattern.test(r)),
      `no reason matched ${pattern}; got ${JSON.stringify(reasons)}`);
  });
}

// --- aggregate ------------------------------------------------------------

const ID = batchId(0, 0n);
const { batch: BATCH } = acceptBatch(CONFIG, GENESIS, entries, capacities);
const host = (() => {
  const h = new core.MmrHost();
  for (const e of entries) h.append(core.entryLeaf(e));
  return h;
})();
const proofs = entries.map((_, i) => host.membershipProof(i));

const aggBase = () => ({
  config: CONFIG, before: GENESIS, after: AFTER, entries, capacities,
  ledgerInCapacity: 318n * CKB, ledgerOutCapacity: 318n * CKB,
  daoOutput: {
    capacity: BATCH.inputCapacity,
    lock: { args: daoLockArgs(CONFIG, ID, BATCH) },
    type: { codeHash: "0x" + CONFIG.daoType.codeHash },
  },
  daoData: "0x" + "00".repeat(8),
  receiptOutput: { type: { args: receiptArgs(CONFIG, 0, ID, BATCH) } },
  proofs,
});

test("a correct aggregate reports no reasons", async () => {
  const { checkAggregate } = await load();
  assert.deepStrictEqual(checkAggregate(aggBase()), []);
});

const aggCases = [
  ["the DAO deposit must take the summed CELL capacity, not the principal",
   (b) => { b.daoOutput = { ...b.daoOutput, capacity: BATCH.principal }; },
   /must be exact/],
  // Over-funding is the case a `>=` check would wave through, and it is the
  // more plausible builder error: paying MORE looks generous and is refused on
  // chain just as firmly, because the contract tests equality.
  ["an OVER-funded DAO deposit is refused just as firmly as an under-funded one",
   (b) => { b.daoOutput = { ...b.daoOutput, capacity: BATCH.inputCapacity + 1n * CKB }; },
   /must be exact/],
  ["the DAO deposit's args must carry this batch's id and digest",
   (b) => { b.daoOutput = { ...b.daoOutput, lock: { args: "0x" + "00".repeat(104) } }; },
   /dao_lock args/],
  ["the DAO deposit must carry the config's dao_type",
   (b) => { b.daoOutput = { ...b.daoOutput, type: { codeHash: "0x" + "11".repeat(32) } }; },
   /dao_type/],
  ["the DAO deposit's data must be eight zero bytes",
   (b) => { b.daoData = "0x"; }, /eight zero bytes/],
  ["the receipt's args must carry this batch's id and digest",
   (b) => { b.receiptOutput = { type: { args: "0x02" + "00".repeat(76) } }; },
   /receipt's args/],
  ["the ledger successor must be what accepting this batch produces",
   (b) => { b.after = GENESIS; }, /not what accepting this batch produces/],
  ["the ledger successor must not lose capacity",
   (b) => { b.ledgerOutCapacity = 100n * CKB; }, /less capacity/],
  ["a batch the ledger would refuse is reported with its reason",
   (b) => { b.entries = [entries[1]]; b.capacities = [capacities[1]];
            b.proofs = [proofs[1]]; },
   /nonce/],
  ["a proof that does not verify is caught before signing",
   (b) => { b.proofs = [proofs[1], proofs[0]]; },
   /does not verify/],
  ["a missing DAO deposit is reported",
   (b) => { b.daoOutput = null; }, /no DAO deposit/],
  ["a missing receipt is reported",
   (b) => { b.receiptOutput = null; }, /no batch receipt/],
];

for (const [name, mutate, pattern] of aggCases) {
  test(`aggregate: ${name}`, async () => {
    const { checkAggregate } = await load();
    const input = aggBase();
    mutate(input);
    const reasons = checkAggregate(input);
    assert.ok(reasons.length > 0, "expected a reason");
    assert.ok(reasons.some((r) => pattern.test(r)),
      `no reason matched ${pattern}; got ${JSON.stringify(reasons)}`);
  });
}

// --- gate 3b: the seal and the entropy record ------------------------------
const { decodeRoundSeal, decodeEntropyRecord } = require("../chain/seal-codec.js");
const SEALED = decodeRoundSeal(unhex(V.round_seal.hex), 1);
const CLOSED_LEDGER = SEALED.ledgers[0];
const REC = decodeEntropyRecord(unhex(V.entropy_record.hex), 1);
const INC = BigInt(V.entropy_record.inclusion_height);
const incHeader = { number: "0x" + INC.toString(16), hash: "0x" + V.entropy_record.inclusion_hash };
const entHeaders = [64n, 128n, 192n].map((o, i) => ({
  number: "0x" + (INC + o).toString(16), hash: "0x" + V.entropy_record.entropy_hashes[i],
}));
const REL256 = 0x8000000000000100n;

const sealBase = () => ({
  config: CONFIG, before: CLOSED_LEDGER, otherLedgers: [], after: SEALED, shardId: 0,
  inCapacity: 318n * CKB, outCapacity: 323n * CKB, entryInputCount: 0,
});

test("a correct seal reports no reasons", async () => {
  const { checkSeal } = await load();
  assert.deepStrictEqual(checkSeal(sealBase()), []);
});

const sealCases = [
  ["shard zero only (seal.rs:17)", { shardId: 1 }, /only shard zero/],
  ["the ledger must be closed (seal.rs, RoundSeal::new)",
   { before: { ...CLOSED_LEDGER, closed: false } }, /still open/],
  ["the seal must be what RoundSeal::new computes",
   { after: { ...SEALED, ledgers: [{ ...CLOSED_LEDGER, acceptedBatches: 9n }] } }, /RoundSeal::new/],
  ["out_cap must not fall below in_cap", { inCapacity: 400n * CKB, outCapacity: 323n * CKB }, /less capacity/],
  ["the seal cell must clear its 323 CKB floor", { inCapacity: 100n * CKB, outCapacity: 200n * CKB }, /323 CKB floor/],
  ["no entry-lock inputs", { entryInputCount: 1 }, /no_entry_inputs/],
];
for (const [name, patch, pattern] of sealCases) {
  test(`seal: ${name}`, async () => {
    const { checkSeal } = await load();
    const reasons = checkSeal({ ...sealBase(), ...patch });
    assert.ok(reasons.some((r) => pattern.test(r)),
      `no reason matched ${pattern}; got ${JSON.stringify(reasons)}`);
  });
}

const entBase = () => ({
  config: CONFIG, seal: SEALED, record: REC, since: REL256,
  headerDeps: [incHeader.hash, ...entHeaders.map((h) => h.hash)],
  inclusionHeader: incHeader, entropyHeaders: entHeaders,
  inCapacity: 323n * CKB, outCapacity: 460n * CKB, entryInputCount: 0,
});

test("a correct entropy finalisation reports no reasons", async () => {
  const { checkEntropy } = await load();
  assert.deepStrictEqual(checkEntropy(entBase()), []);
});

const entCases = [
  // The two unprecedented rules, each on its own case so neither hides the other.
  ["the since must be a RELATIVE BLOCK NUMBER, not the familiar 0x20 epoch (entropy.rs:52)",
   { since: 0x2000000000000100n }, /0x80, a RELATIVE BLOCK NUMBER/],
  ["the since must be at least 256 blocks (entropy.rs:52)",
   { since: 0x80000000000000ffn }, /at least 256 blocks deep/],
  ["exactly four header deps — a fifth is refused (entropy.rs:72)",
   { headerDeps: [incHeader.hash, ...entHeaders.map((h) => h.hash), incHeader.hash] }, /exactly four/],
  ["header dep 0 is the seal's own block",
   { headerDeps: [entHeaders[0].hash, ...entHeaders.map((h) => h.hash)] }, /header dep 0/],
  // The header dep LISTS the same hash it was handed, so the naming check
  // passes and only the height can refuse it. A first version swapped two
  // headers, which tripped the naming check as well — and its message ("does
  // not name the block at +64") matched the /\+64/ pattern, so deleting the
  // height check left the test green.
  ["each entropy header is at its scheduled height",
   { entropyHeaders: [{ ...entHeaders[0], number: "0x" + (INC + 65n).toString(16) },
                      entHeaders[1], entHeaders[2]] },
   /is at height \d+, not \d+/],
  ["each header dep names the scheduled block",
   { headerDeps: [incHeader.hash, entHeaders[1].hash, entHeaders[0].hash, entHeaders[2].hash] },
   /does not name the block/],
  ["the record must be what entropy.rs computes",
   { record: { ...REC, entropyHashes: [...REC.entropyHashes].reverse() } }, /entropy\.rs computes/],
  ["the record cell must clear its 460 CKB floor",
   { inCapacity: 100n * CKB, outCapacity: 323n * CKB }, /460 CKB floor/],
  ["no entry-lock inputs", { entryInputCount: 1 }, /no_entry_inputs/],
];
for (const [name, patch, pattern] of entCases) {
  test(`entropy: ${name}`, async () => {
    const { checkEntropy } = await load();
    const reasons = checkEntropy({ ...entBase(), ...patch });
    assert.ok(reasons.some((r) => pattern.test(r)),
      `no reason matched ${pattern}; got ${JSON.stringify(reasons)}`);
  });
}

test("entropy: a since failing BOTH rules reports BOTH", async () => {
  // One `if` in the contract, two reasons here: the familiar 0x20 flag with too
  // few blocks is two separate mistakes and the operator should hear about both.
  const { checkEntropy } = await load();
  const reasons = checkEntropy({ ...entBase(), since: 0x2000000000000010n });
  assert.ok(reasons.some((r) => /RELATIVE BLOCK NUMBER/.test(r)));
  assert.ok(reasons.some((r) => /at least 256/.test(r)));
});
