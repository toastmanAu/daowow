# Gate 2b — entry and claim minting design

Date: 2026-09-19. Sub-project 2b of gate 2 in `docs/testnet-beta-plan.md`,
following 2a (`2026-09-18-dapp-foundation-design.md`).

## Goal

A connected visitor can enter the live round: see an exact, complete quote of
what entering costs, then build, sign and broadcast TX-02, receiving one claim
NFT per ticket.

This is the first gate in which the client moves value. Everything in 2a was
deliberately read-only so that the hard problems underneath — vendored crypto
agreeing with the contracts, decoders agreeing with the chain, the browser
reaching an indexer — were solved before anything could be signed.

## Scope

- The entry quote, stated in full and derived entirely from chain data.
- TX-02: spend the OPEN shard head plus the entrant's funding; produce the
  shard successor, the entry cell, one claim cell per ticket, and change.
- The MMR append witness, built in the browser.
- Shard-head contention: detect, retry, and report honestly.
- Signing through JoyID, broadcast, and confirmation.
- TX-04: refunding an excluded entry after the aggregation deadline.

### Non-goals

- No transfer, redemption, retirement or memento. That is 2c.
- No draw animation. That is 2d.
- No operator or keeper functionality, including round creation. Gate 3.

## Decisions

### D1. The round's accumulator is MMR, and the client builds MMR witnesses

ADR-0001 selected MMR for the protocol, and the devnet exporter configures
rounds with `ACC_MMR`. This decision is inherited, not retaken, but it is
recorded here because it is what makes 2b feasible in a browser at all.

Entry is participant-built: `TX-02` spends the shard head, so the entrant must
produce the accumulator witness themselves. The two accumulators differ
enormously in what that costs a client:

- **SMT** needs an absence proof *and* an inclusion proof per entry against the
  current root, so the entrant must reconstruct enough of the tree to generate
  merkle paths. `apps/web/core.js` has no SMT at all.
- **MMR** needs only the old peak list — at most 8 hashes for a 200-ticket
  round, and `bag_peaks(old_peaks)` must equal the shard's committed root, so
  the peaks are self-verifying against data already on chain.
  `apps/web/core.js` already implements MMR and passes the Rust vectors.

ADR-0001 also measured the SMT insert certificate at **11× the on-chain cost**.

**Known gap this creates.** `tests/integration/tests/proto1_entry_shard.rs`
builds entries with `SmtHost` throughout, so its beta-config tests run SMT
rather than the beta's MMR — recorded in that file and measured: switching the
config to `ACC_MMR` fails the accept-at-cap test with `-33`
(`SHARD_ERROR_ENTRY_CELL`). 2b must add an MMR entry builder to the harness,
which then lets those tests use the real accumulator.

### D2. The ticket price is never a constant in the client

1000 CKB is this run's configuration value, not a protocol constant. Future
rounds set their own price, and a round already carries `ticket_price` in its
immutable config, which `decodeRoundConfigV1` already returns.

So: every figure in the quote derives from the round config and the connected
wallet's lock. A round priced differently must need **no** client change.

The check is that the only numeric literals in the client are protocol
constants — `100000000` shannons per CKB, the 358/101-byte cell sizes, the
33-byte ScriptRef — and never a price, cap or minimum. Stated precisely because
a loose substring search is useless here: `1000` already appears in
`apps/web/dapp/dapp.js`, inside `SHANNONS = 100000000n`.

### D3. The demo round is 10,000 CKB a ticket, capped at 10

Approved in conversation 2026-09-19, replacing the 1000 x 200 shape gate 1
enforced. Per D2 this is configuration, not a constant: it changes the round
config the operator creates and requires no client change whatsoever.

The reason is the ratio. A claim cell costs 222 CKB per ticket regardless of
what a ticket is worth, so raising the price relative to that fixed cost
improves the overhead tenfold:

| shape | 10 tickets | overhead |
|---|---|---|
| 1,000 x 200 | 12,457 CKB for 10,000 principal | **24.57%** |
| 10,000 x 10 | 102,457 CKB for 100,000 principal | **2.46%** |

Proposed `minimum_tickets` is 5. Viability is not a constraint either way: the
default schedule's weights are `[40, 25, 20, 10, 5]`, so `min_viable_pool` is
20 shannons at five or more tickets — never binding.

**Two consequences worth stating before the demo, not after.**

*Most prizes will fall below the payment-cell floor.* A payment cell needs
about 61 CKB. On 100,000 CKB of principal over roughly 30 days, a 2.5%
annualised DAO yield is a pool near 205 CKB, so by the schedule's weights only
the top prize clears the floor:

```
prize 0   82 CKB   clears
prize 1   51 CKB   below the floor
prize 2   41 CKB   below the floor
prize 3   21 CKB   below the floor
prize 4   10 CKB   below the floor
```

This is a supported path, not a defect — the devnet already redeems a prize
with a sponsor top-up — but it means the sponsor must fund top-ups for most
prizes, and the client must show the prize a winner actually receives rather
than the cell's capacity, which is mostly top-up.

*A single entrant can buy the entire round.* The protocol constrains
`minimum_tickets`, never a minimum number of distinct entrants, so with a cap
of 10 one wallet can hold every ticket and win every prize — on yield from its
own principal. Harmless, and a poor demonstration. Worth deciding whether the
demo relies on convention or on the operator watching the round.

### D4. The quote states the capacity overhead plainly

Approved in conversation 2026-09-19. The overhead is large and the honest
response is to show it, not to bury or discount it.

