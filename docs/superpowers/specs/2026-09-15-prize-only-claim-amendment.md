# Prize-only claim amendment

Status: user-directed amendment and approved paid-obligation proof model.
This supersedes all earlier proposals attaching principal or refunds to NFTs.

## Separate rights

- The original depositor retains the full pooled entry-capacity return and
  excluded-entry refund rights. Returning these funds must not depend on owning,
  spending or obtaining cooperation from the ticket NFT.
- The NFT transfers lottery participation and all remaining unpaid winnings.
  An original depositor who transfers the NFT cannot claim its future winnings.
- Native DAO maturity still applies to principal. Sovereignty does not mean
  instant liquidity or an unrestricted early-withdrawal path.
- Keep principal accounting and prize accounting in distinct authenticated
  domains. An NFT proof must never authorize a principal/refund payment.
- The existing pure `ticket_capacity` helper does not authorize ownership. Do
  not wire it into NFT principal claims; that earlier direction is superseded.
- Failed-round yield is not a winning prize. Preserve existing depositor-return
  semantics unless separately changed by the user; its transfer is not implied.

## Approved redemption state model

Each ticket carries a cryptographic set of paid prize obligations. Obligation
keys bind immutable ticket identity, canonical source and payment kind, never
the current owner or claimed amount. Redemption proves nonpayment, authenticates
the amount and atomically updates the NFT and source accounting. Ready sources
can be redeemed in any order. Transfer preserves every paid-state commitment.

Retire the financial NFT only after proving the complete prize-obligation
universe is discharged. Missing or not-yet-mature funding is not zero liability.
No principal-return state is a prerequisite for proving prize completion.

## Required final winner memento

Final redemption atomically issues the redeemer a procedurally unique winner
memento with a distinct non-financial identity and no remaining principal,
refund or prize claim. Partial redemptions retain the financial claim NFT.
Prevent duplicate memento issuance and its use as a claim or remint authority.

The supplied project-root templates were visually inspected:

| Use | File | SHA-256 |
| --- | --- | --- |
| Entry/prize claim | `ticketBlank.png` | `165b7d7c6997f5ba4146f6a55b66f2ed1edc904cd04e71b830fac4e52325d825` |
| Redeemed winner memento | `ticketWinner.png` | `de98837659f7b6a7abc1125a12ec0dd64dc0cc053d93f48007b1459e6f5cb46d` |

Preserve the originals. Derive draw/ticket-specific serial data and decorative
variation deterministically; preserve the title and winner stamp. Commit the
template identity and renderer version. Live status comes from chain evidence,
not the image. Explicitly label the memento redeemed with no remaining claims.

NFT and memento occupied capacity is separate from the deposit. Quote its funding
and recovery explicitly; never deduct minting, transfer or keepsake costs from
sovereign principal. A non-redeemable CKB collectible still occupies capacity.
Wallet compatibility and renderer implementation remain to be verified.

## Additional required tests

- Transfer A to B: principal/refund still goes only to A; winnings only to B.
- A can recover eligible principal without B's signature or live NFT input.
- Partial prize payment to B, transfer to C: C receives only unpaid prizes.
- NFT retirement/memento issuance neither spends nor redirects principal.
- Principal completion cannot fabricate prize completion or vice versa.
- Duplicate claims, paid-state resets, stale owner proofs, premature retirement,
  forged mementos and claim/memento replay after a reorg are rejected.

No contract, NFT or image was changed by this amendment. It is the authoritative
input to the next redemption-accounting implementation plan.
