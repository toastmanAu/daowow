# Let's get DaoWow on testnet

Status: five prototype code cells deployed, confirmed and verified live;
funded rounds blocked by protocol security gates.
Date: 2026-09-05.

## Target

Complete one testnet round with 20 controlled participants using real secp256k1
locks, two entry shards, one DAO batch initially, full principal repayment,
and an independently reproduced draw and settlement. Publish the transaction
hashes and verifier inputs. No UI is required.

A contracts-only deployment is a separate smoke test, not completion of M10.
An initial demo may use an explicitly labelled off-chain-verified draw, as
allowed by the readiness document; this does not relax principal custody or
liability authentication and does not complete M7.

## 1. Establish trustworthy contracts

- [x] Install the pinned Rust toolchain and build the five existing contracts.
- [x] Reproduce the RoundConfig validation bypass in a real VM transaction.
- [x] Remove the bypass and fix creation's output count to inspect the script
  group, allowing ordinary sponsor change outputs.
- [x] Verify creation and immutable updates; rerun the 16 prototype tests.
- [ ] Specify and implement unique round identity and authenticated config
  dependencies. Reject lookalike config cells and substituted script refs.
- [ ] Enforce entry/freeze deadlines with correctly decoded epoch values.
- [ ] Define failure finalisation: every accepted entry must be included in
  the funded draw universe or deterministically excluded and refundable.
- [ ] Test and repair summed refund repayment, ordinary payout destinations,
  occupied capacity handling and refund/aggregation exclusivity.
- [ ] Implement shard-major global offsets with checked arithmetic; validate
  all expected frozen shards, local tiling, entry counts and global totals.
- [ ] Bind batch commitments to consumed entry proofs, principal, ticket
  counts and native DAO outpoints.
- [ ] Bind DAO withdrawals to exact settlement backing and authenticated
  liabilities; reject decoy settlement cells and attacker-selected roots.

Exit: all positive and adversarial VM tests pass from freshly built binaries.
The spec, encoding and tests agree on identity, refunds, draw eligibility and
every shannon leaving a batch. All G0 findings in deployment-readiness.md
must be resolved. Do not deploy the previous unchecked binaries.

## 2. Build deployment and transaction tooling

- [x] Read CCC fundamentals, signer setup and transaction skills. Deployment
  used ckb-cli; exact CCC APIs must still be checked when implementing the SDK.
- [ ] Add TypeScript packages for shared encoding/proofs, transaction builders,
  the keeper and independent verification.
- [x] Run ckb-cli deployment preparation: actual binary sizes, occupied capacity,
  code hashes, fees, selected funding cells, change and explicit testnet network.
- [x] Produce an unsigned reviewable code-deployment transaction using ckb-cli:
  `deployments/testnet-deploy.local.json`; pending manifest and signing
  instructions are in `deployments/`. No private key is stored in the bundle.
- [x] Sign through the selected local ckb-cli keystore and submit.
- [x] After confirmation, record network/genesis identity, transaction hashes,
  output indices, code hashes, `data1`, code dep types, source revision and
  artifact checksums in the deployed-scripts manifest.
- [x] Verify code cells are live and their data hashes match the artifacts.
- [ ] Build entry, contention retry, freeze, aggregate, native DAO phase one
  and two, refund and settlement transactions from indexed chain state.
- [ ] Persist keeper progress; make restart and already-spent-cell handling
  idempotent. Use measured batch limits and funded fee sponsorship.

Exit: builders consume the manifest; signatures, proofs, dependencies,
headers, maturity constraints, funding and change are validated on a local node.

## 3. Complete the local round

- [ ] Run the keeper unattended with 20 real-key participants and two shards.
- [ ] Complete entry through settlement, including a separately exercised
  failed-aggregation refund scenario.
- [ ] Exercise contention and keeper restart, then verify no duplicate
  payouts and no omitted principal liabilities.
- [ ] Independently derive the frozen universe, global positions, seed,
  winners, realised DAO compensation and final balances from chain data.

Exit: M9 passes with a saved reproducible transcript. Script-harness success
alone does not satisfy this gate; a node must enforce capacity and maturity.

## 4. Launch on testnet

- [x] Select the testnet funding address. Public explorer observation on
  2026-09-05: 300,000 CKB in one live cell; address validated locally by
  `ckb-cli` as testnet Bech32m with the standard secp256k1 lock. Local settings
  are in git-ignored `deployments/testnet.local.json`; no signing key is stored.
- [ ] Finalise the budget for code, state, principal and fees after security
  repairs. Recheck live, spendable cells immediately before building the tx.
- [ ] Check live network identity, RPC/indexer behaviour, VM/hash-type support
  and transaction limits against the built artifacts.
- [x] Deploy the five prototype code binaries, await confirmations and validate
  `deployments/testnet-manifest.json`. Security repairs will require new builds.
- [ ] Run the same local-validated round with conservative batch sizes.
- [ ] Wait for actual DAO maturity; do not replace it with a mocked withdrawal.
- [ ] Publish manifest, transactions, verifier bundle and principal/yield/fee
  reconciliation. Label any off-chain draw limitation prominently.

Exit: M10 only when the real round completes and the independent verifier
matches chain data. The code-only deployment is confirmed at block 22,314,903;
no completed round is claimed. Its transaction is
`0x12c1ec3a523bff74caaefa329ce8b115854be61cc3b50521dd7d9efd0d4b8006`.

### Code-cell budget measured on 2026-09-05

Use the existing `contract-release` profile (`strip = true`). The unstripped
release binaries require 326,761 CKB for five code cells; stripping reduces
that to **180,777 CKB**. Each cell below has the funding wallet's standard
20-byte-args lock, no type script, and the executable as data: minimum capacity
is `(binary bytes + 8 capacity bytes + 33 script bytes + 20 args bytes) CKB`.

| Contract | Stripped bytes | Minimum code-cell CKB |
|---|---:|---:|
| round-type | 11,016 | 11,077 |
| entry-shard-type | 64,576 | 64,637 |
| entry-lock | 49,880 | 49,941 |
| dao-lock | 21,152 | 21,213 |
| settlement-type | 33,848 | 33,909 |
| Total | 180,472 | 180,777 |

This leaves **119,223 CKB before fees and round costs** from the observed
funding cell. These amounts exclude future contracts and binary growth from
security fixes; they are not a final round budget. Code capacity remains
locked while these cells are kept live for dependent transactions.

All **19 current VM tests** pass against stripped binaries. To use the current
harness's hardcoded `release/` directory, they were rebuilt with
`--config 'profile.release.strip=true'`; each of the five resulting files was
verified byte-identical to its `contract-release/` counterpart. Rebuild and
retest after every contract change; hashes change when binaries are stripped.

## Verification commands

```sh
cargo build --locked --target riscv64imac-unknown-none-elf --release \
  -p round-type -p entry-shard-type -p entry-lock -p dao-lock -p settlement-type
cargo test --locked -p daowow-core --lib
cargo test --locked -p daowow-integration-tests \
  --test round_validation --test proto1_entry_shard --test proto2_membership \
  --test proto3_dao_lifecycle --test proto4_settlement
```

These commands cover the current baseline only; extend them with each gate's
tests as implementation proceeds. The code-only ckb-cli deployment commands
are documented in `deployments/README.md`; keeper and round transaction
tooling remain pending.
