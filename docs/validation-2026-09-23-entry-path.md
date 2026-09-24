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

## The round is on chain

`0xe4063f93552c36c7e277abaf8da5efdd8d0a97623c457ffd63379c1c68e8bea5`,
**committed** in block `0x72c2cb00edbc3da1…`. Round `0xd15f6b5e968ec136…`,
entry epochs 13881..13887, 10,000 CKB a ticket, minimum 5, maximum 10, one
shard, the tiered schedule.

Four signing attempts, four distinct failures, in the order they surfaced:
`tx init` wiping the prepared transaction; ckb-cli refusing the shard's
public-lock mode; `ScriptNotFound` on the funding cell's own lock; and `-17`
for an invented round id. Every one is now a guard in
`check-signed-round.mjs`, each with a control that reproduces the original
failure.

### The dry run against the committed round

```
rounds      1
round       d15f6b5e968ec136…  open        entry epochs 13881..13887
schedule    v2, 5 places, thresholds 1, 8, 20, 50, 100  [commitment verified]
peaks       0 recovered and bagged to the committed root
quote       1 ticket → 10,457 CKB
transaction 2 deps, 1 input, 3 outputs, 178-byte append witness
            witness/input balance holds — funding will append, not displace
            the shard head's lock has a cell dep — no ScriptNotFound on input 0
```

That last line is the entry transaction's version of the bug that cost two
signing rounds, and it is checked now rather than discovered.

### The browser, against the live round

`entry.html` in a fresh context, zero console errors, zero error boxes:

- **Round d15f6b5e · open**, 0 of 10 tickets sold
- quote renders four rows totalling **10,457 CKB** for one ticket
- payout table: 1st **paying**, 2nd **opens at 8 tickets**, 3rd–5th **not
  reachable in this round** — correct, since the thresholds are 20/50/100 and
  the cap is 10
- submit disabled, reading "Connect a wallet to enter"

Recomputing across ticket counts, live:

| tickets | total | places |
|---|---|---|
| 1 | 10,457 CKB | 1 |
| 8 | 81,997 CKB | 2 |
| 10 | 102,437 CKB | 2 |
| 11 | refused — "only 10 tickets remain in this round" | |
| 0 | refused — "at least one ticket" | |

The v2 table is discriminating on a live round: the second place opens at
exactly 8 tickets, which a v1 schedule could not express.

**One cosmetic finding.** On a refused ticket count the quote keeps displaying
the last valid total, so "102,437 CKB" sits above "at least one ticket". The
submit button is disabled and the note explains why, so nothing can be acted
on — but a money figure that no longer corresponds to the input is worth
clearing rather than leaving. Not fixed here; it is a UI change during a live
validation and belongs in its own commit.

## An entry, from a real wallet

`0x393b0067b86c3f94e6cc36df3dd06dd4e7ffc544adad74ca2a3f37656e352a93`,
**committed** in block `0x9a36978c803dbf4a…`. Five tickets, entered from JoyID
through the browser.

| output | capacity | |
|---|---:|---|
| 0 | 312 CKB | shard successor |
| 1 | 50,237 CKB | entry cell — 5 × 10,000 principal + 237 |
| 2–6 | 222 CKB each | five claim NFTs under the entrant's lock |
| 7 | 186,266 CKB | change |

Two inputs, and **witness 0 is still 178 bytes**: the append witness survived
`completeInputsByCapacity` and `completeFeeBy` at index 0, which is the hazard
`sign-entry.js` asserts against and the one this repository's feedback log
records most often. The invariant held against a real wallet. The entrant paid
51,347 CKB, exactly the quote.

### The peaks, recovered from a real shard

This is the design decision that had never been exercised on chain. A shard
cell commits to its accumulator ROOT only, so a second entrant must obtain the
peak list some other way — and this client reads `new_peaks` out of the append
witness that last moved the head rather than replaying every prior entry.

Against the shard as it now stands:

