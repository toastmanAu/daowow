# Claim NFT sub-project 3: retirement and the winner memento

Date: 2026-09-16. Status: design for user review. Decisions recorded here were
made by the user on 2026-09-16: a batch may not allocate a zero prize to a
drawn position; retirement is its own transaction rather than riding the final
redemption; the memento is a new args tag on `entry-shard-type` rather than a
separate binary; the memento's data is the self-contained 54-byte layout below.

Inputs: `2026-09-15-prize-only-claim-amendment.md` (which requires the memento
and forbids retiring with obligations outstanding), the lifecycle design, and
sub-projects 1 and 2 (`2026-09-16-claim-mint-transfer-design.md`,
`2026-09-16-prize-redemption-design.md`). This document closes the claim
lifecycle; nothing after it is planned.

## Goal

A claim cell must end. A holder with nothing left to collect retires the claim,
recovers its capacity, and — if the ticket won — receives a memento that says so
and can never collect anything. Retirement must be impossible while a prize
obligation is outstanding, and must remain possible forever once none is.

## The completeness problem, and the amendment that closes it

Sub-project 2 pays prizes per batch: a winning ticket is owed from every batch
of the round, and each payment records that batch's `prize_source` into the
claim's paid set. Retiring safely means proving the paid set covers the whole
universe of sources.

That universe is cheap to establish — see "Evidence" below — but as shipped it
is not the set of batches. `accounting.rs::allocate_prizes_complete` can give a
drawn position zero: `allocate_prizes_complete(&[1, 1, 1], 2) == [2, 0, 0]`, and
sub-project 2's spec says of such amounts that they "create no obligation and
are skipped". A skipped source can never be paid, because
`PrizeRedemptionState::record_verified_prize` rejects `amount == 0`. The only
other evidence that a batch owed a ticket nothing is that batch's funding cell,
and a final drain consumes it. A winner with one zeroed batch would therefore be
unretirable forever, with its capacity stranded.

**Amendment.** On a successful round, `InitialEntitlements::derive` rejects a
batch whose allocation gives any drawn prize position zero, returning
`CoreError::Conservation`. This supersedes the "skipped" sentence in the
sub-project 2 design. The universe then is exactly the batches, and completeness
is a count.

The check must be on the computed allocation, not on the pool size: a pool of at
least one shannon per position is **not** sufficient, because weights
`[1, 1, 1000]` with a pool of `3` allocate `[1, 0, 2]`.

Accepted consequence: a successful batch whose realized yield is pathologically
small relative to its schedule's weight spread becomes unsettleable, stranding
that batch's capacity until the schedule or batch policy changes. Real yields are
many orders of magnitude above the threshold, so this is unreachable in practice.
The alternative — redistributing dust so every drawn position receives at least
one shannon — removes the cliff but changes sub-project 2's committed allocation
vectors; it is recorded here as a known option, not adopted. Failed rounds are
unaffected: they allocate no per-ticket prizes at all.

## Evidence

Retirement authenticates against two cell deps and one witness, all rooted in
the claim's own `args.commitment`.

| Source | Carries | Authenticated by |
| --- | --- | --- |
| dep: round config cell | `RoundConfigV1` | `config_by_commitment(commitment, round_id, CellDep)` |
| dep: entropy record cell | `RoundSeal` and entropy heights | own `code_hash`/`hash_type`, args `commitment ‖ 0u32`, data tag `4` |
| witness `(0, GroupInput)` | `PrizeSchedule` bytes | `PrizeSchedule::decode_committed(bytes, &cfg.prize_schedule_hash)` |

`round_id` is read from the entropy record at bytes `7..39`. `EntryShardDataV1`
puts `round_id` at frozen bytes `0..32`; a seal is `[3] ‖ count_u32 ‖ states`
and each `AggregationState` is `[2] ‖ frozen(101) ‖ ...`, so a bare seal carries
it at `6..38` — which is what `entropy.rs` already reads — and the entropy
record's leading tag shifts that by one.

From these, `ComputedDraw::new(cfg, record, schedule)` answers both halves:

- **Universe:** `Σ over shards of record.seal().ledger(id).accepted_batches()`.
- **Winner status:** for each `(prize_index, global_position)` in
  `positions()` (at most 32), `locate(global_position)` gives
  `(shard_id, local_position)`; the ticket is a winner at `prize_index` if that
  pair equals the claim args' `(shard_id, position)`.

The entropy record's existence is itself the proof that the round is sealed:
`RoundSeal::new` refuses unless every shard ledger is closed and bound to this
commitment. No separate seal check is required. A claim therefore cannot retire
before the draw is recorded, which is correct — before then, nobody knows
whether it won.

