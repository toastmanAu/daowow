"use strict";
// Paging tests run against fixtures CAPTURED FROM A REAL NODE, never
// hand-written. An exhausted scan genuinely returns last_cursor "0x", and
// get_cells(after: "0x") then returns nothing forever -- the 2026-07-19
// incident lost every inbound message for days behind 360 green tests,
// because the mock returned "0x64" on empty pages and never the real "0x".
const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const { createRpc } = require("../chain/rpc.js");

const fixture = (n) => JSON.parse(fs.readFileSync(
  path.join(__dirname, "fixtures", `get_cells.${n}.json`), "utf8"));

// A fetch stand-in that replays captured pages and records every request.
function replay(pages, { maxCalls = 8 } = {}) {
  const calls = [];
  let i = 0;
  const fetchImpl = async (_url, init) => {
    const body = JSON.parse(init.body);
    calls.push(body.params ? body.params[3] : null);
    // Without this cap, deleting the break-on-empty guard makes paging loop
    // forever and the suite HANGS rather than going red -- a timeout in CI
    // is far harder to read than a failed assertion. Fail fast instead.
    if (calls.length > maxCalls) {
      throw new Error(`paging did not terminate: ${calls.length} requests`);
    }
    const page = pages[Math.min(i++, pages.length - 1)];
    return { ok: true, json: async () => page };
  };
  return { fetchImpl, calls };
}

test("paging walks every page and stops at the exhausted one", async () => {
  const { fetchImpl, calls } = replay([fixture("page1"), fixture("page2"), fixture("exhausted")]);
  const rpc = createRpc("http://node.invalid", { fetchImpl });
  const seen = [];
  for await (const cell of rpc.getCells({ script: {}, script_type: "lock" }, { limit: 2 })) {
    seen.push(cell);
  }
  assert.strictEqual(seen.length, 4, "two cells from each of the two real pages");
  assert.strictEqual(calls.length, 3, "one request per page, then it stops");
  assert.strictEqual(calls[0], null, "first request carries no cursor");
});

test("a terminal cursor is never sent back to the node", async () => {
  // The whole failure mode: reusing "0x" poisons every later scan.
  const { fetchImpl, calls } = replay([fixture("exhausted")]);
  const rpc = createRpc("http://node.invalid", { fetchImpl });
  for await (const _ of rpc.getCells({ script: {}, script_type: "lock" })) { /* none */ }
  assert.ok(!calls.includes("0x"), `no request may pass after="0x", got ${JSON.stringify(calls)}`);
  assert.strictEqual(calls.length, 1, "iteration ends on the empty page");
});

test("an empty page ends iteration even when a cursor is present", async () => {
  // Break on empty BEFORE looking at the cursor: a node that returns an empty
  // page with a non-terminal cursor must not loop forever.
  const odd = { jsonrpc: "2.0", id: 1, result: { objects: [], last_cursor: "0x64" } };
  const { fetchImpl, calls } = replay([odd]);
  const rpc = createRpc("http://node.invalid", { fetchImpl });
  for await (const _ of rpc.getCells({ script: {}, script_type: "lock" })) { /* none */ }
  assert.strictEqual(calls.length, 1);
});

test("an RPC error is thrown, never swallowed", async () => {
  const err = { jsonrpc: "2.0", id: 1, error: { code: -32601, message: "Method not found" } };
  const { fetchImpl } = replay([err]);
  const rpc = createRpc("http://node.invalid", { fetchImpl });
  await assert.rejects(() => rpc.call("get_indexer_tip", []), /Method not found/);
});

test("a terminal cursor on a NON-empty page still ends iteration", async () => {
  // SYNTHETIC, and deliberately so. Every captured fixture pairs last_cursor
  // "0x" with an empty page, so the break-on-empty guard fires first and the
  // terminal-cursor check is unreachable through real data -- it is shadowed
  // defence-in-depth. This page (cells present, cursor already terminal) is
  // the only shape that exercises it, and no real node was observed producing
  // it. Written so the guard cannot be deleted silently.
  const page = {
    jsonrpc: "2.0", id: 1,
    result: { objects: [{ out_point: { tx_hash: "0x00", index: "0x0" } }], last_cursor: "0x" },
  };
  const { fetchImpl, calls } = replay([page]);
  const rpc = createRpc("http://node.invalid", { fetchImpl });
  const seen = [];
  for await (const c of rpc.getCells({ script: {}, script_type: "lock" })) seen.push(c);
  assert.strictEqual(seen.length, 1, "the page's cell is still yielded");
  assert.strictEqual(calls.length, 1, "but no follow-up request is made");
  assert.ok(!calls.includes("0x"), "and the terminal cursor is never sent");
});