```
shards      1, 5 tickets sold
peaks       1 recovered and bagged to the committed root
ticket   5  0xac3e7f6d…
ticket   6  0x897eaf31…
ticket   7  0x783d3864…
            witnesses 1, append witness 210 bytes
```

The peaks came out of the live entry transaction's witness and bagged to the
root the cell carries. Ticket positions continue from 5. The witness grew from
178 to 210 bytes because `old_peaks` is no longer empty. And at 5 + 3 tickets
the tiered table opens its second place.

## The page went stale after sending, and now does not

Reported from the live run: after the entry committed, the page still read
"0 of 10 tickets sold". It was not a missing watch service — the page simply
never looked again.

`apps/web/chain/confirm.js` adds two waits, and they are two different things:

1. **the transaction reaching `committed`**, which the node reports directly
2. **the INDEXER catching up to that block**, which it does on its own schedule

Skipping the second is the subtler trap and this repository has met its cousin
before: `get_cells` against a tip the indexer has not reached answers about the
world as it was *before* the transaction, **with no error at all**. A client
that re-reads the instant a send returns renders stale state and looks broken
in exactly the way it just did.

The refresh re-reads the round from chain rather than doing arithmetic on what
it just sent — a client that predicts the new state is a client that can be
wrong about it.

Honesty holds at each step. A send reports "Sent"; only the node's own
`committed` produces "Committed in block N". A timeout says **this page has
stopped watching** rather than claiming failure, because the transaction may
still land and the chain did not stop working. A `rejected` status raises
immediately instead of being polled through, since the node will not change its
mind and a spinner would be a lie.

Six tests, with the clock injected so a timeout is reached by the code asking
for it rather than by the suite waiting.

Confirmed in the browser against the live round: **5 of 10 tickets sold**.

## What is still unproven, and by whom

- ~~The round-creation transaction has not been accepted by a node.~~ Done.
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

## `ckb-cli tx init` destroys a prepared transaction

The first attempt to create the round ran the command this document told Phill
to run, reported success, and produced no round. **`ckb-cli tx init` CREATES an
empty transaction file.** It does not load one. It overwrote the prepared
transaction with `{"transaction": {…all empty…}}` and exited 0.

The instruction was wrong in `tools/create-demo-round.mjs`'s own output and
repeated here. `docs/deploy-dev-testnet.md` is not wrong — there `tx init`
begins a transaction that `add-input`/`add-output` then build, which is what
the subcommand is for. It is only wrong for a transaction that already exists.

`create-demo-round.mjs` now writes ckb-cli's tx-file format directly, so the
flow goes straight to `sign-inputs` with no `tx init` at all. `ckb-cli tx info`
reads the result and resolves it correctly: 121,956.739 CKB in, three outputs,
0.1 CKB fee.

## The witness the signature shares with the schedule

Fixing that surfaced a second problem in the same file, and this one would have
been much harder to see.

`creation_schedule` loads **witness 0** and reads `WitnessArgs.output_type`
(`crates/daowow-contracts-common/src/lib.rs:66`). Witness 0 is also where the
signature goes. The generator was writing a `WitnessArgs` with `output_type`
and **no `lock` field at all**, leaving a signer to invent that field — and a
signer that rebuilds the witness rather than filling its lock in place would
drop the schedule.

It now carries a 65-byte zero lock placeholder beside the schedule, which is
exactly the shape the integration harness builds
(`tests/integration/tests/common/mod.rs:171`). Under RFC 0019 the digest is
computed with the lock zero-filled to its final length and every other field
intact, so writing the signature into that slot is the correct operation and
preserves `output_type`.

**ckb-cli signs in two stages, and it does the right thing.** `tx sign-inputs
--add-signatures` does not touch witness 0 at all: it records the signature in
the file's `signatures` map and leaves the witness as written, lock still
zero-filled. `tx send` assembles the final witnesses from that map. So the
first version of the checker reported "not signed yet" over a file that was
signed — it was looking in the wrong place.

