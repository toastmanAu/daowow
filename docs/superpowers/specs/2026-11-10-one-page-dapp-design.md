# DAOWOW one-app dApp — design

Date: 2026-11-10 · Status: draft for review · Author: Claude, with Phill

## Why

Today the dApp is four separate pages (`apps/web/dapp/index.html`,
`entry.html`, `refund.html`, `how-it-works.html`). Each page has its own
wallet connect, and some only work when you hand-type URL parameters
(`?manifest=`, `?round=`). Using it live on 2026-11-09, Phill needed three
different links to refund two entries and enter a new round. The hub page
defaults to the wrong manifest, and nothing shows "my stuff" across rounds.
His verdict: "UX is bad, i should be able to access everything from one page
not need separate links to view things." He asked for a proper redesign and
explicitly rejected band-aid fixes.

The target is a public testnet demo at **daowow.org** that a first-time
visitor can understand and use from a phone.

## Who it serves

- **A first-timer** lands on the app and needs to learn what DAOWOW is and how
  to use it. Before buying a ticket they must understand four things (Phill's
  list): **the DAO process, the timeframe, the entry cost, and the reward
  structure.**
- **A returning player** comes back to see **their tickets, the status of
  their rounds, the rounds available to enter, and whether they won** (Phill's
  list).

## Goals

1. **One app with a menu bar.** Connect the wallet once, then switch between
   sections without reloading, re-connecting or typing URLs.
2. **Bottom tab bar** (Phill chose option B from the mockups). Four tabs:
   **Home · Rounds · My tickets · How it works.** The header carries the
   logo and a wallet pill. On wide screens the tab bar moves to the top (my
   call).
3. **Every action lives on the card it applies to.** A round card in My
   tickets shows a status badge and its single applicable action: Enter
   more, Refund, or Claim prize, and later Redeem and Retire.
4. **A beautiful animated draw that recalls a lottery draw** (Phill). It is a
   **ball machine rendered in Three.js** ("ball machine but threeJS pretty"):
   a glass drum with tumbling numbered ticket balls, and one ball per prize
   place dropping down a chute onto a winners' rail. It is available **both
   as a live moment and as a replay from the round card** (Phill).
5. **Hosted publicly at daowow.org** on Cloudflare. Phill: "cloudflare is
   already domained for it".

## Anti-goals (Phill: "confusing jargon or hidden fees, bad UX")

