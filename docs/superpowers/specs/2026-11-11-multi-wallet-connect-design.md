# Multi-wallet connect — design

Status: DRAFT for Phill's approval. Nothing is built.
Date: 2026-11-11.
Ships: after Round 5 (`0x0526654b`) closes entries at epoch 14199, for the
round that follows it. Not published while Round 5 is taking entries.

## Goal

Let a player connect with any wallet CCC supports, not only JoyID, and enter
and refund with it.

## What does not change

- **The protocol.** A claim is minted under the entrant's lock and the entry
  records that lock's hash. No contract or codec is touched.
- **`sign-entry.js`.** It already takes any CCC signer.
- **The session boundary.** The signer stays private in a closure. A view still
  receives only `address`, `lockScript`, `balance`, `signEntry`, `broadcast`.
- **No build step, no CDN.** The wallet code is a committed, pinned bundle.
- **The content policy.** `script-src 'self'` and `style-src 'self'` stay.
- **The 5-per-wallet rule.** It is keyed on the lock, so it follows the wallet.

## Decisions

### D1. Our own picker over CCC's signer list, not CCC's connector widget

`@ckb-ccc/ccc` exports `SignersController`, which lists wallets and their
signers with no user interface (`refresh(client, onUpdate, { name, icon })`
yields `WalletWithSigners[]`). The picker is a small panel in the existing
wallet menu, written with the app's own `dom.js`.

Rejected: `@ckb-ccc/connector`. It brings a second UI framework and its own
styling into a page that has neither, and its look is not this app's.

### D2. Only testnet CKB signers are offered

The controller is given the testnet client and a preferred-network list of
testnet only. A signer whose network cannot be confirmed as testnet is not
listed.

### D3. A wallet is listed only once it has entered AND refunded on testnet

The list is an allow-list in the app, by wallet name and signer type. A wallet
CCC detects but we have not run is not shown. Proposed first list, pending
D-open-1: JoyID, MetaMask (EVM), one Bitcoin wallet.

Why: the entry transaction carries the accumulator witness at index 0 and is
fee-sized against the signer's own placeholder. A wallet whose real signature
outgrows its placeholder is refused by the pool, and only a live send shows it.

### D4. The pre-connect quote says "from", not "with a JoyID wallet"

Before a wallet is connected the ticket deposit is quoted for the smallest
listed lock and labelled as a starting figure. After connecting it is exact,
as now. The total a player confirms is always computed from their own lock.

### D5. One connection at a time, remembered by signer

The chosen wallet name and signer type are remembered so a returning visitor
is restored without a prompt. Disconnect clears it. Switching wallets is
disconnect then connect.

## Work

1. `tools/build-vendor-ccc.sh`: bundle `@ckb-ccc/ccc` at a pinned version;
   new artifact name and lock file; `vendor.test.js` updated, hash oracle kept.
2. `chain/wallet.js`: `listWallets()`, `connect(choice)`, `restore()`,
   `disconnect()`; same frozen session shape.
3. Wallet menu: the picker, an empty state ("no supported wallet found"), and
   the connected wallet's name.
4. Sweep JoyID-only wording and the `JOYID_SHAPED` placeholder (`home.js`,
   `enter.js`, `copy.js`, the How page).
5. Refund path: confirm it signs through the same session for a non-JoyID lock.
6. `_headers`: add only what a listed wallet provably needs, each with a
   comment naming the wallet.

## Testing

- Unit: the allow-list filter, the testnet-only filter, restore with a
  remembered choice that is no longer available, session shape unchanged.
- Mutation probe per guard, each redding its own named test.
- Live, per listed wallet, on a throwaway testnet round: connect, enter,
  see tickets, hit the 5-ticket limit, refund. Run by Phill; I cannot drive a
  wallet.
- JoyID regression run on a phone before anything is published.
- Security review of the wallet and signing changes before merge.

## Open

- **D-open-1.** Which wallets go on the first list, and which can Phill test
  with himself?
- **D-open-2.** Whether the larger bundle is loaded up front or only when the
  wallet menu is first opened.
