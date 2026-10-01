# Gates 3b and 3c — the draw, and settlement, on two tracks

**Status:** design, awaiting approval
**Scope:** 3b = seal and entropy finalisation (the draw). 3c = the DAO phases,
settlement funding, payout and completion.
**Spec it supersedes nothing; it follows** `2026-09-24-gate-3a-design.md`.

## The finding that reframes both gates

**The protocol is already proven end to end on devnet, payout included.**
`tests/devnet/test_round_creation.py` is 1,151 lines that build every
lifecycle transaction against a real node — seal, entropy, both DAO phases,
settlement funding, batched payout, retirement — and
`tests/devnet/test_native_dao.py` crosses a genuine 180-epoch maturity,
asserting `Immature` before it and a matured payout after.

So neither gate is protocol work. **What does not exist is tooling a human can
drive**, which is what gate 3 was always about. That changes the risk profile
completely: we are not discovering whether the contracts work, we are building
an interface to contracts that do, and we have two oracles for it.

- `tests/integration/examples/devnet_round.rs` emits the **canonical bytes**
  for every stage.
- The Python devnet harness is a **working reference** for every transaction's
  shape.

The 3a experience says what to do with that: pin to an external oracle, never
to our own output. Every builder in these gates is byte-checked against the
exporter.

## The constraint that sets the shape

Phill wants the lifecycle demonstrably complete on public testnet **within
days**, and the DAO term is 180 epochs — about 30 days. Those cannot both be
satisfied on one round, so the work splits.

### Track A — public testnet, start the real clock

Round `0xa42e2888…` exists for this, with a 30-epoch aggregation window.

```
enter → freeze → genesis → AGGREGATE → close → seal → (≈34 min) → entropy
```

The aggregate is what creates the native DAO deposit and **starts the
180-epoch clock**, so every day it is delayed is a day added before testnet can
settle for real. It also closes gate 3a's one remaining gap: TX-05 has never
run on chain.

This track proves 3b live and leaves a real round maturing.

### Track B — devnet, prove 3c now

A devnet crosses 180 epochs in roughly **2,500 generated blocks**, which is
minutes. So 3c's builders are developed and proven there, against the existing
Python reference and the Rust exporter, and are ready for the testnet round
when it matures.

**Nothing in Track B counts as proving the protocol** — the devnet suite
already does that. Track B proves the TOOLING.

## 3b: two transactions, and no reveal

The transaction templates describe a TX-08 "Entropy Reveal". **There is no
reveal transaction.** `entry-shard-type`'s dispatch has exactly two paths here,
selected by the output data's first byte: `3` is a seal, `4` is an entropy
record. The participant-reveal model was superseded by the computed draw, and
`entropy_commitment` is zero in every round this client builds. The templates
are stale and the spec says so rather than implementing a ghost.

One cell carries all of it, evolving under one type script and one set of args:
**ledger (207 bytes) → seal (212) → entropy record (348)**.

### The seal

Input the CLOSED ledger, output a `RoundSeal`: `u8 3 | u32 LE shard count |
each ledger's 207 bytes`. Shard zero only — `args[32..]` must be zero — with
other shards' ledgers supplied as cell deps. No entry inputs, public lock both
sides, `out_cap >= in_cap`. The contract re-derives the seal and compares, so
the client computes nothing it is trusted on.

`RoundSeal::new` requires every ledger closed and bound to the commitment,
which is why close had to exist before this.

### Entropy finalisation, and its two sharp edges

Input the seal, output an `EntropyRecord`: the seal's bytes, then the
inclusion height, the inclusion hash, and three more hashes.

**The `since` is a RELATIVE BLOCK NUMBER, not an epoch.** `entropy.rs:52`
requires `since >> 56 == 0x80` and the low bits `>= 256`. Every other `since`
in this protocol is an absolute epoch with the `0x20` flag; this one is the
exception, and using the familiar form fails with `SHARD_ERROR_STATE` saying
nothing about metrics. So the seal cell must be **at least 256 blocks old** —
about 34 minutes — before the draw can be finalised.

**Exactly four header deps, in order.** Header dep 0 must be the seal's own
inclusion block, hash-checked against `load_header(0, GroupInput)`. Deps 1, 2
and 3 must be the blocks at inclusion **+64, +128 and +192**, checked by
number. A fifth header dep must be `IndexOutOfBound` — the contract refuses a
transaction carrying one. `entropy_heights` returns a fourth value, +256, which
is not a header dep: it is the earliest height at which the `since` can be
satisfied.

So the entropy transaction cannot be built until those blocks exist, and once
they do it can be built at leisure. There is no minute-scale window, which is
what makes hand-signing viable.

### The draw is derived, never stored

