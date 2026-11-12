"use strict";
// Wrapped in an IIFE: loaded as a classic script these files share one
// global scope, so top-level declarations would collide between modules.
(function () {
// The whole deployment in two indexer scans.
//
// discovery.js answers questions about ONE round, and each answer is a scan of
// every cell under the shard type. The one-page app lists every round, so
// asking per round costs rounds x scans against a public node. Here the two
// scans happen once and each cell is filed under the round it belongs to.
//
// Everything under entry-shard-type shares one code hash, so cells are told
// apart exactly as the contract's own dispatch does it: by data length and
// first byte, and for claims by the args.

// Resolved lazily: a destructure at load time throws inside the IIFE whenever
// this file is evaluated before a sibling, and the module never publishes.
const codec = () =>
  typeof require === "function" ? require("./codec.js") : window.DaowowCodec;
const ledgerCodec = () =>
  typeof require === "function" ? require("./ledger-codec.js") : window.DaowowLedgerCodec;
const sealCodec = () =>
  typeof require === "function" ? require("./seal-codec.js") : window.DaowowSealCodec;
const entryCodec = () =>
  typeof require === "function" ? require("./entry-codec.js") : window.DaowowEntryCodec;

const strip = (s) => String(s ?? "").replace(/^0x/, "").toLowerCase();
const unhex = (s) => {
  const body = strip(s);
  return Uint8Array.from(body.match(/../g) ?? [], (b) => parseInt(b, 16));
};

// The indexer speaks {tx_hash, index: "0x0"}; everything downstream speaks
// {txHash, index: 0}. Converted here and nowhere else.
const outPointOf = (cell) => Object.freeze({
  txHash: cell.out_point.tx_hash,
  index: Number(cell.out_point.index),
});

const typeSearch = (script) => ({
  script: { code_hash: script.codeHash, hash_type: script.hashType, args: "0x" },
  script_type: "type",
  script_search_mode: "prefix",
});

/** A claim's type args, or null when these are not claim args at all. */
function decodeClaimArgs(hexArgs) {
  const ec = entryCodec();
  const bytes = unhex(hexArgs);
  if (bytes.length !== ec.CLAIM_ARGS_SIZE || bytes[0] !== ec.CLAIM_TAG) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return {
    commitment: strip(hexArgs).slice(2, 66),
    shardId: view.getUint32(33, true),
    position: view.getBigUint64(37, true),
  };
}

// Files one shard-type cell under its round, or nowhere.
function fileCell(cell, byRoundId, byCommitment) {
  const data = unhex(cell.output_data);
  const c = codec();
  if (data.length === c.SHARD_DATA_SIZE) {
    const shard = c.decodeEntryShardDataV1(data);
    const round = byRoundId.get(shard.roundId);
    if (!round) return;
    round.shards.push(Object.freeze({
      ...shard,
      capacity: BigInt(cell.output.capacity),
      typeArgs: cell.output.type ? cell.output.type.args : null,
      outPoint: outPointOf(cell),
    }));
    return;
  }
  // Ledger, seal and record carry commitment ‖ shard id as their args.
  const args = strip(cell.output.type && cell.output.type.args);
  if (args.length !== 72) return;
  const round = byCommitment.get(args.slice(0, 64));
  if (!round) return;
  const shardCount = round.config.entryShardCount;
  const lc = ledgerCodec();
  const sc = sealCodec();
  const capacity = BigInt(cell.output.capacity);
  // No version check here: decodeAggregationState refuses any version but 2,
  // and readDeployment drops a cell that does not decode.
  if (data.length === lc.AGGREGATION_STATE_SIZE) {
    round.ledger = Object.freeze({
      state: lc.decodeAggregationState(data), capacity, outPoint: outPointOf(cell),
    });
  } else if (data.length === sc.sealSize(shardCount) && data[0] === sc.SEAL_VERSION) {
    round.seal = Object.freeze({
      seal: sc.decodeRoundSeal(data, shardCount),
      // The seal's own block is the first of the four the draw is built from.
      inclusionHeight: BigInt(cell.block_number),
      capacity,
      outPoint: outPointOf(cell),
    });
  } else if (data.length === sc.recordSize(shardCount) && data[0] === sc.RECORD_VERSION) {
    round.record = Object.freeze({
      record: sc.decodeEntropyRecord(data, shardCount), outPoint: outPointOf(cell),
    });
  }
}

/** Every round under this deployment, oldest first, with its cells attached. */
async function readDeployment(rpc, manifest) {
  const c = codec();
  const rounds = [];
  for await (const cell of rpc.getCells(typeSearch(manifest.scripts["round-type"]))) {
    const data = unhex(cell.output_data);
    if (data.length !== c.ROUND_CONFIG_SIZE) continue;
    rounds.push({
      config: c.decodeRoundConfigV1(data),
      outPoint: outPointOf(cell),
      shards: [], ledger: null, seal: null, record: null,
    });
  }
  const byRoundId = new Map(rounds.map((r) => [r.config.roundId, r]));
  const byCommitment = new Map(rounds.map((r) => [r.config.commitment, r]));
  for await (const cell of rpc.getCells(typeSearch(manifest.scripts["entry-shard-type"]))) {
    // One undecodable cell must not hide every round from the page.
    try { fileCell(cell, byRoundId, byCommitment); } catch { /* not ours to show */ }
  }
  // Age order, decided here. The indexer's order is by type args (round id),
  // which once put a dead round first.
  rounds.sort((a, b) => {
    if (a.config.entryStart !== b.config.entryStart) {
      return a.config.entryStart < b.config.entryStart ? -1 : 1;
    }
    return a.config.roundId < b.config.roundId ? -1 : a.config.roundId > b.config.roundId ? 1 : 0;
  });
  return rounds.map((r) => Object.freeze({ ...r, shards: r.shards.sort((a, b) => a.shardId - b.shardId) }));
}

/** The claim cells this lock holds now, in every round, by position. */
async function findClaims(rpc, manifest, lockScript) {
  const shardType = manifest.scripts["entry-shard-type"];
  const claims = [];
  for await (const cell of rpc.getCells({
    script: {
      code_hash: lockScript.codeHash, hash_type: lockScript.hashType, args: lockScript.args,
    },
    script_type: "lock",
    script_search_mode: "exact",
  })) {
    const type = cell.output.type;
    if (!type || type.code_hash !== shardType.codeHash || type.hash_type !== shardType.hashType) {
      continue;
    }
    const args = decodeClaimArgs(type.args);
    if (!args) continue;
    claims.push(Object.freeze({
      ...args, capacity: BigInt(cell.output.capacity), outPoint: outPointOf(cell),
    }));
  }
  claims.sort((a, b) => (a.position < b.position ? -1 : a.position > b.position ? 1 : 0));
  return claims;
}

/**
 * One participant's entry cells across every round. entry-lock args are
 * participant lock hash ‖ commitment, so the participant is a PREFIX and one
 * scan covers all rounds.
 */
async function findMyEntries(rpc, manifest, participantLockHash) {
  const entryLock = manifest.scripts["entry-lock"];
  const who = strip(participantLockHash);
  if (!/^[0-9a-f]{64}$/.test(who)) throw new Error("a participant lock hash is 32 bytes of hex");
  const ec = entryCodec();
  const found = [];
  for await (const cell of rpc.getCells({
    script: { code_hash: entryLock.codeHash, hash_type: entryLock.hashType, args: "0x" + who },
    script_type: "lock",
    script_search_mode: "prefix",
  })) {
    const args = strip(cell.output.lock.args);
    if (args.length !== 128 || args.slice(0, 64) !== who) continue;
    const data = unhex(cell.output_data);
    if (data.length !== ec.ENTRY_DATA_SIZE) continue;
    found.push(Object.freeze({
      entry: ec.decodeEntryDataV1(data),
      participantLockHash: who,
      commitment: args.slice(64),
      capacity: BigInt(cell.output.capacity),
      outPoint: outPointOf(cell),
    }));
  }
  found.sort((a, b) => Number(a.entry.entryNonce - b.entry.entryNonce));
  return found;
}

const HASH_TYPE_CODE = { data: 0, type: 1, data1: 2, data2: 4 };
const CONFIG_SCRIPTS = Object.freeze({
  "entry-lock": "entryLock",
  "dao-lock": "daoLock",
  "settlement-type": "settlementType",
  "entry-shard-type": "entryShardType",
});

/**
 * Is this round built on the contracts this site was deployed for?
 *
 * Anyone can create a cell under the round type, and the round-type script
 * constrains a config's shape, not which scripts it points at. A round whose
 * config names someone else's DAO lock would look like any other on the page
 * while its deposits answered to that lock. So a round is only "ours" when
 * every script reference in its config equals the manifest's.
 */
function matchesDeployment(config, manifest) {
  for (const [name, field] of Object.entries(CONFIG_SCRIPTS)) {
    const want = manifest.scripts[name];
    const got = config[field];
    if (!want || !got) return false;
    if (strip(got.codeHash) !== strip(want.codeHash)) return false;
    if (Number(got.hashType) !== HASH_TYPE_CODE[want.hashType]) return false;
  }
  return true;
}

/**
 * Can this round ever run? Its config must commit the network's own Nervos
 * DAO type, as the hash of the whole type SCRIPT. A round that commits
 * anything else (two live rounds commit the DAO's CODE hash) can never place
 * its tickets in savings, so nobody may be offered an entry to it. It is
 * still ours: its entries can be refunded. Without `daoTypeHash` to compare
 * against, no round is sound.
 */
function usesNetworkDao(config, daoTypeHash) {
  if (!daoTypeHash) return false;
  return strip(config.daoType.codeHash) === strip(daoTypeHash)
    && Number(config.daoType.hashType) === 1;
}

/** How many entry cells each round still has on chain, keyed by commitment. */
async function countEntries(rpc, manifest) {
  const entryLock = manifest.scripts["entry-lock"];
  const ec = entryCodec();
  const counts = new Map();
  for await (const cell of rpc.getCells({
    script: { code_hash: entryLock.codeHash, hash_type: entryLock.hashType, args: "0x" },
    script_type: "lock",
    script_search_mode: "prefix",
  })) {
    const args = strip(cell.output.lock.args);
    if (args.length !== 128) continue;
    if (unhex(cell.output_data).length !== ec.ENTRY_DATA_SIZE) continue;
    const commitment = args.slice(64);
    counts.set(commitment, (counts.get(commitment) ?? 0) + 1);
  }
  return counts;
}

/**
 * When block `height` was made, in milliseconds. The node is asked for a
 * height and must answer for that height: a neighbouring block has a
 * neighbouring time, and it would be shown as this one's.
 */
async function readBlockTime(rpc, height) {
  const wanted = BigInt(height);
  const header = await rpc.call("get_header_by_number", ["0x" + wanted.toString(16)]);
  if (!header) throw new Error(`block ${wanted} is not available`);
  if (BigInt(header.number) !== wanted) {
    throw new Error(`asked for block ${wanted} and was given block ${BigInt(header.number)}`);
  }
  return BigInt(header.timestamp);
}

/** When period `epoch` began: the time on its first block. */
async function readEpochStartTime(rpc, epoch) {
  const wanted = BigInt(epoch);
  const found = await rpc.call("get_epoch_by_number", ["0x" + wanted.toString(16)]);
  if (!found) throw new Error(`period ${wanted} has not started`);
  if (BigInt(found.number) !== wanted) {
    throw new Error(`asked for period ${wanted} and was given ${BigInt(found.number)}`);
  }
  return readBlockTime(rpc, BigInt(found.start_number));
}

const api = {
  readDeployment, findClaims, findMyEntries, countEntries, decodeClaimArgs, matchesDeployment, usesNetworkDao,
  readBlockTime, readEpochStartTime,
};
if (typeof module !== "undefined" && module.exports) module.exports = api;
if (typeof window !== "undefined") window.DaowowRoundCells = api;
})();
