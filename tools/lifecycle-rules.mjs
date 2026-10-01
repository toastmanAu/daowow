// The lifecycle rules, re-derived from a FINISHED transaction.
//
// Every rule here is enforced on chain and every one of them fails as a bare
// negative code: freeze and the ledger transitions all report SHARD_ERROR_*,
// and one code covers many distinct causes. These functions return REASONS so
// the operator learns which rule broke before signing rather than after
// broadcasting.
//
// They deliberately reuse the builders' pure cores — `genesisState` and
// `acceptBatch` — rather than porting the Rust a second time. A checker that
// shares logic with the builder normally proves nothing, and the exception
// that makes it safe here is specific: those cores are pinned BYTE FOR BYTE to
// Rust-generated vectors, so the shared implementation is validated against
// the contract rather than against itself. Porting twice would give two
// implementations of which only one was checked.
//
// What is NOT shared is the input: these take the cells as they appear in the
// transaction about to be sent, so a builder that wrote something other than
// what it computed is still caught.

import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const require_ = createRequire(path.join(ROOT, "tools/"));
const { genesisState } = require_("../apps/web/chain/genesis-tx.js");
const { acceptBatch, daoLockArgs, receiptArgs } =
  require_("../apps/web/chain/aggregate-tx.js");
const { closedState, closableFrom } = require_("../apps/web/chain/close-tx.js");
const ledgerCodec = require_("../apps/web/chain/ledger-codec.js");
const core = require_("../apps/web/core.js");

export const ABSOLUTE_EPOCH_FLAG = 0x2000000000000000n;
const CKB = 100000000n;
export const LEDGER_CELL_CKB = 318n;

const hexRaw = (b) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");

/**
 * TX-03. `before` and `after` are decoded EntryShardDataV1; `since` is the
 * input's raw since value.
 *
 * Mirrors validate_freeze (shard.rs:132) plus the epoch check at main.rs:262.
 */
export function checkFreeze({ config, before, after, since }) {
  const bad = [];
  if (before.state !== 0) {
    bad.push(`the input shard is not OPEN (state ${before.state})`);
  }
  if (after.state !== 1) {
    bad.push(`the successor is not FROZEN (state ${after.state})`);
  }
  // shard.rs:139-145 — one conjunction in Rust, so one reason here.
  const preserved = ["roundId", "shardId", "sequence", "entryCount",
                     "ticketCount", "principalTotal", "accumulatorRoot"];
  const moved = preserved.filter((f) => String(before[f]) !== String(after[f]));
  if (moved.length > 0) {
    bad.push(
      `freezing must change only the state, but ${moved.join(", ")} also moved`,
    );
  }
  // RFC 0017: without the flag the node reads the value as a BLOCK NUMBER.
  const raw = BigInt(since);
  if ((raw & ABSOLUTE_EPOCH_FLAG) !== ABSOLUTE_EPOCH_FLAG) {
    bad.push(
      "the input's since lacks RFC 0017's absolute-epoch flag, so the node " +
      "would read it as a block number",
    );
  } else {
    const epoch = raw & 0xffffffn;
    if (epoch < config.entryEnd) {
      bad.push(
        `since names epoch ${epoch}, before the round's entry_end ` +
        `(${config.entryEnd}); a shard cannot be frozen until then`,
      );
    }
  }
  return bad;
}

/**
 * The ledger genesis. `state` is the decoded AggregationState in the output.
 */
