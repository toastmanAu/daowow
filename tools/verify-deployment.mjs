#!/usr/bin/env node
// Verify that the code cells a manifest points at contain the binaries in
// this working tree.
//
// This is the only check that proves the chain runs the code you can read.
// Comparing a manifest against a build, or against upstream's published
// constants, proves neither: on 2026-09-12 that gap hid mainnet and testnet
// running DIFFERENT builds of the same lock while every local check passed.
//
// Read-only. It never builds, signs or sends a transaction.
//
// Usage:
//   node tools/verify-deployment.mjs <manifest.json> [rpc-url]
//
// Exits non-zero on any mismatch, so it can gate a deployment.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ccc } from "../apps/web/vendor/ccc-joyid.min.mjs";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const BIN_DIR = path.join(
  ROOT, "target", "riscv64imac-unknown-none-elf", "release",
);

const [manifestPath, rpcOverride] = process.argv.slice(2);
if (!manifestPath) {
  console.error("usage: node tools/verify-deployment.mjs <manifest.json> [rpc-url]");
  process.exit(2);
}

const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
const rpcUrl = rpcOverride ?? manifest.rpcUrl;
if (!rpcUrl) throw new Error("no rpcUrl in the manifest and none given");

const rpc = async (method, params) => {
  const res = await fetch(rpcUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id: 1, jsonrpc: "2.0", method, params }),
  });
  const body = await res.json();
  if (body.error) throw new Error(`${method}: ${JSON.stringify(body.error)}`);
  return body.result;
};

console.log(`manifest ${manifestPath}`);
console.log(`node     ${rpcUrl}\n`);

let failures = 0;
let checked = 0;

for (const [name, script] of Object.entries(manifest.scripts ?? {})) {
  const localPath = path.join(BIN_DIR, name);
  const problems = [];

  let localHash = null;
  if (!fs.existsSync(localPath)) {
    problems.push(
      `no local binary at ${path.relative(ROOT, localPath)} ` +
      `(build with: cargo build --target riscv64imac-unknown-none-elf --release -p ${name})`,
    );
  } else {
    localHash = ccc.hashCkb(fs.readFileSync(localPath));
  }

  const outPoint = script.cellDep?.outPoint;
  let onChainHash = null;
  if (!outPoint) {
    problems.push("manifest has no cellDep out point");
  } else {
    const cell = await rpc("get_live_cell", [
      { tx_hash: outPoint.txHash, index: "0x" + Number(outPoint.index).toString(16) },
      true,
    ]);
    if (cell.status !== "live") {
      problems.push(`cell is ${cell.status}, not live`);
    } else {
      const data = cell.cell?.data?.content ?? "0x";
      if (data === "0x") {
        problems.push("cell carries no data");
      } else {
        onChainHash = ccc.hashCkb(data);
        // The node reports its own hash too; if ours disagrees with it, the
        // fault is in this tool rather than in the deployment, and saying so
        // is more useful than blaming the chain.
        const reported = cell.cell?.data?.hash;
        if (reported && reported !== onChainHash) {
          problems.push(
            `this tool hashed the cell data differently from the node ` +
            `(${onChainHash} vs ${reported}) — the tool is wrong, not the chain`,
          );
        }
      }
    }
  }

  // The three-way check. The manifest is only trustworthy when what is on
  // chain and what is in this tree agree with it AND with each other.
  if (onChainHash && localHash && onChainHash !== localHash) {
    problems.push(
      `on-chain binary differs from the local build\n      on chain ${onChainHash}\n      local    ${localHash}`,
    );
  }
  if (onChainHash && script.codeHash && script.codeHash !== onChainHash) {
    problems.push(
      `manifest codeHash does not match the deployed cell\n      manifest ${script.codeHash}\n      on chain ${onChainHash}`,
    );
  }
  if (script.hashType && !["data", "data1", "data2"].includes(script.hashType)) {
    problems.push(
      `hashType ${script.hashType} is not data-hash pinned; a type-id ` +
      `deployment cannot be verified this way at all`,
    );
  }

  checked += 1;
  if (problems.length === 0) {
    console.log(`  OK   ${name.padEnd(18)} ${onChainHash}`);
  } else {
    failures += 1;
    console.log(`  FAIL ${name}`);
    for (const p of problems) console.log(`       ${p}`);
  }
}

if (checked === 0) {
  console.log("\nno scripts in the manifest — nothing was verified");
  process.exit(1);
}
console.log(
  `\n${checked - failures}/${checked} scripts match the binaries in this tree`,
);
process.exit(failures === 0 ? 0 : 1);
