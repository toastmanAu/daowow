"use strict";
// TX-05. The batch arithmetic is separated from transaction assembly so the
// arithmetic can be pinned to the Rust oracle without a chain anywhere near it.
const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const {
  acceptBatch, buildAggregateTx, daoLockArgs, receiptArgs,
} = require("../chain/aggregate-tx.js");
const {
  decodeAggregationState, encodeAggregationState,
  encodeBatchCommitment, batchId,
} = require("../chain/ledger-codec.js");
const { decodeLedgerWitness } = require("../chain/ledger-witness.js");
const { decodeRoundConfigV1 } = require("../chain/codec.js");
const { scriptHash } = require("../chain/refund-tx.js");
const { decodeEntryDataV1 } = require("../chain/entry-codec.js");
const { loadManifest } = require("../chain/manifest.js");
const core = require("../core.js");

const V = JSON.parse(fs.readFileSync(path.join(
  __dirname, "..", "..", "..", "tests", "vectors", "daowow_core_vectors.json"), "utf8"));
const MANIFEST = loadManifest(JSON.parse(fs.readFileSync(path.join(
  __dirname, "..", "..", "..", "deployments", "dev-testnet-manifest.json"), "utf8")));
const unhex = (s) => Uint8Array.from(s.match(/../g).map((b) => parseInt(b, 16)));
const hex = (b) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
const CKB = 100000000n;
const A = V.aggregation_state;

const CONFIG = decodeRoundConfigV1(unhex(A.config.hex));
const GENESIS = decodeAggregationState(unhex(A.genesis.hex));
const entries = A.entries.map((e) => decodeEntryDataV1(unhex(e.hex)));
const capacities = A.entries.map((e) => BigInt(e.capacity));

// --- the arithmetic, against Rust -----------------------------------------

test("acceptBatch reproduces the Rust batch commitment and next state", () => {
  const { next, batch } = acceptBatch(CONFIG, GENESIS, entries, capacities);
  assert.strictEqual(hex(encodeBatchCommitment(batch)), V.batch_commitment.hex,
    "the digest and counters must match the contract's own");
  assert.strictEqual(hex(encodeAggregationState(next)), A.after_batch.hex);
});

test("the batch's input capacity is the summed cell capacity", () => {
  const { batch } = acceptBatch(CONFIG, GENESIS, entries, capacities);
  assert.strictEqual(batch.inputCapacity, capacities.reduce((s, c) => s + c, 0n));
  assert.ok(batch.inputCapacity > batch.principal);
});

test("entries out of nonce order are refused", () => {
  // accept requires entry_nonce == accepted_entries for each entry IN TURN, so
  // batch n continues exactly where n-1 stopped. Reordering is refused on chain
  // with a state error that says nothing about ordering.
  assert.throws(() => acceptBatch(CONFIG, GENESIS,
    [entries[1], entries[0]], [capacities[1], capacities[0]]), /nonce/);
});

test("a gap in the nonce sequence is refused", () => {
  assert.throws(() => acceptBatch(CONFIG, GENESIS, [entries[1]], [capacities[1]]),
    /nonce/);
});

test("a position_base that does not continue the ticket count is refused", () => {
  const bad = { ...entries[1], positionBase: 99n };
  assert.throws(() => acceptBatch(CONFIG, GENESIS, [entries[0], bad], capacities),
    /position/);
});

test("an empty batch is refused", () => {
  assert.throws(() => acceptBatch(CONFIG, GENESIS, [], []), /at least one/);
});

test("more than 32 entries in one batch is refused", () => {
  const many = Array.from({ length: 33 }, (_, i) => ({ ...entries[0], entryNonce: BigInt(i) }));
  assert.throws(() => acceptBatch(CONFIG, GENESIS, many, many.map(() => 1n * CKB)), /32/);
});

test("a capacity below the entry's principal is refused", () => {
  // The DAO deposit takes the cell's capacity, so a cell holding less than the
  // principal it claims would under-fund the round.
  assert.throws(() => acceptBatch(CONFIG, GENESIS, [entries[0]], [1n]), /capacity/);
});

