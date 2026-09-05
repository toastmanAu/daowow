# Open Questions / Research Backlog

Prioritize these before freezing protocol v0.3.

## P0 — protocol-critical

1. **Accumulator:** SMT vs MMR vs incremental Merkle tree; exact membership and completeness semantics.
2. **Complete Entry universe:** prove all shard-accepted Entries are either deterministically aggregated or deterministically excluded/refundable before entropy starts.
3. **Randomness:** formal analysis of last revealer, miner withholding, reorgs, grinding and transaction delay.
4. **DAO lock composition:** verify every native DAO transition while preventing lock substitution / arbitrary settlement outputs.
5. **Occupied capacity:** measure exact structural capacity cost for all proposed cells and define sponsor vs participant responsibility.
6. **Settlement proof:** define how each payout amount is verified without an unbounded on-chain computation.

## P1 — scalability

7. Optimal EntryShard count.
8. Max EntryCells per aggregation transaction.
9. Max DAO deposit cells per phase-one transaction.
10. Max DAO withdrawing cells per phase-two transaction.
11. Max direct payout outputs per settlement transaction.
12. Header-dep and witness growth at scale.
13. Keeper competition and shard starvation behaviour.

## P1 — economics

14. Minimum viable ticket price considering capacity and fees.
15. Fee policy: sponsor, pro-rata participant deduction, or fixed disclosed cost.
16. Keeper reward mechanism.
17. Prize schedule rounding residue.
18. Minimum Round threshold and cancellation policy.

## P2 — product/protocol evolution

19. Multiple Round terms / concurrent Rounds.
20. Transferable tickets—explicitly not V1.
21. Rollovers—explicitly not V1.
22. Third-party Round creation.
23. Explorer proof UX.
24. Regulatory deployment constraints by jurisdiction.
