# DAOWOW public testnet beta plan

Updated: 2026-09-15. Working scope, not a deployment authorization or launch promise.

Authoritative ownership update: see
`superpowers/specs/2026-09-15-prize-only-claim-amendment.md`. Principal and refunds
remain sovereign to the depositor; only prize rights transfer. Older all-rights
requirements below are superseded wherever they conflict with this amendment.

## Approved direction

- Preserve the existing landing page and visual identity.
- Operator-created beta draws at daowow.org, with wallet-authorized setup and
  no operator custody of participant funds or private keys.
- Target one- and two-native-DAO-cycle draws. Use RFC 0023's deposit-anchored
  180-epoch maturity boundaries, not an assumed additional withdrawal period.
- **Transferable claim NFTs**, approved in conversation: each ticket is a
  uniquely identified wallet-held asset whose current holder controls its
  unpaid prize rights only. Principal and excluded-entry refunds remain bound
  to the original depositor, without requiring the NFT holder's cooperation.
- **Incremental redemption**, approved in conversation: an NFT records paid
  portions and transfers with all unpaid rights. It retires only when every
  obligation has been discharged. See the claim-lifecycle design below.
- A default ticket artwork template with deterministic procedural variation
  tied to immutable draw/ticket identity. Artwork does not determine winners.
- Use `ticketBlank.png` for claim artwork and `ticketWinner.png` for the required
  final winner memento. The memento has no further redeemable financial rights.
- Participant-created configurable lotteries remain outside this beta.

## Ordered delivery gates

1. Finalize immutable beta rules and audit their enforcement. Include the NFT
   ownership change and native-cycle withdrawal correction in the protocol
   design before building a wallet flow against obsolete ownership rules.
2. Implement verified testnet wallet connection and round discovery, followed
   by exact entry/mint quotes, atomic entry plus claim minting, transfer,
   redemption and confirmation/reorg-aware wallet views.
3. Implement operator setup and persistent keeper progression. The keeper
   prepares funding but cannot redirect a holder's claim or select winners.
4. Deploy approved hardened artifacts and rehearse both durations on public
   testnet, including transferred winners, nonwinners, refunds and recovery.
5. Publish on Cloudflare with HTTPS data access, testnet disclosures and
   monitoring. LAN RPC is local development only.
6. Produce go/no-go evidence and a registration notice with several days'
   lead time. Do not announce a launch before required validation passes.

The roughly one-week target must be reassessed against protocol changes and
real public-chain maturity. Do not silently replace public validation with
accelerated isolated tests to meet that target.

## Transferable claim protocol: required properties

This section records requirements; the wire format and contract design still
need review. It is not a claim that these features exist today.

Status 2026-09-16: mint and transfer are implemented as a claim mode of
`entry-shard-type` (spec `superpowers/specs/2026-09-16-claim-mint-transfer-design.md`,
results in the matching plan). Each append now mints one claim cell per ticket
under the entrant's lock; holders can transfer. Redemption, ticket-indexed
prize funding, retirement and the memento are not implemented; a claim's data
cannot change and the cell cannot be consumed without a successor.

- One claim NFT per positional ticket, issued to the entrant's wallet in the
  same transaction as its authenticated entry. Mint exactly once, with no
  standalone forged mint or remint after redemption.
- Stable identity binds the immutable config/round, shard and ticket position.
  Display serials must not depend on eventual cross-shard aggregation offsets.
- The frozen/accepted ledger determines eligibility. Transfer changes claim
  ownership, never ticket identity, odds, entry count or draw entropy.
- A current holder authorizes a transfer by spending the live claim cell and
  creating exactly one valid successor under the recipient's lock. Preserve
  immutable data and any redemption progress.
- Principal, refund and prize rights travel together. A former holder cannot
  redeem using historical ownership, a copied image or stale membership proof.
- Claim transactions must authenticate and consume/update the live claim cell
  together with the relevant funding/refund state. Amounts derive from verified
  liabilities; no witness-supplied amount or recipient is sufficient authority.
- Transfer and claim competing for the same cell cannot both succeed on the
  canonical chain. Reorg handling must restore actual canonical ownership and
  redemption state, not keep an irreversible local 'claimed' flag.
