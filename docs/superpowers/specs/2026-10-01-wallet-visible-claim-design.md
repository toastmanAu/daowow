# A wallet-visible representation of a ticket, bound to the claim

**Status:** design, queued — NOT for implementation before gate 3c
**Problem:** a holder cannot see their tickets in the wallet they bought them with.
**Shape:** a Spore/DOB cell per ticket, bound to its claim by a custom LOCK.

## The problem, stated precisely

Claim NFTs are real NFTs — unique, transferable, on-chain cells — but they
carry `entry-shard-type` as their type script with 45-byte `ClaimArgs`
(`[5] ‖ commitment ‖ shard_id ‖ position`). JoyID's DOB view reads the **Spore
protocol**. A wallet can only display what it knows how to parse, so a custom
type script is invisible to every wallet, and no configuration changes that.

For a lottery this is a trust problem rather than a cosmetic one: the user
spends 10,457 CKB, their wallet shows the balance leave, and nothing arrives
that they can see. "Where did my ticket go?" is the natural reaction and the
honest answer is currently "open our website".

## Why the claim cannot simply BE a Spore

A Spore's content is immutable — Spore's own transfer rule requires the output
spore to carry identical content. The claim cell's data **is** its
`PrizeRedemptionState`: `ticket`, `paid_root`, `paid_count`, `paid_total`
(`redemption.rs:46`), and redemption mutates it. `claim.rs` is explicit that a
data change IS a redemption.

So one cell cannot be both. Two cells, or nothing.

## The binding, and why the LOCK is the enforcement point

The instinct is to make the Spore's type script demand the claim. That cannot
work: the Spore type script is Spore's, not ours, and it permits any new owner.

**A lock always runs when its cell is spent.** That is the asymmetry the design
rests on. Give the Spore a custom lock — call it `ClaimBoundLock` — carrying the
claim's 45-byte `ClaimArgs` so matching is a direct comparison rather than a
derivation. Its rule, in three branches:

1. **Transfer.** A claim input bearing these exact args is present, and a claim
   output bearing them is present → require the output Spore's lock to equal
   the output claim's lock. The Spore lands wherever the ticket lands.
2. **Retirement.** The claim input is present and there is no claim output — the
   ticket is being burned → require that no output carries this Spore's type
   script, i.e. the Spore is melted with it. The representation dies with the
   thing it represents.
3. **Anything else.** Refuse.

Redemption needs no branch: it spends the claim, not the Spore, so this lock
never runs. The claim's own script already keeps the lock unchanged across a
redemption.

### What this buys, and the one thing it does not

**The Spore can never be detached.** Any movement of it carries the claim and
lands both at one owner.

**The claim can still move alone**, because `entry-shard-type` does not demand
the Spore — and making it demand one would mean redeploying that contract.
Last redeploy moved four of five binaries and cost 545,164 CKB of deploy
capacity, so this is a real reason, not a shrug.

That asymmetry is not the divergence problem returning. If the claim moves
alone the Spore is left **stuck, not stolen**: the old owner cannot spend it
(they no longer hold the claim) and the new claim holder *can* sweep it along
on their next transfer. The Spore is magnetic — always re-attachable by the
rightful holder, never detachable by anyone.

The only failure mode is a **temporary visual desync**, closed by the dApp
always including the paired Spore in a claim transfer. It appears only when
someone moves a claim with another tool, and the next dApp action re-unites
them.

## The catch that must be stated to users, not just to us

**JoyID's own transfer button on the Spore will fail.** The wallet builds a
transaction containing only the Spore; the lock refuses; the user gets an
opaque error. The wallet is therefore **view-only** and every movement happens
in the dApp.

That is the price of the binding being real, and the alternative is worse. A
Spore under the holder's plain lock would transfer natively and then detach for
good, leaving a cell that reads "ticket 7" in a stranger's wallet while ticket
7 pays out to someone else. A representation that can lie is worse than no
representation.

So the Spore's own content must say so. Its DOB description carries, in the
holder's words: *this is a view of ticket N; it moves with the ticket and
cannot be sent on its own; transfers happen at <app>*.

## The severe risk, and the mitigation it dictates

