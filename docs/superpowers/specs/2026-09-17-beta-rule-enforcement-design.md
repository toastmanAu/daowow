# Gate 1: immutable beta rules and their enforcement

Date: 2026-09-17. Status: design for user review. Implements delivery gate 1 of
`docs/testnet-beta-plan.md`, which exists to settle the beta's rules and prove
the contracts enforce them *before* a wallet flow is built against them. Inputs:
`docs/beta-rule-enforcement-audit.md` (the source audit this closes) and the
shipped claim-NFT protocol from sub-projects 1 to 3.

Decisions recorded here were made by the user on 2026-09-17: a hard round-wide
ticket cap with the draw proceeding underfilled once the minimum is reached; a
single entry shard for the beta; closing as an announced target with an
observable on-chain freeze; no per-lock cap; a ticket price of 1000 CKB; and a
requirement that every deposit start and finish within a bounded window, with no
dependence on keeper punctuality.

## Why three of the audit's four hard items disappear

The audit lists four unenforced rules. Three are resolved by decision rather
than by engineering, which is worth stating plainly so nobody re-opens them.

**Round-wide ticket cap — already enforced at one shard.** `shard.rs` compares
`shard_before.ticket_count + delta` against `cfg.maximum_tickets`. With
`entry_shard_count == 1` that shard's count IS the round's count, so the check is
an exact round-wide cap today, with no protocol change and existing test
coverage. The audit permits this only as an explicit scope decision, not an
implicit substitute, and it is taken as one here.

Why the multi-shard case was not attempted: shards are independent cells
appended in parallel, so any append-time comparison against a round-wide total
needs every shard's count in one transaction. Passing the other ledgers as cell
deps does not work — two shards aggregating concurrently each read deps that
predate the other's advance, and both may accept up to the cap. That is a
time-of-check/time-of-use race, not an implementation detail. The sound
multi-shard options are a per-shard partition (`cap / shard_count`, which wastes
capacity when shards fill unevenly, so the advertised cap becomes unreachable) or
a redesign. Both are out of scope for the beta; sharding remains in the protocol
for later rounds.

**Per-lock cap — out of scope.** It is defeated by using a second wallet, so it
buys the appearance of fairness rather than fairness. It would also cost a
`RoundConfigV1` version bump, and config fields sit inside `cfg.commitment()`,
which sits inside the draw seed — so every fixture, vector and golden value in
the repository would shift. Large ripple for protection that does not hold.

**Entry closing — already supported, with a limit that must be disclosed.**
`since` is a lower bound: it proves a transaction is not *earlier* than an epoch
and cannot prove one is not *later*. A hard expiry is therefore not a check that
can be added to the append path; the audit says as much. What the protocol does
support is already implemented: `OPEN -> FROZEN` requires `since >= entry_end`,
so nobody can freeze early, and once frozen no append is possible. Entries
landing between `entry_end` and the actual freeze are still accepted. The
published rules must describe closing as an announced target followed by an
observable on-chain freeze, never as a hard expiry.

## What this gate actually builds

### 1. Entry opening enforcement

The one genuine engineering gap. `cfg.entry_start` is encoded and
ordering-validated (`encoding.rs` enforces
`entry_start <= entry_end <= aggregation_deadline`), but the append path never
checks it, so an entry can land before the round opens.

This one IS expressible, because "not earlier than `entry_start`" is exactly
what `since` provides. The `OPEN -> OPEN` append transition gains
`absolute_epoch_at_least(since, cfg.entry_start)`, mirroring how
`AggregationState::close` already uses that helper against its own deadline.

Adversarial cases required: an append one epoch before `entry_start` is
rejected; an append at exactly `entry_start` is accepted; a relative or
block-number `since` is rejected rather than silently treated as an epoch; and
the existing freeze path is unaffected.

### 2. Configuration guards

The decisions above are only safe if a configuration cannot contradict them.
`RoundConfigV1::validate` gains two rules:

- **Reject `entry_shard_count > 1` while `maximum_tickets != 0`.** Without this,
  the cap silently reverts to per-shard and the advertised number becomes wrong.
  This is what converts "the cap is correct today" into "the cap cannot be
  configured incorrectly" — an operational assumption becomes a rule the
  contracts refuse to break.
- **Reject `minimum_tickets > maximum_tickets`** when a cap is set. A round that
  can never reach its own minimum is unsatisfiable and should not be creatable.

`entry_start <= entry_end <= aggregation_deadline` is already validated and needs
no change.

### 3. The lock window

The user's requirement: every deposit must start and finish within a bounded
window, with no dependence on keeper punctuality.

**Starts are already bounded by configuration.** Deposits occur during
aggregation, which runs between the freeze and the close. `close` requires
`since >= aggregation_deadline` when aggregation is incomplete, so the deposit
window is `[entry_end, aggregation_deadline]` plus however long until someone
closes. Its width is a config value, not a protocol gap: setting
`aggregation_deadline` close to `entry_end` makes every lock start within that
span of every other. No code change; it is a value to choose.

**Finishes contain a knife edge that must be designed out.** This is the part
the audit under-states. Nervos DAO stops yield accrual at phase one, so
`dao-lock` requires `since >= deposit_epoch + 180 * dao_term_periods` to
guarantee a full cycle of yield. RFC 0023 then sets maturity at the next
180-epoch boundary from the deposit. Measured from the devnet harness's own
arithmetic (`tests/devnet/test_round_creation.py`, `periods = (elapsed + 179) //
180`):

