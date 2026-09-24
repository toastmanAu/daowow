# Gate 3a — freezing a round and aggregating it into the DAO

**Status:** design, awaiting approval
**Scope:** TX-03 (freeze shard), the ledger genesis, and TX-05 (aggregate an
entry batch into a native Nervos DAO deposit).
**Not in scope:** the draw (3b), DAO maturity and settlement (3c), and anything
in the browser. See *Non-goals*.

## Why this gate exists, and why now

Two rounds have been entered on testnet and neither can move. A round that
fills is not a round that progresses: nothing in this repository can freeze a
shard, and nothing can turn accepted entries into the DAO deposit whose yield
funds the prizes. Gate 2 built the participant's half of the protocol. This is
the half that makes their entry mean something.

The forcing detail is that **the DAO term is 180 epochs, about thirty days on
this testnet.** Everything downstream of the deposit waits a month. So the
deposit has to be reachable early or the whole lifecycle cannot be proven
inside any reasonable schedule, and that is what makes freeze-and-aggregate the
right first slice rather than an arbitrary one.

## Form: CLI tools that emit unsigned transactions

Approved in conversation, and it follows a standing constraint rather than a
preference: **Phill signs everything; no key material enters this repository or
any agent's hands.** Each transaction gets a builder that writes ckb-cli's
tx-file format and a checker that re-derives every rule from the finished
bytes, in the shape `create-demo-round.mjs` and `check-signed-round.mjs`
already take.

That pattern is not ceremony. Creating one round cost four signing attempts —
`tx init` destroying the prepared file, an unclassifiable output lock, a
missing cell dep for the funding cell's own lock, and an invented round id —
and every one of them is now a guard with a control that reproduces the
original failure. Freeze and aggregate will have their own; the point of the
checker is that Phill finds out before signing rather than after.

A daemon is what a real deployment eventually needs, because some steps are
permissionless and someone must actually run them. That is gate 4's problem and
is explicitly deferred.

## The lifecycle this gate implements

```
  OPEN shard  ──TX-03 freeze──▶  FROZEN shard
                                      │
                                      │ ledger genesis (consumes the frozen shard)
                                      ▼
                            AggregationState (207 bytes, 0 accepted)
                                      │
                                      │ TX-05, repeatable, ≤32 entries per batch
                                      ▼
                            AggregationState (n accepted)  +  DAO deposit  +  receipt
```

The frozen shard and the ledger **share a type script and its args**
(`commitment ‖ shard_id`, 36 bytes), so the genesis is one script group in
which a 101-byte shard cell becomes a 207-byte ledger cell. `ledger.rs`
distinguishes them by decoding the input data: if it parses as
`EntryShardDataV1` this is the genesis, and the output must equal
`AggregationState::new(cfg, frozen)` exactly.

### TX-03 Freeze

Input 0 is the OPEN shard head with `since` set to an absolute epoch at or
after `entry_end`. Output 0 is byte-identical except `state` 0 → 1: round id,
shard id, sequence, entry count, ticket count, principal total and accumulator
root must all be preserved (`validate_freeze`, `shard.rs:132`). No claim cells
may appear. Cell deps: the entry-shard-type code cell and the round config
cell. Permissionless — anyone may freeze after the deadline, paying the fee.

### Ledger genesis

Consumes the FROZEN shard, produces the 207-byte `AggregationState`. The
contract recomputes `AggregationState::new` itself and compares, so the client
computes nothing it is trusted on. `no_entry_inputs` forbids entry cells in
this transaction — genesis and acceptance are separate steps by construction.

**This step needs a capacity top-up, and the numbers are tight.** A shard cell
occupies 8 + 101 + 34 + 69 = **212 CKB**; the ledger cell occupies
8 + 207 + 34 + 69 = **318 CKB**. The demo round's shard carries 312 CKB, so the
genesis is **6 CKB short of its own floor** and the contract separately requires
`out_cap >= in_cap`. A sponsor input must cover the difference. This is the
2026-09-16 lesson — cell floors bind transaction order — arriving exactly where
that lesson predicts, and the builder must compute the floor rather than assume
the shard's capacity carries over.

### TX-05 Aggregate a batch

Inputs: the ledger cell, between 1 and 32 entry cells, and a fee sponsor.
Outputs, all three required (`ledger.rs`, `validate_aggregation`):

| output | script | data | capacity |
|---|---|---|---|
| ledger successor | type entry-shard-type, args `commitment ‖ shard_id`, public lock | `next.encode()`, 207 bytes | ≥ the input ledger's |
| DAO deposit | lock `dao_lock` args `round_id ‖ batch_id ‖ commitment ‖ digest` (104 bytes), type the native DAO | eight zero bytes | **exactly** `batch.input_capacity` |
| receipt | type entry-shard-type, args `2 ‖ commitment ‖ shard_id ‖ batch_id ‖ digest` (77 bytes), public lock | empty | its own floor, ~152 CKB |

`batch.input_capacity` is the **sum of the entry cells' full capacities**, not
their principal. An entry of five tickets holds 50,237 CKB and all of it goes
into the DAO deposit. The deposit's capacity must equal that sum exactly —
neither more nor less — so the sponsor funds the receipt and any ledger top-up
from its own input, never by shaving the deposit.

**Entries are accepted in strict nonce order.** `accept` requires
`entry.entry_nonce == accepted_entries` and
`entry.position_base == accepted_tickets` for each entry in turn, so batch *n*
continues exactly where batch *n−1* stopped. There is no way to accept entry 3
before entry 2, and a batch assembled out of order is refused with a state
error that does not say so.

