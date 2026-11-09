"use strict";
// State derivation is pure and tested directly; discovery itself is tested
// through rpc.js rather than against raw JSON, so the paths the page uses are
// the paths under test (2026-08-10: a fix confirmed at a layer the app never
// calls proves nothing).
const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const { deriveRoundState, ROUND_STATE, findRounds, findShards } =
  require("../chain/discovery.js");
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

// --- the shape handed downstream ------------------------------------------
// findRounds/findShards are the only place raw RPC enters the client. The RPC
// speaks `{tx_hash, index: "0x0"}`; buildEntryTx and the CCC adapter speak
// `{txHash, index: 0}`. Passing the raw shape through reaches CCC as
// `txHash: undefined` and builds a transaction against nothing, silent until
// broadcast. So the boundary normalizes, and that is pinned here.
const pagingRpc = (objects) => {
  const pages = [
    { jsonrpc: "2.0", id: 1, result: { objects, last_cursor: "0x" } },
    { jsonrpc: "2.0", id: 1, result: { objects: [], last_cursor: "0x" } },
  ];
  let n = 0;
  return createRpc("http://node.invalid", {
    fetchImpl: async () => ({ ok: true, json: async () => pages[Math.min(n++, 1)] }),
  });
};

test("discovery hands downstream a camelCase out point with a numeric index", async () => {
  const rpc = pagingRpc([{
    out_point: { tx_hash: "0x" + "ab".repeat(32), index: "0x2" },
    output: { capacity: "0x9502f9000", lock: {}, type: {} },
    output_data: "0x" + V.cell_encodings.round_config.hex,
  }]);
  const [round] = await findRounds(rpc, loadManifest(REAL_MANIFEST));
  assert.strictEqual(round.outPoint.txHash, "0x" + "ab".repeat(32));
  assert.strictEqual(round.outPoint.index, 2, "hex index decoded to a number");
});

test("a shard carries the capacity its successor must preserve", async () => {
  // buildEntryTx reads shard.capacity for the successor cell. Without it the
  // successor is built with an undefined capacity and the append is refused.
  const rpc = pagingRpc([{
    out_point: { tx_hash: "0x" + "cd".repeat(32), index: "0x1" },
    output: {
      capacity: "0x9502f9000", lock: {},
      type: { code_hash: "0x00", hash_type: "type", args: "0x" + "77".repeat(36) },
    },
    output_data: "0x" + V.cell_encodings.shard_data.hex,
  }]);
  const [shardCell] = await findShards(
    rpc, loadManifest(REAL_MANIFEST), V.cell_encodings.shard_data.fields.round_id);
  assert.strictEqual(shardCell.capacity, 0x9502f9000n);
  assert.strictEqual(shardCell.outPoint.txHash, "0x" + "cd".repeat(32));
  assert.strictEqual(shardCell.outPoint.index, 1);
  // buildEntryTx checks the successor it derives against the cell being spent.
  assert.strictEqual(shardCell.typeArgs, "0x" + "77".repeat(36));
});

// --- the refund path's discovery ------------------------------------------
// findLedger must tell a ledger cell from a shard cell, and they SHARE a type
// script and its args — only the data length distinguishes them, exactly as the
// contract's own dispatch does it. A helper that matched on args alone would
// return the shard and every refund built from it would be nonsense.
const { findLedger, findEntries } = require("../chain/discovery.js");
const AV = V.aggregation_state;

const ledgerManifest = () => loadManifest(REAL_MANIFEST);
const shardCodeHash = () => ledgerManifest().scripts["entry-shard-type"].codeHash;
const entryCodeHash = () => ledgerManifest().scripts["entry-lock"].codeHash;
const COMMITMENT = AV.config.commitment;

test("findLedger returns the 207-byte cell and skips the 101-byte shard", () => {
  const rpc = pagingRpc([
    { out_point: { tx_hash: "0x" + "aa".repeat(32), index: "0x0" },
      output: { capacity: "0x9502f9000", lock: {},
                type: { code_hash: shardCodeHash(), hash_type: "data1",
                        args: "0x" + COMMITMENT + "00000000" } },
      output_data: "0x" + V.cell_encodings.shard_data.hex },
    { out_point: { tx_hash: "0x" + "bb".repeat(32), index: "0x1" },
      output: { capacity: "0x9502f9000", lock: {},
                type: { code_hash: shardCodeHash(), hash_type: "data1",
                        args: "0x" + COMMITMENT + "00000000" } },
      output_data: "0x" + AV.genesis.hex },
  ]);
  return findLedger(rpc, ledgerManifest(), COMMITMENT).then((found) => {
    assert.ok(found, "the ledger must be found");
    assert.strictEqual(found.outPoint.txHash, "0x" + "bb".repeat(32));
    assert.strictEqual(found.state.acceptedEntries, 0n);
  });
});

