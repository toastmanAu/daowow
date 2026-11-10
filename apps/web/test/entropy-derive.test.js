"use strict";
// The draw is fixed by four block hashes, so the browser can work it out the
// moment the last one exists, without waiting for the operator to post the
// record. That only helps if this derivation is the contract's, byte for byte.
const { test } = require("node:test");
const assert = require("node:assert");
const F = require("./helpers/fake-chain.js");
const {
  entropyBlockHeights, lastEntropyHeight, deriveEntropyRecord, recordsAgree, readEntropyHeaders,
} = require("../chain/entropy-derive.js");
const { buildEntropyTx } = require("../chain/entropy-tx.js");
const { decodeRoundSeal, encodeEntropyRecord } = require("../chain/seal-codec.js");

const R = F.V.entropy_record;
const CKB = 100000000n;
const INCLUSION = BigInt(R.inclusion_height);
const SEAL = decodeRoundSeal(F.unhex(F.V.round_seal.hex), 1);
const inclusionHeader = { number: "0x" + INCLUSION.toString(16), hash: "0x" + R.inclusion_hash };
const entropyHeaders = [64n, 128n, 192n].map((off, i) => ({
  number: "0x" + (INCLUSION + off).toString(16), hash: "0x" + R.entropy_hashes[i],
}));
const good = () => deriveEntropyRecord({ seal: SEAL, inclusionHeader, entropyHeaders });

test("the derived record is byte-identical to the Rust vector", () => {
  assert.strictEqual(F.hex(encodeEntropyRecord(good())), R.hex);
});

test("it equals what the operator's transaction builder would post", () => {
  const built = buildEntropyTx({
    manifest: F.MANIFEST, config: F.CONFIG, inclusionHeader, entropyHeaders,
    sealCell: {
      outPoint: { txHash: "0x" + "11".repeat(32), index: 0 }, capacity: 323n * CKB,
      data: "0x" + F.V.round_seal.hex, typeArgs: "0x" + F.CONFIG.commitment + "00000000",
    },
    configCellOutPoint: { txHash: "0x" + "44".repeat(32), index: 0 },
    sponsor: {
      outPoint: { txHash: "0x" + "55".repeat(32), index: 1 }, capacity: 1000n * CKB,
      lock: { codeHash: "0x" + "22".repeat(32), hashType: "type", args: "0x" + "ab".repeat(20) },
      lockDep: { outPoint: { txHash: "0x" + "77".repeat(32), index: 0 }, depType: "depGroup" },
    },
  });
  assert.strictEqual(recordsAgree(good(), built.expectedRecord), true);
});

test("swapped entropy headers are refused, not silently reordered", () => {
  assert.throws(() => deriveEntropyRecord({
    seal: SEAL, inclusionHeader,
    entropyHeaders: [entropyHeaders[1], entropyHeaders[0], entropyHeaders[2]],
  }), /\+64/);
});

test("fewer than three entropy headers is refused", () => {
  assert.throws(() => deriveEntropyRecord({
    seal: SEAL, inclusionHeader, entropyHeaders: entropyHeaders.slice(0, 2),
  }), /three/);
});

test("one differing block hash means the records do not agree", () => {
  const g = good();
  const other = { ...g, entropyHashes: [g.entropyHashes[0], "00".repeat(32), g.entropyHashes[2]] };
  assert.strictEqual(recordsAgree(g, other), false);
  assert.strictEqual(recordsAgree(g, { ...g, inclusionHeight: g.inclusionHeight + 1n }), false);
  assert.strictEqual(recordsAgree(g, good()), true);
});

test("the four blocks are the seal's own and those 64, 128 and 192 after it", () => {
  assert.deepStrictEqual(entropyBlockHeights(1000n), [1000n, 1064n, 1128n, 1192n]);
});

test("the countdown target is the +192 block", () => {
  assert.strictEqual(lastEntropyHeight(1000n), 1192n);
});

const headersUpTo = (tip) => {
  const out = {};
  for (const h of entropyBlockHeights(1000n)) {
    if (h <= tip) out[h.toString()] = { number: "0x" + h.toString(16), hash: "0x" + h.toString(16).padStart(64, "0") };
  }
  return out;
};

test("readEntropyHeaders is null until the last block exists", async () => {
  assert.strictEqual(await readEntropyHeaders(F.fakeRpc([], { headers: headersUpTo(1191n) }), 1000n), null);
});

test("readEntropyHeaders returns the seal's header and the three after it, in order", async () => {
  const got = await readEntropyHeaders(F.fakeRpc([], { headers: headersUpTo(1192n) }), 1000n);
  assert.strictEqual(BigInt(got.inclusionHeader.number), 1000n);
  assert.deepStrictEqual(got.entropyHeaders.map((h) => BigInt(h.number)), [1064n, 1128n, 1192n]);
  assert.strictEqual(got.entropyHeaders[2].hash, "0x" + (1192n).toString(16).padStart(64, "0"));
});
