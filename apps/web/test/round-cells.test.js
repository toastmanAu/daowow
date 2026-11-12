"use strict";
// One read of the whole deployment. The app lists every round, and a scan per
// round against a public node grows with the square of the round count.
const { test } = require("node:test");
const assert = require("node:assert");
const F = require("./helpers/fake-chain.js");
const { readDeployment, findClaims, findMyEntries, decodeClaimArgs } =
  require("../chain/round-cells.js");
const { decodeRoundConfigV1, encodeEntryShardDataV1 } = require("../chain/codec.js");
const { decodeAggregationState } = require("../chain/ledger-codec.js");
const { encodeClaimArgs } = require("../chain/entry-codec.js");

const A = F.CONFIG;
const B_BYTES = F.variantConfigBytes();
const B = decodeRoundConfigV1(B_BYTES);
const LEDGER_HEX = F.V.round_seal.ledger_hex;
const LEDGER = decodeAggregationState(F.unhex(LEDGER_HEX));
const shardBytes = (roundId) => encodeEntryShardDataV1({ ...LEDGER.frozen, roundId });

// Round A carries the vector's record; round B is a fresh round with a shard.
const twoRounds = () => [
  F.roundCell(B_BYTES),                      // newest FIRST, as an indexer might
  F.roundCell(F.CONFIG_BYTES),
  F.shardTypeCell(A.commitment, F.V.entropy_record.hex),
  F.shardTypeCell(B.commitment, F.hex(shardBytes(B.roundId))),
];

test("readDeployment buckets each cell under its own round", async () => {
  const rounds = await readDeployment(F.fakeRpc(twoRounds()), F.MANIFEST);
  assert.strictEqual(rounds.length, 2);
  assert.strictEqual(rounds[0].config.roundId, A.roundId);
  assert.strictEqual(rounds[0].record.record.inclusionHeight, 1234567n); // the vector's own height
  assert.strictEqual(rounds[0].ledger, null);
  assert.strictEqual(rounds[0].shards.length, 0);
  assert.strictEqual(rounds[1].shards.length, 1);
  assert.strictEqual(rounds[1].ledger, null);
  assert.strictEqual(rounds[1].seal, null);
  assert.strictEqual(rounds[1].record, null);
  assert.strictEqual(typeof rounds[1].outPoint.index, "number");
});

test("rounds come back oldest first whatever order the indexer used", async () => {
  const rounds = await readDeployment(F.fakeRpc(twoRounds()), F.MANIFEST);
  assert.ok(rounds[0].config.entryStart < rounds[1].config.entryStart);
});

test("a closed ledger is attached to its round", async () => {
  const rounds = await readDeployment(F.fakeRpc([
    F.roundCell(F.CONFIG_BYTES), F.shardTypeCell(A.commitment, LEDGER_HEX, { capacity: 317n }),
  ]), F.MANIFEST);
  assert.strictEqual(rounds[0].ledger.state.closed, true);
  assert.strictEqual(rounds[0].ledger.capacity, 31700000000n);
});

test("a seal carries the block it was included in", async () => {
  const rounds = await readDeployment(F.fakeRpc([
    F.roundCell(F.CONFIG_BYTES), F.shardTypeCell(A.commitment, F.V.round_seal.hex, { block: 1000n }),
  ]), F.MANIFEST);
  assert.strictEqual(rounds[0].seal.inclusionHeight, 1000n);
  assert.strictEqual(rounds[0].seal.seal.ledgers.length, 1);
  assert.strictEqual(rounds[0].record, null);
});

test("a cell of the right length but the wrong version byte is ignored", async () => {
  const bad = "09" + LEDGER_HEX.slice(2);
  const rounds = await readDeployment(F.fakeRpc([
    F.roundCell(F.CONFIG_BYTES), F.shardTypeCell(A.commitment, bad),
  ]), F.MANIFEST);
  assert.strictEqual(rounds[0].ledger, null);
});

test("a ledger whose args name another round's commitment is not attached", async () => {
  const rounds = await readDeployment(F.fakeRpc([
    F.roundCell(F.CONFIG_BYTES), F.shardTypeCell(B.commitment, LEDGER_HEX),
  ]), F.MANIFEST);
  assert.strictEqual(rounds[0].ledger, null);
});

test("the scan count does not grow with the number of rounds", async () => {
  const scans = async (cells) => {
    const rpc = F.fakeRpc(cells);
    await readDeployment(rpc, F.MANIFEST);
    return rpc.calls.filter((c) => c.method === "get_cells").length;
  };
  const five = [1, 2, 3, 4, 5].flatMap((i) => {
    const bytes = F.variantConfigBytes({ idByte: i, entryStart: BigInt(3000 + i) });
    const c = decodeRoundConfigV1(bytes);
    return [F.roundCell(bytes), F.shardTypeCell(c.commitment, F.hex(shardBytes(c.roundId)))];
  });
  assert.strictEqual(await scans([F.roundCell(F.CONFIG_BYTES)]), 2);
  assert.strictEqual(await scans(five), 2);
});

