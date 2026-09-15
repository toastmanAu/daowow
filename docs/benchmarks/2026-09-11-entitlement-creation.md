# Initial entitlement creation limits — 2026-09-11

Local Rust CKB-VM harness, not real-node validation. Same benchmark-skill
preflight/toolchain and Cargo fallback described in `2026-09-11-settlement-tail.md`.

All three fixtures combine 32 batch entries, 32 prizes and 256 closed shards.
There are 33 accepted entries in shard zero, one first-batch entry and 32
second-batch entries; all have the same participant owner. Native DAO input
type, DAO lock and settlement creation type all execute. Historical receipt,
entropy and withdrawal cells are seeded, not created through a full history.

| Accumulator | Transaction cycles after fixes |
| --- | ---: |
| MMR | 44,161,476 |
| SMT | 69,266,417 |
| IMT | 62,140,986 |

Command: `cargo test --offline --locked -p daowow-integration-tests --test proto3_dao_lifecycle -- --nocapture`.
Measurement log: `/tmp/daowow-creation-optimized.log` (ephemeral).
The diagnostic verifier allows 3.5B to report actual costs, but the regression
then explicitly asserts every result is below the ordinary 70M ceiling.
SMT has little headroom: different roots/owners/proofs or rebuilt script hashes
may change its cost. These are not universal worst-case guarantees.

## Fixes driven by failing tests

- Inline IMT evidence was rejected by the native DAO type with error -12.
  A separate experiment accepted 16,000/32,000 bytes of lock-field padding but
  rejected 33,000 with the same native error. This is a tested boundary bracket,
  not a claim of the exact maximum raw witness length.
- Large evidence now uses tag0 + absolute u32 LE extra-witness index in
  WitnessArgs.output_type. The raw evidence stays version1 and is bounded to
  160 KiB before allocation; the reference must point beyond all inputs.
  Native input_type retains its header index. Small inline payloads remain valid.
- After moving evidence, combined fixtures measured 78.4M MMR, 112.0M SMT and
  104.1M IMT. Repeated validation/hashing of private, already-validated ledger
  state was removed. Structural checks still execute on decoding, with a cached
  config commitment reused across the batch. Consumers check config binding.
- Detached transport has missing/oversized/malformed evidence and invalid-index
  rejection tests. Expanded dependency groups pass; duplicate canonical receipt
  and entropy cells and multiple matching DAO inputs reject. Failed-round
  creation returns full deposit capacity plus all realized yield.

Bounded Rust/security review approved the changes. All 25 DAO lifecycle tests
pass. Maximum sparse proof lengths, 64 distinct initial liabilities, maximum
simultaneous heap usage, genuine historical execution and real-node
maturity/reorg remain unproven.

Release RISC-V ELF checkpoints:

- DAO lock: 153,920 bytes, SHA-256
  `1a691c4f058c2f55860ce817980fc5100e684c6a6879479835c5bfcfb9b023ae`.
- Settlement type: 146,736 bytes, SHA-256
  `d8a4a74f6ac6b31b4e4ee5543a3b31e9ef94aee71a3003c5f6893f4bc195ba26`.

No deployment, live testnet mutation or signing occurred.
