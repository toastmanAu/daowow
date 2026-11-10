"use strict";
// Fixture cells in the indexer's own shape, and a fake rpc that filters them
// the way get_cells does (script type, code hash, args prefix or exact).
const fs = require("node:fs");
const path = require("node:path");
const { loadManifest } = require("../../chain/manifest.js");
const { decodeRoundConfigV1 } = require("../../chain/codec.js");

const ROOT = path.join(__dirname, "..", "..", "..", "..");
const V = JSON.parse(fs.readFileSync(
  path.join(ROOT, "tests", "vectors", "daowow_core_vectors.json"), "utf8"));
const MANIFEST = loadManifest(JSON.parse(fs.readFileSync(
  path.join(ROOT, "deployments", "dev-testnet-manifest.json"), "utf8")));

const unhex = (s) => Uint8Array.from((s.replace(/^0x/, "").match(/../g) ?? []).map((b) => parseInt(b, 16)));
const hex = (b) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
const strip = (s) => String(s ?? "").replace(/^0x/, "").toLowerCase();

const CONFIG_BYTES = unhex(V.aggregation_state.config.hex);
const CONFIG = decodeRoundConfigV1(CONFIG_BYTES);

// A second, different round: same config with another id and a later start.
function variantConfigBytes({ idByte = 0xbb, entryStart = 2000n, entryEnd = 2010n } = {}) {
  const out = Uint8Array.from(CONFIG_BYTES);
  out.fill(idByte, 4, 36);
  const view = new DataView(out.buffer);
  view.setBigUint64(60, entryStart, true);
  view.setBigUint64(68, entryEnd, true);
  return out;
}

let serial = 0;
function cell({ lock, type = null, data = "", capacity = 100n, block = 1n }) {
  serial += 1;
  return {
    output: {
      capacity: "0x" + (BigInt(capacity) * 100000000n).toString(16),
      lock: { code_hash: lock.codeHash, hash_type: lock.hashType, args: lock.args },
      type: type ? { code_hash: type.codeHash, hash_type: type.hashType, args: type.args } : null,
    },
    output_data: "0x" + strip(data),
    out_point: { tx_hash: "0x" + serial.toString(16).padStart(64, "0"), index: "0x0" },
    block_number: "0x" + BigInt(block).toString(16),
  };
}

const script = (name, args) => ({
  codeHash: MANIFEST.scripts[name].codeHash,
  hashType: MANIFEST.scripts[name].hashType,
  args,
});
const PUBLIC_LOCK = script("entry-shard-type", "0x00");
const WALLET_LOCK = { codeHash: "0x" + "d2".repeat(32), hashType: "type", args: "0x" + "ab".repeat(22) };

const roundCell = (configBytes) =>
  cell({ lock: PUBLIC_LOCK, type: script("round-type", "0x" + hex(configBytes.slice(4, 36))), data: hex(configBytes) });
const shardTypeCell = (commitment, data, extra = {}) =>
  cell({ lock: PUBLIC_LOCK, type: script("entry-shard-type", "0x" + commitment + "00000000"), data, ...extra });

function fakeRpc(cells, { headers = {}, calls = [] } = {}) {
  return {
    calls,
    url: "fake",
    async call(method, params) {
      calls.push({ method, params });
      if (method === "get_header_by_number") return headers[BigInt(params[0]).toString()] ?? null;
      throw new Error(`fake rpc has no ${method}`);
    },
    async *getCells(key) {
      calls.push({ method: "get_cells", params: [key] });
      const want = strip(key.script.args);
      for (const c of cells) {
        const s = key.script_type === "lock" ? c.output.lock : c.output.type;
        if (!s || s.code_hash !== key.script.code_hash || s.hash_type !== key.script.hash_type) continue;
        const args = strip(s.args);
        if (key.script_search_mode === "prefix" ? !args.startsWith(want) : args !== want) continue;
        yield c;
      }
    },
  };
}

module.exports = {
  V, MANIFEST, CONFIG, CONFIG_BYTES, variantConfigBytes, cell, script, roundCell, shardTypeCell,
  fakeRpc, unhex, hex, strip, PUBLIC_LOCK, WALLET_LOCK,
};