const claimType = (commitment, position) => F.script("entry-shard-type",
  "0x" + F.hex(encodeClaimArgs({ commitment: F.unhex(commitment), shardId: 0, position })));

test("findClaims returns only claim-typed cells under the lock", async () => {
  const cells = [
    F.cell({ lock: F.WALLET_LOCK, type: claimType(A.commitment, 3n), capacity: 222n }),
    F.cell({ lock: F.WALLET_LOCK, type: claimType(A.commitment, 7n), capacity: 222n }),
    F.cell({ lock: F.WALLET_LOCK }),
    F.cell({ lock: F.WALLET_LOCK, type: { codeHash: "0x" + "ee".repeat(32), hashType: "data1", args: claimType(A.commitment, 1n).args } }),
    F.cell({ lock: { ...F.WALLET_LOCK, args: "0x" + "cd".repeat(22) }, type: claimType(A.commitment, 9n) }),
  ];
  const claims = await findClaims(F.fakeRpc(cells), F.MANIFEST, F.WALLET_LOCK);
  assert.deepStrictEqual(claims.map((c) => c.position), [3n, 7n]);
  assert.strictEqual(claims[0].commitment, A.commitment);
  assert.strictEqual(claims[0].shardId, 0);
  assert.strictEqual(claims[0].capacity, 22200000000n);
});

test("decodeClaimArgs round-trips encodeClaimArgs, and rejects wrong length or tag", () => {
  const args = encodeClaimArgs({ commitment: F.unhex(A.commitment), shardId: 2, position: 41n });
  assert.deepStrictEqual(decodeClaimArgs("0x" + F.hex(args)),
    { commitment: A.commitment, shardId: 2, position: 41n });
  assert.strictEqual(decodeClaimArgs("0x" + F.hex(args.slice(0, 44))), null);
  const memento = Uint8Array.from(args); memento[0] = 6;
  assert.strictEqual(decodeClaimArgs("0x" + F.hex(memento)), null);
  assert.strictEqual(decodeClaimArgs(undefined), null);
});

test("findMyEntries searches by participant prefix and returns each entry's commitment", async () => {
  const me = "aa".repeat(32);
  const lockFor = (who, commitment) => F.script("entry-lock", "0x" + who + commitment);
  const bytes = F.unhex(F.V.entry_encoding.entry.hex);
  const cells = [
    F.cell({ lock: lockFor(me, A.commitment), data: F.hex(bytes), capacity: 500n }),
    F.cell({ lock: lockFor(me, B.commitment), data: F.hex(bytes), capacity: 500n }),
    F.cell({ lock: lockFor("cc".repeat(32), A.commitment), data: F.hex(bytes) }),
  ];
  const rpc = F.fakeRpc(cells);
  const mine = await findMyEntries(rpc, F.MANIFEST, "0x" + me);
  assert.deepStrictEqual(mine.map((e) => e.commitment).sort(), [A.commitment, B.commitment].sort());
  assert.strictEqual(mine[0].participantLockHash, me);
  const key = rpc.calls.find((c) => c.method === "get_cells").params[0];
  assert.strictEqual(key.script.args, "0x" + me);
  assert.strictEqual(key.script_search_mode, "prefix");
  assert.strictEqual(key.script_type, "lock");
});

test("countEntries counts the entries still on chain, per round, in one scan", async () => {
  const { countEntries } = require("../chain/round-cells.js");
  const bytes = F.V.entry_encoding.entry.hex;
  const lockFor = (who, commitment) => F.script("entry-lock", "0x" + who + commitment);
  const rpc = F.fakeRpc([
    F.cell({ lock: lockFor("aa".repeat(32), A.commitment), data: bytes }),
    F.cell({ lock: lockFor("cc".repeat(32), A.commitment), data: bytes }),
    F.cell({ lock: lockFor("aa".repeat(32), B.commitment), data: bytes }),
    F.cell({ lock: lockFor("aa".repeat(32), B.commitment), data: "00" }), // not an entry
  ]);
  const counts = await countEntries(rpc, F.MANIFEST);
  assert.strictEqual(counts.get(A.commitment), 2);
  assert.strictEqual(counts.get(B.commitment), 1);
  assert.strictEqual(counts.get("ee".repeat(32)), undefined);
  assert.strictEqual(rpc.calls.filter((c) => c.method === "get_cells").length, 1);
});

