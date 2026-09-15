# 64-liability creation and final payout — 2026-09-11

Local CKB-VM integration harness, using the previously documented Cargo
benchmark fallback. No production code or deployed binaries changed in this
checkpoint. This is not a mined-chain or reorg validation report.

## Fixture and assertions

Each accumulator contains 1,056 distinct-owner, one-ticket entries. Pure ledger
transitions accept the first 1,024 entries in 32 batches, then the target 32
entries as batch32. There are 256 closed shards, with entries in shard zero.
The 32-prize schedule uses equal weights. A bounded deterministic fixture
search selects a seeded entropy record with all 32 winners outside the target
batch, yielding exactly 32 depositors plus 32 prize-only winners.

This entropy search is test construction only: real entropy is bound to
scheduled headers and is not keeper-selectable. Receipt, entropy and withdrawal
history remain seeded. The test does not establish their on-chain provenance.

Native DAO, DAO lock and settlement creation type execute. Assertions require
64 derived liabilities, 32,000 CKB principal and batch ID32. The resulting
validated transaction output is then registered under its transaction outpoint
and spent through a complete 64-item payout, not replaced by an independently
seeded funding tree. Participant hashes have known corresponding always-success
scripts with distinct nonce arguments. MMR proofs authenticate all payouts.
Sponsors gift 1,249.86 CKB for occupied capacity and pay a 1 CKB fixture fee;
no funding remainder is created. A subsequent undercapacity mutation rejects.

| Accumulator | Creation cycles | Evidence bytes | Final payout cycles |
| --- | ---: | ---: | ---: |
| MMR | 17,265,600 | 21,490 | 7,288,002 |
| SMT | 31,368,379 | 22,202 | 7,288,062 |
| IMT | 22,270,777 | 41,874 | 7,288,002 |

All use the ordinary 70M verification ceiling. These costs are fixture-specific;
owner scripts and seeded entropy differ from earlier 33-owner measurements.
The IMT case includes its fixed-depth membership paths, but this is not a
universal maximum-proof/maximum-memory bound for all supported accumulators.

## Malformed payload limit

A separate test uses the 256-shard IMT fixture and pads otherwise-valid evidence
to exactly 160 KiB, then 160 KiB +1. Both reject with settlement error -72, not
VM OOM or cycle exhaustion. Padding is invalid trailing data: this proves safe
rejection at the loading/decoding boundary, not successful verification of a
valid 160-KiB proof set.

Command: `cargo test --offline --locked -p daowow-integration-tests --test proto3_dao_lifecycle -- --nocapture`.
All 29 tests pass. Local ephemeral log: `/tmp/daowow-64-combined.log`.

Remaining: maximum valid sparse proof combinations, full historical transitions
before phase2, actual full-node maturity boundaries and competing-chain reorgs.
Testnet deployment and wallet remain unchanged.

Bounded Rust review approved the test-only changes and independently compiled
the suite. Its assessment confirms the fixture and sponsor accounting, while
noting the one-Shannon negative violates both occupancy and amount owed; that
negative alone is not an isolated underpayment test.
