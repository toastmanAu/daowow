"use strict";
// Wrapped in an IIFE: loaded as a classic script these files share one
// global scope, so top-level declarations would collide between modules.
(function () {
// Minimal CKB JSON-RPC client with cursor-safe indexer paging.

function createRpc(url, options = {}) {
  // fetch must be BOUND. Storing a bare window.fetch on an object and calling
  // it as a method throws "Illegal invocation" against native fetch, which no
  // test with an injected plain mock can catch (2026-06-29).
  const fetchImpl = options.fetchImpl ?? (
    typeof fetch === "function" ? fetch.bind(globalThis) : null);
  if (!fetchImpl) throw new Error("no fetch implementation available");

  let nextId = 1;

  async function call(method, params) {
    const res = await fetchImpl(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: nextId++, jsonrpc: "2.0", method, params }),
    });
    const body = await res.json();
    if (body.error) {
      throw new Error(`${method}: ${body.error.message ?? JSON.stringify(body.error)}`);
    }
    return body.result;
  }

  // Yields every cell matching `searchKey`, paging as needed.
  //
  // An exhausted scan returns last_cursor "0x", and get_cells(after: "0x")
  // returns NOTHING FOREVER afterwards -- even once matching cells exist. So
  // a terminal cursor must never be sent back, and never persisted anywhere.
  async function* getCells(searchKey, { limit = 100 } = {}) {
    let cursor = null;
    for (;;) {
      const page = await call("get_cells", [
        searchKey, "asc", "0x" + limit.toString(16), cursor,
      ]);
      const objects = (page && page.objects) || [];
      // Break on empty BEFORE considering the cursor, so neither a terminal
      // "0x" nor a stale non-terminal cursor can be carried forward.
      if (objects.length === 0) return;
      for (const object of objects) yield object;
      const next = page.last_cursor;
      if (!next || next === "0x" || next === "0X") return;
      cursor = next;
    }
  }

  return { call, getCells, url };
}

const api = { createRpc };
if (typeof module !== "undefined" && module.exports) module.exports = api;
if (typeof window !== "undefined") window.DaowowRpc = api;
})();
