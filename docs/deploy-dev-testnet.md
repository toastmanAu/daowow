# Deploying the dev contracts to testnet

Gate 2's dev deployment. **Superseded by gate 4's hardened deployment** — its
purpose is to make the dApp demonstrable and to surface RPC, indexer and pool
behaviour early, not to be the deployment anyone relies on.

Phill runs this. No private key, seed or password goes into this repository,
into a script it contains, or into any agent's hands.

```sh
export ADDR=ckt1qzda0cr08m85hc8jlnfp3zer7xulejywt49kt2rr0vthywaa50xwsqd8w6ls95vu473hf8vsdnpvn2cu785qlac0rckws
export LOCKARG=0xa776bf02d19cafa3749d906cc2c9ab1cf1e80ff7
export CKB_URL=http://192.168.68.134:8114        # wyltek-10700
```

`--url` is global and goes **before** the subcommand. Without it every call
fails against a local node that is not there:
`` http error: `error sending request for url (http://127.0.0.1:8114/)` ``.

## What it costs

Measured 2026-09-18, and independently reproduced by `ckb-cli deploy gen-txs`:

| contract | binary bytes | cell CKB |
|---|---:|---:|
| round-type | 60,080 | 60,141 |
| entry-shard-type | 229,384 | 229,445 |
| entry-lock | 95,392 | 95,453 |
| dao-lock | 77,440 | 77,501 |
| settlement-type | 153,208 | 153,269 |
| **total** | | **615,809** |

Plus a fee of about 0.0062 CKB. The deployer held 744,621 CKB liquid after the
reclaim in `docs/reclaim-testnet-capacity.md`, so this is funded with roughly
128,000 CKB to spare — which must also cover round creation and keeper
operation in later gates.

## Why data-hash pinned, not Type ID

Both `deployments/dev-testnet-a.toml` and `-b.toml` set
`enable_type_id = false` on every cell, so each script's code hash **is** the
data hash of its binary.

A Type ID deployment holds the code hash constant by construction while the
binary behind it changes, so no runtime check can ever detect a redeploy —
only the dep cell's data hash moves. For a round that is already open, that is
the ability to change the rules underneath it. Data-hash pinning makes a
rebuilt binary a *different script* rather than a silent reinterpretation of
cells already live under the old one.

The cells carry the **deployer's own lock**, not `--zero-lock`. `--zero-lock`
is permanent and irreversible; these cells should be reclaimable once gate 4
supersedes them, exactly as the superseded deployments in
`docs/reclaim-testnet-capacity.md` were.

## 1. Build the contracts

One package at a time, and never while a devnet run is in progress.

```sh
for c in round-type entry-shard-type entry-lock dao-lock settlement-type; do
  cargo build --target riscv64imac-unknown-none-elf --release -p "$c"
done
```

## 2. Check the size before anything else

**All five binaries do not fit in one transaction.** They serialise to 616,768
bytes against a 597,000-byte block size limit, and the node refuses the whole
thing with `ExceededMaximumBlockBytes`.

`ckb-cli deploy gen-txs` does **not** catch this. It prices capacity, prints
`status: success`, and writes a signable info file for a transaction that
cannot be broadcast — so the constraint appears only after you have entered
your password. That is why the deployment is split in two, and why this check
runs first:

```sh
node tools/check-deploy-size.mjs deployments/dev-testnet-*.toml
```

Expect both to pass, at 64% and 39% of the limit:

```
  OK   dev-testnet-a.toml       2 cells  382,592 bytes  ≈ 384,392 serialized  (64.4% of the limit)
  OK   dev-testnet-b.toml       3 cells  232,912 bytes  ≈ 235,112 serialized  (39.4% of the limit)
```

## 3. Generate the transactions

Two configs, two info files, two migration directories. `gen-txs` signs and
sends nothing, so it is safe to re-run.

```sh
for part in a b; do
  mkdir -p "deployments/dev-migration-$part"
  ckb-cli --url "$CKB_URL" deploy gen-txs \
    --from-address "$ADDR" \
    --fee-rate 1000 \
    --deployment-config "deployments/dev-testnet-$part.toml" \
    --info-file "dev-deploy-$part.json" \
    --migration-dir "deployments/dev-migration-$part"
done
```

Expect, and stop if the totals differ:

```
part a: entry-shard-type 229445.0 + settlement-type 153269.0  -> 382714.0 CKB, fee 0.0038
part b: round-type 60141.0 + entry-lock 95453.0 + dao-lock 77501.0 -> 233095.0 CKB, fee 0.0023
```

615,809 CKB across the two, the same total as before the split.

## 4. Sign and send, one part at a time

Send part a, wait for it to commit, then part b. Sending both before the first
confirms risks the second selecting inputs the first already spent.

```sh
for part in a b; do
  ckb-cli --url "$CKB_URL" deploy sign-txs \
    --from-account "$LOCKARG" --info-file "dev-deploy-$part.json" --add-signatures
  ckb-cli --url "$CKB_URL" deploy apply-txs \
    --info-file "dev-deploy-$part.json" --migration-dir "deployments/dev-migration-$part"
done
```

A wrong password is harmless: it fails before signing, and nothing is sent.

## 5. Write the manifest

The client reads a schemaVersion 1 manifest; `ckb-cli` writes its own recipe
format. This bridges them so nobody hand-copies 32-byte hashes. Pass **both**
info files — the scripts are spread across two transactions.

```sh
node tools/manifest-from-deploy.mjs "$CKB_URL" dev-deploy-a.json dev-deploy-b.json \
  > deployments/dev-testnet-manifest.json
```

It refuses a cell carrying a type id, a missing script, and the same info file
passed twice.

## 6. Verify against the chain — required

This is the only check that proves the chain runs the code in this tree.
Comparing a manifest against a build proves nothing: on 2026-09-12 that exact
gap hid mainnet and testnet running *different builds of the same lock* while
every local check passed.

```sh
node tools/verify-deployment.mjs deployments/dev-testnet-manifest.json
```

Every script must report `OK`, and the exit code must be 0. The tool checks
three things agree: the binary in this tree, the data on chain, and the
manifest's `codeHash`.

### The tool is known to be able to fail

A verifier that cannot fail is indistinguishable from a broken one. Both
controls were run on 2026-09-18:

- **Positive.** Its hashes of all five local binaries reproduce the
  `data_hash` values `ckb-cli` computed independently in Rust — 5/5.
- **Negative.** Run against the superseded `deployments/testnet-manifest.json`
  it reports 0/5 and exits 1, naming a live cell whose binary differs from the
  local build and four cells that are no longer live. An empty manifest also
  exits 1, because verifying nothing is not a pass.

## 7. Point the client at it

```sh
python3 -m http.server 8931 --bind 127.0.0.1      # from the REPO ROOT
```

Then `http://127.0.0.1:8931/apps/web/dapp/index.html?manifest=/deployments/dev-testnet-manifest.json`.

Serve from the repository root, not `apps/web`: the page loads its manifest
from `/deployments/`. The `?manifest=` parameter accepts same-origin paths
only.

## Afterwards

- Record the result in a `docs/validation-*.md`, including anything that did
  not work (plan Task 12).
- `dev-deploy-a.json` and `dev-deploy-b.json` are operational scratch and are
  git-ignored. They carry no
  key material — only transactions and, after signing, signatures that become
  public on broadcast — but they are not project state.
- When gate 4 supersedes this, these five cells become reclaimable. Run
  `tools/audit-wallet-cells.mjs` and follow `docs/reclaim-testnet-capacity.md`.
