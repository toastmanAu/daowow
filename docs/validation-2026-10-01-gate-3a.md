# Validation — gate 3a and the refund path, 2026-09-24 to 2026-10-01

Spec `docs/superpowers/specs/2026-09-24-gate-3a-design.md`,
plan `docs/superpowers/plans/2026-09-25-gate-3a.md`.

Round `0xd15f6b5e968ec136…` was driven from a full entry set to a fully
unwound round, on testnet, one hand-signed transaction at a time.

## What is proven on chain

| step | transaction | result |
|---|---|---|
| TX-03 freeze | — | shard read `FROZEN` |
| ledger genesis | `0xe379e768…` | 318 CKB cell, 207 bytes of data |
| close | `0x2bfe6b56…` | `closed` flag `01` |
| TX-04 refund ×2 | `0xf8a717d5…` and one prior | 100,474 CKB returned, zero entry cells left |

**TX-05 aggregate is NOT proven on chain.** The round lapsed before it could
take a batch, so that path has only ever run against fixtures. It is the one
gap in this gate.

## Two predictions the spec made, and both held

**The ledger genesis is six CKB short of its own floor.** The shard cell
occupies 212 CKB and mints at 312; the ledger occupies 318. Against the real
frozen shard the builder reported a top-up of exactly 6 CKB. Both bounds are
computed independently because `ledger.rs:54` demands `out_cap >= in_cap`
separately from the floor.

**The DAO deposit takes the summed CELL capacity, not the principal.** Unproven
on chain for want of an aggregate, but pinned against the Rust oracle: 5,474
CKB against a 5,000 CKB principal in the fixture.

## Corrections this gate forced

### Freeze and genesis cannot be one transaction

The spec claimed the contract permitted either. It does not.
`AggregationState::new_bound` (`lifecycle.rs:99`) refuses an input shard whose
`state` is not already `FROZEN`, and the dispatch at `main.rs:101` routes on
data length alone — so a transaction spending an OPEN shard into a ledger cell
is decoded as a genesis and refused. `no_entry_inputs` forces genesis and
aggregate apart the same way. **Three transactions, each separated by its own
contract rule.**

Phill asked for one transaction; it was not implementable, and saying so with
the line numbers was the only useful answer.

### `close` was missing from the plan entirely

Not bookkeeping: `entry-lock`'s refund branch calls `excluded_membership`,
which returns false unless a **closed** ledger is a cell dep. Without it an
unaccepted entry's capacity is stranded. I had told Phill that letting a round
lapse would make its entries refundable — **it does not.** The round must be
frozen, its ledger created, and that ledger closed first, and only then can an
entry be released with an exclusion proof.

Closing has two deadlines (`lifecycle.rs:341`), which is the kind of detail a
guess gets wrong: a ledger that accepted every entry may close from
`entry_end`, one that did not must wait for `aggregation_deadline`.

### The refund path was unreachable and its tests were green over it

TX-04 pinned three of `entry-lock`'s five conditions and missed the two that
decide whether it works at all: the closed ledger as a cell dep, and the
exclusion proof in the witness. `isRefundable` checked only the deadline and
the builder emitted `witnesses: []`. Every refund it could build would have been
refused. The tests were wrong, not the code.

`refundBlocker` now returns the reason, because "not yet" has four causes and
the chain reports one code for all of them. The fourth — an entry inside the
closed prefix — is what stops a winner reclaiming their stake *and* keeping the
prize.

## The bug that only a live round could find

**THE LIVE CELL SET IS NOT THE ACCUMULATOR'S REPLAY SET.**

Found in the worst possible way: the first refund succeeded and the second
failed. The accumulator is append-only, so the frozen root commits to every
entry the shard ever took — but a refund SPENDS a cell, which removes it from
the indexer's live set while the root keeps counting it. Replaying the
survivors builds a different tree.

Measured rather than argued:

```
committed root        bded67e4e9a69025…
from LIVE cells  (1)  5446ba7a2e50293f…  MISMATCH
from HISTORY     (2)  bded67e4e9a69025…  MATCH
```

and the proofs follow — the live-cell proof fails verification against the
committed root, the history proof passes.

`shard-history.js` recovers the set from committed TRANSACTIONS: each entry
transaction consumed the previous shard head at input 0 and carried its entry
in the append witness, so walking input 0 backwards recovers everything
regardless of which cells survive. The parse is strict, because round
creation's witness is a `WitnessArgs` carrying the prize schedule and a loose
parse would invent entries out of it.

**The aggregate path had the same bug, latent.** A round where anyone refunded
before the keeper aggregated would have produced proofs for a different tree.
Phill's refund surfaced a bug in a path he was not using.

Proven on chain by the second refund: a 71-byte exclusion proof verified
against a tree containing an entry whose cell was already spent.

This is the third shape of one lesson. **The chain stores the accumulator's
ROOT and nothing else:** the peaks come from a witness, the proofs from a
replay, and the replay itself from witnesses rather than from cells.

## Four signing failures, and what each taught

Driving three transactions by hand cost seven signing attempts.

1. **`ckb-cli tx init` destroys a prepared file.** It creates an empty one. The
   instruction was in this repository's own tool output.
2. **`--skip-check` is required to SIGN, not only to send.** ckb-cli cannot
   classify the shard's public lock and refuses to sign at all, leaving an empty
   witness; sending that gets `-2 ERROR_ENCODING` from the secp lock. The
   checker caught this before the node did, which is the first time one of
   these guards got ahead of a broadcast.
3. **`ScriptNotFound` on the funding cell's own lock.** A lock runs when its
   cell is spent and needs its code as an explicit dep. The feedback log
   records this exact trap on 2026-09-17; knowing it did not prevent repeating
   it. Now `sponsor.lockDep` is REQUIRED by every builder.
4. **The round id is not free.** It must equal the Type ID derivation over the
   funding input. Verified three independent ways before being trusted.

## Method notes worth carrying

**The mutation round trip found five unpinned guards across tasks 2–7, and
every one was a fault in the tests rather than the code:** two tautologies
comparing a builder to the helper it calls, a field-order test blind because
shard 0 and batch 0 are both all-zero bytes, and a conservation test tripping
two disjuncts at once.

**Three of my own probes were invalid in ways that would have read as
results** — twice the `&&`/`||` precedence trap already in the feedback log,
once a 400 CKB threshold offset by 1,000 shannons. The harness now runs
`node --check` and prints NOT PINNED explicitly.

**ES-module caching made a correct fix look broken, twice.** The second time
cost a live debugging round. Fixed structurally: the module import carries a
content-hash cache buster, and the page now states its replay count so a user
can see whether their browser has the fix.

## Observation for mainnet, not a defect

A completed round leaves capacity permanently committed. `round-type`'s update
branch requires its data unchanged and a successor to exist, so the config cell
(531 CKB) can be moved but never consumed; a closed ledger may only be passed
through unchanged (318 CKB). That is roughly **849 CKB per round**, the price
of an immutable round record. Worth deciding deliberately rather than
discovering at scale.

## Still unproven

- **TX-05 aggregate on chain.** Fixtures only.
- **The draw, DAO maturity and settlement.** Gates 3b and 3c; 3c cannot start
  until 180 epochs after a deposit that has not yet been made.
- **A multi-entry batch**, and therefore the 32-entry bound.
- **The relay trust obligation** from the gate 2a spec: a redirect broker
  renders the preview a user approves while JoyID shows only a hash.
