# Prize schedule v2 — payout depth scales with the field

Date: 2026-09-19. A protocol amendment, required before gate 2b's client work,
because it changes deployed contracts.

## Goal

Pay more places as more tickets enter, the way a poker tournament pays more of
a larger field. A schedule commits a ticket threshold per place, and a place
pays only once the round reaches it.

## Why the current rule is wrong

`weights_for(tickets)` returns `weights[..min(tickets, len)]`: place *i* pays
whenever the round has at least *i + 1* tickets. With the default weights
`[40, 25, 20, 10, 5]` a five-ticket round pays five places — every ticket wins,
which is not a lottery — and the prizes are dust.

Dust is not merely unattractive. A payment cell needs roughly **61 CKB**, so a
prize below that cannot be paid without a sponsor top-up, and the top-up is
capacity the winner did not win. Modelled at 10,000 CKB a ticket, a 2.5%
annualised DAO yield and a 30-day term:

| tickets | pool | current rule | with thresholds |
|---|---|---|---|
| 3 | 62 | 3 places: 29! 18! 15! | 1 place: 62 |
| 5 | 103 | 5 places: 41! 26! 21! 10! 5! | 1 place: 103 |
| 10 | 205 | 5 places: 82 51! 41! 21! 10! | **2 places: 126 79** |
| 20 | 411 | 5 places: 164 103 82 41! 21! | 3 places: 193 121 97 |
| 50 | 1,027 | 5 places: 411 257 205 103 51! | 4 places: 433 270 216 108 |
| 100 | 2,055 | 5 places: 822 514 411 205 103 | 5 places: 822 514 411 205 103 |

`!` marks a prize below the payment-cell floor. The current rule produces one
in almost every realistic round; the threshold rule produces none.

## Decisions

### D1. Thresholds are on ticket count, never on the pool

This is forced, not preferred.

`computed_draw` derives the winning positions from the round seal, the entropy
record and `total` tickets alone — never from yield. Its own comment says why:
"Derived from round-level data only, so every batch and retirement reach the
same verdict." The draw happens before any batch's yield is known, and every
batch and every retirement must independently reach the same result.

A rule of the form "pay as many places as the pool can fund above the cell
floor" would make the number of winners depend on yield, so two batches with
different yields would disagree about who won. It is not implementable here.

Ticket count is known at freeze, is already the input to `weights_for`, and is
what a poker payout table keys on anyway.

### D2. Thresholds are committed, not supplied

The threshold table lives in the schedule, which is committed by
`prize_schedule_hash` in the immutable round config and checked by
`decode_committed`. A keeper cannot vary payout depth for a round in flight,
and a threshold table supplied in a witness would be exactly that.

### D3. Wire version 2, with v1 preserved as an exact special case

```
version  u8  = 2
count    u32 LE, 1..=32
count x { weight u64 LE, min_tickets u64 LE }
```

85 bytes for five places, 517 for the maximum 32.

Validation, all of which must fail closed:

- `count` in `1..=MAX_SCHEDULE_PRIZES`, and the buffer exactly `5 + 16 * count`
- every weight strictly positive, their sum within `u64` — unchanged from v1
- `min_tickets` **non-decreasing**: a later place cannot open before an
  earlier one
- `min_tickets[0] <= 1`, so any round that draws at all pays at least one
  place. Without this a schedule could draw with zero winners, which is a
  state no existing path expects.

**v1 is exactly v2 with thresholds `[1, 2, 3, ..., n]`.** Place *i* paying at
`tickets >= i + 1` is precisely `min(tickets, n)`. That equivalence is the
migration test: decode a v1 schedule, construct the v2 schedule with those
thresholds, and require `weights_for` to agree for every ticket count from 0 to
well past `n`. v1 stays decodable, and its behaviour is unchanged.

### D4. `weights_for` keeps its ticket-count cap

```
weights_for(t) = weights[..min(t, |{ i : min_tickets[i] <= t }|)]
```

The threshold count alone is not enough. A schedule with thresholds
`[1, 1, 1]` would otherwise pay three places in a two-ticket round, and there
are not three distinct positions to draw. The `min(t, ...)` cap is retained
from v1 for exactly that reason.

`min_viable_pool` needs no change: it already derives from `weights_for`, so it
follows the new selection automatically.

### D5. The demo schedule

Weights `[40, 25, 20, 10, 5]` with thresholds `[1, 8, 20, 50, 100]`.

Approved in conversation 2026-09-19. The 2-place threshold is 8 rather than 5
because at exactly five tickets a second place is 40 CKB, still under the floor;
at eight it clears. The demo round is capped at 10 tickets, so it pays two
places of roughly 126 and 79 CKB — both above the floor, neither needing a
top-up.

## Blast radius

`weights_for` is consensus code. It runs inside `entry-shard-type` through
`computed_draw`, and `round-type` decodes the schedule at creation through
`creation_schedule`.

Both change. But `daowow-core` links into all five contracts, so a binary that
never calls the changed code may still change if dead-code elimination does not
remove it. **This is measured, not assumed**: the current deployed data hashes
are recorded in `deployments/dev-testnet-manifest.json`, and after the change
every contract is rebuilt and its hash compared. Only contracts whose hash
actually moved are redeployed.

| contract | deployed data hash | redeploy |
|---|---|---|
| round-type | `0xdc172248…` | expected |
| entry-shard-type | `0x6afa519d…` | expected |
| entry-lock | `0x48ce84d8…` | measure |
| dao-lock | `0x0cb1229a…` | measure |
| settlement-type | `0x3114256d…` | measure |

The deployment is data-hash pinned, so a new binary is a **new script** rather
than a silent reinterpretation of live cells. No round exists on testnet, so
nothing is stranded, and superseded code cells become reclaimable through
`docs/reclaim-testnet-capacity.md`. `tools/check-deploy-size.mjs` still governs
how the redeploy is split.

## Testing

- **v1/v2 equivalence** across every ticket count, as D3 describes. This is the
  test that proves no existing round's behaviour changed.
- **Threshold selection** at each boundary: one ticket below a threshold, at it,
  and one above, for all five places.
- **Validation** refusing each invalid shape on its own: bad count, zero
  weight, decreasing thresholds, `min_tickets[0] > 1`, wrong buffer length.
  Each must red its own named test, since guards over one structure mask each
  other.
- **`min_viable_pool`** follows the new selection rather than the old.
- **Vectors regenerated** and the JavaScript checked against them, because
  `apps/web` reads the schedule to display prizes.
- **On-chain**: a devnet round at the demo schedule, drawing two places at ten
  tickets, with both prizes above the payment-cell floor and no top-up.
- Every guard gets a disable/re-enable round trip.

## Open questions

- ~~Does the client display payout depth before entry?~~ **Answered
  2026-09-19: yes.** A visitor deciding whether to buy the eighth ticket is
  deciding whether a second prize exists at all, so the payout table is part of
  2b's entry view, and the site explains the methodology behind it. Specified
  in `2026-09-19-dapp-entry-design.md` under D7.
- **What happens to a round already open when an operator wants a different
  table?** Nothing can change it, by D2. That is the intended answer, but it
  means the demo's thresholds must be right before the round is created.