- **No jargon.** No protocol word reaches the player: no epoch, shard, cell,
  ledger, freeze, genesis, aggregate, commitment, out point, lock hash or
  witness. Time is shown in human units ("closes in 18 h", "draw on 12
  Dec"), converted from epochs. Rounds get a friendly label; the hex id is
  available only behind a "details" disclosure.
- **No hidden fees.** Before every signature, one plain summary shows what
  leaves the wallet, what is locked and when it comes back, and the network
  fee. It must include the **claim deposit, about 222 CKB per ticket for a
  JoyID wallet and 220 for secp**, computed by `chain/quote.js` from the
  connected lock and never a constant, and it must say that the deposit is
  returned.
- **No bad UX.** No dead ends and no hand-typed parameters. Every failure says
  in plain words what happened and what to do next. Errors are never
  console-only. That gap bit on 2026-11-09 and was patched in `9a39837`.
- **The draw never fakes randomness.** The winners are fixed by on-chain data
  before the animation starts. The animation is a reveal of the real
  `computeDraw` result and must say so. A replay shows the same outcome every
  time.

## Sections

### Home

A short, scrollable explainer for the first-timer, ending in one primary
button, **Enter the current round**, which goes to that round's entry flow
without leaving the app. It covers Phill's four points in plain language:

1. **The DAO process.** Ticket money is pooled into the Nervos DAO. Everyone
   gets their deposit back after the term, and prizes are paid from the
   interest the pool earns.
2. **The timeframe.** A simple visual timeline: entry window → DAO term
   (about 30 days, 180 epochs) → draw → payout. The current round's position
   is marked "you are here".
3. **The entry cost.** The ticket price plus the returned claim deposit per
   ticket, with live figures from the current round.
4. **The reward structure.** How many prize places a round pays at its current
   ticket count, and how they are split. The figures come from the round's
   committed prize schedule (`chain/schedule.js`, `placesFor`,
   `nextThreshold`), never hard-coded.

My call: Home also shows a compact card for the current round (state, time
left, tickets sold), so a first-timer can act immediately.

### Rounds

Every round the app can find, grouped as **Open now**, **Upcoming**,
**Waiting for draw** and **Finished**.

**Round lifecycle states** (my call; each maps to cells the app can find):

| Player-facing | Chain meaning |
|---|---|
| Upcoming | config live, before entry start |
| Open now | inside the entry window |
| Waiting for draw | entry window over; frozen / aggregated / closed / sealed, entropy blocks not yet all mined |
| Drawn — payout pending | draw computable; settlement (gate 3c) not done |
| Didn't fill — refunds open | ledger closed below the minimum, with entries refundable |
| Finished | nothing left for anyone to do (after gate 3c: paid out) |

`deriveRoundState` today returns only pending, open and frozen. The
additional states are a new pure function over the round's config, ledger,
seal and record cells, unit-tested with a case per state. Each card shows live tickets sold
against the cap, the time until its next milestone, and its action:
**Enter** while open. Discovery uses `chain/discovery.js` (`findRounds`,
`findShards`, `deriveRoundState`). The newest round is first; ordering never
depends on indexer order (the 2026-11-09 `rounds[0]` bug, fixed in
`d189335`).

### My tickets

Needs a connected wallet; otherwise it shows a connect prompt. One card per
round in which the wallet holds something, found across **all** rounds so the
player never has to know which round to look in.

**What counts as "my tickets"** (settled from the protocol). A ticket is its
**claim NFT**: one claim cell per ticket, minted at entry under the entrant's
lock (`entry-tx.js`). Claims are transferable, and **the current holder of a
winning claim redeems its prize** (`2026-09-16-prize-redemption-design.md`).
So My tickets is built from:
- **claim cells under the connected lock**. These are the tickets this
  wallet holds now, including ones it was sent. "You won" belongs to the
  holder, not the original entrant;
- **entry cells whose participant lock hash matches the connected lock**.
  These are tickets still waiting to be aggregated, and refundable entries in
  rounds that failed to fill. Aggregation consumes entry cells, so after that
  only the claims remain.

My call: a "Refunded" badge is not shown. Once refunded, an entry leaves no
cell, and reconstructing it would need transaction-history scans on a public
node for little value. The card simply disappears once nothing remains, and
the refund's own success screen is the confirmation. Each card shows tickets held, round status, an
outcome badge (Open / Waiting for draw / Refundable / Refunded / You won /
Not this time), a **Watch the draw** replay once drawn, and the applicable
action:

| Situation | Action shown |
|---|---|
| Round open | Enter more |
| Round failed to fill, entry still on chain | Refund (existing `refund-tx.js` path) |
| Drawn, ticket won | "You won" with the place, its share, and a **labelled running estimate** of the prize (see below); **Claim prize** appears once gate 3c's settlement and payout builders exist |
| Prize paid / claim retirable | Redeem / Retire, once those builders exist |

Until gate 3c lands, the app shows a won prize honestly as **won, claim
coming soon**, never as a dead button.

### Prize figures before payout (Phill chose option B)

Prizes are paid from DAO interest, and the exact amount is only known when the
deposit is withdrawn (gate 3c). Until then, a winning ticket shows:

- its **place and share** of the prize pool, from the committed schedule;
- a **running estimate** worded like "about 41 CKB so far, still growing",
  computed from the interest the round's DAO deposit has actually earned to
  date (standard Nervos DAO accrual between the deposit block and the tip,
  split by the schedule's shares, less anything the protocol deducts before
  prizes).

The estimate is never a projection of the final figure. It is always labelled
as an estimate that is still growing, and it is replaced by the actual paid
amount once settlement exists. Home's reward section uses the same module to
show the current round's prize pool so far. The module is pure and
unit-tested, and its accrual maths is checked against the devnet's real
matured DAO withdrawal (`tests/devnet/test_native_dao.py`) as an oracle.
Before a round is aggregated there is no deposit, so no figure is shown: only
places and shares.

### How it works

Today's `how-it-works.html` content, restyled into the app shell, with the
full detail for readers who want it.

### Wallet

A wallet pill in the header connects JoyID, using the existing
`chain/wallet.js` and the vendored CCC/JoyID bundle. After connecting it shows
a short address and the balance. The session persists across tab switches
for the life of the page. Disconnect sits behind the pill.

## The draw animation

- **Inputs.** The round's config, seal, entropy record and prize schedule,
  fed to the existing `chain/draw.js` `computeDraw`, which is pinned to the
  Rust `ComputedDraw` vectors. The animation only presents the result
  `computeDraw` returns.
- **Live moment** (my call). The result is fixed by chain data before any
  operator posts the entropy record. The record is derived from the seal and
  the hashes of four blocks: the seal block, then 64, 128 and 192 after it
  (`entropy-tx.js`, `entropyHeights`). So the honest countdown runs **to the
  last of those blocks**, and once it exists the browser derives the record
  itself and runs `computeDraw`, without waiting for the operator's
  transaction. This adds a client-side record-derivation function to the
  chain layer, pinned to the same Rust entropy vectors as `entropy-tx.js`
  (an allowed exception to "chain layer stays as-is"). Once the operator's
  record is on chain, the app must check that the two agree and show an error
  if they don't. **Block N** in the honesty line is that last entropy block.
  When the machine runs it reveals places in order, and everyone watching sees
  the same result because it is deterministic.
- **Replay.** Any drawn round's card has **Watch the draw**, which runs the
  same animation with the same result.
- **Your tickets are highlighted** on the balls and the rail when a wallet is
  connected.
- **Honesty line** on screen: words to the effect of "This result was fixed
  on-chain at block N; the animation reveals it."
- **Scale.** Rounds are 10 tickets today and up to 200 under the beta rules.
  The machine must stay legible at 200, for example by tumbling a sample of
  balls and labelling only the drawn ones. That choice is the builder's.
- **Performance.** It must run smoothly on a mid-range phone. Without WebGL,
  or with reduced motion requested, it shows a static, accessible results
  list. Skip and replay controls are always available.

## How it gets built (Claude's calls; Phill: "your call, security is important")

- **No framework, no build step.** Plain JavaScript, with the classic-script
  IIFE modules already in `apps/web/chain/`, plus the vendored ES-module
  bundle. The reason is supply chain: a page that signs transactions moving
  real CKB should not pull hundreds of npm packages.
- **Every third-party file is vendored and hash-pinned.** Three.js joins
  `apps/web/vendor/` at a pinned version, with a lock file and a
  `vendor.test.js`-style test asserting its sha256, exactly as
  `ccc-joyid.min.mjs` is today. No CDN at runtime.
- **A strict Content Security Policy**, kept to the existing pages' pattern
  (`script-src 'self'`, an explicit `connect-src` allowlist), so the page
  loads scripts only from its own origin. Chain and wallet data are rendered
  only via `textContent` or equivalent, never as HTML.
- **Client-side routing** between tabs with no reloads. Whether it uses hash
  routes (`#/my-tickets`) or plain in-page state is the builder's call; the
  constraint is that a shared link to a tab or a round still works.
- **Reuse, don't rewrite, the chain layer.** `apps/web/chain/*` (codecs, tx
  builders, discovery, quote, draw, wallet) stays as-is and stays tested. The
  redesign replaces `apps/web/dapp/*`. Every existing guard, such as
  `entryWindowProblem`, refund blockers and the replay-set fix, must survive
  the move.

