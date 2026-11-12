#!/usr/bin/env node
// Builds one gate 3c transaction with the JavaScript builders, for the
// isolated devnet. Reads a JSON request on stdin, writes the transaction in
// JSON-RPC shape on stdout.
//
// The devnet node is reachable only through `docker exec`, so this script
// makes no RPC call: the Python test reads the chain and hands the cells and
// headers in. Everything protocol-shaped is done here, by the same builders
// the operator tools use.
import { createRequire } from "node:module";
import { ccc } from "../../apps/web/vendor/ccc.min.mjs";

const require = createRequire(import.meta.url);
const chain = (name) => require(`../../apps/web/chain/${name}.js`);
const { decodeRoundConfigV1 } = chain("codec");
const { decodeEntropyRecord } = chain("seal-codec");
const { decodeBatchCommitment } = chain("ledger-codec");
const { decodeEntryDataV1 } = chain("entry-codec");
const { decodeSchedule } = chain("schedule");
const { decodeSettlementFunding } = chain("settlement-codec");
const { deriveEntitlements } = chain("entitlements");
const { buildDaoPhaseOneTx, buildDaoPhaseTwoTx } = chain("dao-tx");
const { buildPayoutTx } = chain("payout-tx");
const { scriptHash } = chain("refund-tx");

const HASH_TYPE_NAME = { 0: "data", 1: "type", 2: "data1", 4: "data2" };
const unhex = (s) => Uint8Array.from((s.startsWith("0x") ? s.slice(2) : s).match(/../g) ?? [], (b) => parseInt(b, 16));
const point = (p) => ({ txHash: p.tx_hash, index: Number(BigInt(p.index)) });
const script = (s) => (s ? { codeHash: s.code_hash, hashType: s.hash_type, args: s.args } : null);
const dep = (d) => ({ outPoint: point(d.out_point), depType: d.dep_type === "dep_group" ? "depGroup" : "code" });

const rpcScript = (s) => (s ? { code_hash: s.codeHash, hash_type: s.hashType, args: s.args } : null);
const rpcPoint = (p) => ({ tx_hash: p.txHash, index: "0x" + Number(p.index).toString(16) });
const rpcTx = (tx) => ({
  version: "0x0",
  cell_deps: tx.cellDeps.map((d) => ({
    out_point: rpcPoint(d.outPoint), dep_type: d.depType === "depGroup" ? "dep_group" : "code",
  })),
  header_deps: tx.headerDeps,
  inputs: tx.inputs.map((i) => ({
    previous_output: rpcPoint(i.previousOutput), since: "0x" + BigInt(i.since).toString(16),
  })),
  outputs: tx.outputs.map((o) => ({
    capacity: "0x" + BigInt(o.capacity).toString(16), lock: rpcScript(o.lock), type: rpcScript(o.type),
  })),
  outputs_data: tx.outputsData,
  witnesses: tx.witnesses,
});

// What every step needs, from what the test read off the chain.
function common(req) {
  const config = decodeRoundConfigV1(unhex(req.config));
  const manifest = { scripts: {} };
  for (const [name, ref] of [["dao-lock", config.daoLock], ["settlement-type", config.settlementType]]) {
    manifest.scripts[name] = {
      codeHash: "0x" + ref.codeHash, hashType: HASH_TYPE_NAME[Number(ref.hashType)],
      outPoint: point(req.scripts[name]), depType: "code",
    };
  }
  const sponsor = {
    outPoint: point(req.sponsor.out_point), capacity: BigInt(req.sponsor.capacity),
    lock: script(req.sponsor.lock), lockDeps: req.sponsor.lock_deps.map(dep),
  };
  return { config, manifest, sponsor };
}

const daoTypeDep = (req) => ({ ...dep(req.dao_type_dep), script: script(req.dao_type) });

