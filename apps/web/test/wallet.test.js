"use strict";
// 2a is read-only. These tests pin that structurally: a live JoyID connection
// needs a browser, but the SHAPE of what the module hands out is testable
// here, and the shape is what enforces the non-goal.
const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const SOURCE = fs.readFileSync(
  path.join(__dirname, "..", "chain", "wallet.js"), "utf8");

test("the wallet module contains no signing or broadcast calls", () => {
  // Gate 2a must not be able to move funds even by accident. If 2b adds
  // signing it belongs in its own module, and this test should be moved
  // rather than deleted.
  const code = SOURCE.replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
  for (const forbidden of [
    "signTransaction", "sendTransaction", "signOnlyTransaction",
    "prepareTransaction", "signMessage",
  ]) {
    assert.ok(!code.includes(forbidden), `wallet.js must not call ${forbidden}`);
  }
});

test("a session exposes only read operations", async () => {
  const { createWallet } = await import("../chain/wallet.js");
  const wallet = createWallet({ rpcUrl: "http://node.invalid" });
  assert.deepStrictEqual(
    Object.keys(wallet).sort(),
    ["client", "connect", "disconnect", "isConnected", "restore"],
  );
  // The signer itself is never handed out, so its signing methods are
  // unreachable from anything the page holds.
  for (const value of Object.values(wallet)) {
    if (value && typeof value === "object") {
      assert.ok(!("signTransaction" in value), "no signer may be exposed");
    }
  }
});

test("a wallet refuses to be created without an rpcUrl", () => {
  // Nothing is hardcoded (spec D4): the endpoint comes from the manifest.
  return import("../chain/wallet.js").then(({ createWallet }) => {
    assert.throws(() => createWallet({}), /rpcUrl/);
  });
});