`ComputedDraw` takes the authenticated record and produces the winning
positions. Nothing writes a winner list to a cell. The seed is
`H("DAOWOW_DRAW_SEED_V1" || round_id || entry_universe_root || total_tickets ||
participant_entropy_root || chain_entropy_root)`, and `core.js` already
implements the seed, the candidate derivation and rejection sampling, pinned to
Rust vectors.

**This is a client capability, not a transaction.** 3b therefore delivers a
`draw` command that reads the record and prints who won, and the honesty
constraints from gate 2's D7 apply to its wording: the seed comes from four
block hashes fixed before the draw, which is not a VRF and must not be
described as one.

## 3c: four transactions and a month of waiting

### DAO phase one — deposit to withdrawing

Per `dao-lock`'s own header: for the input at absolute index `i`, **output `i`**
must keep the same capacity, the same native DAO type, the same DAOWOW lock —
no lock substitution — and carry the deposit's inclusion block number as eight
LE bytes. Index-for-index, which a builder that appends outputs will get wrong.

### DAO phase two — withdrawing to settlement funding

Every `dao-lock` input must be a withdrawing cell, and every output replacing a
DAO cell must be a settlement-type funding cell bound to the same round. The
native DAO type computes the compensation and enforces conservation; `dao-lock`
constrains only the destination. Header deps follow the native DAO's own
deposit-header and withdrawal-header requirements, and the `since` is an
absolute epoch at `deposit + periods × 180`.

**The 2026-06-16 lesson applies directly and is already recorded as a trap in
this project's feedback log: the DAO `since` is measured from the DEPOSIT, not
from the withdrawal.** A scanner that reads the withdrawing cell's own block
computes the wrong maturity.

### Settlement funding and batched payout

`SettlementFundingDataV3` is 160 fixed bytes carrying the realised total, the
principal liability, the prize pool, a payout cursor, and immutable liability
and prize roots with their counts. Created with `cursor = 0` and a positive
liability count.

Each payout authenticates the next unpaid ordinal with an **MMR proof against
the immutable liability root**, advancing the cursor exactly once per item.
The output is an ordinary cell — no type, empty data — under the participant's
own lock, with capacity at least principal plus prize **and** at least its own
occupied floor. Final consumption requires every index paid.

That is the accumulator's client-side cost for the **fourth** time: the peaks
on entry, the proofs on aggregation, the exclusion proof on refund, and now a
liability proof per payout.

### Completion

Optional, and must stay optional: TX-12's own template says completion must not
be required for participants to own or use already-paid CKB.

## Form, unchanged from 3a

CLI builders that emit unsigned ckb-cli tx files, plus a checker that
re-derives every rule from the finished bytes. Phill signs. No process holds a
key.

The builders are JavaScript rather than extensions of the Python harness, for
two reasons that are about more than consistency: the browser needs the draw
and, in gate 2c, claim redemption, and those need these codecs; and the Python
harness is a TEST fixture whose job is to be an independent reference. Making
it the operator tool would destroy the independence that makes it useful as an
oracle.

## Testing

Three layers, and the first is new to this gate.

1. **Against the Rust exporter.** `devnet_round.rs` emits canonical bytes for
   the seal, the entropy record and the settlement funding. Every JS codec is
   byte-checked against it, the way the ledger codecs were pinned to
   `gen_vectors`. A codec pinned only to its own round trip is not pinned.
2. **Dry run against a live chain.** `dry-run-lifecycle.mjs` gains the new
   steps. It found the sponsor-lock-dep seam on its first run in 3a and is
   written before the command it checks.
3. **Live.** Track A on testnet for 3b; Track B on devnet for 3c, with the
   180-epoch wait compressed.

Mutation probes per guard, with the `node --check` sanity step and an explicit
NOT PINNED report — 3a's probes found five unpinned guards and three of my own
probes were invalid without it.

## Non-goals

- Any browser interface for operators. These are CLI tools. The draw's
  *display* in the dApp is gate 2d.
- A keeper daemon or any process holding a key. Gate 4.
- Multi-shard rounds. The beta is one shard and `validate()` refuses a capped
  multi-shard round; the builders take `shard_id` but are exercised at zero.
- Claim redemption and retirement. Those are gate 2c, and the devnet suite
  already proves the contracts.
- Changing the transaction templates doc. It is stale about TX-08; noting that
  here is enough.

## Open questions for the plan

1. **Does Track A stop at entropy, or continue to DAO phase one?** Phase one
   can run any time after the deposit — it does not wait for maturity — and
   doing it early on testnet would prove one more transaction live. But it also
   fixes the withdrawing header early. The plan should decide on the protocol's
   terms, not convenience.
2. **How does the payout batch size get chosen?** Each item needs a proof and
   the witness is bounded against the 512 KiB script heap, which the 2026-09-16
   note says must be checked JOINTLY rather than per field. The plan should
   compute the bound rather than pick a number.
3. **What does the draw command print on a round below `minimum_tickets`?** A
   failed round pays no prizes but still returns principal, and the wording
   must not imply a draw happened.