// The batch's evidence: the schedule from the round's creation witness, and
// the entries with their cells' capacities from the cells the aggregate spent.
function batchEvidence(req, config) {
  const created = ccc.WitnessArgs.fromBytes(ccc.bytesFrom(req.creation_witness));
  const schedule = decodeSchedule(ccc.bytesFrom(created.outputType));
  const entryLock = "0x" + config.entryLock.codeHash;
  const cells = req.aggregate_inputs.filter((c) => c.lock.code_hash === entryLock);
  return {
    schedule,
    record: decodeEntropyRecord(unhex(req.record), Number(config.entryShardCount)),
    receipt: decodeBatchCommitment(unhex(req.receipt)),
    entries: cells.map((c) => decodeEntryDataV1(unhex(c.data))),
    capacities: cells.map((c) => BigInt(c.capacity)),
  };
}

const steps = {
  "dao-phase-one"(req) {
    const { config, manifest, sponsor } = common(req);
    const built = buildDaoPhaseOneTx({
      manifest, config, sponsor,
      deposits: req.deposits.map((d) => ({
        outPoint: point(d.out_point), receiptOutPoint: point(d.receipt_out_point),
        capacity: BigInt(d.capacity), lock: script(d.lock), type: script(d.type),
      })),
      depositHeaders: req.deposit_headers,
      configCellOutPoint: point(req.config_out_point),
      daoTypeDep: daoTypeDep(req),
    });
    return {
      tx: rpcTx(built.tx),
      since_epochs: built.sinceEpochs.map(String), maturity_epochs: built.maturityEpochs.map(String),
    };
  },

  "dao-phase-two"(req) {
    const { config, manifest, sponsor } = common(req);
    const w = req.withdrawing;
    const built = buildDaoPhaseTwoTx({
      manifest, config, sponsor,
      withdrawing: {
        outPoint: point(w.out_point), receiptOutPoint: point(w.receipt_out_point),
        capacity: BigInt(w.capacity), lock: script(w.lock), type: script(w.type), data: w.data,
      },
      depositHeader: req.deposit_header, withdrawHeader: req.withdraw_header,
      recordOutPoint: point(req.record_out_point),
      configCellOutPoint: point(req.config_out_point),
      daoTypeDep: daoTypeDep(req),
      ...batchEvidence(req, config),
    });
    return {
      tx: rpcTx(built.tx), realized: String(built.realized), maturity_epoch: String(built.maturity.epoch),
      liabilities: built.entitlements.liabilities.map((l) => ({
        participant_lock_hash: l.participantLockHash, principal: String(l.principal), prize: String(l.prize),
      })),
      prizes: built.entitlements.prizes.map((p) => ({ ticket: p.ticket, amount: String(p.amount) })),
    };
  },

  payout(req) {
    const { config, manifest, sponsor } = common(req);
    const state = decodeSettlementFunding(unhex(req.funding.data));
    const evidence = batchEvidence(req, config);
    // The liabilities are derived again from the chain's evidence, never
    // carried over from the transaction that created the cell.
    const { liabilities } = deriveEntitlements({
      config, batchId: state.batchId, realizedTotal: state.realizedTotal, ...evidence,
    });
    const locks = Object.fromEntries(req.participant_locks.map((l) => [scriptHash(script(l)), script(l)]));
    const built = buildPayoutTx({
      manifest, sponsor, liabilities, locks, count: req.count ?? undefined,
      funding: {
        outPoint: point(req.funding.out_point), capacity: BigInt(req.funding.capacity),
        lock: script(req.funding.lock), type: script(req.funding.type), state,
      },
    });
    return { tx: rpcTx(built.tx), paid: built.paid.length, held: built.held, final: built.final };
  },
};

let input = "";
process.stdin.setEncoding("utf8");
for await (const chunk of process.stdin) input += chunk;
const request = JSON.parse(input);
const step = steps[request.step];
try {
  if (!step) throw new Error(`unknown step ${request.step}`);
  process.stdout.write(JSON.stringify({ ok: true, ...step(request) }));
} catch (e) {
  // A refusal is an answer the test may be asking for, not a crash.
  process.stdout.write(JSON.stringify({ ok: false, error: e.message }));
}
