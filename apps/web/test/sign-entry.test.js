"use strict";
// The adapter between the pure transaction description and CCC. What is
// testable without a wallet is the conversion and the two invariants that
// bite silently: the witness/input balance, and the splice canary.
const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const { buildEntryTx } = require("../chain/entry-tx.js");
const { decodeSchedule } = require("../chain/schedule.js");
const { loadManifest } = require("../chain/manifest.js");

const V = JSON.parse(fs.readFileSync(path.join(
  __dirname, "..", "..", "..", "tests", "vectors", "daowow_core_vectors.json"), "utf8"));
const MANIFEST = loadManifest(JSON.parse(fs.readFileSync(path.join(
  __dirname, "..", "..", "..", "deployments", "dev-testnet-manifest.json"), "utf8")));
const unhex = (s) => Uint8Array.from(s.match(/../g).map((b) => parseInt(b, 16)));
const CKB = 100000000n;

const description = () => buildEntryTx({
  manifest: MANIFEST,
  config: {
    roundId: V.cell_encodings.round_config.fields.round_id,
    commitment: V.cell_encodings.round_config.commitment,
    ticketPrice: 10000n * CKB, minimumTickets: 5n, maximumTickets: 10n,
    entryStart: 1001n, entryShardCount: 1,
  },
  schedule: decodeSchedule(unhex(V.prize_schedule_v2.hex)),
  shard: {
    roundId: V.cell_encodings.round_config.fields.round_id,
    shardId: 0, state: 0, sequence: 0n, entryCount: 0n, ticketCount: 0n,
    principalTotal: 0n, accumulatorRoot: "00".repeat(32),
    outPoint: { txHash: "0x" + "11".repeat(32), index: 0 }, capacity: 300n * CKB,
  },
  lock: { codeHash: "0x" + "22".repeat(32), hashType: "type", args: "0x" + "ab".repeat(22) },
  participantLockHash: "33".repeat(32),
  tickets: 2n,
  nowEpoch: 1005n,
  configCellOutPoint: { txHash: "0x" + "44".repeat(32), index: 0 },
});

test("the description converts into a CCC transaction without loss", async () => {
  const { toCccTransaction } = await import("../chain/sign-entry.js");
  const d = description().tx;
  const tx = toCccTransaction(d);
  assert.strictEqual(tx.inputs.length, d.inputs.length);
  assert.strictEqual(tx.outputs.length, d.outputs.length);
  assert.strictEqual(tx.cellDeps.length, d.cellDeps.length);
  // The witness the contract reads must survive conversion byte for byte.
  assert.strictEqual(tx.witnesses[0], d.witnesses[0]);
  // The entry cell carries no type script; CCC represents that as undefined.
  assert.strictEqual(tx.outputs[1].type, undefined);
});

test("witnesses and inputs are balanced before funding", async () => {
  // The invariant that makes CCC's addInput splices APPEND rather than
  // displace the append witness at index 0.
  const d = description().tx;
  assert.strictEqual(d.witnesses.length, d.inputs.length);
});

test("an unbalanced transaction is refused before any wallet is involved", async () => {
  const { signAndSendEntry } = await import("../chain/sign-entry.js");
  const d = description().tx;
  d.inputs.push({ previousOutput: { txHash: "0x" + "77".repeat(32), index: 0 }, since: 0n });
  await assert.rejects(
    () => signAndSendEntry({}, d),
    /inputs and 1 witnesses|must match before funding/);
});

test("a displaced witness is caught before sending", async () => {
  const { toCccTransaction, assertWitnessIntact } = await import("../chain/sign-entry.js");
  const tx = toCccTransaction(description().tx);
  const before = tx.witnesses[0];
  assert.doesNotThrow(() => assertWitnessIntact(tx, before), "intact is intact");
  // Reproduce exactly what addInput would do if the witness/input balance did
  // not hold: shift index 0 out from under the contract.
  tx.witnesses.unshift("0x");
  assert.throws(() => assertWitnessIntact(tx, before), /displaced from index 0/);
});
