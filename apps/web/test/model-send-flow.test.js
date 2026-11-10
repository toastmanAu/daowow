"use strict";
// What the player is told after a transaction leaves the wallet.
//
// Once a transaction has been broadcast, "it was not sent" is never true
// again, whatever the network does next. A public node drops polls all the
// time; a dropped poll must not become "nothing has left your wallet", because
// the player's next move is to press the button again and pay twice.
const { test } = require("node:test");
const assert = require("node:assert");
const { watchTransaction, runEntry, runRefund } = require("../dapp/model/send-flow.js");

const committed = { awaitCommitted: async () => ({ status: "committed", blockNumber: 77n }), awaitIndexer: async () => true };

test("a committed transaction is confirmed, with its block", async () => {
  assert.deepStrictEqual(await watchTransaction({ rpc: {}, txHash: "0x1", confirm: committed }),
    { outcome: "confirmed", blockNumber: 77n, detail: null });
});

test("a poll that fails after broadcast means 'still on its way', never 'not sent'", async () => {
  const flaky = { ...committed, awaitCommitted: async () => { throw new Error("502 Bad Gateway"); } };
  const result = await watchTransaction({ rpc: {}, txHash: "0x1", confirm: flaky });
  assert.strictEqual(result.outcome, "pending");
  assert.match(result.detail, /502/);
});

test("a timeout while watching is 'still on its way'", async () => {
  const slow = { ...committed, awaitCommitted: async () => ({ status: "pending", blockNumber: null, timedOut: true }) };
  assert.strictEqual((await watchTransaction({ rpc: {}, txHash: "0x1", confirm: slow })).outcome, "pending");
});

test("only the node's own rejection is reported as rejected", async () => {
  const rejected = { ...committed, awaitCommitted: async () => {
    throw Object.assign(new Error("the node rejected the transaction: dead input"), { status: "rejected" });
  } };
  const result = await watchTransaction({ rpc: {}, txHash: "0x1", confirm: rejected });
  assert.strictEqual(result.outcome, "rejected");
  assert.match(result.detail, /dead input/);
});

test("a committed transaction stays confirmed even if the catch-up wait fails", async () => {
  const lag = { ...committed, awaitIndexer: async () => { throw new Error("fetch failed"); } };
  assert.strictEqual((await watchTransaction({ rpc: {}, txHash: "0x1", confirm: lag })).outcome, "confirmed");
});

// --- entering ----------------------------------------------------------------
const okCheck = async () => ({ ok: true, row: { fresh: true } });
const entry = (over = {}) => {
  const log = [];
  const args = {
    check: okCheck,
    isLive: () => true,
    send: async (row, beforeSign) => { log.push("send"); beforeSign(); log.push("sign"); return { txHash: "0xabc" }; },
    watch: async () => ({ outcome: "confirmed", blockNumber: 5n, detail: null }),
    say: (stage) => log.push(`say:${stage}`),
    ...over,
  };
  return runEntry(args).then((result) => ({ result, log }));
};

test("a clean entry is checked, sent, watched and confirmed, in that order", async () => {
  const { result, log } = await entry();
  assert.deepStrictEqual(result, { stage: "confirmed", txHash: "0xabc", message: null, detail: null });
  assert.deepStrictEqual(log, ["say:checking", "send", "sign", "say:waiting"]);
});

test("a refused check stops before anything is sent", async () => {
  const { result, log } = await entry({ check: async () => ({ ok: false, message: "Entries for this round have closed." }) });
  assert.strictEqual(result.stage, "refused");
  assert.strictEqual(result.message, "Entries for this round have closed.");
  assert.ok(!log.includes("send"));
});

test("leaving the screen during the check means the wallet never opens", async () => {
  const { result, log } = await entry({ isLive: () => false });
  assert.strictEqual(result.stage, "abandoned");
  assert.ok(!log.includes("send"));
});