// Conservation is a disjunction over entries, tickets and principal. A fixture
// that trips two of them pins neither, so each gets a case only it can refuse —
// found the hard way: a probe disabling one disjunct left the test green
// because a sibling still fired.
test("accepting more entries than the frozen shard recorded is refused", () => {
  // Entry counts diverge, ticket and principal totals do not.
  const frozen = { ...GENESIS.frozen, entryCount: 1n };
  assert.throws(() => acceptBatch(CONFIG, { ...GENESIS, frozen }, entries, capacities),
    /more than the frozen shard/);
});

test("accepting more tickets than the frozen shard recorded is refused", () => {
  // Entry count is ample; only the ticket total is exceeded.
  const frozen = { ...GENESIS.frozen, ticketCount: 4n };
  assert.throws(() => acceptBatch(CONFIG, { ...GENESIS, frozen }, entries, capacities),
    /more than the frozen shard/);
});

test("accepting more principal than the frozen shard recorded is refused", () => {
  const frozen = {
    ...GENESIS.frozen,
    principalTotal: 4n * BigInt(CONFIG.ticketPrice),
  };
  assert.throws(() => acceptBatch(CONFIG, { ...GENESIS, frozen }, entries, capacities),
    /more than the frozen shard/);
});

test("a closed ledger accepts nothing", () => {
  assert.throws(() => acceptBatch(CONFIG, { ...GENESIS, closed: true }, entries, capacities),
    /closed/);
});

test("the ledger's batch root advances per batch", () => {
  const { next } = acceptBatch(CONFIG, GENESIS, entries, capacities);
  assert.notStrictEqual(next.batchesRoot, GENESIS.batchesRoot);
  assert.strictEqual(next.acceptedBatches, 1n);
});

// --- the transaction shape ------------------------------------------------

const ledgerCell = {
  outPoint: { txHash: "0x" + "11".repeat(32), index: 0 },
  capacity: 318n * CKB,
  state: GENESIS,
  typeArgs: "0x" + CONFIG.commitment + "00000000",
};
const entryCells = entries.map((entry, i) => ({
  outPoint: { txHash: "0x" + "aa".repeat(32), index: i },
  capacity: capacities[i],
  entry,
}));
const CONFIG_DEP = { txHash: "0x" + "44".repeat(32), index: 0 };
const sponsor = {
  outPoint: { txHash: "0x" + "55".repeat(32), index: 9 },
  capacity: 1000n * CKB,
  lock: { codeHash: "0x" + "22".repeat(32), hashType: "type", args: "0x" + "ab".repeat(20) },
  lockDep: { outPoint: { txHash: "0x" + "77".repeat(32), index: 0 }, depType: "depGroup" },
};
// The native DAO type script, as testnet's genesis defines it. The round
// config does NOT store this code hash: it stores the HASH OF THIS WHOLE
// SCRIPT, because the contracts compare load_cell_type_hash (ledger.rs:159,
// dao-lock, entitlements). The vector config's dao_type is arbitrary bytes, so
// the tests use a config whose dao_type is this script's hash.
const NATIVE_DAO = {
  codeHash: "0x82d76d1b75fe2fd9a27dfbaa65a039221a380d76c926f378d3f81cf3e7e13f2e",
  hashType: "type", args: "0x",
};
const DAO_CONFIG = { ...CONFIG, daoType: { codeHash: scriptHash(NATIVE_DAO), hashType: 1 } };
const DAO_TYPE_DEP = {
  outPoint: { txHash: "0x" + "8f".repeat(32), index: 2 }, depType: "code", script: NATIVE_DAO,
};
const base = () => ({
  manifest: MANIFEST, config: DAO_CONFIG, ledger: ledgerCell, entryCells,
  allEntries: entries, configCellOutPoint: CONFIG_DEP, sponsor,
  daoTypeDep: DAO_TYPE_DEP,
});

test("the ledger is input 0 and its proof witness is witness 0", () => {
  // The raw proof witness must land at the LEDGER input's own index
  // (validate_aggregation loads load_witness(input, Source::Input)), and the
  // sponsor's signature needs its own slot in its own group.
  const { tx } = buildAggregateTx(base());
  assert.deepStrictEqual(tx.inputs[0].previousOutput, ledgerCell.outPoint);
  const records = decodeLedgerWitness(unhex(tx.witnesses[0].replace(/^0x/, "")));
  assert.strictEqual(records.length, entryCells.length);
  assert.deepStrictEqual(records.map((r) => r.inputIndex), [1, 2]);
});