That it does the right thing is now **proven rather than assumed.**
`check-signed-round.mjs` recomputes the RFC 0019 sighash-all digest over the
witness as stored — the one carrying the schedule — and recovers the public key
from the signature:

```
  ok  signature recorded for 0xa776bf02d1… (ckb-cli assembles it into witness 0 at send)
  ok  signature VERIFIED against the witness carrying the schedule —
      any assembly that drops it would invalidate this signature
  ok  schedule intact: v2, 5 places, thresholds 1, 8, 20, 50, 100
  ok  commitment matches the config cell
```

The recovery matching the signer's lock hash means ckb-cli computed the digest
over `output_type` too. An assembly step that dropped the schedule would
therefore produce a signature the node rejects — the failure mode is closed by
the signature itself, not by our checking.

**Positive control**, per the 2026-09-12 lesson that a verifier which cannot
fail proves nothing: flipping one byte of the schedule region breaks both the
recovery (`got 0x504c92e8…`) and the commitment comparison. The verifier bites.

And it would have failed closed anyway. `contracts/round-type/src/main.rs:70`
refuses creation with `ROUND_ERROR_CONFIG` when `creation_schedule` returns
`None`, so a dropped schedule is a rejected transaction, never a round on chain
that cannot pay out.

## `ScriptNotFound` on the funding cell's own lock

The send was refused:

```
Verification failed Script(TransactionScriptError { source: Inputs[0].Lock,
  cause: ScriptNotFound: code_hash: Byte32(0x9bd7e06f…) })
```

The transaction carried deps for `round-type` and `entry-shard-type` — the two
scripts it creates — and none for the lock on the cell it SPENDS. **A lock runs
when its cell is consumed, and the node needs that lock's code as an explicit
cell dep even on a spend where nothing else runs.**

This repository's own feedback log records the identical trap on 2026-09-17,
from the other direction: `ckb-testtool` makes every deployed binary available
with no cell-dep bookkeeping at all, so a green mock suite says nothing about
it. Knowing the lesson did not prevent repeating it — the generator only
thought about the scripts it was creating.

`tools/lock-deps.mjs` resolves the dep from the chain rather than a table of
magic out points, so it works on devnet, testnet and mainnet alike. **It prefers
dep GROUPS, and that ordering is load-bearing rather than tidy:**
`secp256k1_blake160_sighash_all` is a bare code cell in genesis tx0, but the
lock also loads the `secp256k1_data` table from a second cell, and bundling both
is the entire reason the group in genesis tx1 exists. A first version returned
the code cell because it came first in the scan — a dep that satisfies
`ScriptNotFound` and then fails inside the lock instead.

Resolved on this node to `0xf8de3bb4…:0 (dep_group)`.

`check-signed-round.mjs` now refuses a transaction whose inputs' locks have no
dep, resolving dep groups to check. Control: removing the dep group from the
signed file produces

```
  FAIL  input 0's lock (code_hash 0x9bd7e06f3ecf4be0…) has NO cell dep providing
        it; the node will refuse this with ScriptNotFound on Inputs[0].Lock
```

— the same code hash the node named. The check needs a node, so it reports
SKIPPED rather than passing when one is unreachable; a check that silently
passes when it could not run is worse than no check.

The dry run gained the same check for the shard head's lock, which is the one
`buildEntryTx` owns. The entrant's own lock dep comes from the wallet's
`prepareTransaction`, so it stays unverified until a real signature exists.

**Adding a cell dep changes the raw transaction, so the previous signature is
void.** `create-round.json` is regenerated and must be signed again.

## `-17` on the config cell: the round id is not free

With the lock dep in place the send got further, and `round-type` itself
refused it:

```
Outputs[0].Type, cause: ValidationFailure: error code -17
```

`-17` is `ROUND_ERROR_CONFIG`, and it covers **every** failure in round-type's
creation branch, so the node's answer cannot say which rule broke. Two rules
were candidates; one was violated.

**The round id must equal the Type ID derivation over the funding input:**

