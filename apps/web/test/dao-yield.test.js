"use strict";
// The prize pool so far: interest the round's Nervos DAO deposit has ACTUALLY
// earned, from the chain's own accumulated rate. Never a projection.
const { test } = require("node:test");
const assert = require("node:assert");
const F = require("./helpers/fake-chain.js");
const { accumulatedRate, occupiedCapacity, maximumWithdraw, findDaoDeposits, readPoolSoFar } =
  require("../chain/dao-yield.js");
const { scriptHash } = require("../chain/refund-tx.js");

const CKB = 100000000n;
const daoField = (ar) => {
  const b = new Uint8Array(32).fill(0x11);
  new DataView(b.buffer).setBigUint64(8, ar, true);
  return "0x" + F.hex(b);
};
const DAO_TYPE = { codeHash: "0x" + "82".repeat(32), hashType: "type", args: "0x" };
const CONFIG = { ...F.CONFIG, daoType: { codeHash: scriptHash(DAO_TYPE), hashType: 1 } };
const daoLock = (roundId = CONFIG.roundId, commitment = CONFIG.commitment) => ({
  codeHash: "0x" + CONFIG.daoLock.codeHash, hashType: "data1",
  args: "0x" + roundId + "0100000000000000" + commitment + "dd".repeat(32),
});
const deposit = (over = {}) => F.cell({
  lock: daoLock(), type: DAO_TYPE, data: "00".repeat(8), capacity: 10000n, block: 500n, ...over,
});
const TIP = { number: "0x3e8", dao: daoField(10010000000000000n) };
const HEADERS = { 500: { number: "0x1f4", dao: daoField(10000000000000000n) } };

test("the accumulated rate is bytes 8..16 of the dao field, little-endian", () => {
  const dao = "0x" + "11".repeat(8) + "0080c6a47e8d0300" + "22".repeat(16);
  assert.strictEqual(accumulatedRate({ dao }), 1000000000000000n);
});

test("maximumWithdraw matches the devnet oracle's formula", () => {
  // tests/devnet/test_native_dao.py:
  //   occupied + (capacity - occupied) * withdrawal_ar // deposit_ar
  assert.strictEqual(
    maximumWithdraw({
      capacity: 10000n * CKB, occupied: 95n * CKB,
      depositAr: 10000000000000000n, currentAr: 10010000000000000n,
    }),
    95n * CKB + (9905n * CKB * 1001n) / 1000n);
});

test("interest accrues on the free capacity only, never the occupied part", () => {
  assert.strictEqual(
    maximumWithdraw({ capacity: 186n * CKB, occupied: 186n * CKB, depositAr: 10n, currentAr: 20n }),
    186n * CKB);
});

test("occupiedCapacity counts script fields, not their molecule encoding", () => {
  // 8 capacity + (32 + 1 + 104) lock + (32 + 1 + 0) type + 8 data = 186 CKB.
  assert.strictEqual(occupiedCapacity(deposit()), 186n * CKB);
  assert.strictEqual(occupiedCapacity(F.cell({ lock: F.WALLET_LOCK })), (8n + 33n + 22n) * CKB);
});

test("a round's deposit is found with its block and capacity", async () => {
  const found = await findDaoDeposits(F.fakeRpc([deposit()]), CONFIG);
  assert.strictEqual(found.length, 1);
  assert.strictEqual(found[0].capacity, 10000n * CKB);
  assert.strictEqual(found[0].occupied, 186n * CKB);
  assert.strictEqual(found[0].blockNumber, 500n);
});

test("a withdrawing cell (non-zero data) is not counted as a deposit", async () => {
  const withdrawing = deposit({ data: "f401000000000000" });
  assert.strictEqual((await findDaoDeposits(F.fakeRpc([withdrawing]), CONFIG)).length, 0);
});

test("a deposit under another round's id or commitment is not counted", async () => {
  const otherRound = deposit({ lock: daoLock("bb".repeat(32)) });
  const otherCommitment = deposit({ lock: daoLock(CONFIG.roundId, "cc".repeat(32)) });
  assert.strictEqual(
    (await findDaoDeposits(F.fakeRpc([otherRound, otherCommitment]), CONFIG)).length, 0);
});

test("a cell under the round's lock that is not a Nervos DAO cell is not counted", async () => {
  const plain = deposit({ type: null });
  const wrongType = deposit({ type: { ...DAO_TYPE, codeHash: "0x" + "83".repeat(32) } });
  assert.strictEqual((await findDaoDeposits(F.fakeRpc([plain, wrongType]), CONFIG)).length, 0);
});

test("the pool so far is the interest earned to date, summed over deposits", async () => {
  const rpc = F.fakeRpc([deposit(), deposit({ capacity: 5186n })], { headers: HEADERS });
  // 0.1% on the free capacity of each: (10000-186) and (5186-186) CKB.
  assert.strictEqual(await readPoolSoFar(rpc, CONFIG, TIP), ((9814n + 5000n) * CKB) / 1000n);
});

test("a deposit newer than the tip it is measured against adds nothing, never a negative", async () => {
  const older = { number: "0x1", dao: daoField(9990000000000000n) }; // rate BELOW the deposit's
  const rpc = F.fakeRpc([deposit()], { headers: HEADERS });
  assert.strictEqual(await readPoolSoFar(rpc, CONFIG, older), 0n);
});

test("no deposit means null, not zero", async () => {
  assert.strictEqual(await readPoolSoFar(F.fakeRpc([]), CONFIG, TIP), null);
});