**A lock script's args are never validated when a cell is created**, because a
lock only runs on consumption. This is recorded in the project's own
`ckb-transactions.feedback.md` for 2026-08-15 as a severe, new-class trap: args
committing to the wrong identity broadcast cleanly, pass every consensus check,
render correctly in explorers, and are **permanently unspendable**.

Here that means a Spore minted with the wrong `ClaimArgs` is bricked forever —
unmovable, unmeltable, and showing a ticket it is not bound to. At ~300 CKB a
cell and one per ticket, a batch mint with an off-by-one in the position field
strands the lot.

**Mitigation is mandatory, not optional:** an `assertMintConsistency` that runs
**after fee completion, against the exact broadcast bytes**, recomputing each
Spore's `ClaimArgs` from the claim it is paired with and requiring the lock to
carry them. The same lesson also warns that `completeFeeBy` appends a change
output, so the assertion checks the first N outputs and then that no further
output carries `ClaimBoundLock` — never an exact output count.

## Cost

| item | capacity |
|---|---|
| claim cell (already paid) | 222 CKB |
| Spore cell, minimal content | ~250 CKB |
| Spore cell, 74-byte DNA | 343 CKB (measured, hot-chicks) |
| cluster, one-off and optional | ~3,200 CKB |

Roughly **doubles per-ticket overhead**. At the demo's 10 tickets that is
2,500–3,500 CKB plus the cluster. Note the DNA is stored JSON-quoted, so on-chain
content runs about `2 × bytes + 2` — budget from that, not from the binary size.

A cluster is optional (`clusterMode: "skip"` works) and buys collection
grouping in wallets for ~3,200 CKB. Worth it once, not per round.

## Retroactive by construction

Minting needs only the claim's `ClaimArgs`, which are on chain. **Nothing about
this requires minting at entry time**, so it can be added to rounds that
already exist — including the two already on testnet. That is what makes
deferring it safe.

## Why this is queued, not built now

A new lock script sits **in the signing path for an asset representing real
value**, and this project's standing rule is that payment and signing code gets
security review before merge. Shipping it while 3b and 3c are unproven would put
an unaudited lock between a user and their ticket.

The claim remains the source of truth throughout, so nothing downstream depends
on this existing.

## Testing

1. **Host tests** for the three branches, each pinned by a mutation that reds
   its own named test — including a case where the claim moves alone, asserting
   the Spore is stuck and then provably sweepable by the new holder.
2. **ckb-debugger** against the real binary, with a positive control that must
   pass, per the 2026-09-12 lesson that a broken harness and a real finding are
   otherwise indistinguishable.
3. **Devnet**, because only a real node exercises pool policy and cell floors,
   and a melt is a value-preserving spend — the 2026-09-17 entry records that
   exact shape being accepted by `ckb-testtool` and refused by a real node for
   `PoolRejectedTransactionByMinFeeRate`.
4. **Testnet** last: mint against an existing round's claims, confirm the Spore
   appears in JoyID, transfer via the dApp and confirm both move.

## Non-goals

- Making the Spore redeemable. It is a view; the claim pays.
- Wallet-native transfer. It cannot work and the design says so out loud.
- Changing `entry-shard-type` to demand the Spore. The redeploy cost is not
  worth closing a gap that self-heals.
- Minting at entry time. Retroactive is simpler and keeps the entry path
  untouched.

## Open questions for the plan

1. **Where does a melted Spore's capacity go?** Branch 2 requires the Spore to
   be melted with the claim; the plan must decide whether its ~300 CKB returns
   to the retiring holder (likely) or is constrained further, and whether the
   lock enforces the destination or leaves it to the retirement transaction.
2. **What exactly does the DOB render?** Ticket number, round, and the paying
   places are all on chain. The honesty constraints from gate 2's D7 apply: it
   must not imply the ticket has won, or that the draw is anything other than
   four block hashes fixed in advance.
3. **One Spore per ticket, or one per entry?** Ten tickets is ten cells and
   ~3,000 CKB. One Spore per ENTRY saying "5 tickets, positions 5–9" is a fifth
   of the cost, but then it binds to five claims at once and branch 1 has to
   require all of them to move together — which is stricter than the protocol,
   since claims are independently transferable. Probably one per ticket, but the
   plan should say why.