test("witnesses and inputs are balanced, so funding appends rather than displaces", () => {
  const { tx } = buildAggregateTx(base());
  assert.strictEqual(tx.witnesses.length, tx.inputs.length);
});

test("there are exactly three protocol outputs plus change", () => {
  const { tx } = buildAggregateTx(base());
  assert.strictEqual(tx.outputs.length, 4);
});

test("the DAO deposit's capacity is the summed entry capacity, exactly", () => {
  // Not the principal. An entry cell of five tickets holds its principal plus
  // 237 CKB and ALL of it goes in; the sponsor funds the receipt from its own
  // input rather than by shaving the deposit.
  const { tx, batch } = buildAggregateTx(base());
  const dao = tx.outputs.find((o) => o.lock.codeHash === "0x" + CONFIG.daoLock.codeHash);
  assert.ok(dao, "a DAO deposit output must exist");
  assert.strictEqual(BigInt(dao.capacity), batch.inputCapacity);
  assert.strictEqual(BigInt(dao.capacity), capacities.reduce((s, c) => s + c, 0n));
});

test("the DAO deposit carries the native DAO type and eight zero bytes", () => {
  const { tx } = buildAggregateTx(base());
  const i = tx.outputs.findIndex((o) => o.lock.codeHash === "0x" + CONFIG.daoLock.codeHash);
  assert.deepStrictEqual(tx.outputs[i].type, NATIVE_DAO);
  // What the contract actually compares: the type SCRIPT's hash.
  assert.strictEqual(scriptHash(tx.outputs[i].type), DAO_CONFIG.daoType.codeHash);
  assert.strictEqual(tx.outputsData[i], "0x" + "00".repeat(8));
});

test("positive control: testnet's native DAO script hashes to the value ccc computes", () => {
  // Computed independently with ccc.Script.hash() against the live testnet
  // consensus dao_type_hash; scriptHash must agree or every test above that
  // leans on it is comparing a wrong value with itself.
  assert.strictEqual(
    scriptHash(NATIVE_DAO),
    "cc77c4deac05d68ab5b26828f0bf4565a8d73113d7bb7e92b8362b8a74e58e58",
  );
});

test("a config that committed the RAW DAO code hash is refused before signing", () => {
  // Round 0xa42e2888's shape: create-demo-round wrote get_consensus's
  // dao_type_hash into the config. No script hashes to that, so the contract
  // answers -28 on Inputs[0].Type for every aggregate, and the node is the
  // first to say so. The builder must say so first.
  const raw = { ...CONFIG, daoType: { codeHash: NATIVE_DAO.codeHash.slice(2), hashType: 1 } };
  assert.throws(() => buildAggregateTx({ ...base(), config: raw }), /script hash/);
});

test("the native DAO type script itself is required, not only its dep", () => {
  const { script, ...depOnly } = DAO_TYPE_DEP;
  assert.throws(() => buildAggregateTx({ ...base(), daoTypeDep: depOnly }), /native DAO/);
});

// Built by hand rather than by calling daoLockArgs, because comparing the
// builder's output to the helper the builder itself calls is a TAUTOLOGY: both
// move together under any change and the assertion can never fail. A mutation
// swapping two of these fields passed until this was rewritten.
const u64leHex = (v) => {
  let out = "";
  let n = BigInt(v);
  for (let i = 0; i < 8; i++) { out += Number(n & 0xffn).toString(16).padStart(2, "0"); n >>= 8n; }
  return out;
};
const u32leHex = (v) => {
  let out = "";
  let n = BigInt(v);
  for (let i = 0; i < 4; i++) { out += Number(n & 0xffn).toString(16).padStart(2, "0"); n >>= 8n; }
  return out;
};

test("dao_lock args are round_id, batch id, commitment, digest in that order", () => {
  const { tx, batch, batchId: id } = buildAggregateTx(base());
  const dao = tx.outputs.find((o) => o.lock.codeHash === "0x" + CONFIG.daoLock.codeHash);
  const expected = "0x" + CONFIG.roundId + u64leHex(id) + CONFIG.commitment + batch.digest;
  assert.strictEqual(dao.lock.args, expected, "field ORDER is what the contract rebuilds");
  assert.strictEqual(unhex(dao.lock.args.replace(/^0x/, "")).length, 104);
  // And the helper must agree with the hand-built bytes, so a caller using it
  // cannot drift from the contract either.
  assert.strictEqual(daoLockArgs(CONFIG, id, batch), expected);
});