export function checkGenesis({
  config, frozen, state, inCapacity, outCapacity, entryInputCount,
}) {
  const bad = [];
  let expected = null;
  try {
    expected = genesisState(config, frozen);
  } catch (e) {
    // The contract recomputes this and refuses on the same conditions, so a
    // refusal here is the reason the chain will not give.
    bad.push(`this shard cannot seed a ledger: ${e.message}`);
  }
  if (expected) {
    const a = hexRaw(ledgerCodec.encodeAggregationState(expected));
    const b = hexRaw(ledgerCodec.encodeAggregationState(state));
    if (a !== b) {
      bad.push(
        "the ledger cell's data is not what AggregationState::new computes " +
        "from this frozen shard, which the contract recomputes and compares",
      );
    }
  }
  // ledger.rs:54, independent of the cell's own floor.
  if (BigInt(outCapacity) < BigInt(inCapacity)) {
    bad.push(
      `the ledger cell holds ${BigInt(outCapacity) / CKB} CKB, less than the ` +
      `${BigInt(inCapacity) / CKB} CKB the shard it replaces held`,
    );
  }
  const floor = LEDGER_CELL_CKB * CKB;
  if (BigInt(outCapacity) < floor) {
    bad.push(
      `the ledger cell holds ${BigInt(outCapacity) / CKB} CKB, below its own ` +
      `${LEDGER_CELL_CKB} CKB occupied floor`,
    );
  }
  // ledger.rs:26 — this is the rule that keeps genesis and acceptance apart.
  if (entryInputCount > 0) {
    bad.push(
      `the genesis carries ${entryInputCount} entry-lock input(s); ` +
      "no_entry_inputs forbids any",
    );
  }
  return bad;
}

/**
 * TX-05. Everything is taken from the transaction as it stands: `before` and
 * `after` are the ledger states in and out, `entries`/`capacities` come from
 * the entry cells being spent, and the three outputs are as written.
 */
export function checkAggregate({
  config, before, after, entries, capacities,
  ledgerOutCapacity, ledgerInCapacity, daoOutput, daoData, receiptOutput, proofs,
}) {
  const bad = [];
  let computed = null;
  try {
    computed = acceptBatch(config, before, entries, capacities);
  } catch (e) {
    bad.push(`this batch would be refused: ${e.message}`);
  }
  if (!computed) return bad;

  const { next, batch } = computed;
  const id = ledgerCodec.batchId(Number(before.frozen.shardId), before.acceptedBatches);

  if (hexRaw(ledgerCodec.encodeAggregationState(next))
      !== hexRaw(ledgerCodec.encodeAggregationState(after))) {
    bad.push(
      "the ledger successor's data is not what accepting this batch produces",
    );
  }
  if (BigInt(ledgerOutCapacity) < BigInt(ledgerInCapacity)) {
    bad.push("the ledger successor holds less capacity than the ledger it replaces");
  }

  // The DAO deposit is where a mistake is most expensive: its capacity must
  // equal the summed ENTRY CELL capacity exactly, not the principal.
  if (!daoOutput) {
    bad.push("there is no DAO deposit output under the config's dao_lock");
  } else {
    if (BigInt(daoOutput.capacity) !== batch.inputCapacity) {
      bad.push(
        `the DAO deposit holds ${BigInt(daoOutput.capacity)} shannons but the ` +
        `batch's summed input capacity is ${batch.inputCapacity}; it must be ` +
        "exact, and the principal " + batch.principal + " is a different number",
      );
    }
    const wantArgs = daoLockArgs(config, id, batch).toLowerCase();
    if ((daoOutput.lock.args ?? "").toLowerCase() !== wantArgs) {
      bad.push("the DAO deposit's dao_lock args do not carry this batch's id and digest");
    }
    if (!daoOutput.type
        || (daoOutput.type.codeHash ?? "").replace(/^0x/, "").toLowerCase()
           !== config.daoType.codeHash.toLowerCase()) {
      bad.push("the DAO deposit's type script is not the config's dao_type");
    }
    if ((daoData ?? "").replace(/^0x/, "") !== "00".repeat(8)) {
      bad.push(
        "the DAO deposit's data must be eight zero bytes, the native DAO's " +
        "deposit-block-number slot",
      );
    }
  }

  if (!receiptOutput) {
    bad.push("there is no batch receipt output");
  } else {
    const want = receiptArgs(config, before.frozen.shardId, id, batch).toLowerCase();
    if ((receiptOutput.type?.args ?? "").toLowerCase() !== want) {
      bad.push("the receipt's args do not carry this batch's id and digest");
    }
  }

  // Every proof, verified locally. A proof that fails here is -4 on chain,
  // after someone has signed.
  if (proofs) {
    if (proofs.length !== entries.length) {
      bad.push(`${entries.length} entries but ${proofs.length} proofs`);
    } else {
      entries.forEach((entry, i) => {
        const ok = core.mmrVerifyMembership(
          core.unhex(before.frozen.accumulatorRoot),
          Number(before.frozen.entryCount), Number(entry.entryNonce),
          core.entryLeaf(entry), proofs[i]);
        if (!ok) {
          bad.push(
            `the membership proof for entry nonce ${entry.entryNonce} does not ` +
            "verify against the frozen accumulator root",
          );
        }
      });
    }
  }
  return bad;
}