Each entry needs an **MMR membership proof** against the frozen accumulator
root. `core.js` already generates these (`MmrHost.membershipProof(pos)`, pinned
to the Rust vectors), and this is the second time the accumulator's client-side
cost has landed: entry needed the peaks, aggregation needs the proofs.

### The witness, and a hazard it shares with entry

The proofs travel in the witness **at the ledger input's own index**, as raw
bytes rather than a `WitnessArgs`:

```
u8 version = 2
u32 LE count            (1..=32)
repeat count:
  u32 LE input_index    (distinct, must name an entry-lock input)
  u32 LE proof_len
  proof bytes
                        (no trailing bytes permitted)
```

So the same splice hazard applies that `sign-entry.js` asserts against, with a
sharper edge: here the raw witness sits at whatever index the ledger input
occupies, and the sponsor's signature needs its own slot in its own group. The
builder must place the ledger at input 0 and assert the witness/input balance
before handing over, exactly as the entry path does — and the checker must
re-derive the witness's index from the finished transaction rather than trust
the builder's intent, which is the lesson from `assertCkbfsV3WitnessLayout`
being a tautology.

## What the checker must verify before Phill signs

Every rule below is enforced on chain and every one of them fails as an opaque
negative code. The checker re-derives each from the finished transaction:

- **freeze**: `since` is an absolute epoch ≥ `entry_end` with the RFC-0017 flag
  set; the successor differs from the input in `state` and nothing else
- **genesis**: the output equals `AggregationState::new(cfg, frozen)`; the
  output capacity clears both the 318 CKB floor and the input's capacity; no
  entry cells are present
- **aggregate**: entries are in nonce order from the ledger's current position;
  every membership proof verifies against the frozen root *locally*; the DAO
  deposit's capacity equals the summed input capacity exactly; `dao_lock` args
  and receipt args match the computed `batch_id` and digest byte for byte; the
  DAO type script is the config's `dao_type` and its data is eight zero bytes
- **every transaction**: each input's lock has a cell dep providing it, walking
  dep groups — the guard that already exists in `check-signed-round.mjs`

A port drifts, so each ported rule is pinned to the Rust line it came from, as
`round-rules.mjs` does now.

## Testing

Three layers, and the third is the one that counts.

1. **Unit** — the builders are pure functions over a described chain state,
   tested against the Rust vectors. The witness codec gets a byte-for-byte
   cross-check against `witness.rs`'s own encoder, because a TS molecule or
   framing encoder that is not byte-checked against the Rust is the single most
   repeated failure in this project's history.
2. **Dry run** — `dry-run-entry.mjs` gains siblings that build freeze and
   aggregate against the live chain without a wallet. This is what caught the
   missing `config.commitment` on its first run and it should be written before
   the transaction it checks.
3. **Live** — a fresh round, entered, frozen, aggregated, with the DAO deposit
   visible on chain. Nothing counts as proven until this happens; this project's
   feedback log records repeatedly that a green mock suite says nothing about
   pool policy, cell floors or cell deps.

## The round that is already on chain

Round `0xd15f6b5e…` is full at 10 of 10 and **will be allowed to lapse.** Its
aggregation deadline is epoch 13889, which arrives before this gate can be
built responsibly, and from that epoch its entries become refundable. That is a
deliberate choice, not a loss: it exercises TX-04 refund on chain for the first
time, with capacity that returns in full.

Gate 3a is therefore proven against a **new** round created with a wide
aggregation window — days, not the two epochs the demo tool defaults to. The
builder must make that window an explicit argument, because a two-epoch
aggregation window is a trap for anyone driving a round by hand.

## Non-goals

- The draw, entropy reveal and seal. Gate 3b.
- DAO phase one and two, settlement shards, payout, round completion. Gate 3c,
  and unprovable for thirty days after the first deposit regardless.
- Any browser interface for operators. These are CLI tools.
- A keeper daemon, or any process holding a key. Gate 4.
- Multi-shard rounds. The beta is fixed at one shard and `validate()` refuses a
  capped round with more, so the builders take `shard_id` but are exercised at
  zero only.

## Open questions for the plan

1. ~~Should freeze and ledger genesis be one transaction or two?~~ **Resolved
   by the contract, not by preference: they cannot be combined.** The claim in
   the paragraph above was wrong. `AggregationState::new_bound`
   (`lifecycle.rs:99`) refuses any input shard whose `state` is not already
   `FROZEN`, and the dispatch in `main.rs:101` routes to `ledger::transition`
   on data length alone — so a transaction spending an OPEN shard into a ledger
   cell is decoded as a genesis, fails that guard, and is refused with
   `SHARD_ERROR_STATE`. Only a prior transaction can set `state` to FROZEN.

   `no_entry_inputs` (`ledger.rs:26`) forces the next pair apart the same way.
   So the lifecycle is **three transactions, each separated by its own contract
   rule**: freeze, genesis, then batches. The plan minimises signing effort by
   driving all three from one command rather than by merging them.

   Neither refusal has a test. A genesis attempted from an OPEN shard, and an
   aggregate attempted in the genesis transaction, are both structurally
   impossible and both unpinned.
2. **Who sponsors the receipt cells?** Each batch mints a ~152 CKB receipt under
   a public lock. At one batch this is noise; the plan should say whether they
   are ever reclaimed, since a public lock means anyone can.
