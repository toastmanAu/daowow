// Finding the cell dep that provides a script, and checking one is present.
//
// A lock script only runs when a cell is SPENT, and the node needs that lock's
// code cell as an explicit cell dep on every spend — including a spend where
// nothing but the lock runs. Omitting it is `ScriptNotFound` on Inputs[0].Lock
// at broadcast and nothing earlier catches it: this repository's own feedback
// log records the same trap on 2026-09-17, because ckb-testtool makes every
// deployed binary available with no cell-dep bookkeeping at all, so a green
// mock suite says nothing about it.
//
// Resolved from the chain rather than hardcoded, so this works on devnet, on
// testnet and on mainnet without a table of magic out points.

import { ccc } from "../apps/web/vendor/ccc.min.mjs";

const HASH_TYPE_IS_DATA = { data: true, data1: true, data2: true, type: false };

// A dep group's data is a fixvec of OutPoints: u32 LE count, then 36 bytes
// each (32-byte tx hash, 4-byte LE index).
function parseDepGroup(dataHex) {
  const bytes = ccc.bytesFrom(dataHex);
  if (bytes.length < 4) return [];
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const count = view.getUint32(0, true);
  if (bytes.length < 4 + count * 36) return [];
  const out = [];
  for (let i = 0; i < count; i++) {
    const at = 4 + i * 36;
    out.push({
      tx_hash: ccc.hexFrom(bytes.subarray(at, at + 32)),
      index: "0x" + view.getUint32(at + 32, true).toString(16),
    });
  }
  return out;
}

// Does this one cell carry the code `script` names?
function cellProvides(cell, script) {
  if (!cell || cell.status !== "live") return false;
  const wantData = HASH_TYPE_IS_DATA[script.hash_type ?? script.hashType];
  const codeHash = (script.code_hash ?? script.codeHash).toLowerCase();
  if (wantData) {
    return (cell.cell.data?.hash ?? "").toLowerCase() === codeHash;
  }
  const type = cell.cell.output.type;
  if (!type) return false;
  return ccc.Script.from({
    codeHash: type.code_hash, hashType: type.hash_type, args: type.args,
  }).hash().toLowerCase() === codeHash;
}

const liveCell = (rpc, outPoint) =>
  rpc.call("get_live_cell", [outPoint, true]);

/**
 * Do `cellDeps` (ckb-cli/JSON-RPC shape) already provide `script`?
 * Walks dep groups, because that is how the system locks ship.
 */
export async function depsProvide(rpc, cellDeps, script) {
  for (const dep of cellDeps) {
    const cell = await liveCell(rpc, dep.out_point);
    if (dep.dep_type === "dep_group") {
      if (cell.status !== "live") continue;
      for (const inner of parseDepGroup(cell.cell.data?.content ?? "0x")) {
        if (cellProvides(await liveCell(rpc, inner), script)) return true;
      }
      continue;
    }
    if (cellProvides(cell, script)) return true;
  }
  return false;
}

/**
 * The cell dep providing `script`, found in the genesis dep groups and code
 * cells. Returns the ckb-cli/JSON-RPC cell dep shape, or null.
 */
export async function resolveLockDep(rpc, script) {
  const genesis = await rpc.call("get_block_by_number", ["0x0"]);
  const points = [];
  for (const tx of genesis.transactions) {
    for (let index = 0; index < tx.outputs.length; index++) {
      points.push({ tx_hash: tx.hash, index: "0x" + index.toString(16) });
    }
  }

  // DEP GROUPS FIRST, and the ordering is load-bearing rather than tidy.
  // secp256k1_blake160_sighash_all lives in genesis tx0 as a bare code cell,
  // but the lock also loads the secp256k1_data table from a SECOND cell — and
  // bundling both is the entire reason the dep group in genesis tx1 exists.
  // Returning the code cell because it was found first yields a dep that
  // satisfies ScriptNotFound and then fails inside the lock instead.
  const fallbacks = [];
  for (const out_point of points) {
    const cell = await liveCell(rpc, out_point);
    if (cell.status !== "live") continue;
    const group = parseDepGroup(cell.cell.data?.content ?? "0x");
    if (group.length > 0) {
      for (const inner of group) {
        if (cellProvides(await liveCell(rpc, inner), script)) {
          return { out_point, dep_type: "dep_group" };
        }
      }
      continue;
    }
    if (cellProvides(cell, script)) fallbacks.push({ out_point, dep_type: "code" });
  }
  return fallbacks[0] ?? null;
}
