"use strict";
// Deployment manifest loading.
//
// The client hardcodes no chain constants (spec D4): network, RPC endpoint and
// every script's code hash, hash type and out point come from here. A manifest
// that cannot be fully validated is REFUSED rather than best-effort parsed,
// because the failure it would otherwise cause is silent — a wrong code hash
// makes discovery watch the wrong cells and report an empty round, which looks
// exactly like a round that has not opened yet.

const SCHEMA_VERSION = 1;

const REQUIRED_SCRIPTS = Object.freeze([
  "round-type",
  "entry-shard-type",
  "entry-lock",
  "dao-lock",
  "settlement-type",
]);

// CKB hash type discriminants are DataN = N<<1: data=0, type=1, data1=2,
// data2=4. There is no hash type 3, so a permissive parser would silently
// mis-map an invalid value onto a real one.
const HASH_TYPES = Object.freeze(["data", "type", "data1", "data2"]);

const isCodeHash = (v) => typeof v === "string" && /^0x[0-9a-f]{64}$/.test(v);

function loadScript(name, raw) {
  if (!raw || typeof raw !== "object") {
    throw new Error(`manifest is missing the ${name} script`);
  }
  if (!isCodeHash(raw.codeHash)) {
    throw new Error(`${name}: code hash must be 32 bytes of lowercase hex`);
  }
  if (!HASH_TYPES.includes(raw.hashType)) {
    throw new Error(
      `${name}: hashType must be one of ${HASH_TYPES.join(", ")}`,
    );
  }
  const outPoint = raw.cellDep && raw.cellDep.outPoint;
  if (!outPoint || typeof outPoint.txHash !== "string") {
    throw new Error(`${name}: cellDep out point is missing`);
  }
  return Object.freeze({
    codeHash: raw.codeHash,
    hashType: raw.hashType,
    depType: (raw.cellDep && raw.cellDep.depType) || "code",
    outPoint: Object.freeze({
      txHash: outPoint.txHash,
      index: Number(outPoint.index ?? 0),
    }),
  });
}

function loadManifest(raw) {
  if (!raw || typeof raw !== "object") {
    throw new Error("manifest must be an object");
  }
  if (raw.schemaVersion !== SCHEMA_VERSION) {
    throw new Error(
      `unsupported manifest schemaVersion ${raw.schemaVersion}, expected ${SCHEMA_VERSION}`,
    );
  }
  if (typeof raw.network !== "string" || raw.network.length === 0) {
    throw new Error("manifest is missing network");
  }
  if (typeof raw.rpcUrl !== "string" || !/^https?:\/\//.test(raw.rpcUrl)) {
    throw new Error("manifest is missing a usable rpcUrl");
  }
  const scripts = {};
  for (const name of REQUIRED_SCRIPTS) {
    scripts[name] = loadScript(name, raw.scripts && raw.scripts[name]);
  }
  return Object.freeze({
    network: raw.network,
    rpcUrl: raw.rpcUrl,
    genesisHash: raw.genesisHash ?? null,
    purpose: raw.purpose ?? null,
    scripts: Object.freeze(scripts),
  });
}

const api = { loadManifest, REQUIRED_SCRIPTS, HASH_TYPES, SCHEMA_VERSION };
if (typeof module !== "undefined" && module.exports) module.exports = api;
if (typeof window !== "undefined") window.DaowowManifest = api;