```
phase one prepared at D+180  ->  maturity D+180
phase one prepared at D+181  ->  maturity D+360
```

`elapsed` also carries the epoch fraction (`wn - dn + (wi*dl > di*wl)`), so the
keeper must land in the boundary epoch *and* before the deposit's fractional
position within it — a sub-epoch window, potentially minutes. One late
transaction costs every participant in that batch roughly thirty further days.
A payout date must not depend on that.

**Resolution, requiring no protocol change: target phase one inside the interval
`(D+180, D+360)` deliberately.** Maturity is then `D+360` for every deposit,
deterministically, and the keeper has an approximately 29-day window rather than
minutes. Yield accrues until whenever phase one actually lands, so acting early
in that window maximises it. The round is described as settling at the second
boundary, which is what it will actually do, instead of a first boundary it can
only hit by luck.

This is a policy the keeper implements and the published rules describe. It is
recorded here as the resolution rather than left to operational discipline,
because the failure it avoids is silent: a keeper that misses by one epoch
produces a round that still settles correctly, just thirty days late, with
nothing on chain marking it as wrong.

An alternative that would remove the edge in the protocol rather than by policy
— relaxing `dao-lock`'s term guard to admit a tolerance window — is NOT adopted.
The guard is what guarantees a full cycle of yield, and weakening it to buy
timing tolerance would trade a disclosed scheduling property for an undisclosed
economic one.

## Numbers

Decided: **`ticket_price = 1000 CKB`** (100,000,000,000 shannons).

An entrant pays more than the ticket price. Each ticket mints a claim NFT whose
cell occupies roughly 220 CKB under a secp256k1 lock (`claim_occupied_capacity`,
returned in full at retirement), plus transaction fees. The entry quote must
show the total, not the ticket price alone — the audit's "price is not the full
wallet transaction cost" finding. At 1000 CKB per ticket the claim overhead is
about 22 per cent of the ticket price, which is material and must be visible
rather than absorbed silently.

Decided: **`maximum_tickets = 200`**, **`minimum_tickets = 50`**.

| | |
| --- | --- |
| Full round principal | 200,000 CKB |
| Minimum viable round | 50,000 CKB |
| Entrant pays per ticket | ~1,220 CKB (1000 ticket + ~220 claim cell) |
| Claim overhead | ~22 per cent of the ticket price, returned at retirement |

A useful property falls out of this pairing and should not be disturbed
casually. `MAX_SCHEDULE_PRIZES` is 32 and `weights_for(tickets)` truncates to
`min(tickets, len)`. Because `minimum_tickets = 50` exceeds 32, a round that
draws at all has more accepted tickets than the schedule has weights, so **the
schedule never truncates in a successful round**. That removes the audit's
truncation-disclosure requirement entirely: a preset can promise a fixed winner
count, because an underfilled-but-successful round still has at least 50 tickets
for at most 32 prizes. Lowering `minimum_tickets` below 33 would reintroduce the
problem and the disclosure along with it.

Still required before a round can be created, and deliberately not invented
here:

Still required before a round can be created, and deliberately not invented
here:

- The prize schedule: 1 to 32 positive weights. Truncation is no longer a
  concern at these numbers (see above), but the viability gate still applies:
  `MAX_POOL_BAR` voids a round whose weight spread is too wide for a batch's
  yield to pay every drawn position, so `ceil(sum / min)` of the chosen weights
  must stay at or below 1,000,000 shannons.
- `entry_start`, `entry_end` and `aggregation_deadline`, chosen so the deposit
  window is tight per the lock-window requirement above.

## Required disclosures

Three decisions trade enforcement for honest wording. Each is a published-rules
requirement, not a UI preference, because the gap between what the interface
advertises and what the contracts enforce is the specific failure this audit
exists to close.

- **Closing** is an announced target followed by an observable on-chain freeze.
  Entries may land after the announced time and before the freeze. Do not
  describe a hard expiry.
- **Duration** is a minimum accrual term followed by native DAO maturity at the
  second 180-epoch boundary. Any calendar estimate derives from actual chain
  state and shows uncertainty. Never a fixed date.
- **Quantity limits** in the entry interface are a convenience, not a rule. The
  protocol enforces no per-lock cap.

## Verification

Pure core: the two new `RoundConfigV1::validate` rejections, each pinned by a
test that fails if the rule is deleted; the opening check's epoch comparison
including the exactly-at-`entry_start` boundary.

VM: an append before `entry_start` is refused with an exact error code, isolated
so only one script group can reject; an append at `entry_start` is accepted; a
malformed `since` (relative, or block-number rather than epoch) is refused; the
freeze path is unchanged.

Devnet: a round whose deposits all land inside a deliberately tight
`[entry_end, aggregation_deadline]` window, with phase one prepared inside
`(D+180, D+360)`, settling at `D+360` for every batch. This is the evidence that
the lock-window requirement holds end to end rather than only in principle.

Mutation probes per guard individually, per this project's standing lesson that
redundant guards mask each other and a green suite proves nothing about any
particular one.

## Out of scope

Multi-shard cap enforcement; per-lock accounting; a hard entry expiry; any
change to `dao-lock`'s term guard; the operator setup and keeper progression of
gate 3; and the wallet flow of gate 2, which this gate exists to unblock.