// --- which rounds belong to this deployment ----------------------------------
// Anyone can create a cell under the round type. A round only counts as OURS if
// its config points at the same contracts the site was built for; otherwise a
// stranger could list a round whose deposits go to a lock of their choosing.
const { matchesDeployment, usesNetworkDao } = require("../chain/round-cells.js");
const { scriptHash } = require("../chain/refund-tx.js");
const NAMES = { "entry-lock": "entryLock", "dao-lock": "daoLock",
  "settlement-type": "settlementType", "entry-shard-type": "entryShardType" };
const HASH_TYPE = { data: 0, type: 1, data1: 2, data2: 4 };
const DAO_TYPE_HASH = scriptHash({ codeHash: "0x" + "82".repeat(32), hashType: "type", args: "0x" });
const deployedConfig = (over = {}) => {
  const config = { ...A, daoType: { codeHash: DAO_TYPE_HASH, hashType: 1 } };
  for (const [name, field] of Object.entries(NAMES)) {
    const s = F.MANIFEST.scripts[name];
    config[field] = { codeHash: s.codeHash.replace(/^0x/, ""), hashType: HASH_TYPE[s.hashType] };
  }
  return { ...config, ...over };
};

test("a round built on this deployment's contracts is ours", () => {
  assert.strictEqual(matchesDeployment(deployedConfig(), F.MANIFEST), true);
});

test("a round pointing any one script somewhere else is not ours", () => {
  const rogue = { codeHash: "66".repeat(32), hashType: 2 };
  for (const field of Object.values(NAMES)) {
    assert.strictEqual(matchesDeployment(deployedConfig({ [field]: rogue }), F.MANIFEST), false, field);
  }
});

test("the same code under a different hash type is not ours", () => {
  const lock = deployedConfig().daoLock;
  assert.strictEqual(matchesDeployment(
    deployedConfig({ daoLock: { ...lock, hashType: 1 } }), F.MANIFEST), false);
});

test("a manifest missing one of the contracts trusts no round, and does not throw", () => {
  const scripts = { ...F.MANIFEST.scripts };
  delete scripts["dao-lock"];
  assert.strictEqual(matchesDeployment(deployedConfig(), { ...F.MANIFEST, scripts }), false);
});

test("a round is sound only if its DAO type is the network's own, as a script hash", () => {
  assert.strictEqual(usesNetworkDao(deployedConfig(), DAO_TYPE_HASH), true);
  // The 2026-10-05 trap: two live rounds committed the DAO's CODE hash here
  // and can never run. They are ours, but nobody may be offered an entry.
  const codeHashInstead = { codeHash: "82".repeat(32), hashType: 1 };
  assert.strictEqual(usesNetworkDao(deployedConfig({ daoType: codeHashInstead }), DAO_TYPE_HASH), false);
  assert.strictEqual(usesNetworkDao(
    deployedConfig({ daoType: { codeHash: DAO_TYPE_HASH, hashType: 2 } }), DAO_TYPE_HASH), false);
});

test("without the network's DAO type to compare against, no round is sound", () => {
  assert.strictEqual(usesNetworkDao(deployedConfig(), null), false);
});

// ---- when a block was made -------------------------------------------------
const { readEpochStartTime, readBlockTime } = require("../chain/round-cells.js");
const clockRpc = (over = {}) => {
  const asked = [];
  return {
    asked,
    call: async (method, params) => {
      asked.push([method, ...params]);
      if (method === "get_epoch_by_number") {
        return "epoch" in over ? over.epoch : { number: params[0], start_number: "0x64", length: "0x708" };
      }
      if (method === "get_header_by_number") {
        return "header" in over ? over.header : { number: params[0], timestamp: "0x1a2b3c4d5e" };
      }
      throw new Error(`unexpected ${method}`);
    },
  };
};

test("a period's start is the time on its first block", async () => {
  const rpc = clockRpc();
  assert.strictEqual(await readEpochStartTime(rpc, 14168n), 0x1a2b3c4d5en);
  assert.deepStrictEqual(rpc.asked, [
    ["get_epoch_by_number", "0x3758"], ["get_header_by_number", "0x64"],
  ]);
});

test("a period the node does not know has no start time", async () => {
  await assert.rejects(readEpochStartTime(clockRpc({ epoch: null }), 99n), /has not started/);
});

test("a block's time is read from that block and no other", async () => {
  assert.strictEqual(await readBlockTime(clockRpc(), 100n), 0x1a2b3c4d5en);
  await assert.rejects(readBlockTime(clockRpc({ header: null }), 100n), /not available/);
  await assert.rejects(
    readBlockTime(clockRpc({ header: { number: "0x65", timestamp: "0x1" } }), 100n),
    /asked for block 100 and was given block 101/);
});

test("a period answered for a different period is refused", async () => {
  const rpc = clockRpc({ epoch: { number: "0x1", start_number: "0x64", length: "0x708" } });
  await assert.rejects(readEpochStartTime(rpc, 14168n), /asked for period 14168 and was given 1/);
});
