# Validation checkpoint — 2026-09-09

**Verdict: local gates pass; full-round node validation is blocked, not complete.**

Later implementation checkpoint: the owner approved the +64/+128/+192 entropy
schedule and +256 earliest finalization. One-time sealing and seal-backed
shard-zero refunds are now local, with 69 core and 69 VM tests passing, including
256-shard cases. Header/draw/initial-entitlement authentication is still unfinished.
The earlier observations and open decisions below describe the pre-seal checkpoint.

Checks performed around 08:28 UTC against the dirty working tree and the owner-supplied
RPC `http://192.168.68.134:8114`. No deployment, transaction submission, signing,
node configuration changes or historical manifest changes were made.

## Verified locally

- All five protocol contracts build with pinned offline dependencies for
  `riscv64imac-unknown-none-elf`, release profile.
- 69 core library tests pass.
- 66 VM integration tests pass across `round_validation`, `security_refunds`,
  `security_freeze`, `security_config`, `security_shard_lock`, `security_ledger`,
  and `proto1_entry_shard` through `proto4_settlement`.
- Strict core default/no_std and five-contract Clippy gates pass.
- Repository formatting and `git diff --check` pass.
- JavaScript: five security tests, eleven vector checks and demonstration engine pass.
  The demonstration still uses prototype accounting; it is not a verified builder
  or mirror of the hardened full-round protocol.
- The maximum SMT aggregation test succeeds under the 70-million-cycle budget.
  The previously measured optimized fixture is 47,389,969 cycles; that is not
  an all-proof/all-accumulator worst-case bound.

## Verified on the supplied node

- Chain: `ckb_testnet`; initial block download reports false; no alerts reported.
- Genesis: `0x10639e0895502b5688a6be8cf69460d76541bfa4821629d86d62ba0aae3f9606`,
  matching the deployment manifest.
- Indexer and transaction-pool tip both reported height `0x1552ebe` (22,359,742)
  and hash `0x670096ae8e9fe0340ba22c8dffe35e4140053cbf1f72ea6843f98967e780b079`.
  This is a point-in-time consistency check, not comparison with independent peers.
- Historical deployment transaction
  `0x12c1ec3a523bff74caaefa329ce8b115854be61cc3b50521dd7d9efd0d4b8006`
  remains committed in the manifest's block
  `0xd8ebd265f8f1aca1b1e92b617c5019f884c036cc64992a237b59b40027fdea36`.
- Its outputs 0–4 are live; all five data hashes match `deployments/testnet-manifest.json`.
  These are the old prototype payloads, not the current hardened local builds.
- `dry_run_transaction` and `test_tx_pool_accept` return parameter-validation
  errors (-32602), rather than method-not-found. This establishes that the node
  recognizes the methods only. No valid transaction was passed to either method.
- Reported consensus block cycle limit is 3,500,000,000 and pool transaction-size
  limit is 512,000 bytes. Neither is evidence that an unbuilt round transaction
  meets all script, size, capacity, fee, dependency and maturity rules.

## Full-validation gates still open

1. Implement the unique round seal, authenticated future entropy and draw, and
   contract-derived initial liability root/count. Settlement creation currently
   checks initial funding structure but does not establish the claimed entitlements.
2. Finalize entropy policy. Proposed seal-relative offsets +64/+128/+192 and
   finalization no earlier than +256 are still awaiting explicit owner approval.
3. Implement failed-round proportional-yield payouts and sponsor capacity rules.
   First-prize dust allocation exists as a tested core helper, not a complete
   authenticated settlement constructor.
4. Build real chain-state transaction/proof tooling for the new ABI and obtain
   bounded review of the complete authentication path before deploying it.
5. Use the resulting code-cell manifest and reviewable transactions to exercise
   node validation, then committed entry → aggregation → native DAO phases →
   authenticated settlement and excluded-entry refunds. Record actual outpoints,
   headers, fees, balances and rejection cases; test contention and keeper restart.
6. Do not claim ordinary testnet execution validates forced reorgs or accelerated
   DAO maturity. Those scenarios need an isolated devnet with controlled mining.

The node-access blocker is resolved. The incomplete protocol and transaction
tooling are not resolved by confirming node connectivity or rerunning VM tests.
