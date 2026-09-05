# DAOWOW Threat Model

## Assets

- participant principal;
- DAO-generated compensation / Yield Pool;
- ticket ownership/order;
- entropy and winning positions;
- settlement liabilities;
- keeper funding.

## Adversaries

Assume any of the following can be malicious independently or in collusion:

- Round creator;
- coordinator/front-end;
- keeper;
- participant / whale / Sybil participant;
- indexer/API provider;
- block producer with limited short-term influence;
- transaction relay/RPC endpoint.

## T-01 Operator steals Entry principal

Mitigation: EntryLock only permits same-Round DAO aggregation or participant refund. No operator signature path.

Acceptance test: enumerate destination mutations and confirm rejection.

## T-02 Lock substitution during DAO phase one

Native DAO permits its own structural semantics; DAOWOW must independently preserve DAOWOW custody identity.

Mitigation: DAOWOWDAOLock verifies corresponding withdrawing output lock/args and Round/batch binding.

## T-03 Coordinator omits an eligible Entry

Mitigation: every accepted Entry must update a fixed EntryShard accumulator. Frozen shard roots define the accepted universe. Aggregation requires proofs against those commitments.

Open risk: accumulator/proof design must make omission impossible or detectable on-chain at acceptable cycle cost.

## T-04 Selective DAO aggregation after entropy becomes known

Mitigation: entropy generation cannot begin until accepted DAO-participating Entry set is irrevocably fixed.

## T-05 Last revealer manipulates randomness

Mitigation candidate: missing-reveal fallback plus future chain entropy. Requires formal review; participant reveal alone is insufficient.

## T-06 Miner/block producer biases selected block entropy

Mitigation candidate: multiple predetermined future blocks separated by fixed offsets plus participant entropy. Quantify economic manipulation threshold before mainnet.

## T-07 Coordinator grinds transaction hashes / ordering

Mitigation: ticket ordering and entropy must avoid any coordinator-selectable field after commitment. Do not use arbitrary settlement transaction hash as randomness.

## T-08 Whale splits tickets across addresses

This should not change aggregate probability because selection is by ticket position, not address. Address caps are not Sybil resistance.

## T-09 Keeper censors progression

Mitigation: progression permissionless; multiple keepers can compete. Refund deadline before DAO protects unaggregated Entries.

## T-10 Keeper drains reward pool

Mitigation: reward tied to unique state transition, fixed/bounded by immutable policy, impossible to repeat for already-consumed state.

## T-11 Settlement overpays or underpays

Mitigation: integer accounting, deterministic test vectors, conservation checks, property tests, settlement shard proofs.

## T-12 Double payout

Mitigation: settlement shard state progression plus CKB single-spend semantics. Direct payouts avoid user claim replay.

## T-13 Occupied capacity erodes principal unexpectedly

Mitigation: treat infrastructure capacity separately; quantify and disclose; sponsor it in V1 where practical.

## T-14 Reorg changes entropy block

Define confirmation/finality depth before entropy finalization. Test shallow reorg handling in coordinator/keeper.

## T-15 RPC/indexer lies

On-chain scripts remain authoritative. Independent verifier must reconstruct Round from CKB. Coordinator must verify returned transactions/headers and support multiple endpoints where feasible.

## Mainnet blockers

- unreviewed randomness;
- unbounded settlement/accounting path;
- privileged custody path;
- incomplete Entry-set proof;
- insufficient adversarial tests;
- unknown transaction/cycle ceilings;
- unresolved legal operating model.
