"use strict";
// A manifest is the client's only source of chain constants (spec D4), so a
// malformed one must be refused outright rather than best-effort parsed. A
// wrong code hash makes discovery watch the wrong cells and report an empty
// round, which is indistinguishable from a round that has not opened yet.
const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const { loadManifest, REQUIRED_SCRIPTS } = require("../chain/manifest.js");

const REAL = JSON.parse(fs.readFileSync(
  path.join(__dirname, "..", "..", "..", "deployments", "testnet-manifest.json"), "utf8"));
const clone = () => JSON.parse(JSON.stringify(REAL));

test("the committed testnet manifest loads", () => {
  const m = loadManifest(REAL);
  assert.strictEqual(m.network, "ckb_testnet");
  assert.ok(m.rpcUrl.startsWith("http"));
  for (const name of REQUIRED_SCRIPTS) {
    assert.match(m.scripts[name].codeHash, /^0x[0-9a-f]{64}$/, `${name} code hash`);
    assert.ok(m.scripts[name].outPoint.txHash, `${name} out point`);
  }
});

test("an unrecognised schemaVersion is refused", () => {
  const m = clone(); m.schemaVersion = 2;
  assert.throws(() => loadManifest(m), /schemaVersion/);
});

test("a missing rpcUrl is refused", () => {
  const m = clone(); delete m.rpcUrl;
  assert.throws(() => loadManifest(m), /rpcUrl/);
});

test("a missing script is refused by name", () => {
  const m = clone(); delete m.scripts["entry-shard-type"];
  assert.throws(() => loadManifest(m), /entry-shard-type/);
});

test("a malformed code hash is refused", () => {
  const m = clone(); m.scripts["round-type"].codeHash = "0xdeadbeef";
  assert.throws(() => loadManifest(m), /code hash/);
});

test("an unknown hashType is refused", () => {
  // data/type/data1/data2 only. There is no hash type 3: the discriminants
  // are DataN = N<<1, so a permissive parser would silently mis-map.
  const m = clone(); m.scripts["round-type"].hashType = "data3";
  assert.throws(() => loadManifest(m), /hashType/);
});

test("a missing cell dep out point is refused", () => {
  const m = clone(); delete m.scripts["dao-lock"].cellDep;
  assert.throws(() => loadManifest(m), /cellDep|out point/);
});
