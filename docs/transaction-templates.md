# Transaction Templates

These are logical templates, not frozen raw transactions.

## TX-01 Create Round

Inputs: sponsor/creator CKB.

Outputs:
- immutable RoundConfigCell;
- EntryShardCells 0..N-1;
- optional KeeperFundingCells;
- sponsor change.

## TX-02 Enter Round

Inputs:
- latest OPEN EntryShardCell N;
- participant funding.

Outputs:
- updated EntryShardCell N;
- EntryCell;
- participant change.

Retry required if competing transaction consumes the chosen shard head first.

## TX-03 Freeze Shard

Input: OPEN EntryShard N.

Output: FROZEN EntryShard N, preserving final counters and accumulator root.

Permissionless after deadline.

## TX-04 Refund Entry

Input: eligible refundable EntryCell.

Output: committed participant lock with attributable value less only permitted fee policy.

## TX-05 Aggregate DAO Batch

Inputs:
- bounded accepted EntryCells;
- membership/proof data;
- optional fee sponsor input.

Outputs:
- native DAO deposit cell under DAOWOWDAOLock;
- BatchCommitmentCell;
- change.

Must be atomic; no intermediary operator custody.

## TX-06 DAO Phase One

Inputs: one or more DAODepositCells; optional keeper fee input.

For every DAO input at index i, output i is its corresponding DAOWithdrawingCell with same capacity, same native DAO type, deposit block number in 8-byte little-endian cell data, and a DAOWOW-authorised lock.

Header deps include associated deposit headers as required by native DAO.

## TX-07 DAO Phase Two

Inputs: mature DAOWithdrawingCells with correct absolute-epoch `since`.

Header deps / witnesses satisfy native DAO's deposit-header and withdrawal-header requirements.

Outputs:
- FinalizedBatchFundingCell(s);
- bounded keeper reimbursement/change only as authorised.

## TX-08 Entropy Reveal

Inputs: participant funding for transaction fee.

Outputs: validated RevealCell and change.

Alternative reveal representations require explicit protocol review.

## TX-09 Finalise Entropy / Draw

Inputs/state references establish frozen Entry root and reveal set.

Uses predetermined future block headers/hashes. Output commits final seed and draw-result hash. No operator-selected entropy source.

## TX-10 Create Settlement Shards

Inputs: finalized DAO batch funding / final accounting authority.

Outputs: deterministic SettlementShardFundingCells whose total equals principal liabilities + prize allocations + explicitly bounded costs.

## TX-11 Batched Direct Payout

Input: SettlementShardFunding N.

Outputs:
- ordinary participant-controlled CKB cells for a bounded deterministic subset;
- remainder SettlementShardFunding N if unfinished.

## TX-12 Complete Round

Optional compact provenance record once all settlement shard liabilities are discharged. Completion must not be required for participants to own/use already-paid CKB.
