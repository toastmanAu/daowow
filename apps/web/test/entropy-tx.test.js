"use strict";
// Entropy finalisation: the seal becomes an EntropyRecord fixing the draw.
// Rules from contracts/entry-shard-type/src/entropy.rs.
//
// Two rules here have NO PRECEDENT elsewhere in this protocol, and both fail
// on chain as SHARD_ERROR_STATE or _DATA with no hint at the cause:
//
//   1. The since is a RELATIVE BLOCK NUMBER (top byte 0x80, >= 256). Every
//      other since here is an absolute epoch with 0x20.
//   2. EXACTLY four header deps — the seal's own block, then +64, +128, +192.
//      A fifth is refused outright.
const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const {
  buildEntropyTx, entropyHeights, relativeBlockSince,
  RELATIVE_BLOCK_FLAG, RECORD_CELL_CKB,
} = require("../chain/entropy-tx.js");
const { decodeEntropyRecord } = require("../chain/seal-codec.js");
const { decodeRoundConfigV1 } = require("../chain/codec.js");
const { loadManifest } = require("../chain/manifest.js");

const V = JSON.parse(fs.readFileSync(path.join(
  __dirname, "..", "..", "..", "tests", "vectors", "daowow_core_vectors.json"), "utf8"));
const MANIFEST = loadManifest(JSON.parse(fs.readFileSync(path.join(
  __dirname, "..", "..", "..", "deployments", "dev-testnet-manifest.json"), "utf8")));
const unhex = (s) => Uint8Array.from(s.match(/../g).map((b) => parseInt(b, 16)));
const CKB = 100000000n;
const R = V.entropy_record;

const CONFIG = decodeRoundConfigV1(unhex(V.aggregation_state.config.hex));
const INCLUSION = BigInt(R.inclusion_height);

// The exact headers the Rust vector was built from, so the record this builds
// must equal it byte for byte.
const inclusionHeader = { number: "0x" + INCLUSION.toString(16), hash: "0x" + R.inclusion_hash };
const entropyHeaders = [64n, 128n, 192n].map((off, i) => ({
  number: "0x" + (INCLUSION + off).toString(16),
  hash: "0x" + R.entropy_hashes[i],
}));
const sealCell = {
  outPoint: { txHash: "0x" + "11".repeat(32), index: 0 },
  capacity: 323n * CKB,                 // what the seal step mints
  data: "0x" + V.round_seal.hex,
  typeArgs: "0x" + CONFIG.commitment + "00000000",
};
const sponsor = {
  outPoint: { txHash: "0x" + "55".repeat(32), index: 1 },
  capacity: 1000n * CKB,
  lock: { codeHash: "0x" + "22".repeat(32), hashType: "type", args: "0x" + "ab".repeat(20) },
  lockDep: { outPoint: { txHash: "0x" + "77".repeat(32), index: 0 }, depType: "depGroup" },
};
const base = () => ({
  manifest: MANIFEST, config: CONFIG, sealCell, inclusionHeader, entropyHeaders,
  configCellOutPoint: { txHash: "0x" + "44".repeat(32), index: 0 }, sponsor,
});

// --- the schedule ----------------------------------------------------------

test("entropyHeights is inclusion plus 64, 128, 192 and 256", () => {
  assert.deepStrictEqual(entropyHeights(1000n), [1064n, 1128n, 1192n, 1256n]);
});

test("entropyHeights matches the Rust oracle, including past 2^53", () => {
  // The third vector is above 2^53: a port computing heights as Number rounds
  // silently there.
  for (const v of V.entropy_heights) {
    assert.deepStrictEqual(entropyHeights(BigInt(v.inclusion)), v.heights.map(BigInt));
  }
});

// --- RULE 1: the relative block number since ------------------------------

test("the since is a RELATIVE BLOCK NUMBER, not an absolute epoch", () => {
  // entropy.rs:52 requires `since >> 56 == 0x80`. Every other since in this
  // protocol is an absolute epoch with 0x20; using that familiar form here
  // fails as SHARD_ERROR_STATE and says nothing about metrics.
  const { tx } = buildEntropyTx(base());
  assert.strictEqual(tx.inputs[0].since >> 56n, 0x80n);
  assert.notStrictEqual(tx.inputs[0].since >> 56n, 0x20n);
});

test("the relative block count is at least 256", () => {
  const { tx } = buildEntropyTx(base());
  assert.ok((tx.inputs[0].since & 0x00ffffffffffffffn) >= 256n);
});

test("relativeBlockSince sets the flag and refuses fewer than 256 blocks", () => {
  // The flag and the bound are ONE `if` in the contract and two guards here,
  // so each can be pinned without the other hiding it.
  assert.strictEqual(relativeBlockSince(256n), RELATIVE_BLOCK_FLAG | 256n);
  assert.strictEqual(relativeBlockSince(256n), 0x8000000000000100n);
  assert.throws(() => relativeBlockSince(255n), /at least 256/);
});

