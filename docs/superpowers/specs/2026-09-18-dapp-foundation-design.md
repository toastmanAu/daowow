# Gate 2a — dApp foundation (read-only) design

Date: 2026-09-18. Sub-project 2a of gate 2 in `docs/testnet-beta-plan.md`.

## Goal

A real web page that connects a JoyID wallet and shows the live DAOWOW round
read from chain. No signing, no transaction building, no writes of any kind.

The value of stopping there is that every hard problem underneath a signing
client — is the vendored crypto the same crypto the contracts use, do our
JavaScript decoders agree with the Rust byte-for-byte, can a browser reach an
indexer at all — gets solved and proven while nothing can yet move funds.

## Scope

Gate 2 in the beta plan reads: "verified testnet wallet connection and round
discovery, followed by exact entry/mint quotes, atomic entry plus claim
minting, transfer, redemption and confirmation/reorg-aware wallet views." That
is four independently testable pieces, split as:

- **2a (this spec)** — foundation, read-only.
- **2b** — entry: the capacity quote and TX-02 (entry + claim mint).
- **2c** — holdings: claim state, transfer, redemption, retirement, memento.
- **2d** — the animated post-draw reveal.

2d can jump the queue: the devnet exports complete rounds, so it can be built
against real fixture data without waiting on any write path.

### Non-goals for 2a

Explicit, so review can reject anything that drifts in:

- No transaction building, no signing, no broadcast. The JoyID signer is
  constructed for its **address** only.
- No entry quote. That is 2b, and it is the piece the numbers below exist to
  make honest.
- No claim, transfer, redemption or memento views. That is 2c.
- No draw animation. That is 2d.
- No operator or keeper functionality. That is gate 3.
- No Cloudflare publication, DNS or monitoring. That is gate 5.

## Decisions taken, with their reasons

### D1. Vendor a pre-built CCC bundle rather than adopt npm at serve time

Approved in conversation 2026-09-18 after three options were weighed.

The repository has no `package.json` anywhere. `apps/web` is deliberately
zero-dependency, no build step, `file://`-safe, and `entry.html` is CSP-locked
against network access. That discipline was right for a simulator and a
display-only preview, and it is worth keeping as far as a signing client
allows.

But a signing client needs molecule encoding, witness layout, fee sizing and
wallet connection, which is precisely the territory `~/.claude/rules/
ckb-transactions.feedback.md` documents 75 entries of traps about — almost all
of them written against CCC. Reimplementing that by hand is where silent,
expensive bugs live.

So: build CCC once, commit the single ESM artifact, import it with
`<script type="module">`. No CDN, no `node_modules` at serve time, no runtime
build step. Measured during design:

| bundle | minified | gzipped |
|---|---|---|
| `@ckb-ccc/core` alone | 443 KB | 150 KB |
| `core` + `@ckb-ccc/joy-id` | 458 KB | **154 KB** |
| `@ckb-ccc/connector` (all wallets) | 1.6 MB | 500 KB |

### D2. JoyID only

Approved in conversation 2026-09-18. The full connector carries every wallet's
SDK and costs 3.3x the bundle; JoyID alone costs 4 KB gzipped over `core`.
JoyID is a passkey wallet needing no extension, which is the right default for
visitors arriving cold at daowow.org on a phone.

Every additional wallet is a signing path that has to be proven on chain rather
than assumed, so the narrow choice also shrinks what later gates must verify.

**Recorded risk, not resolved here.** The feedback log's 2026-08-13 entry flags
a redirect/relay broker as a *trusted component in the signing path*: it renders
the human-readable preview the user approves while JoyID itself displays only a
hash. 2a does not sign anything, so the risk does not bite yet. 2b must address
it explicitly before the first signature.

### D3. Ship against both devnet and an early dev testnet deployment

Approved in conversation 2026-09-18. Gate 2 as written depends on testnet, but
the contracts are not deployed there — `docs/deployment-readiness.md` says "not
deployment-ready" and the existing testnet code cells predate all of the claim
NFT work. Deploying hardened artifacts is gate 4.

