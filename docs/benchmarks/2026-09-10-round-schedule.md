# Round schedule creation — 2026-09-10

Scope: real CKB-VM execution of the round-creation fixtures with the new
committed schedule check. Not a full-round or maximum-256-shard cost bound.

Benchmark skill preflight passed: Intel i7-14700KF, Linux 6.8.0-106-generic,
ckb-debugger 1.1.1, RISC-V GCC 10.2.0, size analyzer 1.1.1. The skill's C
Makefile/vector discovery does not match this Cargo repository; measurements
therefore use its existing Rust ckb-testtool transaction verifier. No separate
debugger or symbol-breakdown results are claimed.

Command: `cargo test --offline --locked -p daowow-integration-tests --test round_validation -- --nocapture`

| Fixture | Cycles |
| --- | ---: |
| 4 canonical shards, 32 prizes, typed config at output 1 | 825,327 |
| Same fixture, untyped anchored config, shard enforcement | 704,738 |

Both place schedule bytes in WitnessArgs.output_type at absolute witness index
1, beyond the single funding input. A 65-byte lock placeholder demonstrates
serialization coexistence, not a real wallet signature. Missing/invalid schedule,
wrong commitment and oversized full-witness cases are rejected. The script
limit for these tests is 70,000,000 cycles.

Built with pinned offline release dependencies for
`riscv64imac-unknown-none-elf`. ELF evidence at this checkpoint:

| Contract | Bytes | SHA-256 (file, not CKB data hash) |
| --- | ---: | --- |
| round-type | 60,064 | `4611174af807e23bd8324854486108b0bae38ee2ef658ef6bffb6d158a673c36` |
| entry-shard-type | 182,744 | `c1234cc234a8e566273939e1baf3e0899ae30fb3199fd8cc144752ef1dbfbab0` |

No testnet manifest update, deployment, signing, full-node maturity test or
forced-reorg validation occurred during this measurement.