```rust
ckb_hash256(&[CellInput(input 0).as_slice(), &(config_output_index as u64).to_le_bytes()])
```

(`daowow-contracts-common/src/lib.rs:54`, checked at
`contracts/round-type/src/main.rs:67`.) That is what makes a round id unique to
the cell that funded it — a second round cannot claim the same identity without
spending the same cell. `create-demo-round.mjs` was inventing one from a
string.

The correct value was derived **three independent ways** before being trusted,
per the 2026-08-15 lesson that a cross-language derivation must be pinned to
something other than itself: CCC's `hashTypeId`, a hand-rolled molecule struct
(`CellInput` is a struct — bare concat, 8 + 32 + 4 = 44 bytes), and Python's
`blake2b(person=b"ckb-default-hash")`. All three give
`0xd15f6b5e968ec136…`, and the CCC and hand-rolled `CellInput` bytes match
byte for byte.

`tests/integration/tests/round_validation.rs:61` derives it the same way, so the
contract's creation path **was** tested — this tool was simply the only thing
that did not follow the rule.

## Both creation rules now checked locally

`tools/round-rules.mjs` ports the round-id derivation and `RoundConfigV1::validate`
(`encoding.rs:192`) so a broadcast is not the thing that discovers a bad config.
It returns *reasons*, not a boolean, because naming the rule is the entire point
when the chain says only `-17`. `create-demo-round.mjs` re-derives from the
FINISHED transaction rather than from the variables that built it — reading what
is actually being sent is the only way that check could have caught this — and
`check-signed-round.mjs` runs both.

Controls, one per guard:

- Restoring the invented round id reproduces the transaction the node refused,
  and the checker names the reason: `config says 7b37556f…, input 0 with config
  output 0 gives d15f6b5e…`.
- Setting `entry_start` past `entry_end` yields `the windows are out of order`.

A port drifts, so `apps/web/test/round-rules.test.js` pins each rule to the
Rust line it came from — including the two guards `encoding.rs:211-214`
deliberately keeps separate with a review ruling saying not to merge them. Each
is pinned by a case only it can refuse, so merging them would red a test rather
than silently make one unreachable.

## `tx send` needs `--skip-check`, and that is not a shortcut

ckb-cli refuses the transaction with:

```
Output(no.2) invalid lock script code_hash: 0x60052a7b…, hash_type: data1, args.length: 1
```

That is the **entry shard cell**, and its lock is correct: `entry-shard-type` in
its public-lock mode, one zero byte of args — the same mode
`is_public_settlement_lock` documents and the same lock `buildEntryTx` gives
every successor. ckb-cli only knows how to classify sighash and multisig locks
and refuses what it cannot name. The check is ckb-cli's own; the node still
validates every script in full.

## To run the live leg

```bash
# 1. Create the round. Do NOT run `tx init` — it would overwrite this file.
node tools/create-demo-round.mjs deployments/dev-testnet-manifest.json \
  0x86cb7a8ebac06ec26099e7da062764a64be61b4fa763c4509f82adc18f3400be:2

ckb-cli --url http://192.168.68.134:8114 tx info --tx-file create-round.json
ckb-cli --url http://192.168.68.134:8114 tx sign-inputs --tx-file create-round.json \
    --from-account 0xa776bf02d19cafa3749d906cc2c9ab1cf1e80ff7 --add-signatures

# 2. Check the schedule survived signing. This fails closed.
node tools/check-signed-round.mjs create-round.json

ckb-cli --url http://192.168.68.134:8114 tx send --tx-file create-round.json --skip-check

# 3. Confirm the dApp sees the committed round, with no --from-tx this time
node tools/dry-run-entry.mjs deployments/dev-testnet-manifest.json --tickets 1

# 4. Enter from the browser with JoyID
python3 -m http.server 8791 --bind 127.0.0.1     # from the repo root
#   http://127.0.0.1:8791/apps/web/dapp/entry.html
```