test("receipt args are version 2, commitment, shard, batch id, digest", () => {
  const { tx, batch, batchId: id } = buildAggregateTx(base());
  // Guard the empty-args case: the DAO deposit's type args are "0x", and
  // unhex("") returns null from String.match rather than an empty array.
  const receipt = tx.outputs.find((o) =>
    o.type && o.type.args.length === 2 + 77 * 2);
  assert.ok(receipt, "a receipt output must exist");
  const expected = "0x02" + CONFIG.commitment + u32leHex(0) + u64leHex(id) + batch.digest;
  assert.strictEqual(receipt.type.args, expected, "field ORDER, built independently");
  assert.strictEqual(unhex(receipt.type.args.replace(/^0x/, ""))[0], 2);
  assert.strictEqual(receiptArgs(CONFIG, 0, id, batch), expected);
});

// The args helpers, with DISTINGUISHABLE values. The demo round is shard 0 and
// its first batch is id 0, and u32le(0) and u64le(0) are both all-zero bytes —
// so a test using those values cannot tell the two fields apart, and a mutation
// swapping them passed. Field order needs values that differ.
test("receiptArgs field order is pinned with distinguishable values", () => {
  const batch = { digest: "ab".repeat(32) };
  const args = receiptArgs(CONFIG, 3, 7n, batch);
  const expected = "0x02" + CONFIG.commitment
    + "03000000"              // shard 3, u32 LE
    + "0700000000000000"      // batch 7, u64 LE
    + batch.digest;
  assert.strictEqual(args, expected);
  // And explicitly: swapping the two would produce different bytes now.
  const swapped = "0x02" + CONFIG.commitment
    + "0700000000000000" + "03000000" + batch.digest;
  assert.notStrictEqual(args, swapped);
});

test("daoLockArgs field order is pinned with distinguishable values", () => {
  const batch = { digest: "cd".repeat(32) };
  const args = daoLockArgs(CONFIG, 7n, batch);
  assert.strictEqual(args,
    "0x" + CONFIG.roundId + "0700000000000000" + CONFIG.commitment + batch.digest);
});

test("the batch id for the first batch of shard zero is zero", () => {
  const { batchId: id } = buildAggregateTx(base());
  assert.strictEqual(id, batchId(0, 0n));
});

test("the ledger successor keeps its capacity and its type args", () => {
  const { tx } = buildAggregateTx(base());
  assert.ok(BigInt(tx.outputs[0].capacity) >= ledgerCell.capacity);
  assert.strictEqual(tx.outputs[0].type.args, ledgerCell.typeArgs);
  assert.strictEqual(tx.outputs[0].lock.args, "0x00", "the public lock");
});

test("every membership proof verifies locally before a wallet is involved", () => {
  // A proof that does not verify here is -4 ERROR_MEMBERSHIP_PROOF on chain,
  // after the visitor has signed.
  const { tx } = buildAggregateTx(base());
  const records = decodeLedgerWitness(unhex(tx.witnesses[0].replace(/^0x/, "")));
  const frozen = GENESIS.frozen;
  for (const r of records) {
    const entry = entryCells[r.inputIndex - 1].entry;
    assert.ok(core.mmrVerifyMembership(
      unhex(frozen.accumulatorRoot), Number(frozen.entryCount),
      Number(entry.entryNonce), core.entryLeaf(entry), r.proof),
      `proof for nonce ${entry.entryNonce} must verify against the frozen root`);
  }
});

test("a replay set that does not reproduce the frozen root is refused", () => {
  // The proofs are generated by replaying allEntries. If that replay does not
  // bag to the shard's committed root the proofs are for a different tree, and
  // every one of them would fail on chain.
  assert.throws(() => buildAggregateTx({ ...base(), allEntries: [entries[0]] }),
    /accumulator root/);
});

