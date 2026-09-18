#!/usr/bin/env node
// Turn a `ckb-cli deploy` info file into the schemaVersion 1 deployment
// manifest the web client consumes.
//
// ckb-cli writes its own recipe format; apps/web/chain/manifest.js reads the
// shape already established by deployments/testnet-manifest.json. This is the
// one-way bridge between them, so nobody hand-copies 32-byte hashes.
//
// Read-only with respect to the chain: it builds a file, nothing else.
//
// Usage:
//   node tools/manifest-from-deploy.mjs <info-file> <rpc-url> [purpose]
//     > deployments/dev-testnet-manifest.json

import fs from "node:fs";

const [infoPath, rpcUrl, purpose = "dev-deployment-gate-2"] = process.argv.slice(2);
if (!infoPath || !rpcUrl) {
  console.error(
    "usage: node tools/manifest-from-deploy.mjs <info-file> <rpc-url> [purpose]",
  );
  process.exit(2);
}

// Every script the client needs. Listing them explicitly means a deployment
// that silently dropped one fails here rather than producing a manifest the
// client refuses later with a less obvious message.
const REQUIRED = [
  "round-type",
  "entry-shard-type",
  "entry-lock",
  "dao-lock",
  "settlement-type",
];

const info = JSON.parse(fs.readFileSync(infoPath, "utf8"));
const recipes = info?.new_recipe?.cell_recipes;
if (!Array.isArray(recipes) || recipes.length === 0) {
  throw new Error(`${infoPath} has no new_recipe.cell_recipes`);
}

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

const chain = await rpc("get_blockchain_info", []);
const genesis = await rpc("get_block_hash", ["0x0"]);

const scripts = {};
for (const name of REQUIRED) {
  const recipe = recipes.find((r) => r.name === name);
  if (!recipe) throw new Error(`deployment is missing the ${name} cell`);
  if (recipe.type_id && recipe.type_id !== "None") {
    // A Type ID deployment would hold the code hash constant while the binary
    // behind it changed, so no runtime check could detect a redeploy. The
    // config sets enable_type_id = false for exactly that reason; if one
    // turned up here the config was edited and the guarantee is gone.
    throw new Error(
      `${name} was deployed with a type id; this deployment must be data-hash pinned`,
    );
  }
  scripts[name] = {
    codeHash: recipe.data_hash,
    // data1 selects CKB-VM v1, which is what these binaries target. The code
    // hash IS the data hash, so a rebuilt binary is a different script rather
    // than a silent reinterpretation of cells already live under the old one.
    hashType: "data1",
    binaryBytes: null,
    cellDep: {
      outPoint: { txHash: recipe.tx_hash, index: Number(recipe.index) },
      depType: "code",
    },
    occupiedCapacityShannons: String(recipe.occupied_capacity),
  };
}

const manifest = {
  schemaVersion: 1,
  status: "generated",
  purpose,
  fundedRoundsReady: false,
  network: chain.chain,
  rpcUrl,
  genesisHash: genesis,
  generatedAt: new Date().toISOString(),
  generatedFrom: infoPath,
  note:
    "Dev deployment for gate 2. Superseded by gate 4's hardened deployment. " +
    "Verify with tools/verify-deployment.mjs before trusting it.",
  scripts,
};

process.stdout.write(JSON.stringify(manifest, null, 2) + "\n");
