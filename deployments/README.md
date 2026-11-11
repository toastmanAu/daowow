# Testnet code deployment

The confirmed deployment publishes five **prototype code cells**. It does not
create a round, deposit participant funds, or close the security gates in
`docs/deployment-readiness.md`. All code cells and change use the funding
wallet's secp256k1 lock. Spending a code cell later recovers its capacity but
breaks transactions that require it as a live dependency.

## Confirmed deployment

Committed in testnet block **22,314,903**, hash
`0xd8ebd265f8f1aca1b1e92b617c5019f884c036cc64992a237b59b40027fdea36`.
At 2026-09-05 04:47:27 UTC the transaction had **9 confirmations**. All five
code cells and the change cell were live; binary SHA-256 and CKB data hashes,
capacities and owner locks matched the prepared transaction.

Use [`testnet-manifest.json`](testnet-manifest.json) for confirmed code hashes
and `cellDep` outpoints. This records code availability, not round readiness.

## Deployment files

- `testnet.toml`: reproducible ckb-cli configuration; no type IDs or dep groups.
- `testnet-deploy.local.json`: git-ignored, signed and submitted ckb-cli bundle.
- `testnet-manifest.pending.json`: historical pre-signing snapshot; superseded
  by `testnet-manifest.json`.
- `migrations/2026-09-05-044628.json`: ckb-cli deployment receipt.

The confirmed transaction spent 300,000 CKB, locked 180,777 CKB in code cells,
pays 0.00362744 CKB in fees (2,000 shannons/KB), and returns
119,222.99637256 CKB as ordinary wallet change. Its transaction hash
is `0x12c1ec3a523bff74caaefa329ce8b115854be61cc3b50521dd7d9efd0d4b8006`.

All five payloads match the stripped, VM-tested artifacts byte for byte.
The original funding cell is now spent by this deployment. Do not reuse it
for another deployment. The commands below record the completed workflow;
future deployments require a new bundle and review.

## Sign locally

Run in your own terminal so the keystore password stays local:

```sh
cd daowow   # the repository root
ckb-cli --url https://testnet.ckb.dev/rpc deploy sign-txs \
  --info-file deployments/testnet-deploy.local.json \
  --from-account 0x5ea0977c3cab6898817c9860fe70d26acf559f76 \
  --add-signatures
```

This signs the prepared payload and updates its signature slots; it does not
broadcast. No key export or private-key file is necessary.

## Submit and confirm

After signatures are present, inspect the bundle and submit:

```sh
ckb-cli --url https://testnet.ckb.dev/rpc deploy explain-txs \
  --info-file deployments/testnet-deploy.local.json
ckb-cli --url https://testnet.ckb.dev/rpc deploy apply-txs \
  --info-file deployments/testnet-deploy.local.json \
  --migration-dir deployments/migrations
```

Submission is not confirmation. Query `get_transaction` for committed status;
verify all five outpoints with `get_live_cell`, comparing code-cell data hashes,
capacities and owner locks against the pending manifest. Record the block hash
and publish a separate confirmed manifest only after those checks pass.
Consumers use `hash_type: data1` and `dep_type: code`; the owner lock's
`hash_type: type` is a different field and does not select the contract VM.

## Rebuild a new unsigned deployment

From the repository root, build the stripped profile and rerun the VM tests
against byte-identical artifacts before generating another bundle:

```sh
cargo build --locked --target riscv64imac-unknown-none-elf \
  --profile contract-release \
  -p round-type -p entry-shard-type -p entry-lock -p dao-lock -p settlement-type
mkdir -p deployments/migrations
ckb-cli --url https://testnet.ckb.dev/rpc deploy gen-txs \
  --deployment-config deployments/testnet.toml \
  --from-address ckt1qzda0cr08m85hc8jlnfp3zer7xulejywt49kt2rr0vthywaa50xwsq275zthc09tdzvgzlycvrl8p5n2ea2e7aspjvjng \
  --fee-rate 2000 \
  --info-file deployments/testnet-deploy-next.local.json \
  --migration-dir deployments/migrations
```

Keep the previous bundle intact; review the newly generated transaction and
regenerate its pending manifest before signing. Never copy old code hashes
into a manifest for newly built executables.
