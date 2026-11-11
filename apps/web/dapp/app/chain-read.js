// Reads that need the vendored CKB library, kept out of the classic modules.

import { ccc } from "../../vendor/ccc.min.mjs";

// The config cell commits to the schedule's HASH, not its bytes: the schedule
// itself travels in the round-creation transaction's witness, where
// creation_schedule reads it from WitnessArgs.output_type.
//
// So the client recovers it the same way — fetch the transaction that created
// the config cell and read that field — then VERIFIES the commitment. Without
// that check a node could serve any schedule and the payout table would be
// whatever it liked. Molecule parsing is left to CCC rather than hand-rolled;
// getting a length prefix wrong here is the exact class of bug the vendored
// library exists to avoid.
export async function fetchSchedule(rpc, round) {
  const created = await rpc.call("get_transaction", [round.outPoint.txHash]);
  const raw = created?.transaction?.witnesses?.[0];
  if (!raw) throw new Error("the round creation transaction carries no witness");
  const args = ccc.WitnessArgs.fromBytes(ccc.bytesFrom(raw));
  if (!args.outputType) {
    throw new Error("the creation witness carries no prize schedule");
  }
  const bytes = ccc.bytesFrom(args.outputType);
  const commitment = ccc
    .hashCkb(ccc.bytesConcat(ccc.bytesFrom("DAOWOW_PRIZE_SCHEDULE_V1", "utf8"), bytes))
    .replace(/^0x/, "");
  if (commitment !== round.config.prizeScheduleHash) {
    throw new Error("the published schedule does not match the round's commitment");
  }
  return bytes;
}
