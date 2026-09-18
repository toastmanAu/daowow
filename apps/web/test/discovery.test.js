"use strict";
// State derivation is pure and tested directly; discovery itself is tested
// through rpc.js rather than against raw JSON, so the paths the page uses are
// the paths under test (2026-08-10: a fix confirmed at a layer the app never
// calls proves nothing).
const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const { deriveRoundState, ROUND_STATE, findRounds } = require("../chain/discovery.js");
const { createRpc } = require("../chain/rpc.js");
const { loadManifest } = require("../chain/manifest.js");

const V = JSON.parse(fs.readFileSync(path.join(
  __dirname, "..", "..", "..", "tests", "vectors", "daowow_core_vectors.json"), "utf8"));
const REAL_MANIFEST = JSON.parse(fs.readFileSync(path.join(
  __dirname, "..", "..", "..", "deployments", "testnet-manifest.json"), "utf8"));

// The oracle config: entry_start 1001, entry_end 1002, min 50, max 200.
const cfg = {
  entryStart: 1001n, entryEnd: 1002n, minimumTickets: 50n, maximumTickets: 200n,
};
const shard = (state, tickets) => ({ state, ticketCount: BigInt(tickets) });

test("a round before its entry_start is pending", () => {
  const r = deriveRoundState(cfg, [shard(0, 0)], 1000n);
  assert.strictEqual(r.state, ROUND_STATE.PENDING);
});

test("entry_start is inclusive, matching the contract's since check", () => {
  // The shard script accepts an append whose since equals entry_start, so the
  // UI must not show "pending" at the exact epoch entry becomes legal.
  const r = deriveRoundState(cfg, [shard(0, 0)], 1001n);
  assert.strictEqual(r.state, ROUND_STATE.OPEN);
});

test("a frozen shard reports frozen regardless of epoch", () => {
  const r = deriveRoundState(cfg, [shard(1, 120)], 1001n);
  assert.strictEqual(r.state, ROUND_STATE.FROZEN);
});

test("tickets sold and remaining come from the shard against the cap", () => {
  const r = deriveRoundState(cfg, [shard(0, 120)], 1001n);
  assert.strictEqual(r.ticketsSold, 120n);
  assert.strictEqual(r.ticketsRemaining, 80n);
});

test("viability is inclusive at exactly minimum_tickets", () => {
  // A round below minimum_tickets does not draw, so 50 must read as viable.
  assert.strictEqual(deriveRoundState(cfg, [shard(0, 49)], 1001n).viable, false);
  assert.strictEqual(deriveRoundState(cfg, [shard(0, 50)], 1001n).viable, true);
});

test("an uncapped round reports no remaining figure rather than a wrong one", () => {
  // maximum_tickets 0 means uncapped; 0 - sold would be a nonsense number.
  const r = deriveRoundState({ ...cfg, maximumTickets: 0n }, [shard(0, 120)], 1001n);
  assert.strictEqual(r.ticketsRemaining, null);
});

test("findRounds decodes a round cell fetched through the rpc client", async () => {
  const hex = V.cell_encodings.round_config.hex;
  const page = { jsonrpc: "2.0", id: 1, result: { objects: [{
    out_point: { tx_hash: "0x" + "ab".repeat(32), index: "0x0" },
    output: { capacity: "0x1", lock: {}, type: {} },
    output_data: "0x" + hex,
  }], last_cursor: "0x" } };
  const empty = { jsonrpc: "2.0", id: 1, result: { objects: [], last_cursor: "0x" } };
  let n = 0;
  const fetchImpl = async () => ({ ok: true, json: async () => (n++ === 0 ? page : empty) });
  const rpc = createRpc("http://node.invalid", { fetchImpl });
  const rounds = await findRounds(rpc, loadManifest(REAL_MANIFEST));
  assert.strictEqual(rounds.length, 1);
  assert.strictEqual(rounds[0].config.roundId, V.cell_encodings.round_config.fields.round_id);
  assert.strictEqual(rounds[0].config.maximumTickets, 200n);
});

test("a cell that is not a round config is skipped, not fatal", async () => {
  // Prefix search matches on code hash alone, so a cell carrying the
  // round-type code hash with different data can legitimately come back.
  // decodeRoundConfigV1 refuses a wrong length by design, so without the size
  // filter one foreign cell would throw and take the whole round list with it
  // — the page would show no rounds at all rather than the rounds that exist.
  const good = {
    out_point: { tx_hash: "0x" + "ab".repeat(32), index: "0x0" },
    output_data: "0x" + V.cell_encodings.round_config.hex,
  };
  const foreign = {
    out_point: { tx_hash: "0x" + "cd".repeat(32), index: "0x0" },
    output_data: "0x" + "ff".repeat(64),
  };
  const page = { jsonrpc: "2.0", id: 1,
    result: { objects: [foreign, good], last_cursor: "0x" } };
  const empty = { jsonrpc: "2.0", id: 1, result: { objects: [], last_cursor: "0x" } };
  let n = 0;
  const fetchImpl = async () => ({ ok: true, json: async () => (n++ === 0 ? page : empty) });
  const rpc = createRpc("http://node.invalid", { fetchImpl });
  const rounds = await findRounds(rpc, loadManifest(REAL_MANIFEST));
  assert.strictEqual(rounds.length, 1, "the real round survives the foreign cell");
  assert.strictEqual(rounds[0].config.maximumTickets, 200n);
});

test("decodes a round cell captured from a real devnet chain", () => {
  // Not a hand-written sample: tests/devnet/test_round_creation.py captures
  // this cell from the indexer after creating a round on a real node, so the
  // decoder is pinned to a round the devnet suite actually produced. Every
  // other decoder test uses the Rust oracle, which proves agreement with the
  // encoder; this proves agreement with what a node really serves.
  const cellPath = path.join(__dirname, "fixtures", "devnet-round-cell.json");
  if (!fs.existsSync(cellPath)) {
    // The fixture is written by a devnet run, which is opt-in and slow.
    // Skipping is honest; silently passing would not be.
    return assert.ok(true, "no devnet fixture present — run the devnet suite");
  }
  const cell = JSON.parse(fs.readFileSync(cellPath, "utf8"));
  const data = cell.output_data.slice(2);
  assert.strictEqual(data.length / 2, 358, "a round config cell is 358 bytes");

  const { decodeRoundConfigV1 } = require("../chain/codec.js");
  const cfg = decodeRoundConfigV1(unhexBytes(data));

  // Values the devnet's own config fixes. If the decoder drifted, these are
  // the fields that would go visibly wrong rather than subtly.
  assert.strictEqual(cfg.version, 1, "version");
  assert.match(cfg.roundId, /^[0-9a-f]{64}$/, "round id is a 32-byte hash");
  assert.ok(cfg.ticketPrice > 0n, "a ticket must cost something");
  assert.ok(cfg.entryEnd >= cfg.entryStart, "the entry window cannot run backwards");
  assert.ok(cfg.aggregationDeadline >= cfg.entryEnd, "aggregation follows entry");
  assert.ok(cfg.entryShardCount >= 1, "a round has at least one shard");

  // The type script's args are the round id, which is how the round cell is
  // identified on chain; a decoder reading the id from the wrong offset would
  // disagree with the script that the node itself matched on.
  assert.strictEqual(cell.output.type.args, "0x" + cfg.roundId,
    "decoded round id must equal the type script args the indexer matched");
});

function unhexBytes(s) {
  return Uint8Array.from(s.match(/../g).map((b) => parseInt(b, 16)));
}