Resolution: the Docker devnet drives the automated test loop, because it is
deterministic and already green at 16/16; and an early **dev deployment**,
explicitly superseded by gate 4, makes the demo real and surfaces RPC, CORS,
indexer and pool behaviour early. The client hardcodes neither.

### D4. The client hardcodes no chain constants

Everything network-shaped is loaded from a deployment manifest: network name,
RPC URL, and every script's code hash, hash type and out point.
`deployments/testnet-manifest.json` already establishes `schemaVersion: 1` and
is the format consumed. A `deployments/devnet-manifest.json` is produced by the
devnet harness for local runs.

A manifest whose `schemaVersion` is unrecognised is refused outright rather than
best-effort parsed. A wrong code hash silently watches the wrong cells and
reports an empty round, which is indistinguishable from a round that has not
opened.

### D5. JavaScript cell decoders must be pinned to Rust-generated vectors

This is the decision most likely to be shortcut, so it is stated as a
requirement rather than a preference.

`apps/web/core.js` implements CKB blake2b, MMR verification and the draw, and
passes 11/11 Rust vectors. It does **not** decode `RoundConfigV1` or
`EntryShardDataV1`, which round discovery needs. Those decoders are new code in
2a.

`tests/vectors/daowow_core_vectors.json` currently carries only
`canonical_sizes` for these structures — `round_config: 358`, `shard_data: 101`.
A size pins nothing about field offsets: a decoder that reads `ticket_price`
four bytes early still produces a plausible number, and every test passes.

So 2a extends the Rust `gen_vectors` generator to emit, for both structures, a
canonical sample as **exact bytes plus every decoded field value**. The
JavaScript decoder is asserted against that oracle field by field. This is the
same discipline the feedback log's 2026-06-22 entry records for molecule
encoders: a JavaScript codec must be byte-checked against the Rust, because
codegen and hand-rolling disagree in ways only a byte comparison reveals.

### D6. The simulator must stop claiming to be the protocol

`apps/web/index.html` with `engine.js` is a 574-line simulator of the
*superseded* model: it pays prizes directly to participants, which the contracts
abandoned three sub-projects ago, and its own notes record a position-space
delta it resolved unilaterally. Serving it beside a live dApp would show
visitors a protocol that does not exist.

2a adds a prominent banner marking it a historical simulator of an obsolete
design. Deleting it or relocating it behind `/simulator` is a routing decision
that belongs to gate 5.

## Architecture

```
apps/web/
  vendor/
    ccc-joyid.min.mjs        committed artifact, the only third-party code
    ccc-joyid.lock.json      exact versions + sha256 of the artifact
    README.md                what this is, how to regenerate, why it is vendored
  chain/
    manifest.js              load + validate a deployment manifest
    rpc.js                   JSON-RPC client; get_cells paging
    codec.js                 decodeRoundConfigV1, decodeEntryShardDataV1
    discovery.js             find rounds and their shards, derive round state
    wallet.js                JoyID connect, address, balance
  dapp/
    index.html               the page
    dapp.css                 ported from entry.css
    dapp.js                  DOM behaviour
  test/
    vendor.test.js           artifact provenance + crypto agreement
    codec.test.js            decoders vs the Rust oracle
    discovery.test.js        paging, cursor handling, state derivation
tools/
  build-vendor-ccc.sh        regenerate the vendored artifact
```

New files only. `index.html`, `engine.js`, `entry.html` are untouched by 2a
except for D6 above.

### Round state derivation

A round is a `round-type` cell (config, 358 bytes) plus its `entry-shard-type`
shard cells (101 bytes each). The beta runs one shard, enforced by gate 1's
config guard. Displayed state is derived, never stored:

- **Pending** — now is before `entry_start`.
- **Open** — shard state is OPEN and now is within the entry window.
- **Frozen** — shard state is FROZEN.
- Tickets sold and remaining come from the shard's `ticket_count` against the
  config's `maximum_tickets`; `minimum_tickets` is shown as the viability
  threshold, since a round below it does not draw.

## Traps this design must not walk into

Each is drawn from a recorded incident, cited so a reviewer can check it.