test("an entry cell not in the replay set is refused", () => {
  const foreign = { ...entryCells[0], entry: { ...entries[0], entryNonce: 7n } };
  assert.throws(() => buildAggregateTx({ ...base(), entryCells: [foreign] }), /nonce|replay/i);
});

test("the sponsor funds the receipt and the arithmetic balances", () => {
  const { tx, fee } = buildAggregateTx(base());
  const inputs = ledgerCell.capacity + capacities.reduce((s, c) => s + c, 0n)
    + sponsor.capacity;
  const outputs = tx.outputs.reduce((s, o) => s + BigInt(o.capacity), 0n);
  assert.strictEqual(inputs - outputs, fee);
});

test("the config cell and the shard code cell are both deps", () => {
  const { tx } = buildAggregateTx(base());
  const deps = tx.cellDeps.map((d) => `${d.outPoint.txHash}:${d.outPoint.index}`);
  const shardDep = MANIFEST.scripts["entry-shard-type"].outPoint;
  assert.ok(deps.includes(`${shardDep.txHash}:${shardDep.index}`));
  assert.ok(deps.includes(`${CONFIG_DEP.txHash}:${CONFIG_DEP.index}`));
  // The entry cells' own lock runs when they are spent, so its code cell is
  // required too — omitting it is ScriptNotFound on those inputs.
  const entryLockDep = MANIFEST.scripts["entry-lock"].outPoint;
  assert.ok(deps.includes(`${entryLockDep.txHash}:${entryLockDep.index}`),
    "entry-lock's code cell must be a dep: it runs on every entry input");
});

// Found by the dry run on its FIRST live run, which is what it exists for: the
// sponsor's own lock had no cell dep, so the node would have refused the
// transaction with ScriptNotFound — the same failure that cost two signing
// rounds on the round-creation transaction. Required rather than resolved, so
// it cannot be forgotten again.
test("the sponsor's lock cell dep is required and lands among the deps", () => {
  const { tx } = buildAggregateTx(base());
  const deps = tx.cellDeps.map((d) => `${d.outPoint.txHash}:${d.outPoint.index}`);
  assert.ok(deps.includes("0x" + "77".repeat(32) + ":0"),
    "the sponsor's lock dep must be present, or its input is ScriptNotFound");
  const { lockDep, ...without } = sponsor;
  assert.throws(() => buildAggregateTx({ ...base(), sponsor: without }), /lockDep|ScriptNotFound/);
});

// Found reading the FIRST live aggregate before it was signed. The transaction
// creates a native DAO deposit, and a TYPE script runs on every cell that
// carries it — outputs included — so the DAO type's code cell must be a dep.
// It was missing, and the dry run's checks were green, because they only
// looked at input LOCKS. Sent, it would have failed with ScriptNotFound on
// Outputs[1].Type. The Python reference harness adds this dep explicitly
// (native_dao_dep, genesis tx0:2); this builder never did.
test("the native DAO type's cell dep is required and lands among the deps", () => {
  const { tx } = buildAggregateTx(base());
  const deps = tx.cellDeps.map((d) => `${d.outPoint.txHash}:${d.outPoint.index}`);
  assert.ok(deps.includes("0x" + "8f".repeat(32) + ":2"),
    "without it the DAO deposit output is ScriptNotFound on Outputs[1].Type");
  const { daoTypeDep, ...without } = base();
  assert.throws(() => buildAggregateTx(without), /native DAO|daoTypeDep/);
});

// The contract compares the receipt cell's data with the batch it computed
// (daowow-contracts-common/src/ledger.rs, the receipt_count branch). An empty
// receipt is -28 SHARD_ERROR_DATA; round 0xaffb66f7 found that on testnet.
test("the receipt cell carries the 73-byte batch record and pays for it", () => {
  const { encodeBatchCommitment } = require("../chain/ledger-codec.js");
  const { tx, batch } = buildAggregateTx(base());
  const want = "0x" + Buffer.from(encodeBatchCommitment(batch)).toString("hex");
  assert.strictEqual(tx.outputsData[2], want);
  assert.strictEqual(want.length, 2 + 73 * 2);
  // 8 capacity + 73 data + 34 lock + 110 type
  assert.strictEqual(BigInt(tx.outputs[2].capacity), 225n * 100000000n);
});
