#!/usr/bin/env node
// Classify every live cell under an address and report which deployed code
// cells nothing on chain is using any more.
//
// Read-only. It never builds, signs or sends a transaction, and it never
// touches key material.
//
// Usage:
//   node tools/audit-wallet-cells.mjs <address> [rpc-url]
//
// The "users" column is the load-bearing part. For each deployed binary it
// searches the WHOLE chain in prefix mode -- every live cell under any owner,
// as both type script and lock -- rather than only this wallet's cells. A
// binary this wallet no longer references may still be a dependency of
// somebody else's live cell, and consuming it would strand them.
//
// users=NONE means nothing is live against it RIGHT NOW. It does not promise
// nothing ever will be: consuming a code cell is irreversible and the binary
// would have to be redeployed.

import { ccc } from "../apps/web/vendor/ccc.min.mjs";

const ADDR = process.argv[2];
const RPC = process.argv[3] ?? "https://testnet.ckb.dev/rpc";
if (!ADDR) {
  console.error("usage: node tools/audit-wallet-cells.mjs <address> [rpc-url]");
  process.exit(2);
}

const TYPE_ID =
  "0x00000000000000000000000000000000000000000000000000545950455f4944";

const rpc = async (method, params) => {
  const res = await fetch(RPC, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id: 1, jsonrpc: "2.0", method, params }),
  });
  const body = await res.json();
  if (body.error) throw new Error(JSON.stringify(body.error));
  return body.result;
};

// Every live cell carrying this code hash, under any lock and any owner.
const usersOf = async (codeHash, hashTypes) => {
  let n = 0;
  for (const hashType of hashTypes) {
    for (const scriptType of ["type", "lock"]) {
      const page = await rpc("get_cells", [
        {
          script: { code_hash: codeHash, hash_type: hashType, args: "0x" },
          script_type: scriptType,
          script_search_mode: "prefix",
        },
        "asc",
        "0x5",
        null,
      ]);
      n += page.objects.length;
    }
  }
  return n;
};

const ckb = (shannons) =>
  (shannons / 100000000n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");

const client = new ccc.ClientPublicTestnet({ url: RPC });
const address = await ccc.Address.fromString(ADDR, client);

const cells = [];
for await (const cell of client.findCellsByLock(address.script, null, true)) {
  const data = cell.outputData ?? "0x";
  cells.push({
    capacity: cell.cellOutput.capacity,
    bytes: (data.length - 2) / 2,
    type: cell.cellOutput.type,
    dataHash: data.length > 2 ? ccc.hashCkb(data) : null,
    outPoint: cell.outPoint,
  });
}

const total = cells.reduce((n, c) => n + c.capacity, 0n);
const plain = cells.filter((c) => !c.type && c.bytes === 0);
const code = cells.filter((c) => !c.type && c.bytes > 0);
const typeId = cells.filter(
  (c) => c.type && c.type.codeHash.toLowerCase() === TYPE_ID,
);
const otherTyped = cells.filter(
  (c) => c.type && c.type.codeHash.toLowerCase() !== TYPE_ID,
);

console.log(`${ADDR.slice(0, 24)}...  ${cells.length} cells  ${ckb(total)} CKB\n`);
const line = (name, group) =>
  console.log(
    `${name.padEnd(28)}${String(group.length).padStart(5)} cells ${ckb(
      group.reduce((n, c) => n + c.capacity, 0n),
    ).padStart(12)} CKB`,
  );
line("plain capacity (liquid)", plain);
line("deployed code cells", code);
line("Type ID deployments", typeId);
line("other typed cells", otherTyped);

// Deployed binaries, grouped by content. Two cells with the same data hash
// are exact duplicates: all but one are redundant whatever else is true.
const byContent = new Map();
for (const c of code) {
  if (!byContent.has(c.dataHash)) byContent.set(c.dataHash, []);
  byContent.get(c.dataHash).push(c);
}

console.log("\n=== deployed code cells ===");
let reclaimable = 0n;
for (const [hash, group] of [...byContent].sort(
  (a, b) => Number(b[1][0].capacity - a[1][0].capacity),
)) {
  const users = await usersOf(hash, ["data", "data1", "data2"]);
  const verdict = users === 0 ? "UNUSED" : `used by ${users}+`;
  console.log(
    `${ckb(group[0].capacity).padStart(9)} CKB  x${group.length}  ${String(
      group[0].bytes,
    ).padStart(7)}B  ${verdict}`,
  );
  for (const c of group) {
    console.log(`            ${c.outPoint.txHash}:${c.outPoint.index}`);
  }
  if (users === 0) reclaimable += group[0].capacity * BigInt(group.length);
  else if (group.length > 1) {
    reclaimable += group[0].capacity * BigInt(group.length - 1);
  }
}

console.log("\n=== Type ID deployments ===");
// A Type ID deployment is referenced by its TYPE SCRIPT hash, not its data
// hash -- that is the whole point of Type ID, and why a data-hash check can
// never detect one being redeployed underneath live cells.
let typeIdUnused = 0n;
for (const c of typeId.sort((a, b) => Number(b.capacity - a.capacity))) {
  const users = await usersOf(c.type.hash(), ["type"]);
  const verdict = users === 0 ? "UNUSED" : `used by ${users}+`;
  console.log(
    `${ckb(c.capacity).padStart(9)} CKB  ${String(c.bytes).padStart(
      7,
    )}B  ${verdict}  ${c.outPoint.txHash}:${c.outPoint.index}`,
  );
  if (users === 0) typeIdUnused += c.capacity;
}

console.log(`\nliquid now                 ${ckb(plain.reduce((n, c) => n + c.capacity, 0n)).padStart(12)} CKB`);
console.log(`reclaimable from code      ${ckb(reclaimable).padStart(12)} CKB`);
console.log(`unused Type ID (confirm!)  ${ckb(typeIdUnused).padStart(12)} CKB`);
