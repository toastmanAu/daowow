#!/usr/bin/env node
// Refuse a deployment config whose transaction would exceed CKB's block size
// limit.
//
// This exists because `ckb-cli deploy gen-txs` does NOT check it. gen-txs
// prices capacity, prints "status: success", and writes a signable info file
// for a transaction the node will reject at broadcast with
//
//   ExceededMaximumBlockBytes: expected transaction serialized size (616768)
//   < block size limit (597000)
//
// which is the only point the constraint appears. A dry run that validates
// one property and is read as validating all of them is worse than no dry run.
//
// Read-only: it reads the config and the binaries, nothing else.
//
// Usage: node tools/check-deploy-size.mjs <deployment-config.toml>...

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

// Consensus limit. Measured against a real rejection: 5 cells totalling
// 615,504 bytes of binary serialised to 616,768, so overhead was 1,264 bytes.
const BLOCK_SIZE_LIMIT = 597000;
// Everything that is not binary payload: inputs, witnesses, change output and
// per-output cell structure. Generous, because being wrong in the other
// direction costs a failed broadcast after signing.
const OVERHEAD_BASE = 1000;
const OVERHEAD_PER_CELL = 400;
// Stop well short of the cliff: a binary can grow between this check and the
// deployment, and a config sitting at 99% is a trap for whoever edits next.
const SAFE_FRACTION = 0.9;

const configs = process.argv.slice(2);
if (configs.length === 0) {
  console.error("usage: node tools/check-deploy-size.mjs <deployment-config.toml>...");
  process.exit(2);
}

let failed = false;

for (const configPath of configs) {
  const toml = fs.readFileSync(configPath, "utf8");
  // Deliberately a line scan rather than a TOML parser: the only thing needed
  // is each cell's file, and a dependency here would be a dependency in the
  // deployment path.
  const files = [...toml.matchAll(/location\s*=\s*\{\s*file\s*=\s*"([^"]+)"/g)]
    .map((m) => m[1]);

  if (files.length === 0) {
    console.log(`${configPath}: no file-backed cells, nothing to size`);
    continue;
  }

  let total = 0;
  const missing = [];
  for (const file of files) {
    const full = path.isAbsolute(file) ? file : path.join(ROOT, file);
    if (!fs.existsSync(full)) { missing.push(file); continue; }
    total += fs.statSync(full).size;
  }

  if (missing.length > 0) {
    console.log(`${configPath}: FAIL — binaries not built:`);
    for (const m of missing) console.log(`    ${m}`);
    failed = true;
    continue;
  }

  const estimate = total + OVERHEAD_BASE + OVERHEAD_PER_CELL * files.length;
  const budget = Math.floor(BLOCK_SIZE_LIMIT * SAFE_FRACTION);
  const ok = estimate <= budget;
  const pct = ((estimate / BLOCK_SIZE_LIMIT) * 100).toFixed(1);

  console.log(
    `${ok ? "  OK  " : " FAIL "} ${path.basename(configPath).padEnd(24)} ` +
    `${files.length} cells  ${total.toLocaleString()} bytes  ` +
    `≈ ${estimate.toLocaleString()} serialized  (${pct}% of the limit)`,
  );
  if (!ok) {
    console.log(
      `        exceeds the ${budget.toLocaleString()}-byte working budget ` +
      `(${BLOCK_SIZE_LIMIT.toLocaleString()} limit at ${SAFE_FRACTION * 100}%).`,
    );
    console.log("        Split this config into more transactions.");
    failed = true;
  }
}

process.exit(failed ? 1 : 0);