## Claim script: retire mode

`entry-shard-type` tag `5`, one group input and no group output. This replaces
the unconditional `CLAIM_ERROR_RETIRE` that sub-project 1 shipped.

```
non-winner:  ticket not in draw.positions()
             AND state.paid_count == 0
             AND no memento output carries this identity

winner:      ticket == positions[prize_index]
             AND state.paid_count == Σ accepted_batches
             AND exactly one memento output carries this identity
```

A failed round draws no positions, so every claim is a non-winner and retires as
soon as the entropy record exists.

`paid_count == 0` for a non-winner is implied by the draw check and is asserted
anyway: it pins the invariant that only a drawn ticket can ever have redeemed,
and it is free.

The count comparison is sufficient — no per-source membership proofs — because
every recorded source is genuine and distinct. Genuine: the redeem mode requires
a settlement funding input of this commitment that names this claim, so a source
can only be a real batch of this round. Distinct: `smt::inserted_root` proves
absence before every insert, so no source is counted twice. Given the amendment
above, every batch owes every winner a positive amount, so a count equal to the
universe means every obligation is discharged.

Capacity needs no rule. The holder's wallet lock authorizes the spend, so the
claim's 220 CKB (with a secp256k1 lock) lands wherever they direct it.

## Memento: args tag 6

Args mirror the claim exactly: `[6] ‖ commitment(32) ‖ shard_id(u32 LE) ‖
position(u64 LE)`, 45 bytes. A distinct tag is a distinct type script and so a
distinct script group, cell type and identity; the memento has no redeem path
and no mint authority of its own.

Data, 54 bytes:

| Offset | Field | Meaning |
| --- | --- | --- |
| 0 | `version: u8 = 1` | layout version |
| 1 | `renderer_version: u8 = 1` | pins the procedural renderer; the contract enforces the constant |
| 2..34 | `template_hash: [u8; 32]` | `sha256(ticketWinner.png)` = `de98837659f7b6a7abc1125a12ec0dd64dc0cc053d93f48007b1459e6f5cb46d` |
| 34..38 | `prize_index: u32 LE` | rank in the committed schedule |
| 38..46 | `paid_count: u64 LE` | sources discharged |
| 46..54 | `paid_total: u64 LE` | shannons won |

`ComputedDraw::positions()` carries `prize_index` as a `u64`. It is bounded by
`MAX_SCHEDULE_PRIZES = 32`, so the claim script rejects anything at or above that
bound before narrowing to `u32`; the narrowing is never lossy.

Occupied capacity with a secp256k1 lock is `8 + 53 + (32 + 1 + 45) + 54 = 193`
CKB, against the 220 CKB the retired claim returns. The template hash is stored
in full so a memento is verifiable against the real PNG with no off-chain
registry, consistent with how every other artifact in this protocol is committed.
Ticket identity is not repeated in data; args already bind it, and the render
seed derives from it.

Three transitions:

- **Mint** (no group input, one group output): exactly one input carries a tag
  `5` claim of this binary with byte-identical `commitment`, `shard_id` and
  `position`, and no output carries that claim identity — that is, a claim of
  this exact ticket is retiring here. Nothing else.

  The memento does **not** re-derive the draw. Everything about its content —
  winner status, `prize_index`, `paid_count`, `paid_total`, `template_hash`,
  `renderer_version`, `version` and the lock matching the retiring holder — is
  validated by the claim's retire mode, which has already loaded the evidence to
  decide whether it may retire at all. The memento only asserts the one fact the
  claim script cannot assert on its behalf: that it exists beside a retiring
  claim of its own identity.

  This is the delegation pattern sub-project 1 established, where claim mint
  delegates counting to the shard's `OPEN` transition rather than recounting.
  It matters here for cost: `ComputedDraw::new` is the expensive part of
  retirement, and this keeps it to one derivation per transaction instead of
  two. It also means the retire-mode witness is read once, at
  `load_witness(0, Source::GroupInput)` of the claim group; the memento group
  has no input and reads no witness.
- **Transfer** (one in, one out): data byte-identical, any lock.
- **Burn** (input, no output): allowed unconditionally. The memento is
  non-financial, so letting a holder recover their own 193 CKB costs the
  protocol nothing and needs no proof.

Duplicate issuance is structurally impossible rather than separately checked: a
memento mints only beside a retiring claim of the same identity, each ticket has
exactly one claim for its whole life, and retirement consumes it. Both
directions are enforced — the claim counts memento outputs for its identity, the
memento verifies the claim — which is the discipline sub-project 2 learned when
an unchanged claim successor satisfied the claim script as a transfer while the
settlement paid.