1. **Never persist a terminal indexer cursor.** `get_cells` returns
   `last_cursor: "0x"` on an exhausted scan, and `get_cells(after: "0x")`
   thereafter returns nothing forever, even once matching cells exist. The
   2026-07-19 incident lost every inbound message this way for days, behind 360
   green tests, because the mock returned `"0x64"` on empty pages and never the
   real `"0x"`. `rpc.js` breaks on an empty page *before* recording a cursor,
   and `discovery.test.js` uses a fixture captured from a real node, not a
   hand-written one.
2. **`script_len_range` measures the serialized script length and is
   half-open.** 32 code hash + 1 hash type + args, so `[65, 65]` matches
   nothing and `[65, 66]` matches a 32-byte-args script. The 2026-08-10
   incident returned zero cells with no error while 29 cells sat on chain.
   Filters are asserted against a live endpoint, not reasoned about.
3. **Verify at the layer the app actually calls.** The same incident confirmed
   a fix against raw JSON-RPC that the app never used. Discovery tests run
   through `rpc.js` itself.
4. **Include a positive control.** Per 2026-09-12: a check with no run that
   must pass cannot distinguish a broken harness from a real finding. The
   vendored-crypto test asserts a value that is impossible to get wrong by
   accident — the Rust `domain_hash` vector.

## Testing

- `vendor.test.js` — the artifact's sha256 matches `ccc-joyid.lock.json`, so a
  silent swap fails the suite; and the vendored `hashCkb` reproduces the Rust
  `domain_hash` vector `ba768205…53ed8f`. Verified during design: it does.
- `codec.test.js` — every field of `RoundConfigV1` and `EntryShardDataV1`
  against the extended Rust vectors, plus refusal of wrong-length input.
- `discovery.test.js` — paging and cursor handling against a fixture captured
  from a real node; round-state derivation across pending, open and frozen.
- **A live run is required, not optional.** Round discovery must be executed
  once against the dev deployment and the result recorded in a
  `docs/validation-*.md`, because every trap above is invisible to a mock.
- Every guard introduced gets a disable/re-enable round trip. A green suite is
  not evidence that a guard is pinned; this project's standing rule.

## Confirmed feasible during design

Rather than assumed, so the plan does not rest on guesses:

- CCC bundles to a single browser ESM file in ~30 ms.
- The vendored bundle reproduces the Rust hash oracle exactly.
- `https://testnet.ckb.dev/rpc` serves `access-control-allow-origin: *`, so a
  browser can call it directly with no proxy, and answers `get_indexer_tip`,
  so the indexer RPC that discovery needs is present.
- Install surface: 309 packages, 21 advisories, all low, none high or critical,
  all chaining from one root — `elliptic`, GHSA-848j-6mx2-7j84, reached via
  `@joyid/ckb`. Recorded honestly: `elliptic` **is present in the shipped
  artifact** (49 references). It is build-time *and* runtime surface, not
  build-time only.

## Finding that belongs to 2b but was surfaced here

A claim cell occupies **222 CKB under a JoyID lock** (8 capacity + 55 lock + 78
type + 81 data), and the protocol mints one claim **per ticket**, not per entry.
At the beta's 1000 CKB ticket price a ten-ticket entry locks 2,220 CKB in claim
cells on top of 10,000 CKB of principal — about 22% overhead — for the round's
duration, which at one to two native DAO cycles is roughly 30 to 60 days. A full
200-ticket round locks about 44,400 CKB in claim cells. It is recoverable at
retirement, and a winner's memento is 193 CKB.

This is the gap `docs/HANDOFF-2026-09-16.md` records as "the web entry quote
does not show claim capacity yet". 2a does not quote anything, so nothing here
depends on it, but 2b's quote must state it plainly and the number may warrant
revisiting the ticket price or the cap.

## Open questions

- **The dev deployment's funding.** Deploying the current contracts to testnet
  needs testnet CKB for code cells; the prototype deployment used 180,777 CKB.
  Who funds it and from which key is not settled here, and no key material goes
  anywhere near this repository.
- **Final routing.** Whether the dApp becomes `/` at daowow.org with the
  simulator relocated is deferred to gate 5.