test("leaving the screen before the wallet is asked means nothing is signed", async () => {
  let live = true;
  const steps = [];
  const { result } = await entry({
    isLive: () => live,
    // The player leaves while the transaction is being built.
    send: async (row, beforeSign) => { steps.push("build"); live = false; beforeSign(); steps.push("sign"); return { txHash: "0x1" }; },
  });
  assert.strictEqual(result.stage, "abandoned");
  assert.deepStrictEqual(steps, ["build"]);
});

test("a wallet refusal or a failed broadcast is 'not sent', with the reason kept", async () => {
  const { result } = await entry({ send: async () => { throw new Error("User rejected"); } });
  assert.strictEqual(result.stage, "not-sent");
  assert.strictEqual(result.detail, "User rejected");
  assert.strictEqual(result.txHash, null);
});

test("after broadcast, a network failure is 'pending' and keeps the transaction's id", async () => {
  const { result } = await entry({ watch: async () => ({ outcome: "pending", blockNumber: null, detail: "502" }) });
  assert.deepStrictEqual(result, { stage: "pending", txHash: "0xabc", message: null, detail: "502" });
});

test("a watcher that itself throws is still 'pending', never 'not sent'", async () => {
  const { result } = await entry({ watch: async () => { throw new Error("boom"); } });
  assert.strictEqual(result.stage, "pending");
  assert.strictEqual(result.txHash, "0xabc");
});

test("the node's rejection after broadcast is reported as rejected", async () => {
  const { result } = await entry({ watch: async () => ({ outcome: "rejected", blockNumber: null, detail: "dead input" }) });
  assert.strictEqual(result.stage, "rejected");
});

// --- refunding ---------------------------------------------------------------
const refund = (over = {}) => {
  const log = [];
  const args = {
    check: async () => ({ ok: true, row: {}, entry: {}, nowEpoch: 1n }),
    prepare: async () => ({ ok: true, tx: { t: 1 } }),
    signer: () => ({ signEntry: async (tx) => { log.push("sign"); return { signed: tx }; }, broadcast: async () => { log.push("broadcast"); return "0xdef"; } }),
    isLive: () => true,
    watch: async () => ({ outcome: "confirmed", blockNumber: 9n, detail: null }),
    say: (stage) => log.push(`say:${stage}`),
    ...over,
  };
  return runRefund(args).then((result) => ({ result, log }));
};

test("a clean refund is checked, prepared, signed, sent and confirmed", async () => {
  const { result, log } = await refund();
  assert.deepStrictEqual(result, { stage: "confirmed", txHash: "0xdef", message: null, detail: null });
  assert.deepStrictEqual(log, ["say:checking", "say:approve", "sign", "say:sending", "broadcast", "say:waiting"]);
});

test("a refund whose check or preparation fails is refused before the wallet opens", async () => {
  const a = await refund({ check: async () => ({ ok: false, message: "no" }) });
  const b = await refund({ prepare: async () => ({ ok: false, message: "history", detail: "1 of 2" }) });
  assert.strictEqual(a.result.stage, "refused");
  assert.deepStrictEqual([b.result.stage, b.result.message, b.result.detail], ["refused", "history", "1 of 2"]);
  assert.ok(!a.log.includes("sign") && !b.log.includes("sign"));
});

test("a refund with no wallet to sign it is refused, and says so", async () => {
  const { result } = await refund({ signer: () => null });
  assert.strictEqual(result.stage, "no-wallet");
});

test("a refund abandoned before signing signs nothing", async () => {
  const { result, log } = await refund({ isLive: () => false });
  assert.strictEqual(result.stage, "abandoned");
  assert.ok(!log.includes("sign"));
});

test("after a refund is broadcast, a failed poll is 'pending', never 'not sent'", async () => {
  const { result } = await refund({ watch: async () => { throw new Error("502"); } });
  assert.strictEqual(result.stage, "pending");
  assert.strictEqual(result.txHash, "0xdef");
});

test("a wallet refusal on a refund is 'not sent'", async () => {
  const { result } = await refund({ signer: () => ({ signEntry: async () => { throw new Error("cancelled"); }, broadcast: async () => "x" }) });
  assert.strictEqual(result.stage, "not-sent");
  assert.strictEqual(result.txHash, null);
});
