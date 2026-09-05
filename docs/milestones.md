# Milestones and Acceptance Gates

| Milestone | Gate |
|---|---|
| M0 Toolchain | Clean clone builds scripts and runs baseline tests |
| M1 Core math | Rust + TS match all deterministic vectors |
| M2 Entry shards | Concurrent entries work across shards; conflicts retry safely |
| M3 Accumulator | Membership proof verified on CKB-VM with measured cost |
| M4 Refunds | No Entry can be both refunded and aggregated |
| M5 DAO lifecycle | Full native DAO lifecycle works under DAOWOW lock without privileged key |
| M6 Batch accounting | Multi-batch principal/yield accounting exactly conserves value |
| M7 Draw | Independent verifier reproduces entropy and winners |
| M8 Settlement | Parallel direct-payout shards settle all liabilities exactly once |
| M9 Automation | Keeper/coordinator runs a local Round unattended from open to payout |
| M10 Testnet | Real testnet Round completes and verifier report matches chain |
| M11 Pre-audit freeze | Threat model, spec and implementation agree; protocol constants benchmarked |

Mainnet is explicitly outside this handoff's initial completion criteria.
