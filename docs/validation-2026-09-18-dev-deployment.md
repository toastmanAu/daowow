# Validation — dev deployment and read-only client, 2026-09-18

Gate 2a, plan Task 12. Records what was run, what it produced, and what it
does **not** cover.

## The deployment

Five contracts deployed to testnet as plain, data-hash-pinned code cells from
`ckt1qzda0cr08m85hc8jlnfp3zer7xulejywt49kt2rr0vthywaa50xwsqd8w6ls95vu473hf8vsdnpvn2cu785qlac0rckws`.
Superseded by gate 4; its purpose is to make the client demonstrable and to
surface RPC, indexer and pool behaviour early.

| contract | code hash (= data hash) | out point |
|---|---|---|
| round-type | `0xdc1722489533499ac4e709f4be657926792e663183141f08bbf3571b23d5a36d` | `0xb536d389…:0` |
| entry-shard-type | `0x6afa519d839d3e4f04d029d901ed4b6ff7ceb9158a6fdad4c0d9a78cbb5efd89` | `0x41169f0d…:0` |
| entry-lock | `0x48ce84d836d7999013d9af50cf78abcf15ddd816c49ac20551d1ee0e5a769ded` | `0xb536d389…:1` |
| dao-lock | `0x0cb1229acee4a8555c97224f1905ab43f70783e5d37924bdd431394790e543bd` | `0xb536d389…:2` |
| settlement-type | `0x3114256db914c9f0d23d2807514069c83a1fe21c7c93f3e4a0f91c75c1beed2f` | `0x41169f0d…:1` |

Both transactions committed: `0x41169f0ddebfa99108e4fcb591bd247e5212ef500207e5a2ea52aa0b7137d0f2`
and `0xb536d389344447adb6bcddda348a87e0432fc117f4c5419b08bc5bedd0296e41`.
615,809 CKB across the two. Manifest:
`deployments/dev-testnet-manifest.json`.

`tools/verify-deployment.mjs` reports **5/5, exit 0**: for every script the
binary in this tree, the data on chain and the manifest's `codeHash` agree.
That is the only check proving the chain runs the code that is readable here.

## Three failures on the way, and what each cost

Recorded because each was a dry run that validated one property and was read
as validating all of them. None of them lost funds.

1. **Missing `--url`.** Every `ckb-cli` call went to `127.0.0.1:8114`, where
   nothing is listening. `--url` is global and goes before the subcommand, and
   `deploy gen-txs` and even `init-config` need it.
2. **`ExceededMaximumBlockBytes`.** All five binaries in one transaction
   serialise to 616,768 bytes against a 597,000-byte limit. `gen-txs` prices
   capacity, prints `status: success` and writes a signable info file for a
   transaction the node refuses, so the constraint appeared only after the
   password prompt. Fixed by splitting into two configs, and
   `tools/check-deploy-size.mjs` now refuses anything above 90% of the limit
   before signing.
3. **`PoolRejectedRBF`.** Part b was generated before part a committed, so it
   selected four of the same input cells and conflicted with part a in the
   mempool. **Not a fee problem** — raising the fee is the wrong cure;
   regenerating against current chain state is the right one. The procedure
   had warned about this and then contradicted itself with a loop that sent
   both back-to-back; it is now strictly sequential with an explicit
   input-overlap check.

## Client against the deployment

Served from the repository root and loaded at
`/apps/web/dapp/index.html?manifest=/deployments/dev-testnet-manifest.json`,
in Chromium against the wyltek-10700 node:

- manifest parsed, `network: ckb_testnet`
- node reached at `http://192.168.68.134:8114`, tip epoch **13847**
- CSP permitted the LAN node, so no proxy is needed in development
- round discovery ran with **zero console errors** and **zero error boxes**
- result: no rounds found

**"No rounds found" is a real result but a weak one.** It proves the manifest,
RPC, indexer and paging paths work end to end against contracts we deployed;
it does **not** prove that a round decodes correctly, because none exists on
testnet yet. Creating one is operator work belonging to gate 3.

## Node facts confirmed

- wyltek-10700 (`http://192.168.68.134:8114`) is synced in lockstep with the
  public chain, serves the `Indexer` module, and returns
  `access-control-allow-origin: *` — so the browser can call it directly.
- `https://testnet.ckb.dev/rpc` also serves `access-control-allow-origin: *`
  and `get_indexer_tip`. Running the wallet audit against both produced
  identical figures, which makes the analysis a two-node cross-check rather
  than one endpoint's opinion.

## Devnet leg

The devnet is where a round actually exists, so it is what proves round
decoding against genuine cell data. `tests/devnet/test_round_creation.py` now
queries the indexer for the round-type script after creating a round, asserts
exactly one 358-byte cell is returned at the expected out point, and captures
it as `apps/web/test/fixtures/devnet-round-cell.json` so the JavaScript
decoder is pinned to a round this suite really created.

This needs the `Indexer` rpc module, which the pinned image does not enable by
default — `node_harness` patches the module list, and
`test_node_harness.LiveNodeTests.test_indexer_rpc_module_is_enabled` proves
the patch took effect.

### Result — 17/17, 1,483s

- **8 rounds discovered through the indexer**, one per history, each a
  358-byte cell returned at the out point the round was created at. The
  indexer path the client depends on therefore works against a real chain, not
  only against captured pages.
- The captured cell is decoded by `apps/web/test/discovery.test.js` with the
  production decoder. Its sharpest assertion costs nothing: the round-type
  script's **args are the round id**, and the indexer matched on them to find
  the cell, so the decoded round id must equal the args the node itself used.
  A decoder reading the id from the wrong offset disagrees with the node's own
  matching. Shifting the offset by one byte reds both this test and the Rust
  oracle test — two independent sources.
- **5 premature-winner retire refusals**, every one reporting
  `error code -99` (CLAIM_ERROR_INCOMPLETE), unchanged by this work.

This closes the gap the testnet leg leaves open. Every other decoder test
proves the JavaScript agrees with the *encoder*; this proves it agrees with
what a node actually serves.

**One failure on the way, mine.** The first run errored in 8 histories with
`'PosixPath' object is not subscriptable`. The capture step named its variable
`fixture`, which is already the genesis fixture cell in that 1000-line
function, so every later `fixture["lock"]` read broke. Plain shadowing from
introducing a name into a long function without checking what was already
bound. Renamed, and the rename carries a comment saying why the obvious name
is wrong there.

## Not covered

Stated plainly rather than left to inference:

- No round exists on testnet, so the testnet leg proves discovery finds
  *scripts*, not that it renders a round.
- Nothing in gate 2a signs, builds or sends a transaction. Entry, transfer,
  redemption and retirement are 2b and 2c.
- The JoyID connection was never exercised against a real wallet: it needs a
  browser with a passkey, and the module is constructed for its address only.
- `universe > 1` arithmetic remains integration-only on a live chain; the
  devnet round accepts a single batch.
