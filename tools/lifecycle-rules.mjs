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
