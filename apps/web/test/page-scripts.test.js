"use strict";
// Does each page's script list actually produce the globals its own code uses?
//
// 287 tests were green while entry.html was BROKEN. discovery.js destructured
// two modules at load time; entry.html evaluated it before one of them and
// never loaded the other, so the destructure threw INSIDE the IIFE and
// `window.DaowowDiscovery` was never assigned. The symptom arrived much later
// as `c.findRounds is not a function`, which says nothing about load order.
//
// Node's module tests cannot see that class of fault at all: `require` resolves
// by path and ignores the page's ordering entirely. So this evaluates each
// page's scripts IN THE ORDER THE PAGE LISTS THEM, in one shared sandbox, the
// way a browser does.
const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const DAPP = path.join(__dirname, "..", "dapp");
const WEB = path.join(__dirname, "..");

// Every page, and the globals its own module code reads off `window`.
const PAGES = {
  "index.html": [
    "DaowowCore", "DaowowCodec", "DaowowEntryCodec", "DaowowLedgerCodec", "DaowowSealCodec",
    "DaowowManifest", "DaowowRpc", "DaowowDiscovery", "DaowowRoundCells", "DaowowSchedule",
    "DaowowQuote", "DaowowMmrWitness", "DaowowEntryTx", "DaowowContention", "DaowowShardPeaks",
    "DaowowShardHistory", "DaowowConfirm", "DaowowRefundTx", "DaowowDraw", "DaowowEntropyTx",
    "DaowowEntropyDerive", "DaowowDaoYield", "DaowowEntryView", "DaowowTime", "DaowowRoundState",
    "DaowowTickets", "DaowowRoute", "DaowowPrizeEstimate", "DaowowCopy", "DaowowStore",
    "DaowowTimeline", "DaowowEntryGuard", "DaowowRefundGuard", "DaowowDrawScript",
  ],
};

// The classic scripts a page loads, in order. Module scripts are skipped: they
// are ES modules with their own resolution and cannot be evaluated this way.
function classicScripts(html) {
  const out = [];
  const re = /<script([^>]*)src="([^"]+)"([^>]*)><\/script>/g;
  let m;
  while ((m = re.exec(html)) !== null) {
    const attrs = m[1] + m[3];
    if (/type\s*=\s*"module"/.test(attrs)) continue;
    out.push(m[2].split("?")[0]);
  }
  return out;
}

for (const [page, expected] of Object.entries(PAGES)) {
  test(`${page}: its scripts, in page order, publish every global it uses`, () => {
    const html = fs.readFileSync(path.join(DAPP, page), "utf8");
    const scripts = classicScripts(html);
    assert.ok(scripts.length > 0, "the page must load classic scripts");

    // One shared sandbox, exactly as the browser shares one global scope. No
    // `require`, because the browser has none — which is the whole point: it
    // forces each file down its `window` branch.
    const sandbox = { TextEncoder, TextDecoder, DataView, Uint8Array, BigInt, console };
    sandbox.window = sandbox;
    sandbox.globalThis = sandbox;
    const context = vm.createContext(sandbox);

    for (const src of scripts) {
      const file = path.join(DAPP, src);
      const resolved = fs.existsSync(file) ? file : path.join(WEB, src.replace(/^\.\.\//, ""));
      const code = fs.readFileSync(resolved, "utf8");
      // A throw here IS the bug: in a browser it would be swallowed into a
      // console error and leave the global unassigned.
      vm.runInContext(code, context, { filename: src });
    }

    const missing = expected.filter((name) => typeof sandbox[name] !== "object");
    assert.deepStrictEqual(missing, [],
      `${page} loads its scripts in an order that leaves these unpublished: ` +
      `${missing.join(", ")}. A module that destructures a sibling at LOAD time ` +
      "throws inside its IIFE and never publishes itself.");
  });
}

test("the new chain modules publish themselves whatever order they load in", () => {
  const sandbox = { TextEncoder, TextDecoder, DataView, Uint8Array, BigInt, console };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  const context = vm.createContext(sandbox);
  // Hostile order: the three new modules FIRST, everything they use after.
  for (const src of ["chain/round-cells.js", "chain/entropy-derive.js", "chain/dao-yield.js",
                     "dapp/model/store.js", "dapp/model/copy.js", "dapp/model/tickets.js",
                     "core.js", "chain/codec.js", "chain/entry-codec.js", "chain/ledger-codec.js",
                     "chain/seal-codec.js", "chain/refund-tx.js"]) {
    vm.runInContext(fs.readFileSync(path.join(WEB, src), "utf8"), context, { filename: src });
  }
  for (const name of ["DaowowRoundCells", "DaowowEntropyDerive", "DaowowDaoYield",
                      "DaowowStore", "DaowowCopy", "DaowowTickets"]) {
    assert.strictEqual(typeof sandbox[name], "object", `${name} must publish itself`);
  }
});

test("a page that loads discovery.js before its dependencies still works", () => {
  // The exact regression, pinned: discovery must not care about order.
  const sandbox = { TextEncoder, TextDecoder, DataView, Uint8Array, BigInt, console };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  const context = vm.createContext(sandbox);
  // Deliberately hostile order — discovery FIRST, its dependencies after.
  for (const src of ["chain/discovery.js", "core.js", "chain/codec.js",
                     "chain/entry-codec.js", "chain/ledger-codec.js"]) {
    vm.runInContext(fs.readFileSync(path.join(WEB, src), "utf8"), context, { filename: src });
  }
  assert.strictEqual(typeof sandbox.DaowowDiscovery, "object",
    "discovery must publish itself even when evaluated first");
  assert.strictEqual(typeof sandbox.DaowowDiscovery.findLedger, "function");
  assert.strictEqual(typeof sandbox.DaowowDiscovery.findEntries, "function");
});
