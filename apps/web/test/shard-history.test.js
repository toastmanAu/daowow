"use strict";
// THE LIVE CELL SET IS NOT THE REPLAY SET.
//
// The accumulator is append-only, so a frozen shard's root commits to every
// entry it ever took. A refund SPENDS an entry cell, which removes it from the
// indexer's live set while the root keeps counting it — so replaying the
// survivors builds a different tree and every proof drawn from it is refused.
//
// This bit on a live round: the first refund succeeded and the second failed,
// because the first had spent the cell the second's replay needed. These tests
// pin the recovery that fixes it.
const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const {
  readShardEntries, entriesFromAppendWitness,
} = require("../chain/shard-history.js");
const { encodeAppendWitnessMmr, encodePeaks } = require("../chain/mmr-witness.js");
const { decodeEntryDataV1 } = require("../chain/entry-codec.js");
const core = require("../core.js");

const V = JSON.parse(fs.readFileSync(path.join(
  __dirname, "..", "..", "..", "tests", "vectors", "daowow_core_vectors.json"), "utf8"));
const unhex = (s) => Uint8Array.from(s.match(/../g).map((b) => parseInt(b, 16)));
const hex = (b) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
const entries = V.aggregation_state.entries.map((e) => decodeEntryDataV1(unhex(e.hex)));

// A shard's real lineage: round creation, then one transaction per entry, then
// freeze and the ledger genesis — the last two carrying no append witness.
function fakeChain() {
  const host = new core.MmrHost();
  const txs = {};
  const h = (n) => "0x" + String(n).padStart(2, "0").repeat(32);

  // Round creation: witness 0 is a WitnessArgs carrying the prize schedule, so
  // it MUST NOT parse as an append witness.
  txs[h(1)] = { transaction: { inputs: [], witnesses: ["0x" + "aa".repeat(80)] } };

  let prev = h(1);
  entries.forEach((entry, i) => {
    const old = encodePeaks(host.peaks);
    host.append(core.entryLeaf(entry));
    const witness = encodeAppendWitnessMmr([entry], old, encodePeaks(host.peaks));
    txs[h(10 + i)] = {
      transaction: {
        inputs: [{ previous_output: { tx_hash: prev, index: "0x0" } }],
        witnesses: ["0x" + hex(witness)],
      },
    };
    prev = h(10 + i);
  });

  // Freeze, then genesis: both walked through, neither contributing entries.
  txs[h(30)] = {
    transaction: {
      inputs: [{ previous_output: { tx_hash: prev, index: "0x0" } }],
      witnesses: ["0x", "0x"],
    },
  };
  txs[h(31)] = {
    transaction: {
      inputs: [{ previous_output: { tx_hash: h(30), index: "0x0" } }],
      witnesses: ["0x", "0x"],
    },
  };

  const calls = [];
  return {
    root: hex(host.root()),
    ledger: { txHash: h(31), index: 0 },
    calls,
    rpc: {
      call: async (method, params) => {
        calls.push(params[0]);
        return txs[params[0]] ?? null;
      },
    },
  };
}

test("the walk recovers every entry in nonce order", async () => {
  const chain = fakeChain();
  const recovered = await readShardEntries(chain.rpc, chain.ledger, 2n);
  assert.strictEqual(recovered.length, 2);
  assert.deepStrictEqual(recovered.map((e) => Number(e.entryNonce)), [0, 1]);
});

test("the recovered set reproduces the shard's committed root", async () => {
  // The property that matters. A set that does not reproduce the root yields
  // proofs for a different tree, which the contract refuses as -4.
  const chain = fakeChain();
  const recovered = await readShardEntries(chain.rpc, chain.ledger, 2n);
  const host = new core.MmrHost();
  for (const entry of recovered) host.append(core.entryLeaf(entry));
  assert.strictEqual(hex(host.root()), chain.root);
});

test("it walks THROUGH freeze and genesis, which carry no append witness", async () => {
  const chain = fakeChain();
  await readShardEntries(chain.rpc, chain.ledger, 2n);
  // Genesis, freeze, then both entry transactions: four hops, in that order.
  assert.strictEqual(chain.calls.length, 4);
  assert.strictEqual(chain.calls[0], chain.ledger.txHash);
});

test("a round-creation WitnessArgs does not parse as an append witness", async () => {
  // The decisive strictness. A loose parse would invent entries out of the
  // prize-schedule witness, and the root check is the only thing downstream
  // that would notice.
  assert.strictEqual(entriesFromAppendWitness(unhex("aa".repeat(80))), null);
  assert.strictEqual(entriesFromAppendWitness(new Uint8Array(0)), null);
  assert.strictEqual(entriesFromAppendWitness(new Uint8Array(11)), null);
});

test("a witness whose declared length does not match exactly is refused", async () => {
  // A witness that merely CONTAINS a plausible prefix is not one.
  const host = new core.MmrHost();
  host.append(core.entryLeaf(entries[0]));
  const good = encodeAppendWitnessMmr(
    [entries[0]], encodePeaks([]), encodePeaks(host.peaks));
  const padded = new Uint8Array(good.length + 1);
  padded.set(good);
  assert.strictEqual(entriesFromAppendWitness(padded), null);
  assert.ok(entriesFromAppendWitness(good), "the unpadded one must still parse");
});

test("an incomplete walk is an error, not a short list", async () => {
  // Silently returning what it found is how a wrong tree reaches the contract.
  const chain = fakeChain();
  await assert.rejects(() => readShardEntries(chain.rpc, chain.ledger, 5n),
    /recovered 2 of the shard's 5/);
});

test("a transaction missing from the node is an error", async () => {
  const rpc = { call: async () => null };
  await assert.rejects(
    () => readShardEntries(rpc, { txHash: "0x" + "99".repeat(32), index: 0 }, 1n),
    /not on this node/);
});

test("entries recovered out of nonce order are refused", async () => {
  // The walk assembling the wrong set would otherwise be caught only by the
  // root check, as an unexplained refusal.
  const host = new core.MmrHost();
  host.append(core.entryLeaf(entries[1]));
  const witness = encodeAppendWitnessMmr(
    [entries[1]], encodePeaks([]), encodePeaks(host.peaks));
  const rpc = { call: async () => ({ transaction: {
    inputs: [], witnesses: ["0x" + hex(witness)],
  } }) };
  await assert.rejects(
    () => readShardEntries(rpc, { txHash: "0x" + "11".repeat(32), index: 0 }, 1n),
    /nonce 1.*out of order|out of order/);
});

test("a shard with no entries needs no walk at all", async () => {
  let called = false;
  const rpc = { call: async () => { called = true; } };
  assert.deepStrictEqual(
    await readShardEntries(rpc, { txHash: "0x" + "11".repeat(32), index: 0 }, 0n), []);
  assert.strictEqual(called, false);
});

test("a multi-entry batch witness contributes all of its entries", async () => {
  // Aggregation accepts up to 32 entries in one transaction, so one witness can
  // carry several and the walk must take them all, in order.
  const host = new core.MmrHost();
  for (const e of entries) host.append(core.entryLeaf(e));
  const witness = encodeAppendWitnessMmr(
    entries, encodePeaks([]), encodePeaks(host.peaks));
  const rpc = { call: async () => ({ transaction: {
    inputs: [], witnesses: ["0x" + hex(witness)],
  } }) };
  const recovered = await readShardEntries(
    rpc, { txHash: "0x" + "11".repeat(32), index: 0 }, 2n);
  assert.deepStrictEqual(recovered.map((e) => Number(e.entryNonce)), [0, 1]);
});
