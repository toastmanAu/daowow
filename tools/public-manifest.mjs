#!/usr/bin/env node
// Writes the manifest the public site serves.
//
// The dev manifest names a node on a private network, which the internet
// cannot reach and which must not be published. This copies it and changes
// exactly one field. apps/web/test/app-shell.test.js fails if the two files
// differ anywhere else, so a redeploy cannot leave the site on old contracts.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const PUBLIC_RPC = "https://testnet.ckb.dev";
const from = path.join(ROOT, "deployments", "dev-testnet-manifest.json");
const to = path.join(ROOT, "apps", "web", "dapp", "manifest.json");

const manifest = JSON.parse(fs.readFileSync(from, "utf8"));
fs.writeFileSync(to, JSON.stringify({ ...manifest, rpcUrl: PUBLIC_RPC }, null, 2) + "\n");
console.log(`wrote ${path.relative(ROOT, to)} (node ${PUBLIC_RPC})`);
