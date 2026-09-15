# Atomic ledger VM checkpoint — 2026-09-08

## Cost tuning follow-up

After removing repeated whole-batch proof validation from each entry-lock group,
the same 32-distinct-participant SMT scenario uses **47,389,969 cycles**,
down from **637,576,221** (92.6% reduction). The regression now executes with
the ordinary **70,000,000** ceiling, not the enlarged measurement ceiling.
The entry lock requires the exact canonical open ledger input; its mandatory
shard type still validates every entry, proof, successor, DAO output and receipt.
The receipt type retains independent validation. Bounded Rust/security review
found no authorization regression. Untyped and permissive-type ledger decoys
are rejected specifically by the entry lock.

This is one SMT fixture, not an all-accumulator worst-case bound or node admission
claim. The values and ELF sizes below are the historical pre-optimization baseline.

## Historical baseline

Measured with pinned offline release RISC-V binaries and ckb-testtool, using
`cargo test --offline --locked -p daowow-integration-tests --test security_ledger -- --nocapture`.
The benchmark skill preflight passed (ckb-debugger 1.1.1; Intel i7-14700KF;
Linux 6.8.0-106-generic). Its C/Makefile discovery runner does not match this
Cargo workspace; measurements use the existing real CKB-VM integration harness.

| SMT aggregation transaction | VM cycles |
| --- | ---: |
| First single-entry batch in a two-entry shard | 2,584,467 |
| Next single-entry batch | 2,582,476 |
| 32 entries, 32 distinct participant lock groups | 637,576,221 |

Each entry lock group repeats transaction-wide validation, so the maximum
batch is expensive. It fails the ordinary 70,000,000-cycle harness ceiling.
The maximum-batch measurement deliberately uses a 2,000,000,000-cycle ceiling;
that is not a production admission limit or a node/testnet feasibility claim.
Smaller operational batches or reviewed validation optimization are still needed.
This measures one SMT fixture, not worst-case proofs across every accumulator.

Release ELF file sizes (not stripped occupied on-chain capacity):

| Binary | Bytes |
| --- | ---: |
| entry-shard-type | 160,944 |
| entry-lock | 113,696 |
| dao-lock | 85,304 |

No deployment artifacts were replaced. Script-harness execution does not
establish node-level capacity balance, DAO maturity or complete-round security.