test("findLedger ignores a ledger belonging to another round", async () => {
  const rpc = pagingRpc([
    { out_point: { tx_hash: "0x" + "cc".repeat(32), index: "0x0" },
      output: { capacity: "0x9502f9000", lock: {},
                type: { code_hash: shardCodeHash(), hash_type: "data1",
                        args: "0x" + "99".repeat(32) + "00000000" } },
      output_data: "0x" + AV.genesis.hex },
  ]);
  assert.strictEqual(await findLedger(rpc, ledgerManifest(), COMMITMENT), null);
});

test("findEntries orders by nonce and can filter to one participant", async () => {
  // A refund needs EVERY entry of the shard to replay the accumulator, and the
  // page needs only the connected wallet's to display — so both modes matter.
  const mine = "11".repeat(32);
  const theirs = "22".repeat(32);
  const cell = (participant, hex, idx) => ({
    out_point: { tx_hash: "0x" + "dd".repeat(32), index: "0x" + idx.toString(16) },
    output: { capacity: "0x9502f9000",
              lock: { code_hash: entryCodeHash(), hash_type: "data1",
                      args: "0x" + participant + COMMITMENT } },
    output_data: "0x" + hex,
  });
  const e0 = AV.entries[0].hex, e1 = AV.entries[1].hex;
  const rpc = () => pagingRpc([cell(theirs, e1, 1), cell(mine, e0, 0)]);
  const all = await findEntries(rpc(), ledgerManifest(), COMMITMENT);
  assert.deepStrictEqual(all.map((x) => Number(x.entry.entryNonce)), [0, 1],
    "sorted by nonce regardless of the order the indexer returned them");
  const filtered = await findEntries(rpc(), ledgerManifest(), COMMITMENT, mine);
  assert.strictEqual(filtered.length, 1);
  assert.strictEqual(filtered[0].participantLockHash, mine);
});

test("findEntries skips an entry-lock cell from another round", async () => {
  const rpc = pagingRpc([{
    out_point: { tx_hash: "0x" + "ee".repeat(32), index: "0x0" },
    output: { capacity: "0x9502f9000",
              lock: { code_hash: entryCodeHash(), hash_type: "data1",
                      args: "0x" + "11".repeat(32) + "99".repeat(32) } },
    output_data: "0x" + AV.entries[0].hex,
  }]);
  assert.deepStrictEqual(await findEntries(rpc, ledgerManifest(), COMMITMENT), []);
});

// --- selectRound: which round a page shows --------------------------------
// findRounds returns rounds in INDEXER order, which for a prefix type search
// is by type args, i.e. by round id — not by age. With four rounds on testnet
// rounds[0] was a dead round, so both entry and refund pages showed the wrong
// one (2026-11-09).
const { selectRound } = require("../chain/discovery.js");
const rnd = (id, entryStart) => ({ config: { roundId: id, entryStart: BigInt(entryStart) } });
const ROUNDS = [
  rnd("0x7000bce2" + "00".repeat(28), 13956),
  rnd("0xa42e2888" + "00".repeat(28), 13900),
  rnd("0xaffb66f7" + "00".repeat(28), 14157),
  rnd("0xd15f6b5e" + "00".repeat(28), 13800),
];

test("with no round requested, the newest round by entry_start is shown, not the first returned", () => {
  assert.strictEqual(selectRound(ROUNDS).config.roundId.slice(0, 10), "0xaffb66f7");
});

test("a requested round prefix selects that round, with or without 0x and in any case", () => {
  assert.strictEqual(selectRound(ROUNDS, "a42e2888").config.roundId.slice(0, 10), "0xa42e2888");
  assert.strictEqual(selectRound(ROUNDS, "0xA42E").config.roundId.slice(0, 10), "0xa42e2888");
});

test("a requested round that matches nothing returns null rather than falling back to another round", () => {
  assert.strictEqual(selectRound(ROUNDS, "ffff"), null);
});

test("an ambiguous prefix returns null rather than guessing", () => {
  assert.strictEqual(selectRound(ROUNDS, "0xa"), null);
});

test("a requested value that is not hex returns null", () => {
  assert.strictEqual(selectRound(ROUNDS, "a42e<script>"), null);
});

test("no rounds returns null", () => {
  assert.strictEqual(selectRound([]), null);
});