/**
 * Closing the ledger. A close and a batch are BOTH 207-byte to 207-byte
 * transitions, so they are told apart by what moved: a close flips `closed` and
 * carries no entry inputs, a batch leaves it false and carries them.
 *
 * Mirrors AggregationState::close (lifecycle.rs:338).
 */
export function checkClose({ config, before, after, since, entryInputCount }) {
  const bad = [];
  const epoch = BigInt(since) & 0xffffffn;
  if ((BigInt(since) & ABSOLUTE_EPOCH_FLAG) !== ABSOLUTE_EPOCH_FLAG) {
    bad.push(
      "the ledger input's since lacks RFC 0017's absolute-epoch flag, so the " +
      "node would read it as a block number",
    );
  }
  let expected = null;
  try {
    expected = closedState(config, before, epoch);
  } catch (e) {
    bad.push(`this ledger cannot be closed: ${e.message}`);
  }
  if (expected) {
    const a = hexRaw(ledgerCodec.encodeAggregationState(expected));
    const b = hexRaw(ledgerCodec.encodeAggregationState(after));
    if (a !== b) {
      bad.push(
        "the successor is not this ledger with only its closed flag set; " +
        `closing must preserve every counter (closable from epoch ` +
        `${closableFrom(config, before)})`,
      );
    }
  }
  // ledger.rs checks no_entry_inputs on the closing branch too.
  if (entryInputCount > 0) {
    bad.push(
      `the closing transaction carries ${entryInputCount} entry-lock input(s); ` +
      "no_entry_inputs forbids any",
    );
  }
  return bad;
}

// --- gate 3b: the seal and the entropy record ------------------------------

const { sealOf } = require_("../apps/web/chain/seal-tx.js");
const sealCodec = require_("../apps/web/chain/seal-codec.js");
const { entropyHeights, RELATIVE_BLOCK_FLAG, MIN_RELATIVE_BLOCKS } =
  require_("../apps/web/chain/entropy-tx.js");

const stripHex = (h) => String(h ?? "").replace(/^0x/, "").toLowerCase();

/**
 * Sealing (contracts/entry-shard-type/src/seal.rs). `before` is the CLOSED
 * ledger being spent, `otherLedgers` the closed ledgers of every other shard
 * (cell deps), `after` the decoded seal in the output.
 */
export function checkSeal({
  config, before, otherLedgers = [], after, shardId,
  inCapacity, outCapacity, entryInputCount,
}) {
  const bad = [];
  if (Number(shardId) !== 0) {
    bad.push(`only shard zero's ledger can become the seal (seal.rs:17); this is shard ${shardId}`);
  }
  let expected = null;
  try {
    expected = sealOf(config, [before, ...otherLedgers]);
  } catch (e) {
    bad.push(`these ledgers cannot be sealed: ${e.message}`);
  }
  if (expected) {
    const want = hexRaw(sealCodec.encodeRoundSeal(expected));
    const got = hexRaw(sealCodec.encodeRoundSeal(after));
    if (want !== got) {
      bad.push("the seal cell's data is not what RoundSeal::new computes from these ledgers");
    }
  }
  const floor = (8n + BigInt(sealCodec.sealSize(config.entryShardCount)) + 34n + 69n) * CKB;
  if (BigInt(outCapacity) < BigInt(inCapacity)) {
    bad.push("the seal cell holds less capacity than the ledger it replaces");
  }
  if (BigInt(outCapacity) < floor) {
    bad.push(`the seal cell holds ${BigInt(outCapacity) / CKB} CKB, below its own ${floor / CKB} CKB floor`);
  }
  if (entryInputCount > 0) {
    bad.push(`the sealing transaction carries ${entryInputCount} entry-lock input(s); no_entry_inputs forbids any`);
  }
  return bad;
}

