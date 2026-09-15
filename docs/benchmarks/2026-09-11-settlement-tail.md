# Settlement payout checkpoint — 2026-09-11

Local CKB-VM integration measurements, not node or deployment validation.
The benchmark skill preflight passed (ckb-debugger 1.1.1, GCC 10.2.0,
size analyzer 1.1.1; i7-14700KF, Linux 6.8.0-106-generic). This Cargo project
has no ckb-bench.toml or matching C Makefile/vector discovery layout, so the
existing Rust VM harness was used instead of the skill's C build scripts.
No separate debugger-mode or symbol-size measurement is claimed.

Build: offline/locked Rust release, `riscv64imac-unknown-none-elf`, data1.
Settlement ELF: 145,328 bytes; SHA-256
`eb523b41040ab090c5c196d7475e6dd894c7e359b873d320219d7e887120ba03`.

| Scenario | Total transaction script cycles |
| --- | ---: |
| Four ordinary payouts, funding remainder | 319,239 |
| Two ordinary payouts, final drain | 179,308 |
| 32 small-prize payouts with sponsored occupancy, final drain | 2,959,326 |
| Synthetic 64-liability sponsored final tail | 7,394,402 |

Command: `cargo test --offline --locked -p daowow-integration-tests --test proto4_settlement -- --nocapture`.
All 16 tests pass. The 64-item test explicitly asserts fewer than 70M cycles.
Raw local log: `/tmp/daowow-payout-final-green.log` (ephemeral).

The initial 64-item test failed with runtime error -1. Temporary instrumentation
showed heap usage above 480,000 bytes before failure in the 512-KiB bump
allocator. Repeated full-cell output scans allocated quadratically. The fix
uses allocation-free lock-hash syscalls for scanning and loads a full cell only
for a matching participant, retaining script bytes, ordinary-cell and occupied
capacity checks. Diagnostic instrumentation was removed before measurement.

Funding now pays exactly principal plus prize; full deposited capacity is
already included in principal. Sponsors fund excess output capacity and fees.
Tests reject funding deductions/top-ups of one Shannon and underpaid or
underoccupied outputs. The 64-item fixture is a conservative payout stress
case using seeded liabilities, not proof that initial creation can produce
that exact all-prize-only tree. Actual maximum creation witnesses across
accumulators, 256-shard entropy, full history and node maturity/reorg remain
unvalidated. Historical testnet binaries are unchanged.
