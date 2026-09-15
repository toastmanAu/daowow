# Single initial-entitlement verification — 2026-09-11

Local Rust CKB-VM integration measurements using the Cargo harness fallback
described in `2026-09-11-entitlement-creation.md`; not node validation.

The owner approved splitting verification after the distinct-owner SMT fixture
exceeded 70M. DAO phase2 now requires exactly one newly-created output with the
configured settlement type (exact code hash, hash_type and cfg/batch/digest
args), under its public lock. Any matching settlement input rejects, ensuring
the type executes creation rather than its payout-update branch. Settlement
creation retains the full entitlement validator; native DAO checks remain.

| 32 entries / 32 prizes / 256 shards | MMR | SMT | IMT |
| --- | ---: | ---: | ---: |
| One consolidated owner | 25,126,045 | 35,216,929 | 28,603,625 |
| 33 distinct liabilities | 23,122,018 | 32,957,450 | 29,029,843 |

Before this change the distinct-owner SMT case was 73,445,370 cycles and failed
the unchanged 70M assertion. Both creation-limit tests now pass their 70M gate.
Differences include the new DAO ELF hash changing config commitments and draw
seeds; these are measured fixture costs, not universal worst-case guarantees.

Command: `cargo test --offline --locked -p daowow-integration-tests --test proto3_dao_lifecycle -- --nocapture`.
Cycle log: `/tmp/daowow-single-verification-focused.log` (ephemeral). That first
run still had three obsolete error-source assertions; after changing them to
the settlement type's actual errors, all 27 DAO lifecycle tests and standalone
creation rejection passed in `/tmp/daowow-single-verification-green.log`.

New bypass cases reject matching existing funding inputs, duplicate outputs,
missing/wrong types, altered hash_type, public-lock-mode types and wrong batch
digest. Existing forged-root/count/amount, decoy routing, dependency and witness
mutations still reject; entitlement failures now arise in settlement creation.

Release RISC-V ELF checkpoints:

- DAO lock: 76,776 bytes, SHA-256
  `ed9bb5754e7667f57576b3babee0d57e3f2f9ab2fa4f910e514f58a8aa64a5c4`.
- Settlement: 146,736 bytes, SHA-256
  `d8a4a74f6ac6b31b4e4ee5543a3b31e9ef94aee71a3003c5f6893f4bc195ba26`.

Maximum sparse proofs, 64 distinct initial liabilities, full historical
execution, and real-node maturity/reorg remain separate open gates. Historical
testnet deployment and wallet are unchanged.

Final gates: 96 core and 91 named VM tests pass; all five release builds, strict
core default/no_std and RISC-V Clippy, formatting and whitespace pass. Bounded
Rust/security review approved delegation, conditional on the configured
settlement script resolving to the reviewed enforcing implementation.