/**
 * Entropy finalisation (contracts/entry-shard-type/src/entropy.rs). Every input
 * is the transaction's own: the since on the seal input, the header deps as
 * listed, the headers the node reported for them, and the record as written.
 *
 * The since's metric flag and its 256-block bound are ONE `if` in the contract
 * and TWO reasons here, so a transaction failing both is told about both.
 */
export function checkEntropy({
  config, seal, record, since, headerDeps, inclusionHeader, entropyHeaders,
  inCapacity, outCapacity, entryInputCount,
}) {
  const bad = [];
  const raw = BigInt(since);
  if (raw >> 56n !== RELATIVE_BLOCK_FLAG >> 56n) {
    bad.push(
      `the seal input's since has top byte 0x${(raw >> 56n).toString(16)}; entropy.rs:52 ` +
      "requires 0x80, a RELATIVE BLOCK NUMBER — not the absolute epoch (0x20) used everywhere else",
    );
  }
  if ((raw & 0x00ffffffffffffffn) < MIN_RELATIVE_BLOCKS) {
    bad.push(
      `the seal input's since is ${raw & 0x00ffffffffffffffn} blocks; the seal must be at least 256 blocks deep`,
    );
  }

  // Exactly four header deps: the seal's block, then +64, +128, +192.
  if (!Array.isArray(headerDeps) || headerDeps.length !== 4) {
    bad.push(
      `the transaction carries ${headerDeps?.length ?? 0} header dep(s); entropy.rs ` +
      "requires exactly four, and refuses a fifth",
    );
  }
  const inclusionHeight = BigInt(inclusionHeader.number);
  if (stripHex(headerDeps?.[0]) !== stripHex(inclusionHeader.hash)) {
    bad.push("header dep 0 is not the block the seal was committed in");
  }
  const schedule = entropyHeights(inclusionHeight);
  ["+64", "+128", "+192"].forEach((label, i) => {
    const h = entropyHeaders?.[i];
    if (!h) {
      bad.push(`no header supplied for the block at ${label}`);
      return;
    }
    if (BigInt(h.number) !== schedule[i]) {
      bad.push(`header dep ${i + 1} is at height ${BigInt(h.number)}, not ${schedule[i]} (${label})`);
    }
    if (stripHex(headerDeps?.[i + 1]) !== stripHex(h.hash)) {
      bad.push(`header dep ${i + 1} does not name the block at ${label}`);
    }
  });

  // The record the contract will recompute, from the seal being spent and the
  // headers actually listed.
  const expected = sealCodec.encodeEntropyRecord({
    seal,
    inclusionHeight,
    inclusionHash: stripHex(inclusionHeader.hash),
    entropyHashes: (entropyHeaders ?? []).map((h) => stripHex(h.hash)),
  });
  if (entropyHeaders?.length === 3
      && hexRaw(expected) !== hexRaw(sealCodec.encodeEntropyRecord(record))) {
    bad.push("the record cell's data is not what entropy.rs computes from this seal and these headers");
  }

  const floor = (8n + BigInt(sealCodec.recordSize(config.entryShardCount)) + 34n + 69n) * CKB;
  if (BigInt(outCapacity) < BigInt(inCapacity)) {
    bad.push("the record cell holds less capacity than the seal it replaces");
  }
  if (BigInt(outCapacity) < floor) {
    bad.push(`the record cell holds ${BigInt(outCapacity) / CKB} CKB, below its own ${floor / CKB} CKB floor`);
  }
  if (entryInputCount > 0) {
    bad.push(`the entropy transaction carries ${entryInputCount} entry-lock input(s); no_entry_inputs forbids any`);
  }
  return bad;
}