One pair here is deliberately redundant and should be documented as such rather
than tested as if it were pinnable: a non-winner's memento is refused by the
claim script (which counts memento outputs) and by the memento script (which
finds no retiring claim, or finds one the claim script will refuse). Removing
either alone leaves the suite green. Sub-project 2's mutation lesson says a
guard earns its place only through an observable effect its neighbours do not
reproduce; this one does not have one, and is kept for defence in depth with
that stated plainly.

Sharing a binary does not weaken this. CKB groups scripts by the whole type
script, so the claim group and the memento group are separate invocations
exactly as two binaries would be; the shared binary saves a code cell of roughly
60,000 CKB and one deployment, nothing else.

## Error codes

Extend `crates/daowow-core/src/error.rs` below the existing claim range
(`CLAIM_ERROR_ARGS -91` through `CLAIM_ERROR_REDEEM -97`):

| Code | Name | Meaning |
| --- | --- | --- |
| -98 | `CLAIM_ERROR_UNIVERSE` | missing or unauthenticated config/entropy/schedule evidence |
| -99 | `CLAIM_ERROR_INCOMPLETE` | retire attempted with obligations outstanding |
| -100 | `MEMENTO_ERROR_ARGS` | malformed tag 6 args |
| -101 | `MEMENTO_ERROR_DATA` | memento data of the wrong length or version, or changed by a transfer |
| -102 | `MEMENTO_ERROR_GROUP` | wrong group shape |
| -103 | `MEMENTO_ERROR_MINT` | minted without a matching retiring winner claim |

`CLAIM_ERROR_RETIRE -96` keeps its name and becomes the code for a retire whose
memento obligation is wrong: missing for a winner, present for a non-winner, or
more than one.

## Verification

Pure core, host tests: the obligation-universe sum over a sealed multi-shard
round; winner lookup including a ticket at a shard boundary and an empty shard;
the zero-allocation rejection, with a case proving pool size alone is not the
condition (`[1, 1, 1000]` at pool `3`); memento codec round trip and rejection
of every malformed length, version and field.

VM suites under `ckb-testtool`. Accepted: non-winner retires after the seal;
every claim of a failed round retires; winner retires after all batches, with
the memento issued; memento transfers; memento burns. Rejected: retire before
the entropy record exists; winner retire with `paid_count` one short of the
universe; winner retire with no memento; non-winner retire with a memento; two
mementos for one retiring claim; memento minted with no retiring claim; memento
minted against a claim of a different ticket; memento with a wrong
`paid_total`, `prize_index` or `template_hash`; memento locked to somebody other
than the retiring holder; memento data offered as claim data.

Then the isolated-devnet extension carrying a sealed round through redemption to
retirement, and a mutation probe run **per guard individually** — removing one
guard at a time and confirming the named test goes red. Sub-project 2 recorded
that four redundant guards could each be deleted with the whole suite still
green; a guard earns its place only if it has one observable effect its
neighbours do not reproduce.

Two traps from sub-projects 1 and 2 apply directly and belong in the plan:
script groups execute in script-hash order, so a rejection test where both the
claim and the memento would refuse reports whichever code hash sorts first — to
pin a guard in one, keep the other consistent. And `ckb-testtool` must not
re-verify a transaction after `chain_cell` has advanced its input; return cycles
from the helper instead.

## Ripple

- `entry-shard-type` links `ComputedDraw`, `PrizeSchedule`, `draw` and
  `accounting` for the first time; only `settlement-type` pulls them in today.
  The binary is already the largest at 209,360 bytes, so its code cell grows.
  Measure it, because deployment cost is a mainnet economic item.
- Sub-project 2's derivation, its golden vectors and any test that relied on a
  zero allocation change with the amendment. `cargo test -p daowow-core --test
  gen_vectors` rewrites `tests/vectors/daowow_core_vectors.json`, and
  `apps/web/vectors.js` is regenerated from it.
- The deployment manifest is still `prototype-code-cells-only`; the testnet code
  cells predate all of the claim work and must be redeployed before any funded
  round.

## Out of scope

The memento renderer itself, which needs `renderer_version` pinned first; the
web app's claim and memento capacity quotes, and `apps/web/engine.js`, which
still simulates prizes paid to participants; the unclaimed-prize expiry sweep
that would keep a funding cell from staying open indefinitely; and the
`beta-rule-enforcement-audit.md` items, which this work does not touch.
