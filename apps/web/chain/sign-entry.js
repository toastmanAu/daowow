// Turning the pure transaction description into a signed, broadcast entry.
//
// buildEntryTx is deliberately CCC-free so its shape can be tested
// exhaustively. This is the adapter: it hands the description to CCC, lets the
// wallet fund and sign it, and sends it.
//
// Two hazards here are recorded in ~/.claude/rules/ckb-transactions.feedback.md
// and both are silent when they bite:
//
//  1. completeInputsByCapacity/completeFeeBy call addInput, which SPLICES an
//     empty witness per input added. A pre-populated witness can be shifted
//     out from under the index the contract reads it at. Our append witness
//     sits at index 0 alongside input 0 (the shard head), and witnesses.length
//     equals inputs.length when we hand the transaction over, so the splices
//     append rather than displace. That is an invariant, not a coincidence, so
//     it is ASSERTED after fee completion rather than assumed.
//
//  2. Cell deps must be present BEFORE completeFeeBy, or the fee is sized
//     against a smaller transaction than the one broadcast. The wallet's own
//     lock dep is added by prepareTransaction; ours come from buildEntryTx.

import { ccc } from "../vendor/ccc-joyid.min.mjs";

const hexed = (value) => (value.startsWith("0x") ? value : `0x${value}`);

// The plain description uses BigInt capacities and 0x-less data; CCC wants its
// own types. Converting here keeps buildEntryTx free of the dependency.
export function toCccTransaction(description) {
  return ccc.Transaction.from({
    version: 0,
    cellDeps: description.cellDeps.map((dep) => ({
      outPoint: {
        txHash: hexed(dep.outPoint.txHash),
        index: Number(dep.outPoint.index),
      },
      depType: dep.depType === "depGroup" ? "depGroup" : "code",
    })),
    headerDeps: [],
    inputs: description.inputs.map((input) => ({
      previousOutput: {
        txHash: hexed(input.previousOutput.txHash),
        index: Number(input.previousOutput.index),
      },
      since: input.since,
    })),
    outputs: description.outputs.map((output) => ({
      capacity: output.capacity,
      lock: {
        codeHash: hexed(output.lock.codeHash),
        hashType: output.lock.hashType,
        args: hexed(output.lock.args),
      },
      type: output.type
        ? {
            codeHash: hexed(output.type.codeHash),
            hashType: output.type.hashType,
            args: hexed(output.type.args),
          }
        : undefined,
    })),
    outputsData: description.outputsData.map((data) => hexed(data || "0x")),
    witnesses: description.witnesses.map((w) => hexed(w)),
  });
}

/**
 * The splice canary, extracted so it can be exercised without a wallet.
 *
 * CCC's addInput splices an empty witness per input it adds. Our append
 * witness sits at index 0 and survives only because witnesses.length equals
 * inputs.length when we hand the transaction over. If that ever stops holding,
 * the contract reads whatever landed at index 0 and fails with
 * SHARD_ERROR_DATA, which says nothing about the cause.
 */
export function assertWitnessIntact(tx, expectedWitnessZero) {
  if (tx.witnesses[0] !== expectedWitnessZero) {
    throw new Error(
      "the accumulator witness was displaced from index 0 while funding; " +
      "refusing to send",
    );
  }
}

/**
 * Fund and sign an entry, returning the signed transaction WITHOUT sending it.
 *
 * Signing and broadcasting are separate because losing the race for the shard
 * head is a broadcast-time outcome: the retry loop in contention.js needs to
 * see the send fail on its own so it can re-read the head and rebuild. A
 * combined call would bury that failure inside the signing step.
 *
 * `signer` is a CCC signer — the JoyID one in the browser. Nothing here reads
 * or stores key material; signing happens inside the wallet.
 */
export async function prepareAndSignEntry(signer, description, { feeRate = 1200 } = {}) {
  const tx = toCccTransaction(description);
  const witnessBefore = tx.witnesses[0];
  if (tx.witnesses.length !== tx.inputs.length) {
    // The invariant hazard 1 depends on. If a future change adds an input
    // without its witness slot, say so here rather than letting the append
    // witness be displaced into a contract error nobody can read.
    throw new Error(
      `entry transaction has ${tx.inputs.length} inputs and ` +
      `${tx.witnesses.length} witnesses; they must match before funding`,
    );
  }

  // prepareTransaction adds the wallet's own lock cell deps and its signature
  // placeholder. It runs BEFORE fee completion so the fee covers them.
  await signer.prepareTransaction(tx);
  await tx.completeInputsByCapacity(signer);
  await tx.completeFeeBy(signer, feeRate);

  assertWitnessIntact(tx, witnessBefore);

  return await signer.signTransaction(tx);
}

/**
 * Send an already-signed entry. Returns the transaction hash.
 *
 * This is where contention surfaces: the node refuses an input another entry
 * already took, and contention.js classifies that refusal.
 */
export async function broadcastEntry(signer, signedTx) {
  return await signer.client.sendTransaction(signedTx);
}

/**
 * Fund, sign and send in one step. Returns the transaction hash.
 */
export async function signAndSendEntry(signer, description, options = {}) {
  return await broadcastEntry(signer, await prepareAndSignEntry(signer, description, options));
}
