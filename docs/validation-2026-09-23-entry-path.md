# Validation — the entry path, 2026-09-23

Plan `docs/superpowers/plans/2026-09-22-dapp-entry.md`, Tasks 7 and 11.

## Task 7 was reported complete and was not

The plan's Task 7 is "the entry view, signing and broadcast". What shipped in
`b7c4fc7` was the view and the confirmation gate. **There was no submit handler
at all** — the button was inert, and the commit message did not say so. Recorded
here rather than quietly fixed in a later commit.

## Five seams between the pure layer and the live page

Wiring the button exposed five places where modules that each passed their own
tests disagreed with each other. Every one is silent until broadcast, and every
one is now pinned by a test.

| # | seam | what it would have done |
|---|---|---|
| 1 | discovery emitted the raw indexer out point `{tx_hash, index: "0x0"}`; everything downstream reads `{txHash, index}` | CCC sees `txHash: undefined` and builds against nothing |
| 2 | discovery carried no shard `capacity` | the successor cell built with `undefined` capacity |
| 3 | no way to obtain a shard's accumulator peaks at all | every entry after the first is unbuildable |
| 4 | `decodeRoundConfigV1` never produced `config.commitment`, which `buildEntryTx` reads | a hex parser receives `undefined` |
| 5 | the successor's type args are derived from the config, never checked against the head being spent | the head's type script appears in inputs and vanishes from outputs → `BadState` |

Seams 1, 2 and 5 are fixed at the discovery boundary, which is the only place
raw RPC enters the client. Seam 4 is fixed in the decoder, pinned to the Rust
oracle already in the vectors file rather than to our own output — the
commitment is what the *contract* computes, so reproducing it is the only thing
that counts.

**Seam 3 is the substantial one.** A shard cell commits to its accumulator ROOT
and nothing else, so the peak list a witness must carry is not on chain. Two
ways exist: replay every prior entry, or read `new_peaks` out of the append
witness that last moved the head. `apps/web/chain/shard-peaks.js` takes the
second — one RPC call instead of a walk, and the same bytes the contract
already validated.

Reading the node's copy is safe structurally rather than on trust: the peaks
must bag to the root the cell commits to, and that check runs locally against
the cell we already read. A node serving a stale or invented witness fails it.

**The test for that guard was shadowed on the first attempt.** The fixture used
the wrong *number* of tampered peaks, so the peak-count guard refused it first
and the bag check could be deleted with the suite green — the same shape as the
`rpcUrl` and non-decreasing-thresholds cases before it. Rewritten with the
right count; disabling the guard now reds that test and only that test.

## Task 11: what could be validated without a wallet, and what could not

Live validation needs a round on chain, and a round needs Phill's signature. So
`tools/dry-run-entry.mjs` was built first: it runs every step the browser runs
— discovery, schedule recovery and commitment verification, peak recovery, the
quote, the append transaction — against a real node, stopping at the only step
a human does.

With `--from-tx` it answers the question worth asking *before* anyone signs:
**will the dApp be able to enter the round this unsent transaction creates?** It
serves that transaction's outputs at the out points they will actually have
(the hash is computed from the transaction, not invented) and runs the
identical pipeline. The tip still comes from the real node, because the entry
window is in absolute epochs and a made-up epoch would prove nothing.

It found seam 4 on its first run — after discovery, the commitment check and
the quote had all passed.

Against the generated `create-round.json`, at testnet epoch 13877:

```
round       92af1ae1de607961…  open        entry epochs 13877..13883
schedule    v2, 5 places, thresholds 1, 8, 20, 50, 100  [commitment verified]
peaks       0 recovered and bagged to the committed root
quote       1 ticket  → 10,457 CKB   (10,000 principal + 220 claim + 237 entry)
            8 tickets → 81,997 CKB,  "Paying 2 places."
transaction 2 deps, 1 input, 3 outputs, 178-byte append witness
            witness/input balance holds — funding will append, not displace
```

The tiered table discriminates: one ticket pays one place, eight tickets pays
two. That is the v2 rule doing work a v1 schedule could not.

### Browser

Both pages load clean against the live deployment in Chromium: every module
publishes, node reached at epoch 13877, zero console errors, zero error boxes.
The entry form stays hidden because no round exists yet.

Adding `core.js` as a codec dependency broke `index.html`, which did not load
it. Caught here rather than by a visitor. A first browser check then reported
the new field as broken — it was a **cached `codec.js`**, and a fresh context
shows both pages clean. Worth recording in both directions: a stale asset makes
a working fix look broken, and would equally make a broken fix look fine.

## What is still unproven, and by whom

- **The round-creation transaction has not been accepted by a node.** The dry
  run proves the dApp can read the round it creates; it does not prove
  `round-type` accepts the creation. That costs a fee to find out, not
  principal. Round creation is gate 3's job; `tools/create-demo-round.mjs` is a
  stand-in and says so at the top of the file.
- **Nothing has been signed or sent.** No signature path in this repository is
  automated, by design.
- **The JoyID leg is untested end to end.** The wallet's `signEntry` and
  `broadcast` are structurally correct and unit-tested against the splice and
  balance hazards, but no real JoyID signature has been produced. The recorded
  relay trust obligation is also still open: a redirect broker renders the
  human-readable preview while JoyID itself shows only a hash.
- **The entering wallet needs funding.** One ticket costs **10,457 CKB**. The
  operator's ckb-cli wallet holds 121,956 CKB liquid; the JoyID wallet that
  would actually enter is a different wallet and its balance is unknown here.
- `audit-wallet-cells.mjs` and `reclaim-cells.sh` still disagree about
  `dao-lock` (carried over from 2026-09-20).

## To run the live leg

```bash
# 1. Create the round (Phill signs; the window is 6 epochs, ~a day)
node tools/create-demo-round.mjs deployments/dev-testnet-manifest.json \
  0x86cb7a8ebac06ec26099e7da062764a64be61b4fa763c4509f82adc18f3400be:2
ckb-cli --url http://192.168.68.134:8114 tx init --tx-file create-round.json
#   ... sign-inputs, send — see docs/deploy-dev-testnet.md

# 2. Confirm the dApp sees the committed round, with no --from-tx this time
node tools/dry-run-entry.mjs deployments/dev-testnet-manifest.json --tickets 1

# 3. Enter from the browser with JoyID
python3 -m http.server 8791 --bind 127.0.0.1     # from the repo root
#   http://127.0.0.1:8791/apps/web/dapp/entry.html
```
