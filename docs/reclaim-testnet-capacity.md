# Reclaiming testnet capacity before the dev deployment

Measured 2026-09-18 against `https://testnet.ckb.dev/rpc`.

## Why this is on the critical path

Deploying DAOWOW's five contracts as plain code cells costs **615,809 CKB**
(see `docs/deploy-dev-testnet.md`). The deployer address holds **1,391,878 CKB
across 140 live cells**, but only **605,748 CKB of that is liquid** — roughly
**10,000 CKB short** of the deployment. The rest is locked inside cells that
carry data: old deployed binaries and Type ID deployments.

So reclaiming is not housekeeping. Without it the deployment cannot be funded.

## What was measured

`tools/audit-wallet-cells.mjs` classifies every live cell under the address and,
for each deployed binary, searches the **whole chain** in prefix mode — every
live cell under any owner, as both type script and lock — not merely this
wallet's own cells. A binary this wallet no longer references may still be a
dependency of somebody else's live cell, and consuming it would strand them.

```sh
node tools/audit-wallet-cells.mjs ckt1qzda0cr08m85hc8jlnfp3zer7xulejywt49kt2rr0vthywaa50xwsqd8w6ls95vu473hf8vsdnpvn2cu785qlac0rckws
```

| bucket | cells | CKB |
|---|---:|---:|
| plain capacity (liquid) | 7 | 605,748 |
| deployed code cells | 16 | 365,016 |
| Type ID deployments | 7 | 388,378 |
| other typed cells | 110 | 32,736 |

### What `UNUSED` does and does not mean

It means **no live cell carries that code hash right now**. It does not promise
none ever will. Consuming a code cell is irreversible: if the binary is wanted
again it must be redeployed, at full capacity cost, under a new out point.

## Recommended: reclaim the plain code cells only — 217,522 CKB

Two complete deployments are dead. Reclaiming both takes liquid capacity from
605,748 to **823,270 CKB**, comfortably covering the 615,809 deployment.

### Transaction 1 — `0xa4d1e1e8…`, five cells, 78,649 CKB

Every one of these five is unreferenced anywhere on chain. Do this one first:
it is the smaller blast radius and it rehearses the procedure.

| out point | CKB |
|---|---:|
| `0xa4d1e1e8b9a672a53a273889cd43599d2390320d3621e84f40f12fc46cf199fe:0` | 15,981 |
| `0xa4d1e1e8b9a672a53a273889cd43599d2390320d3621e84f40f12fc46cf199fe:1` | 19,077 |
| `0xa4d1e1e8b9a672a53a273889cd43599d2390320d3621e84f40f12fc46cf199fe:2` | 9,397 |
| `0xa4d1e1e8b9a672a53a273889cd43599d2390320d3621e84f40f12fc46cf199fe:3` | 22,613 |
| `0xa4d1e1e8b9a672a53a273889cd43599d2390320d3621e84f40f12fc46cf199fe:4` | 11,581 |
| **total** | **78,649** |

### Transaction 2 — `0x9916a7a7…`, five cells, 138,873 CKB

Three are unreferenced. The other two (`:2` and `:4`) are **byte-identical** to
cells in the live `0x247e78e1…` set, so they are exact duplicates: the content
survives in the other deployment whatever happens here.

| out point | CKB | status |
|---|---:|---|
| `0x9916a7a720e61e15b57c59c7500780d2b3e0d4c21101b96e4ba32d388801c47b:0` | 29,413 | unreferenced |
| `0x9916a7a720e61e15b57c59c7500780d2b3e0d4c21101b96e4ba32d388801c47b:1` | 33,509 | unreferenced |
| `0x9916a7a720e61e15b57c59c7500780d2b3e0d4c21101b96e4ba32d388801c47b:2` | 17,125 | duplicate of `0x247e78e1…:2` |
| `0x9916a7a720e61e15b57c59c7500780d2b3e0d4c21101b96e4ba32d388801c47b:3` | 37,605 | unreferenced |
| `0x9916a7a720e61e15b57c59c7500780d2b3e0d4c21101b96e4ba32d388801c47b:4` | 21,221 | duplicate of `0x247e78e1…:4` |
| **total** | **138,873** | |

`0x9916a7a7…` and `0x247e78e1…` deployed the same five-contract shape — two
binaries byte-identical, three recompiled — and only the newer set is
referenced. `0x247e78e1…` supersedes `0x9916a7a7…`.

This is inferred from shape, not from deployment records. **Confirm against
what you know these projects are before sending.**

## Do not touch