- Prevent voluntary destruction from bypassing the claim lifecycle. If a
  redeemed souvenir is offered, it must be unambiguously non-redeemable and
  cannot recreate the original financial identity.
- Quote NFT occupied capacity separately from ticket principal, entry-cell
  overhead and fees. Specify who funds and recovers each capacity component;
  avoid counting NFT storage as both pooled principal and a separate asset.
- Render the default template from a versioned, committed deterministic seed.
  Show live accepted/excluded/winning/redeemed status from chain evidence,
  separately from immutable artwork. Wallet compatibility must be tested,
  not inferred merely from calling a custom cell an NFT.

## Settlement architecture issue to resolve

Current `InitialEntitlements::derive` builds **per-batch** liabilities keyed by
participant lock hashes. Winning tickets can receive a share of yield from
multiple batches. Current entry records can also contain multiple tickets.

Consequently, 'burn the NFT to claim' is only sufficient when that transaction
discharges every obligation attached to the ticket. Burning on the first batch
payout can strand later winnings. Gathering every batch into one transaction
can violate the existing bounded-processing requirement.

The approved approach is authenticated incremental redemption with progress
carried by the transferable claim. Transfer conveys all remaining unpaid rights,
and the financial NFT retires only when all obligations are discharged. Each
ticket/batch obligation must be paid at most once, even across transfers and
reorgs. Proof encoding and funding-state coordination still require a concrete
contract design and adversarial validation.

Per-ticket allocation must also conserve every Shannon of shared entry-cell
capacity and failed-round yield. Deterministic allocation cannot depend on a
mutable holder address or on how claims are grouped in redemption transactions.
Excluded-ticket refund processing must support independently transferred
tickets from the same original entry without double-spending its shared funds.

## Required adversarial evidence

- Forged/duplicate mint, altered ticket identity and unauthorized transfer fail.
- Transfer before freeze, after freeze, after draw and after funding preserves
  eligibility and directs remaining rights to the correct live holder.
- Old-owner claim, duplicate redemption, transfer/claim conflict and reorg replay
  cannot redirect or duplicate funds.
- Multiple winners/owners/batches settle in bounded transactions; partial
  redemption cannot lose or duplicate later obligations.
- Multiple tickets from one entry can change owners and receive exact principal,
  prize or excluded-entry refund allocations with no capacity leakage.
- Unknown/unaccepted tickets cannot claim accepted-ticket prizes; failed rounds
  use their approved settlement path, not an invented immediate DAO exit.
- One/two-cycle maturity, fractional epochs, preparation lead time, missed
  boundaries and keeper restart are exercised against the actual node.
- Wallet rendering, procedural-art reproducibility, mint/transfer costs and
  user-facing claim status are verified in supported wallets.

## Remaining product decisions

- Variable odds, total cap, minimum and underfilled behavior remain unapproved.
- Ticket principal, caps and prize preset still need explicit values.
- Define optional per-lock limits as purchase limits or holding limits; allowing
  transfers makes these different policies. Neither is a per-person guarantee.
- Specify preparation lead time and missed-maturity handling for native cycles.
- Review `superpowers/specs/2026-09-15-transferable-claim-lifecycle-design.md`
  before selecting wire formats and implementing the claim protocol.
- Select NFT implementation after reviewing protocol compatibility, wallet
  support, unique issuance, transfer validation and redemption constraints.

See `beta-rule-enforcement-audit.md` for current source findings. Existing
participant-lock-based settlement is baseline evidence, not implementation of
the newly approved transferable-claim model.

## Implementation checkpoint — 2026-09-15

The pure `daowow-core::ticket` module now provides stable config/shard/position
identities and deterministic per-ticket allocation of full pooled entry capacity.
Separate NFT storage capacity is explicitly excluded. These functions neither
authenticate chain inputs nor mint, transfer or redeem a claim.

Both test groups first failed on the absent planned functions. The implemented
module passes four tests including exact remainder allocation, 2,112 allocation
scenarios, invalid inputs and a u64 boundary. The full core library suite passes
100 tests. The no-default-features check, strict library Clippy, targeted rustfmt
and whitespace checks pass. Existing contract codecs, deployment artifacts and
the landing page were not changed. Changes remain uncommitted in the existing
workspace; no claim of whole-workspace or full-node validation is made here.
Scoped Rust review approved both tasks with no correctness or safety findings.