## Hosting

- **Cloudflare Pages** at daowow.org. The domain is already on Cloudflare
  (Phill).
- **The node.** The dApp today reads from Phill's LAN node
  (`http://192.168.68.134:8114`), which the public internet cannot reach.
  The public site uses a public testnet RPC (`https://testnet.ckb.dev` is
  already in the CSP `connect-src`), configured in the deployment manifest
  and not hard-coded in the pages.
- **HTTPS throughout.** JoyID on a phone requires it.
- **The manifest** (my call). The site ships the **dev-testnet deployment**:
  the one the live rounds use, including round `affb66f7`. It is repointed at
  the public RPC in a public copy of the manifest, and the LAN URL is never
  served. The app only lists rounds under that deployment's code hashes;
  rounds from the older prototype deployment (`testnet-manifest.json`,
  `prototype-code-cells-only`) are not shown. The served app loads this
  manifest by default and never needs `?manifest=`.

## Constraints

- Testnet only for this design; mainnet is out of scope.
- Must work on a phone browser with JoyID, and on desktop.
- The existing test suite (385 tests at `9a39837`) stays green. New UI logic
  that has a real decision in it (outcome badges, the time conversion, "my
  entries across rounds") is pure and unit-tested, with mutation probes per
  Phill's standing workflow.
- Visual language: keep Astra's existing palette and type (`--deep`,
  `--blue`, `--paper`, `--amber`, Avenir Next), as already in
  `apps/web/dapp/dapp.css`.

## Non-goals

- Gate 3c's settlement, DAO withdrawal and payout transaction builders. The
  app shows where Claim, Redeem and Retire will go; building those
  transactions is gate 3c's job.
- Operator functions (create, freeze, genesis, aggregate, close, seal,
  entropy). They stay in `tools/` with ckb-cli signing.
- Wallets other than JoyID.
- Mainnet.

## Left to the builder

- Exact copy for Home and How it works, within the no-jargon rule.
- The friendly round label scheme.
- Draw-scene art direction within "glass drum, tumbling balls, chute, rail,
  Three.js pretty", and the 200-ticket legibility approach.
- Routing mechanism, file layout under `apps/web/dapp/`, and how the four old
  pages are retired or redirected.
- The epoch-to-wall-clock conversion method; it must say "about" where it is
  an estimate.