// --- RULE 2: exactly four header deps --------------------------------------

test("there are EXACTLY four header deps", () => {
  // entropy.rs:72 requires load_header(4, HeaderDep) to be IndexOutOfBound.
  assert.strictEqual(buildEntropyTx(base()).tx.headerDeps.length, 4);
});

test("header dep 0 is the seal's own inclusion block", () => {
  // Hash-checked against load_header(0, GroupInput) — the block the seal input
  // was committed in.
  assert.strictEqual(buildEntropyTx(base()).tx.headerDeps[0], inclusionHeader.hash);
});

test("header deps 1 to 3 are the blocks at +64, +128, +192, in order", () => {
  assert.deepStrictEqual(buildEntropyTx(base()).tx.headerDeps.slice(1),
    entropyHeaders.map((h) => h.hash));
});

test("a header at the wrong height is refused before signing", () => {
  // The contract checks each header's number against the schedule. Supplied
  // in the wrong slot, the chain says SHARD_ERROR_DATA.
  const swapped = [entropyHeaders[1], entropyHeaders[0], entropyHeaders[2]];
  assert.throws(() => buildEntropyTx({ ...base(), entropyHeaders: swapped }),
    /\+64|height/);
});

test("fewer than three entropy headers is refused", () => {
  assert.throws(() => buildEntropyTx({ ...base(), entropyHeaders: entropyHeaders.slice(0, 2) }),
    /three/);
});

// --- the record ------------------------------------------------------------

test("the record is exactly what the contract will recompute", () => {
  // Pinned to the Rust oracle. entropy.rs re-derives it and compares.
  const { tx } = buildEntropyTx(base());
  assert.strictEqual(tx.outputsData[0].replace(/^0x/, ""), R.hex);
});

test("the record cell clears its 460 CKB floor: a 137 CKB top-up over the seal", () => {
  // NOT predicted when the plan was first written. The Task 1 vector showed
  // the record is 349 bytes, so this step grows its cell more than genesis (6)
  // and seal (5) combined.
  assert.strictEqual(RECORD_CELL_CKB, 460n);
  const { tx, topUp } = buildEntropyTx(base());
  assert.strictEqual(BigInt(tx.outputs[0].capacity), 460n * CKB);
  assert.strictEqual(topUp, 137n * CKB);
});

test("earliestHeight says when this transaction becomes sendable", () => {
  // A keeper who does not know this is a ~34 minute WAIT will read the delay
  // as a failure. The dry run prints it.
  const { earliestHeight } = buildEntropyTx(base());
  assert.strictEqual(earliestHeight, INCLUSION + 256n);
});

test("an input whose data is not a seal is refused", () => {
  // entropy.rs:31 — before[0] must be 3. A ledger or a record here is a
  // different step entirely.
  assert.throws(() => buildEntropyTx({
    ...base(), sealCell: { ...sealCell, data: "0x" + V.round_seal.ledger_hex },
  }), /not a seal/);
});

test("the record keeps the seal's type args and the public lock", () => {
  const { tx } = buildEntropyTx(base());
  assert.strictEqual(tx.outputs[0].type.args, sealCell.typeArgs);
  assert.strictEqual(tx.outputs[0].lock.args, "0x00");
  const record = decodeEntropyRecord(unhex(tx.outputsData[0].replace(/^0x/, "")), 1);
  assert.strictEqual(record.inclusionHeight, INCLUSION);
});

test("a seal cell carrying another round's type args is refused", () => {
  assert.throws(() => buildEntropyTx({
    ...base(), sealCell: { ...sealCell, typeArgs: "0x" + "99".repeat(32) + "00000000" },
  }), /does not belong to this round/);
});

test("an entry-lock input is refused: no_entry_inputs", () => {
  const entryLock = MANIFEST.scripts["entry-lock"];
  assert.throws(() => buildEntropyTx({
    ...base(),
    sponsor: { ...sponsor,
      lock: { codeHash: entryLock.codeHash, hashType: entryLock.hashType, args: "0x00" } },
  }), /no_entry_inputs/);
});

test("the sponsor's lock cell dep is required", () => {
  const { lockDep, ...without } = sponsor;
  assert.throws(() => buildEntropyTx({ ...base(), sponsor: without }), /lockDep|ScriptNotFound/);
});

test("witnesses and inputs are balanced and the arithmetic closes", () => {
  const { tx, fee } = buildEntropyTx(base());
  assert.strictEqual(tx.witnesses.length, tx.inputs.length);
  const inputs = sealCell.capacity + sponsor.capacity;
  const outputs = tx.outputs.reduce((s, o) => s + BigInt(o.capacity), 0n);
  assert.strictEqual(inputs - outputs, fee);
});