| what | CKB | why |
|---|---:|---|
| `0x247e78e1…` all five | 138,873 | live, referenced |
| `0x37a2df05…:0` | 8,621 | used by 3+ live cells |
| Type ID `0x1074b1ac…:3` | 78,630 | used by 5+ |
| Type ID `0x87722bff…:0` | 2,398 | used by 4+ |

### The five unused Type ID cells — 307,350 CKB, confirm before acting

`0x1074b1ac…:0`, `:1`, `:2`, `:4` and `0x39b1c11e…:2` report no users. They are
deliberately excluded from the recommendation above.

A Type ID cell is an **upgradeable identity**, not just a binary. Consuming one
destroys that identity permanently: anything that was ever meant to upgrade
under it never can again, and unlike a plain code cell it cannot be recreated —
a fresh Type ID is a different id. That is a materially heavier loss than
reclaiming a data-hash-pinned binary, and the reclaim is not needed to fund the
deployment. Leave them until you have confirmed what they belong to.

## The commands

`ckb-cli` 2.0.0. Flags below were checked against that version's `--help`;
confirm again if yours differs.

`ckb-cli wallet transfer` selects its own inputs and will not target these
cells, so the transaction is built by hand with the `tx` subcommands.

**No key material belongs in this repository.** Use an account already imported
into your `ckb-cli` keystore (`--from-account`), or a key file kept outside the
repo (`--privkey-path`). The lock arg for this address is
`0xa776bf02d19cafa3749d906cc2c9ab1cf1e80ff7`.

### Transaction 1

```sh
ADDR=ckt1qzda0cr08m85hc8jlnfp3zer7xulejywt49kt2rr0vthywaa50xwsqd8w6ls95vu473hf8vsdnpvn2cu785qlac0rckws
TX=0xa4d1e1e8b9a672a53a273889cd43599d2390320d3621e84f40f12fc46cf199fe

ckb-cli tx init --tx-file reclaim-1.json
for i in 0 1 2 3 4; do
  ckb-cli tx add-input --tx-file reclaim-1.json --tx-hash "$TX" --index "$i"
done

# 78,649 in, less a 0.1 CKB fee.
ckb-cli tx add-output --tx-file reclaim-1.json \
  --capacity 78648.9 --to-sighash-address "$ADDR"

# READ THIS BEFORE SIGNING: five inputs, one output, and the difference
# between them is the fee. A mistyped capacity is burned, not refunded.
ckb-cli tx info --tx-file reclaim-1.json

ckb-cli tx sign-inputs --tx-file reclaim-1.json \
  --from-account 0xa776bf02d19cafa3749d906cc2c9ab1cf1e80ff7 --add-signatures
ckb-cli tx send --tx-file reclaim-1.json
```

### Transaction 2

Only after transaction 1 has confirmed and the audit below reflects it.

```sh
TX=0x9916a7a720e61e15b57c59c7500780d2b3e0d4c21101b96e4ba32d388801c47b

ckb-cli tx init --tx-file reclaim-2.json
for i in 0 1 2 3 4; do
  ckb-cli tx add-input --tx-file reclaim-2.json --tx-hash "$TX" --index "$i"
done

# 138,873 in, less a 0.1 CKB fee.
ckb-cli tx add-output --tx-file reclaim-2.json \
  --capacity 138872.9 --to-sighash-address "$ADDR"

ckb-cli tx info --tx-file reclaim-2.json
ckb-cli tx sign-inputs --tx-file reclaim-2.json \
  --from-account 0xa776bf02d19cafa3749d906cc2c9ab1cf1e80ff7 --add-signatures
ckb-cli tx send --tx-file reclaim-2.json
```

Keep `reclaim-1.json` and `reclaim-2.json` out of the repository. They contain
no secrets, but they are throwaway operational state.

## Verifying it landed

Re-run the audit. Do not judge by the balance alone — the total capacity barely
moves, because reclaiming converts locked capacity into liquid capacity rather
than creating any.

```sh
node tools/audit-wallet-cells.mjs ckt1qzda0cr08m85hc8jlnfp3zer7xulejywt49kt2rr0vthywaa50xwsqd8w6ls95vu473hf8vsdnpvn2cu785qlac0rckws
```

Expected after both transactions:

| line | before | after |
|---|---:|---:|
| liquid now | 605,748 | **823,270** |
| reclaimable from code | 217,522 | 0 |
| deployed code cells | 16 cells | 6 cells |

`reclaimable from code` reaching 0 is the check that matters: it means nothing
dead is left behind, measured the same way it was measured before.