Entering costs more than principal, in three parts:

| component | per | size | note |
|---|---|---|---|
| ticket principal | ticket | `ticket_price` | held in the entry cell, returned at settlement |
| entry cell overhead | entry | **237 CKB** | `8 + 132 data + 33 + 64 args` |
| claim cell | **ticket** | **222 CKB** | `8 + 55 JoyID lock + 78 type + 81 data` |
| fee | tx | small | |

A claim is minted per **ticket**, not per entry, so at the demo's 10,000 CKB
price a ten-ticket entry is:

```
principal     10 x 10000 = 100,000 CKB   returned at settlement
claim cells   10 x   222 =   2,220 CKB   returned when the claim retires
entry cell                     237 CKB   returned at settlement
                           ------------
total                       102,457 CKB  + fee
```

That is **2.46% above principal**, locked for the round's duration — one to two
native DAO cycles, roughly 30 to 60 days. The same ten tickets under the
earlier 1,000 CKB shape carried 24.57%, because the 222 CKB claim cell is fixed
per ticket whatever the ticket is worth. It is recoverable, not spent: the
claim capacity returns when the claim retires (2c), and a winner's memento is
193 CKB.

The quote must show each line, the total, and how long the capacity is
committed for. A quote that shows only the principal is a defect, and is the
gap `docs/HANDOFF-2026-09-16.md` recorded against the old entry preview.

The claim figure is computed from the **connected wallet's own lock**, never
assumed: 222 CKB is the JoyID number (22-byte args), and a secp lock gives 220.

### D5. Contention is a first-class flow, not error handling

Gate 1 fixed the beta at one entry shard, so every entrant competes for one
cell. `TX-02` in `docs/transaction-templates.md` says so outright: "retry
required if competing transaction consumes the chosen shard head first."

A losing entry fails at broadcast, after the visitor has approved it in their
wallet. The client must therefore:

- read the shard head immediately before building, not from a cached round view;
- detect the specific failure (the input is dead or already spent) and separate
  it from a genuine rejection;
- rebuild against the new head — which changes the MMR peaks, the entry's
  position and its nonce — and ask for signature again;
- cap the retries and say plainly what happened rather than looping silently.

**The nonce rule constrains the rebuild.** `shard.rs:46` requires
`entry_nonce == first_nonce_in_tx + nonce_index_in_tx`, so a rebuilt entry is
genuinely a different entry, not a resubmission of the same bytes.

### D6. The visitor approves our numbers before the wallet sees them

2a recorded an obligation to settle before the first signature. CCC's JoyID
signer hands off to JoyID's own hosted signing UI, so this is not the
self-hosted relay of the feedback log's 2026-08-13 entry — but the visitor
still approves a transaction rendered by a third party, and JoyID shows a hash
rather than a human-readable DAOWOW quote.

Mitigation, and it is a mitigation rather than a fix: the client shows its own
complete quote and requires an explicit confirmation **before** invoking the
signer, so the visitor has already agreed to a specific total from a page whose
source they can read. The client must never present a figure it did not
compute from chain data.

## The transaction

Per `TX-02`, at one shard:

```
inputs
  0  OPEN EntryShardCell          (the head, read immediately before building)
  1+ participant funding cells

outputs
  0  updated EntryShardCell       counters advanced, new MMR root
  1  EntryCell                    principal + 237 CKB, under entry-lock
  2..N claim cells                one per ticket, 222 CKB each, entrant's lock
  N+1 change

witness 0  ShardAppendWitness (MMR): entries, old peaks, new peaks
since      absolute epoch >= config.entry_start
```

`since` is gate 1's opening enforcement: an append before `entry_start` is
refused with `SHARD_ERROR_NOT_OPEN` (-39). It is a lower bound only, so it
cannot express the closing side — that is the freeze transition's job.

## Testing

- **Quote arithmetic** against the Rust helpers, so the client and the contracts
  agree on every component. A quote test that only checks the client against
  itself proves nothing.
- **MMR witness construction** cross-checked against the Rust encoder, byte for
  byte, as the decoders were in 2a.
- **An MMR entry builder in the integration harness**, which lets the beta
  config tests run the beta's real accumulator (the D1 gap).
- **Contention**, simulated by advancing the shard head between read and
  broadcast, asserting the client detects and rebuilds rather than reporting a
  generic failure.
- **A real entry on devnet, then on the dev testnet deployment.** Nothing here
  is proven until a claim cell exists on chain under a wallet's lock. Every
  trap in 2a was invisible until the layer the app actually calls was run.
- Every guard gets a disable/re-enable round trip.

## Open questions

- **How many tickets may one transaction buy?** The cap is round-wide, but a
  200-ticket entry mints 200 claim cells in one transaction — worth measuring
  against the block size limit, which the dev deployment has already shown is
  a real constraint at 597,000 bytes.
- ~~Who pays the fee when an entry loses a contention race?~~ **Answered, and
  the question was misframed.** A losing entry is rejected by the pool and
  never committed, so no fee is paid and nothing reaches the chain. The cost is
  entirely a matter of experience: the visitor approves in their wallet, waits,
  and is asked to approve again. What remains open is how many silent retries
  are acceptable before the client stops and explains.
- **How does a visitor learn their entry was excluded?** Refunds are in scope
  (TX-04), but an excluded entry is only knowable after the aggregation
  deadline, by which time the visitor has likely closed the page. Discovering
  refundable entries on reconnect is part of this, and the client must derive
  that from chain state rather than remembering a local flag — a reorg can
  reverse it.
