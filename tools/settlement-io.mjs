// Shared plumbing for the settlement tools: transaction shapes, resolving
// what a transaction names off the chain, and choosing which rule set
// applies. Used by dry-run-settlement.mjs (before signing) and
// check-signed-lifecycle.mjs (after), so both judge a transaction the same way.

import { checkDaoPhaseOne, checkDaoPhaseTwo, checkPayout } from "./settlement-rules.mjs";

const HASH_TYPE_NAME = { 0: "data", 1: "type", 2: "data1", 4: "data2" };
const strip = (s) => String(s ?? "").replace(/^0x/, "").toLowerCase();
const hexIndex = (n) => "0x" + Number(n).toString(16);

export const scriptFromRpc = (s) => (s ? { codeHash: s.code_hash, hashType: s.hash_type, args: s.args } : null);
export const scriptToRpc = (s) => (s ? { code_hash: s.codeHash, hash_type: s.hashType, args: s.args } : null);
export const pointFromRpc = (p) => ({ txHash: p.tx_hash, index: Number(BigInt(p.index)) });
export const pointToRpc = (p) => ({ tx_hash: p.txHash, index: hexIndex(p.index) });
export const depFromRpc = (d) => ({
  outPoint: pointFromRpc(d.out_point), depType: d.dep_type === "dep_group" ? "depGroup" : "code",
});

/** A builder's transaction, in JSON-RPC shape. */
export function toRpc(tx) {
  return {
    version: "0x0",
    cell_deps: tx.cellDeps.map((d) => ({
      out_point: pointToRpc(d.outPoint), dep_type: d.depType === "depGroup" ? "dep_group" : "code",
    })),
    header_deps: tx.headerDeps ?? [],
    inputs: tx.inputs.map((i) => ({
      previous_output: pointToRpc(i.previousOutput), since: "0x" + BigInt(i.since).toString(16),
    })),
    outputs: tx.outputs.map((o) => ({
      capacity: "0x" + BigInt(o.capacity).toString(16), lock: scriptToRpc(o.lock), type: scriptToRpc(o.type),
    })),
    outputs_data: tx.outputsData,
    witnesses: tx.witnesses,
  };
}

/** A JSON-RPC transaction, in the shape the builders and the rules use. */
export function fromRpc(raw) {
  return {
    cellDeps: (raw.cell_deps ?? []).map(depFromRpc),
    headerDeps: raw.header_deps ?? [],
    inputs: raw.inputs.map((i) => ({ previousOutput: pointFromRpc(i.previous_output), since: BigInt(i.since ?? 0) })),
    outputs: raw.outputs.map((o) => ({ capacity: BigInt(o.capacity), lock: scriptFromRpc(o.lock), type: scriptFromRpc(o.type) })),
    outputsData: raw.outputs_data,
    witnesses: raw.witnesses ?? [],
  };
}

const cellOf = (got) => (got && got.status === "live"
  ? {
    capacity: BigInt(got.cell.output.capacity), lock: scriptFromRpc(got.cell.output.lock),
    type: scriptFromRpc(got.cell.output.type), data: got.cell.data?.content ?? "0x",
  }
  : null);

/** The header of the block the transaction `txHash` was committed in. */
export async function inclusionHeader(rpc, txHash) {
  const tx = await rpc.call("get_transaction", [txHash]);
  if (!tx || !tx.tx_status || !tx.tx_status.block_hash) return null;
  return rpc.call("get_header", [tx.tx_status.block_hash]);
}

/**
 * Everything the settlement rules need that the transaction only NAMES: the
 * cells its inputs spend, the blocks those were committed in, the cells its
 * cell deps point at, and its header deps. Each is read from the chain, never
 * taken from what built the transaction.
 */
export async function resolveForRules(rpc, tx) {
  const inputCells = [];
  const inputHeaders = [];
  for (const input of tx.inputs) {
    const point = pointToRpc(input.previousOutput);
    inputCells.push(cellOf(await rpc.call("get_live_cell", [point, true])));
    inputHeaders.push(await inclusionHeader(rpc, point.tx_hash));
  }
  const depCells = [];
  for (const dep of tx.cellDeps) {
    depCells.push(cellOf(await rpc.call("get_live_cell", [pointToRpc(dep.outPoint), true])));
  }
  const headers = {};
  for (const hash of tx.headerDeps) headers[strip(hash)] = await rpc.call("get_header", [hash]);
  return { inputCells, inputHeaders, depCells, headers };
}

/**
 * Which settlement step a transaction is, from what it spends: a deposit
 * (eight zero bytes of data) is phase one, a withdrawing cell is phase two,
 * and a settlement cell is a payout. Null when it is none of them.
 */
export function settlementStepOf(config, inputCells) {
  const under = (script, ref) => Boolean(script) && strip(script.codeHash) === ref.codeHash.toLowerCase()
    && script.hashType === HASH_TYPE_NAME[Number(ref.hashType)];
  const dao = inputCells.filter((c) => c && under(c.lock, config.daoLock));
  if (dao.length > 0) return dao.every((c) => strip(c.data) === "00".repeat(8)) ? "phase-one" : "phase-two";
  if (inputCells.some((c) => c && under(c.type, config.settlementType) && strip(c.type.args).length === 144)) {
    return "payout";
  }
  return null;
}

/** The reasons a settlement transaction would be refused; empty if none. */
export async function checkSettlement(rpc, config, tx) {
  const resolved = await resolveForRules(rpc, tx);
  const missing = resolved.inputCells.map((c, i) => (c ? null : i)).filter((i) => i !== null);
  if (missing.length > 0) {
    return { step: null, reasons: missing.map((i) => `input ${i} is not a live cell on this chain`) };
  }
  const step = settlementStepOf(config, resolved.inputCells);
  const check = { "phase-one": checkDaoPhaseOne, "phase-two": checkDaoPhaseTwo, payout: checkPayout }[step];
  if (!check) return { step: null, reasons: ["this is not a settlement transaction"] };
  return { step, reasons: check({ config, tx, ...resolved }) };
}
