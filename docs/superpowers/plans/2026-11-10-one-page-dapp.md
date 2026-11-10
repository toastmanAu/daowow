# DAOWOW One-App dApp Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the four separate dApp pages with one app at daowow.org: connect once, four tabs (Home · Rounds · My tickets · How it works), every action on its card, and a Three.js ball-machine draw that reveals the real on-chain result.

**Architecture:** One static `apps/web/dapp/index.html` holds all four tab sections; a hash router shows one at a time. Every decision (round state, time wording, my tickets, prize estimate, draw timeline, all player copy) lives in pure classic-script modules under `apps/web/dapp/model/`, unit-tested in node. Thin ES modules under `apps/web/dapp/app/` do the DOM and wallet wiring. Three small additive files join `apps/web/chain/`; nothing existing there is edited.

**Tech Stack:** Plain JavaScript, no framework, no build step. Classic IIFE modules + ES modules. Vendored `@ckb-ccc` bundle (existing) and vendored Three.js 0.170.0 (new). `node --test`. Cloudflare Pages.

**Spec:** `docs/superpowers/specs/2026-11-10-one-page-dapp-design.md` (approved by Phill 2026-11-10). Read it before starting any task.

## Global Constraints

- Run the suite with `node --test apps/web/test/*.test.js` from the repo root (globs, never directory arguments). It is 385 green at the start and must be green at the end of every task.
- No framework, no bundler, no npm dependency at serve time, no CDN. Third-party code is vendored under `apps/web/vendor/` with a lock file and a sha256 test.
- CSP on every served page: `default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self' https://testnet.ckb.dev; form-action 'none'; base-uri 'none'`. The LAN URL `http://192.168.68.134:8114` must not appear in any served file.
- Chain data, wallet data and error messages reach the page only through `textContent` or `Node.append(string)`. No `innerHTML`, `outerHTML`, `insertAdjacentHTML` or `document.write` anywhere under `apps/web/dapp/`.
- Classic modules follow the existing pattern exactly: `"use strict"; (function () { … const api = {…}; if (typeof module !== "undefined" && module.exports) module.exports = api; if (typeof window !== "undefined") window.DaowowX = api; })();`. Sibling modules are resolved **lazily** (`const x = () => typeof require === "function" ? require("…") : window.DaowowX;`), never destructured at load time.
- Amounts are BigInt shannons end to end. Heights and epochs are BigInt.
- Banned player-facing words (Home, Rounds, My tickets, entry, refund and draw screens): `epoch`, `shard`, `cell`, `ledger`, `freeze`, `frozen`, `genesis`, `aggregate`, `aggregation`, `commitment`, `out point`, `outpoint`, `lock hash`, `witness`. The How it works tab is the opt-in detail page and is exempt. Chain-layer error text is shown only inside a "Technical details" disclosure under a plain-words headline.
- Existing files in `apps/web/chain/` are not edited. Existing guards must survive the move: `selectRound` (never `rounds[0]`), `refundBlocker`, the replay set from `readShardEntries` (never the live cell set), the schedule commitment check in `fetchSchedule`, `submitEntryWithRetry`, `awaitCommitted` then `awaitIndexer` before any re-read, and the signer staying private in `wallet.js`.
- Palette and type stay as in `apps/web/dapp/dapp.css` (`--deep`, `--blue`, `--paper`, `--amber`, `--muted`, `--line`, `--good`, Avenir Next).
- Testnet only. JoyID only. No operator functions. No gate 3c transaction builders.
- Phill's workflow: after each task's tests pass, run the mutation probes the task lists (break the guard, confirm the named test goes red, restore, confirm green). A green suite is not evidence a guard is pinned.
- Commits follow `<type>: <description>`; never commit `.env`, `*.local.json` or key material.

## Decisions made in this plan (not in the spec)

1. **Timeline order.** The spec's Home timeline reads "entry window → DAO term → draw → payout". On chain the draw happens shortly after entries close (close → seal → 256 blocks), and the DAO term runs *after* it; payout follows the term. The plan shows what the chain does: **Entries open → Entries close → Draw → Savings term (about 30 days) → Payout**. Phill must confirm this before Task 9.
2. **One scan, not one per round.** A new `chain/round-cells.js` reads the whole deployment in two indexer scans and buckets cells per round, because per-round `findShards`/`findLedger` scans against a public RPC grow quadratically.
3. **Manifest.** A generated public copy is committed at `apps/web/dapp/manifest.json` and loaded as `./manifest.json`. Dev and production both use the public RPC, so there is no `?manifest=` at all.
4. **Routing.** Hash routes: `#/home`, `#/rounds`, `#/tickets`, `#/how`, `#/round/<id8>/enter`, `#/round/<id8>/draw`, where `<id8>` is the first 8 hex chars of the round id.
5. **Old pages.** `entry.html`, `refund.html` and `how-it-works.html` become script-free `<meta http-equiv="refresh">` stubs pointing at the matching route.
6. **Round labels.** "Round N", N being the 1-based rank by `(entryStart, roundId)` ascending within the deployment. The hex id is shown only inside "Details".
7. **Three.js 0.170.0**, the last release that ships as a single `three.module.min.js` (later releases split into two files). Ball motion uses a PRNG seeded from the draw seed, so the page never calls `Math.random` near a lottery result.
8. **Multi-shard rounds.** Every live round has one shard. Win detection refuses rounds with `entryShardCount !== 1` with a plain message rather than guessing global positions.
9. **Network fee in the summary.** The fee is sized by the wallet library at signing (rate 1200 shannons/kB), so the summary states it as "under 0.01 CKB, not returned".

## Review Focus

1. **The public node is slow, down, or its indexer lags.** Every tab must show a plain "can't reach the network, try again" card with a Retry button, never a blank section or a spinner that never ends. (Tests: Task 8.)
2. **A wallet holding claims from a round the app cannot find** (older deployment, or a claim sent from elsewhere). The card must be skipped silently, not crash My tickets. (Tests: Task 5.)
3. **A shared link to a round that does not exist, is ambiguous, or is not hex** (`#/round/zzzz/draw`). The app shows "We couldn't find that round" with a link to Rounds, never another round. (Tests: Task 6, Task 8.)
4. **The entry window closes, or the round fills, while the entry summary is open.** Confirm must re-read the tip and round and refuse with plain words before the wallet opens. (Tests: Task 10.)
5. **The operator's on-chain record disagrees with the browser's own derivation, or a reorg replaces an entropy block after the animation ran.** The draw screen must show an error and no winners. (Tests: Task 3, Task 13.)

---

### Task 1: Read the whole deployment in two scans

**Files:**
- Create: `apps/web/chain/round-cells.js`
- Test: `apps/web/test/round-cells.test.js`

**Interfaces:**
- Consumes: `createRpc().getCells` (`chain/rpc.js`), `decodeRoundConfigV1`, `decodeEntryShardDataV1`, `ROUND_CONFIG_SIZE`, `SHARD_DATA_SIZE` (`chain/codec.js`), `decodeAggregationState`, `AGGREGATION_STATE_SIZE` (`chain/ledger-codec.js`), `decodeRoundSeal`, `decodeEntropyRecord`, `sealSize`, `recordSize`, `SEAL_VERSION`, `RECORD_VERSION` (`chain/seal-codec.js`), `CLAIM_ARGS_SIZE`, `CLAIM_TAG`, `ENTRY_DATA_SIZE`, `decodeEntryDataV1` (`chain/entry-codec.js`).
- Produces (global `window.DaowowRoundCells`):
  - `async readDeployment(rpc, manifest) -> RoundSnapshot[]`, sorted by `(config.entryStart, config.roundId)` ascending. `RoundSnapshot = { config, outPoint, shards: Shard[], ledger: {state, capacity, outPoint}|null, seal: {seal, inclusionHeight: bigint, outPoint, capacity}|null, record: {record, outPoint}|null }`. `Shard` has the same shape `findShards` returns.
  - `async findClaims(rpc, manifest, lockScript) -> Claim[]`, `Claim = { commitment: string /* 64 hex, no 0x */, shardId: number, position: bigint, capacity: bigint, outPoint }`.
  - `async findMyEntries(rpc, manifest, participantLockHash) -> Entry[]`, same element shape as `findEntries`, plus `commitment`.
  - `decodeClaimArgs(hexArgs) -> { commitment, shardId, position } | null`.

How cells are told apart (all share the `entry-shard-type` code hash): shard = data length 101; ledger = 207 bytes with first byte 2; seal = `sealSize(config.entryShardCount)` bytes with first byte `SEAL_VERSION`; record = `recordSize(config.entryShardCount)` bytes with first byte `RECORD_VERSION`; claim = type args of exactly 45 bytes whose first byte is `CLAIM_TAG`. Shards attach to a round by `shard.roundId`; ledger, seal and record attach by the first 32 bytes of their type args equalling `config.commitment`. A seal's `inclusionHeight` is the `block_number` the indexer reports for the seal cell. `findClaims` searches by **lock** (the wallet's lock, exact) and keeps cells whose type is `entry-shard-type` with claim args. `findMyEntries` searches the `entry-lock` code hash with `args` set to the 32-byte participant lock hash and `script_search_mode: "prefix"`, so it returns one wallet's entries across all rounds in one scan.

- [ ] **Step 1: Write the failing tests** in `round-cells.test.js`, using a fake `rpc` whose `getCells` is an async generator over fixture cells built with the real encoders (`encodeRoundConfigV1`, `encodeEntryShardDataV1`, `encodeAggregationState`, `encodeRoundSeal`, `encodeEntropyRecord`, `encodeClaimArgs`) and the `round_seal` / `entropy_record` hex from `tests/vectors/daowow_core_vectors.json`:

```js
test("readDeployment buckets shard, ledger, seal and record under their own round", async () => {
  const rounds = await readDeployment(fakeRpc(twoRoundFixture), MANIFEST);
  assert.strictEqual(rounds.length, 2);
  assert.strictEqual(rounds[0].shards.length, 1);
  assert.strictEqual(rounds[0].ledger.state.closed, true);
  assert.strictEqual(rounds[0].record.record.inclusionHeight, 1234567n); // the vector's own height
  assert.strictEqual(rounds[1].ledger, null);
  assert.strictEqual(rounds[1].seal, null);
  assert.strictEqual(rounds[1].record, null);
});
test("rounds come back oldest first whatever order the indexer used", async () => { /* feed newest first; assert entryStart ascending */ });
test("a seal carries the block it was included in", async () => { /* block_number "0x3e8" -> inclusionHeight 1000n */ });
test("a cell of the right length but the wrong version byte is ignored", async () => { /* 207 bytes, first byte 9 -> ledger null */ });
test("a ledger whose args name another round's commitment is not attached", async () => {});
test("the scan count does not grow with the number of rounds", async () => { /* count getCells calls: exactly 2 for 1 round and for 5 rounds */ });
test("findClaims returns only claim-typed cells under the lock", async () => { /* fixture: 2 claims + 1 plain cell + 1 cell typed by another code hash -> 2 */ });
test("decodeClaimArgs round-trips encodeClaimArgs, and rejects wrong length or tag", () => {});
test("findMyEntries searches by participant prefix and returns each entry's commitment", async () => { /* assert the search key's args equals the lock hash and mode is "prefix" */ });
```

- [ ] **Step 2: Run** `node --test apps/web/test/round-cells.test.js`. Expected: FAIL, cannot find module.
- [ ] **Step 3: Implement `round-cells.js`** to the interfaces above. Convert out points with the same `{txHash, index: Number}` shape `discovery.js` uses.
- [ ] **Step 4: Run** the test file, then the whole suite. Expected: PASS, 385 + new.
- [ ] **Step 5: Mutation probes.** (a) Drop the version-byte check on ledgers → "wrong version byte" goes red. (b) Attach ledgers without comparing the commitment → "another round's commitment" goes red. (c) Call `getCells` inside the per-round loop → "scan count" goes red. Restore after each.
- [ ] **Step 6: Commit** `feat: read a whole deployment's round cells in two scans`.

### Task 2: Wall-clock time from the chain's clock

**Files:**
- Create: `apps/web/dapp/model/time.js`
- Test: `apps/web/test/model-time.test.js`

**Interfaces:**
- Produces (`window.DaowowTime`):
  - `EPOCH_MS = 14400000n` (a CKB epoch targets four hours).
  - `parseEpoch(hexField) -> { number: bigint, index: bigint, length: bigint }` (RFC 0017: low 24 bits number, next 16 index, next 16 length).
  - `msUntilEpoch(targetEpoch: bigint, tipEpoch: {number,index,length}) -> bigint` — `(target − number) × EPOCH_MS − index × EPOCH_MS / length`, floored at `0n`; `length === 0n` is treated as index 0.
  - `msUntilBlock(targetHeight: bigint, tipHeight: bigint, msPerBlock = 10000n) -> bigint`, floored at `0n`.
  - `describeDuration(ms: bigint) -> string` — always begins "about": under 1 minute "about a minute"; under 90 minutes "about N min"; under 48 hours "about N h"; otherwise "about N days". N is rounded to the nearest whole unit.
  - `describeDate(ms: bigint, nowMs: number, locale = "en-AU") -> string` — "around 12 Dec".

- [ ] **Step 1: Write the failing tests:**

```js
test("parseEpoch splits the packed field", () => {
  // number 14163, index 450, length 1800
  const f = "0x" + ((1800n << 40n) | (450n << 24n) | 14163n).toString(16);
  assert.deepStrictEqual(parseEpoch(f), { number: 14163n, index: 450n, length: 1800n });
});
test("a quarter of the way through an epoch, the next one is three hours off", () => {
  assert.strictEqual(msUntilEpoch(14164n, { number: 14163n, index: 450n, length: 1800n }), 10800000n);
});
test("a target already reached is zero, never negative", () => {
  assert.strictEqual(msUntilEpoch(14000n, { number: 14163n, index: 0n, length: 1800n }), 0n);
});
test("a zero-length epoch field does not divide by zero", () => {
  assert.strictEqual(msUntilEpoch(2n, { number: 1n, index: 0n, length: 0n }), 14400000n);
});
test("every duration says 'about'", () => {
  assert.strictEqual(describeDuration(30000n), "about a minute");
  assert.strictEqual(describeDuration(45n * 60000n), "about 45 min");
  assert.strictEqual(describeDuration(18n * 3600000n), "about 18 h");
  assert.strictEqual(describeDuration(30n * 86400000n), "about 30 days");
});
test("256 blocks is about 43 minutes", () => {
  assert.strictEqual(describeDuration(msUntilBlock(1256n, 1000n)), "about 43 min");
});
```

- [ ] **Step 2: Run** the test. Expected: FAIL.
- [ ] **Step 3: Implement `time.js`.**
- [ ] **Step 4: Run** test + suite. Expected: PASS.
- [ ] **Step 5: Mutation probe.** Remove the floor at zero → "never negative" goes red. Restore.
- [ ] **Step 6: Commit** `feat: wall-clock wording for chain time`.

### Task 3: The browser derives the draw record itself

**Files:**
- Create: `apps/web/chain/entropy-derive.js`
- Test: `apps/web/test/entropy-derive.test.js`

**Interfaces:**
- Consumes: `entropyHeights` (`chain/entropy-tx.js`), `encodeEntropyRecord`, `RECORD_VERSION` (`chain/seal-codec.js`).
- Produces (`window.DaowowEntropyDerive`):
  - `entropyBlockHeights(inclusionHeight) -> [bigint, bigint, bigint, bigint]` — the four blocks the record is built from: `[h, h+64, h+128, h+192]`.
  - `lastEntropyHeight(inclusionHeight) -> bigint` — `h + 192n`. This is "Block N" in the honesty line and the countdown target.
  - `deriveEntropyRecord({ seal, inclusionHeader, entropyHeaders }) -> EntropyRecord` — same field shape as `buildEntropyTx(...).expectedRecord`. Throws unless `entropyHeaders` has exactly 3 entries whose `number`s are `+64`, `+128`, `+192` in that order.
  - `recordsAgree(a, b) -> boolean` — byte equality of `encodeEntropyRecord(a)` and `encodeEntropyRecord(b)`.
  - `async readEntropyHeaders(rpc, inclusionHeight) -> { inclusionHeader, entropyHeaders } | null` — four `get_header_by_number` calls; `null` if any is not mined yet. Each returned header is `{ number, hash }`.

- [ ] **Step 1: Write the failing tests**, reusing the fixture setup at the top of `entropy-tx.test.js` (`V.entropy_record`, `sealCell`, `inclusionHeader`, `entropyHeaders`, `base()`):

```js
test("the derived record is byte-identical to the Rust vector", () => {
  const record = deriveEntropyRecord({ seal: SEAL, inclusionHeader, entropyHeaders });
  assert.strictEqual(hex(encodeEntropyRecord(record)), V.entropy_record.hex);
});
test("it equals what the operator's transaction builder would post", () => {
  assert.ok(recordsAgree(
    deriveEntropyRecord({ seal: SEAL, inclusionHeader, entropyHeaders }),
    buildEntropyTx(base()).expectedRecord));
});
test("swapped entropy headers are refused, not silently reordered", () => {
  assert.throws(() => deriveEntropyRecord({ seal: SEAL, inclusionHeader,
    entropyHeaders: [entropyHeaders[1], entropyHeaders[0], entropyHeaders[2]] }), /\+64/);
});
test("one differing block hash means the records do not agree", () => {
  const other = { ...good, entropyHashes: [good.entropyHashes[0], "00".repeat(32), good.entropyHashes[2]] };
  assert.strictEqual(recordsAgree(good, other), false);
});
test("the countdown target is the +192 block", () => {
  assert.strictEqual(lastEntropyHeight(1000n), 1192n);
});
test("readEntropyHeaders is null until the last block exists", async () => {
  // fake rpc returns null for height 1192
});
```

(Use the vector's real key names; read `entropy-tx.test.js` lines 20–60 for them.)

- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement `entropy-derive.js`.** Header hashes are taken as the node reports them, exactly as `entropy-tx.js` does.
- [ ] **Step 4: Run** test + suite. Expected: PASS.
- [ ] **Step 5: Mutation probes.** (a) Skip the height check → "swapped" goes red. (b) Make `recordsAgree` compare only `inclusionHash` → "one differing block hash" goes red. Restore.
- [ ] **Step 6: Commit** `feat: derive the draw record in the browser, pinned to the Rust vector`.

### Task 4: Round states a player understands

**Files:**
- Create: `apps/web/dapp/model/round-state.js`
- Test: `apps/web/test/model-round-state.test.js`

**Interfaces:**
- Consumes: `SHARD_STATE` (`chain/codec.js`).
- Produces (`window.DaowowRoundState`):
  - `PLAYER_STATE = { UPCOMING: "upcoming", OPEN: "open", WAITING: "waiting", DRAWN: "drawn", REFUNDS: "refunds", FINISHED: "finished" }` (frozen).
  - `derivePlayerState({ snapshot, nowEpoch, entropyReady, liveEntryCount }) -> { state, ticketsSold: bigint, cap: bigint|null, full: boolean, viable: boolean }`. `snapshot` is a `RoundSnapshot` (Task 1). `entropyReady` is true once the `+192` block exists for the seal. `liveEntryCount` is the number of entry cells still on chain for the round.
  - `groupRounds(rows) -> { open, upcoming, waiting, finished }` where each row is `{ snapshot, view }`; group membership is given below the rules table; each group is newest first (by `entryStart` descending).
  - `roundLabels(snapshots) -> Map<roundId, string>` — "Round 1", "Round 2"… by `(entryStart, roundId)` ascending.

Rules, first match wins (`sold` = sum of shard `ticketCount`; `frozen` = at least one shard and every shard `FROZEN`; `accepted` = `ledger.state.acceptedTickets`):

| # | Condition | State |
|---|---|---|
| 1 | `record` present, or (`seal` present and `entropyReady`) | DRAWN |
| 2 | `ledger` closed and `accepted < minimumTickets` and `liveEntryCount > 0` | REFUNDS |
| 3 | `ledger` closed and `accepted < minimumTickets` | FINISHED |
| 4 | not frozen and `nowEpoch >= entryEnd` and `sold === 0n` | FINISHED |
| 5 | frozen, or `nowEpoch >= entryEnd` | WAITING |
| 6 | `nowEpoch < entryStart` | UPCOMING |
| 7 | otherwise | OPEN |

`entryStart` is inclusive, `entryEnd` exclusive. `full` is `cap !== null && sold >= cap`. `viable` is `sold >= minimumTickets`. `groupRounds`: OPEN → `open`; UPCOMING → `upcoming`; WAITING → `waiting`; DRAWN, REFUNDS and FINISHED → `finished` (DRAWN and REFUNDS cards carry their own badge and action there).

- [ ] **Step 1: Write the failing tests**, one per rule plus boundaries:

```js
test("before entry start it is upcoming", () => {});
test("AT entry start it is open (inclusive)", () => {});
test("one epoch before entry end it is still open", () => {});
test("AT entry end it is waiting (exclusive), even though no shard is frozen yet", () => {});
test("a frozen round is waiting", () => {});
test("past entry end with nothing sold it is finished, not waiting forever", () => {});
test("a closed ledger below the minimum with entries still on chain means refunds are open", () => {});
test("the same round with no entries left is finished", () => {});
test("a closed ledger AT the minimum is waiting, not refunds", () => {});
test("a sealed round is waiting until its last entropy block exists", () => { /* seal present, entropyReady false -> WAITING */ });
test("a sealed round with its entropy blocks mined is drawn before the operator posts the record", () => {});
test("a round with a record on chain is drawn", () => {});
test("an open round at its cap is open and full", () => {});
test("an uncapped round reports cap null and is never full", () => {});
test("labels number rounds oldest first and do not depend on input order", () => {});
test("groups list newest first", () => {});
```

- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement `round-state.js`.**
- [ ] **Step 4: Run** test + suite. Expected: PASS.
- [ ] **Step 5: Mutation probes.** (a) `>=` → `>` on entry end → "AT entry end" red. (b) `<` → `<=` on the minimum → "AT the minimum" red. (c) Delete rule 4 → "nothing sold" red. (d) Drop `entropyReady` from rule 1 → "before the operator posts" red. One at a time, restore each.
- [ ] **Step 6: Commit** `feat: six player-facing round states`.

### Task 5: My tickets across every round

**Files:**
- Create: `apps/web/dapp/model/tickets.js`
- Test: `apps/web/test/model-tickets.test.js`

**Interfaces:**
- Consumes: `PLAYER_STATE` (Task 4), `refundBlocker` (`chain/refund-tx.js`).
- Produces (`window.DaowowTickets`):
  - `OUTCOME = { IN_ROUND: "in-round", WAITING: "waiting", REFUNDABLE: "refundable", DID_NOT_RUN: "did-not-run", WON: "won", NOT_THIS_TIME: "not-this-time" }`.
  - `ACTION = { ENTER_MORE: "enter-more", REFUND: "refund", WATCH_DRAW: "watch-draw", CLAIM_SOON: "claim-soon", RETIRE_SOON: "retire-soon", NONE: "none" }`.
  - `buildMyTickets({ rows, claims, entries, draws, nowEpoch }) -> TicketCard[]`, newest round first. `rows` = `[{ snapshot, view }]`; `claims` from `findClaims`; `entries` from `findMyEntries`; `draws` = `Map<commitment, ComputedDraw>` for drawn rounds. `TicketCard = { roundId, commitment, ticketsHeld: number, positions: bigint[], outcome, actions: string[], wins: [{ place: number, position: bigint }], refundable: Entry[], blocked: [{ entry, reason: string }] }`.

Rules: a card exists for a round when the wallet holds at least one claim or at least one entry cell in it. `ticketsHeld` is the number of claims (claims are minted at entry, so entry cells are never added to it). Claims or entries whose commitment matches no row are dropped. `wins` are the held claim positions that appear in `draw.positions` (`place = prizeIndex + 1`), and are only computed when `config.entryShardCount === 1`; otherwise the card carries `outcome: WAITING` and `multiShard: true`. Outcome by round state: OPEN → IN_ROUND (`[ENTER_MORE]`, or `[]` if `view.full`); UPCOMING/WAITING → WAITING (`[]`); REFUNDS → REFUNDABLE if any of the wallet's entries has `refundBlocker(...) === null` (`[REFUND]`), else DID_NOT_RUN (`[RETIRE_SOON]`); FINISHED → DID_NOT_RUN (`[RETIRE_SOON]`); DRAWN with `draw.viable` and a win → WON (`[WATCH_DRAW, CLAIM_SOON]`); DRAWN with `draw.viable` and no win → NOT_THIS_TIME (`[WATCH_DRAW, RETIRE_SOON]`); DRAWN and not viable → DID_NOT_RUN (`[RETIRE_SOON]`). `refundBlocker` is called with `ledger: snapshot.ledger ? snapshot.ledger.state : null`.

- [ ] **Step 1: Write the failing tests:**

```js
test("ticketsHeld counts claims, not entry cells, so nothing is counted twice", () => { /* 1 entry of 5 tickets + 5 claims -> 5 */ });
test("a claim sent from another wallet counts for the holder", () => { /* claims but no entries -> card exists */ });
test("the holder of a winning claim wins", () => { /* positions [3n,7n], draw.positions [{prizeIndex:0, position:3}] -> WON, wins [{place:1, position:3n}] */ });
test("a drawn round with no winning claim is 'not this time'", () => {});
test("a failed round with a refundable entry offers Refund", () => {});
test("a failed round whose entry is blocked reports the reason and offers no Refund", () => {});
test("after the refund, the remaining claims leave a did-not-run card", () => { /* entries [], claims 5, REFUNDS/FINISHED */ });
test("a claim from a round the app cannot find is skipped, not thrown", () => {});
test("an open, full round offers no Enter more", () => {});
test("a drawn but unviable round is did-not-run, never 'not this time'", () => {});
test("a multi-shard round is flagged rather than given a guessed result", () => {});
test("cards come back newest round first", () => {});
```

- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement `tickets.js`.**
- [ ] **Step 4: Run** test + suite. Expected: PASS.
- [ ] **Step 5: Mutation probes.** (a) Add entry `ticketCount` into `ticketsHeld` → "counted twice" red. (b) Compare wins by entry ownership instead of held claims → "sent from another wallet" / "holder wins" red. (c) Throw on unknown commitment → "skipped" red. (d) Ignore `draw.viable` → "unviable" red.
- [ ] **Step 6: Commit** `feat: my tickets across all rounds, from claims and entries`.

### Task 6: Hash routes

**Files:**
- Create: `apps/web/dapp/model/route.js`
- Test: `apps/web/test/model-route.test.js`

**Interfaces:**
- Produces (`window.DaowowRoute`):
  - `parseRoute(hash: string) -> { tab: "home"|"rounds"|"tickets"|"how", round: string|null, panel: "enter"|"draw"|null, unknown: boolean }`.
  - `formatRoute({ tab, round, panel }) -> string`.
  - `TABS = ["home", "rounds", "tickets", "how"]`.

Rules: `""`, `"#"`, `"#/"` → home. `#/round/<hex 4–64>/enter` → `{ tab: "rounds", round, panel: "enter" }`; `/draw` likewise. The round token must match `/^[0-9a-f]{4,64}$/i` and is lower-cased; anything else, and any unrecognised path, yields `{ tab: "home", round: null, panel: null, unknown: true }`. `formatRoute` emits the first 8 chars of the round id.

- [ ] **Step 1: Write the failing tests:**

```js
test("empty hash is home", () => assert.deepStrictEqual(parseRoute(""), { tab: "home", round: null, panel: null, unknown: false }));
test("each tab parses", () => { for (const t of TABS) assert.strictEqual(parseRoute(`#/${t}`).tab, t); });
test("a round draw link parses", () => assert.deepStrictEqual(parseRoute("#/round/AFFB66F7/draw"),
  { tab: "rounds", round: "affb66f7", panel: "draw", unknown: false }));
test("a non-hex round token is unknown, never a route", () => assert.strictEqual(parseRoute("#/round/zzzz/draw").unknown, true));
test("markup in the hash is unknown", () => assert.strictEqual(parseRoute('#/round/<img src=x>/enter').unknown, true));
test("an unknown panel is unknown", () => assert.strictEqual(parseRoute("#/round/affb66f7/steal").unknown, true));
test("format and parse round-trip", () => {});
```

- [ ] **Step 2–4:** Run (FAIL), implement, run test + suite (PASS).
- [ ] **Step 5: Mutation probe.** Loosen the token regex to `.+` → "non-hex" and "markup" red.
- [ ] **Step 6: Commit** `feat: hash routes for tabs and round panels`.

### Task 7: Prize pool so far

**Files:**
- Create: `apps/web/chain/dao-yield.js`, `apps/web/dapp/model/prize-estimate.js`
- Test: `apps/web/test/dao-yield.test.js`, `apps/web/test/model-prize-estimate.test.js`

**Interfaces:**
- Produces (`window.DaowowDaoYield`):
  - `accumulatedRate(header) -> bigint` — little-endian u64 at bytes 8..16 of `header.dao`.
  - `occupiedCapacity(cell) -> bigint` shannons — `(8 + 33 + lockArgsBytes + (type ? 33 + typeArgsBytes : 0) + dataBytes) × 10^8`.
  - `maximumWithdraw({ capacity, occupied, depositAr, currentAr }) -> bigint` — `occupied + (capacity − occupied) × currentAr / depositAr` (integer division).
  - `async findDaoDeposits(rpc, manifest, config) -> [{ capacity, occupied, blockNumber: bigint, outPoint }]` — cells locked by the config's `daoLock` whose lock args start with `roundId` and carry `config.commitment` at bytes 40..72, and whose data is 8 zero bytes (a deposit, not a withdrawal in progress).
  - `async readPoolSoFar(rpc, manifest, config, tipHeader) -> bigint | null` — `null` when there is no deposit; otherwise the sum over deposits of `maximumWithdraw − capacity`, each using the accumulated rate of the deposit's own block header (`get_header_by_number`) and of `tipHeader`.
- Produces (`window.DaowowPrizeEstimate`):
  - `allocatePrizes(weights: bigint[], pool: bigint) -> bigint[]` — each place gets `floor(pool × w / W)`; the remainder goes to place 1. Port of `allocate_prizes_complete` in `crates/daowow-core/src/accounting.rs`. Throws on empty or zero weights.
  - `estimatePrizes({ schedule, tickets, poolSoFar }) -> { pool: bigint, prizes: bigint[] } | null` — `null` when `poolSoFar` is `null`; uses `schedule.weights.slice(0, placesFor(schedule, tickets))`.
  - `shareOf(schedule, tickets, place) -> { weight: bigint, total: bigint }`.

The deposit's capacity equals the batch's summed entry capacity (`aggregate-tx.js`, output 1), and the contract's prize pool is `realized − that capacity` (`entitlements.rs`), so nothing else is deducted.

- [ ] **Step 1: Write the failing tests:**

```js
// dao-yield
test("the accumulated rate is bytes 8..16 of the dao field, little-endian", () => {
  const dao = "0x" + "11".repeat(8) + "0080c6a47e8d0300" + "22".repeat(16);
  assert.strictEqual(accumulatedRate({ dao }), 1000000000000000n);
});
test("maximumWithdraw matches the devnet oracle's formula", () => {
  // tests/devnet/test_native_dao.py: occupied + (capacity - occupied) * withdrawal_ar // deposit_ar
  const CKB = 100000000n;
  assert.strictEqual(maximumWithdraw({ capacity: 10000n * CKB, occupied: 95n * CKB,
    depositAr: 10000000000000000n, currentAr: 10010000000000000n }), 95n * CKB + 9905n * CKB * 1001n / 1000n);
});
test("interest accrues on the free capacity only, never the occupied part", () => { /* occupied === capacity -> exactly capacity */ });
test("occupiedCapacity counts script fields, not their molecule encoding", () => { /* 104-byte lock args, DAO type with 0 args, 8 data bytes -> 186 CKB */ });
test("a withdrawing cell (non-zero data) is not counted as a deposit", async () => {});
test("a deposit under another round's id is not counted", async () => {});
test("no deposit means null, not zero", async () => { assert.strictEqual(await readPoolSoFar(emptyRpc, MANIFEST, CONFIG, TIP), null); });
// prize-estimate
test("allocation floors each share and gives the remainder to first place", () => {
  assert.deepStrictEqual(allocatePrizes([3n, 7n], 3n), [1n, 2n]);   // accounting.rs's own example
  assert.deepStrictEqual(allocatePrizes([50n, 30n, 20n], 101n), [51n, 30n, 20n]);
});
test("the allocation always sums to the pool", () => {});
test("only the places open at this ticket count share the pool", () => {});
test("before any deposit there is no estimate", () => assert.strictEqual(estimatePrizes({ schedule, tickets: 10n, poolSoFar: null }), null));
```

- [ ] **Step 2–4:** Run (FAIL), implement both files, run tests + suite (PASS).
- [ ] **Step 5: Mutation probes.** (a) Multiply the whole capacity by the rate → "free capacity only" red. (b) Give the remainder to the last place → "remainder to first place" red. (c) Return `0n` for no deposit → "null, not zero" red.
- [ ] **Step 6: Commit** `feat: prize pool so far from real DAO interest`.

### Task 8: The app shell

**Files:**
- Create: `apps/web/dapp/app/main.js`, `apps/web/dapp/app/store.js`, `apps/web/dapp/app/dom.js`, `apps/web/dapp/app/chain-read.js`, `apps/web/dapp/model/copy.js`, `apps/web/dapp/manifest.json`, `tools/public-manifest.mjs`
- Rewrite: `apps/web/dapp/index.html`, `apps/web/dapp/dapp.css`
- Delete: `apps/web/dapp/dapp.js`
- Modify: `apps/web/test/page-scripts.test.js` (the `PAGES` table), `apps/web/test/dapp.test.js`
- Test: `apps/web/test/app-shell.test.js`, `apps/web/test/model-copy.test.js`, `apps/web/test/store.test.js`

**Interfaces:**
- Consumes: Tasks 1–7; `createWallet` (`chain/wallet.js`); `loadManifest`; `createRpc`.
- Produces:
  - `dom.js` (ES module): `h(tag, props, ...children) -> Element` (props: `class`, `id`, `hidden`, `href`, `type`, `disabled`, `aria-*`, `data-*`, `on<event>`; string children appended as text), `clear(node)`, `showError(node, headline, detail)` (detail inside `<details><summary>Technical details</summary>`), `showRetry(node, headline, onRetry)`.
  - `chain-read.js` (ES module): `fetchSchedule(rpc, round) -> Uint8Array` moved verbatim from `dapp/entry.js` with its commitment check; `scriptHash` re-exported from `DaowowRefundTx`.
  - `store.js` (ES module): `createStore({ manifest, rpc, readers }) -> { state, subscribe(fn), refresh(), setSession(session|null) }`. `readers` defaults to the real chain functions and is injected in tests. `state = { status: "loading"|"ready"|"error", error, tip: { height: bigint, epoch: {number,index,length}, header }, rows: [{ snapshot, view, label, schedule|null, scheduleError|null, draw|null, drawError|null, pool: bigint|null }], session, mine: TicketCard[]|null, mineError }`. `refresh()` never throws; it sets `status: "error"`. A draw is computed for rows in state DRAWN: from `snapshot.record.record` if present, else from `deriveEntropyRecord` of `readEntropyHeaders`; when both exist and `recordsAgree` is false, `draw` is `null` and `drawError` is set.
  - `copy.js` (classic, `window.DaowowCopy`): every player-facing string as a function or constant: `stateBadge(state, view)`, `milestone(view, snapshot, tip)` ("closes in about 18 h"), `outcomeBadge(outcome)`, `actionLabel(action)`, `ticketsLine(sold, cap)`, `errors.network`, `errors.roundNotFound`, `errors.wallet(message)`, `connectPrompt`, `honestyLine(height)`, `estimateLine(shannons)` ("about 41 CKB so far, still growing"), `claimSoon`, `retireSoon`. It also exports `ALL_SAMPLES()` returning every string it can produce for a fixed set of inputs, used by the jargon test.
- `index.html` structure: header (logo, `#wallet` pill); `<main>` with `<section id="view-home">`, `#view-rounds`, `#view-tickets`, `#view-how`, `#view-panel` (entry and draw panels), all but one `hidden`; `<nav id="tabs">` with four `<a href="#/home">` style links; a "Testnet" banner; no footer showing node URL or epoch. Classic scripts first in dependency-tolerant order, then `<script type="module" src="app/main.js">`.
- `dapp.css`: tab bar fixed to the bottom under 720px, moved under the header at 720px and wider; 16px side gutters; no horizontal scroll at 360px; `prefers-reduced-motion` respected.
- `manifest.json`: produced by `node tools/public-manifest.mjs`, which copies `deployments/dev-testnet-manifest.json` and sets `rpcUrl` to `https://testnet.ckb.dev`.
- Wallet pill: "Connect wallet" → on success `ckt1…<last 6> · <balance> CKB`; clicking it when connected opens a small menu with Disconnect. `wallet.restore()` runs at boot. A connect failure shows `copy.errors.wallet(e.message)` in a visible banner (the `9a39837` behaviour).

- [ ] **Step 1: Write the failing tests.**

```js
// app-shell.test.js
test("the shell carries the exact CSP and no LAN address", () => {
  const html = read("dapp/index.html");
  assert.match(html, /connect-src 'self' https:\/\/testnet\.ckb\.dev;/);
  assert.doesNotMatch(html, /192\.168\./);
  assert.match(html, /script-src 'self';/);
});
test("no file under dapp/ writes HTML from a string", () => {
  for (const f of walk("dapp")) assert.doesNotMatch(read(f), /innerHTML|outerHTML|insertAdjacentHTML|document\.write/, f);
});
test("the shell has the four tabs in order and one section per tab", () => { /* hrefs #/home #/rounds #/tickets #/how; ids view-home… */ });
test("no inline script, style attribute or event handler attribute in the shell", () => {
  assert.doesNotMatch(html, /<script(?![^>]*\bsrc=)/); assert.doesNotMatch(html, /\sstyle=|\son[a-z]+=/);
});
test("the public manifest is the dev deployment with only the node address changed", () => {
  const pub = JSON.parse(read("dapp/manifest.json")); const dev = JSON.parse(readRoot("deployments/dev-testnet-manifest.json"));
  assert.strictEqual(pub.rpcUrl, "https://testnet.ckb.dev");
  assert.deepStrictEqual({ ...pub, rpcUrl: null }, { ...dev, rpcUrl: null });
});
test("nothing under dapp/ reads ?manifest= or ?round= any more", () => {
  for (const f of walk("dapp")) assert.doesNotMatch(read(f), /get\("manifest"\)|get\("round"\)/, f);
});
// model-copy.test.js
test("no banned word reaches the player", () => {
  const banned = /\b(epochs?|shards?|cells?|ledgers?|freez\w*|frozen|genesis|aggregat\w*|commitments?|out ?points?|lock hash|witness\w*)\b/i;
  for (const s of ALL_SAMPLES()) assert.doesNotMatch(s, banned, s);
});
test("a time milestone always says 'about'", () => {});
test("the estimate line says it is still growing", () => assert.match(estimateLine(4100000000n), /about 41 CKB so far, still growing/));
// store.test.js (import the ES module; inject fake readers)
test("a failing node leaves status 'error' and does not throw", async () => {});
test("a retry after a failure reaches 'ready'", async () => {});
test("rows are labelled Round 1..N oldest first and never by indexer order", async () => {});
test("a round whose published schedule fails its commitment check gets scheduleError and no schedule", async () => {});
test("a derived record that disagrees with the on-chain record yields drawError and no draw", async () => {});
test("without a session, mine is null; with one, it is built from that lock's claims and entries", async () => {});
test("the rpc URL comes from the manifest, and the store never reads location", async () => {});
```

Update `page-scripts.test.js`: `PAGES` becomes `{ "index.html": [...] }` listing every `Daowow*` global the app reads (`DaowowCore`, `DaowowCodec`, `DaowowEntryCodec`, `DaowowLedgerCodec`, `DaowowSealCodec`, `DaowowManifest`, `DaowowRpc`, `DaowowDiscovery`, `DaowowRoundCells`, `DaowowSchedule`, `DaowowQuote`, `DaowowMmrWitness`, `DaowowEntryTx`, `DaowowContention`, `DaowowShardPeaks`, `DaowowShardHistory`, `DaowowConfirm`, `DaowowRefundTx`, `DaowowDraw`, `DaowowEntropyTx`, `DaowowEntropyDerive`, `DaowowDaoYield`, `DaowowEntryView`, `DaowowTime`, `DaowowRoundState`, `DaowowTickets`, `DaowowRoute`, `DaowowPrizeEstimate`, `DaowowCopy`). Add a hostile-order case for `round-cells.js`, `entropy-derive.js` and `dao-yield.js` evaluated before their dependencies. In `dapp.test.js`, delete the `isSafeManifestUrl` test (the parameter no longer exists) and repoint the two source-scan tests at `app/main.js` and `app/store.js`.

- [ ] **Step 2: Run** the three new test files and `page-scripts.test.js`. Expected: FAIL.
- [ ] **Step 3: Write `tools/public-manifest.mjs`** and run it to produce `apps/web/dapp/manifest.json`.
- [ ] **Step 4: Write `copy.js`, `dom.js`, `chain-read.js`, `store.js`.**
- [ ] **Step 5: Write `index.html`, `dapp.css`, `main.js`.** `main.js` boots in this order: fetch `./manifest.json` → `loadManifest` → `createRpc(manifest.rpcUrl)` → create store → render tab from `parseRoute(location.hash)` → `store.refresh()` → `wallet.restore()`. It listens for `hashchange`, shows exactly one section, sets `aria-current="page"` on the active tab, and for `unknown` routes shows `copy.errors.roundNotFound` with a link to `#/rounds`. Each section in this task renders only a loading card, the error-with-Retry card, or a placeholder heading; Tasks 9–11 fill them.
- [ ] **Step 6: Run** the suite. Expected: PASS.
- [ ] **Step 7: Verify in a browser.** The dev server is already running on port 8931 (`python3 -m http.server 8931 --bind 127.0.0.1` from the repo root; do not start a second one). Open `http://127.0.0.1:8931/apps/web/dapp/` at 390px and 1280px widths: four tabs switch without a reload, the tab bar is at the bottom on the narrow width and under the header on the wide one, the console shows no CSP violation, and the network tab shows requests only to the page's origin and `testnet.ckb.dev`.
- [ ] **Step 8: Mutation probes.** (a) Make `refresh()` rethrow → "does not throw" red. (b) Skip `recordsAgree` in the store → "disagrees" red. (c) Add `innerHTML` to any view → "writes HTML" red. (d) Put "epoch" in one `copy.js` string → jargon test red.
- [ ] **Step 9: Commit** `feat: one-app shell with tab bar, wallet pill and shared store`.

### Task 9: Home and Rounds

**Blocked on:** Phill confirming decision 1 (timeline order).

**Files:**
- Create: `apps/web/dapp/app/views/home.js`, `apps/web/dapp/app/views/rounds.js`, `apps/web/dapp/app/views/round-card.js`, `apps/web/dapp/model/timeline.js`
- Modify: `apps/web/dapp/app/main.js`, `apps/web/dapp/index.html` (static Home copy), `apps/web/dapp/model/copy.js`
- Test: `apps/web/test/model-timeline.test.js`, extend `model-copy.test.js`

**Interfaces:**
- Consumes: store `state.rows`, `groupRounds`, `describeDuration`, `msUntilEpoch`, `describePayout` (`dapp/entry-view.js`), `claimCellCapacity` and `entryCellCapacity` (`chain/quote.js`), `estimatePrizes`.
- Produces:
  - `timeline.js` (`window.DaowowTimeline`): `buildTimeline({ snapshot, view, tip }) -> [{ key: "opens"|"closes"|"draw"|"term"|"payout", label: string, when: string, done: boolean, here: boolean }]`. Exactly one step has `here: true`. `when` for a future epoch boundary comes from `describeDuration(msUntilEpoch(...))`; the term step's `when` is `describeDuration(BigInt(config.daoTermPeriods) × 180n × EPOCH_MS)`; the draw step before sealing reads "soon after entries close".
  - `round-card.js`: `renderRoundCard(row, { session, onEnter, onWatchDraw }) -> Element` — label, state badge, tickets-sold bar (`ticketsLine`), milestone line, and one action: **Enter** when OPEN and not full; **Watch the draw** when DRAWN; none otherwise. A `<details>` "Details" holds the round id hex.
  - `home.js`: `renderHome(node, state, nav)`; `rounds.js`: `renderRounds(node, state, nav)`.
- Home content, in order: one-sentence promise ("Everyone gets their deposit back. Prizes come from the interest the pool earns."); the four explainer blocks (How the savings pool works · How long it takes · What it costs · What you can win); the current-round card (`selectRound(rounds)` — the newest by entry start); primary button **Enter the current round** → `#/round/<id8>/enter` (disabled with a reason when the newest round is not OPEN). "What it costs" shows the ticket price from the current round's config, the per-ticket returned deposit (`claimCellCapacity` of the connected lock; when not connected, both figures: "222 CKB with a JoyID wallet" computed from a 22-byte-args lock, never typed as a constant), and the fee line. "What you can win" renders `describePayout(schedule, sold, cap)` and, when `row.pool !== null`, the pool-so-far line.
- Rounds: four headed groups in the order Open now, Upcoming, Waiting for draw, Finished; an empty group is omitted; if all are empty, one card "No rounds yet."

- [ ] **Step 1: Write the failing tests:**

```js
test("an open round is 'here' at 'closes'", () => {});
test("after entries close and before the draw, 'here' is the draw step", () => {});
test("a drawn round is 'here' at the savings term until payout exists", () => {});
test("exactly one step is 'here' in every state", () => { for (const s of ALL_STATES) assert.strictEqual(buildTimeline(fixture(s)).filter((x) => x.here).length, 1); });
test("the draw comes before the savings term", () => { assert.deepStrictEqual(keys, ["opens", "closes", "draw", "term", "payout"]); });
test("the term length comes from the round, 180 four-hour periods each", () => { /* daoTermPeriods 1 -> "about 30 days" */ });
test("timeline labels carry no banned word", () => {});
```

- [ ] **Step 2–4:** Run (FAIL), implement, run suite (PASS).
- [ ] **Step 5: Verify in a browser** against live testnet: Home shows round `affb66f7` as the current round with live figures; Rounds lists it and omits nothing from the dev-testnet deployment; no round from the prototype deployment appears; no hex id is visible until "Details" is opened.
- [ ] **Step 6: Mutation probe.** Hard-code the term to "about 30 days" → "comes from the round" red (use `daoTermPeriods: 2` in the test).
- [ ] **Step 7: Commit** `feat: Home explainer and Rounds list`.

### Task 10: Entering a round inside the app

**Files:**
- Create: `apps/web/dapp/app/views/enter.js`, `apps/web/dapp/model/entry-guard.js`
- Modify: `apps/web/dapp/entry-view.js` (wording only), `apps/web/test/entry-view.test.js`, `apps/web/dapp/app/main.js`
- Delete: `apps/web/dapp/entry.js`; replace `apps/web/dapp/entry.html` with a refresh stub to `./#/rounds`
- Test: `apps/web/test/model-entry-guard.test.js`

**Interfaces:**
- Consumes: `quoteEntry`, `describeQuote`, `describePayout`, `describeTicketRequest`, `buildEntryTx`, `submitEntryWithRetry`, `readShardPeaks`, `awaitCommitted`, `awaitIndexer`, `fetchSchedule`, `scriptHash`, store.
- Produces:
  - `entry-guard.js` (`window.DaowowEntryGuard`): `entryProblem({ view, snapshot, tickets, nowEpoch }) -> string | null` — plain-words reason entry cannot proceed: state not OPEN ("Entries for this round have closed."), full, more tickets than remain, or `nowEpoch + 1n >= entryEnd` ("This round closes within the next few hours; an entry sent now may not arrive in time." — a warning the player must tick to override, returned as `{ warn: string }` instead of a string).
  - `enter.js`: `renderEnter(node, { row, store, nav })`.
- Summary wording (`describeQuote`), replacing today's labels: "Your tickets (N × price) — returned after the round" · "Ticket deposit (N) — held with your tickets, returned when the round is finished" · "Storage deposit — returned after the round" · "Network fee — under 0.01 CKB, not returned" · "Total leaving your wallet now". The duration note on the total reads from the round's own term, not "one to two months".
- Flow: ticket count → live summary → tick "I understand" → **Enter for X CKB**. On click, before the wallet opens: `store.refresh()`, then `entryProblem` on the fresh state; a problem stops the flow with that sentence. Then the existing `submitEntryWithRetry` sequence, unchanged, with plain status lines ("Checking the round…", "Approve in your wallet…", "Sending…", "Sent. Waiting for confirmation…", "Confirmed. Your N tickets are in the round."). After `awaitIndexer`, `store.refresh()` and a **See my tickets** button. Not connected → the button reads "Connect wallet to enter" and opens the connect flow, then returns here.

- [ ] **Step 1: Write the failing tests:**

```js
test("a round that closed while the summary was open is refused in plain words", () => {});
test("a round that filled while the summary was open is refused", () => {});
test("asking for more tickets than remain is refused with the number left", () => {});
test("an entry in the round's last period is a warning, not a refusal", () => { assert.ok(entryProblem(lastEpoch).warn); });
test("an ordinary entry has no problem", () => assert.strictEqual(entryProblem(ok), null));
// entry-view.test.js (updated)
test("the summary names the returned ticket deposit and says the fee is not returned", () => {});
test("no summary row uses a banned word", () => {});
test("the total row is the sum of every row above it", () => {});
```

- [ ] **Step 2–4:** Run (FAIL), implement, run suite (PASS).
- [ ] **Step 5: Verify in a browser.** Walk the flow against a live open round up to, not through, the wallet approval (no round may be open; if none is, verify the "Entries for this round have closed." path on `affb66f7` instead and say so in the task report).
- [ ] **Step 6: Mutation probes.** (a) Skip the pre-sign refresh → add a store-level test `the entry flow re-reads the round before the wallet opens` (inject a counting `refresh`) and confirm it goes red. (b) Remove the "full" branch → "filled" red.
- [ ] **Step 7: Request a security review** of `enter.js` and `entry-guard.js` (signing path) with the security-reviewer agent; fix CRITICAL and HIGH findings.
- [ ] **Step 8: Commit** `feat: enter a round from inside the app, with a full plain-words summary`.

### Task 11: My tickets and refunds

**Files:**
- Create: `apps/web/dapp/app/views/tickets.js`, `apps/web/dapp/app/views/refund.js`
- Modify: `apps/web/dapp/app/main.js`, `apps/web/dapp/model/copy.js`
- Delete: `apps/web/dapp/refund.js`; replace `apps/web/dapp/refund.html` with a refresh stub to `./#/tickets`
- Test: extend `apps/web/test/store.test.js`, `apps/web/test/model-copy.test.js`

**Interfaces:**
- Consumes: `state.mine` (Task 5 cards), `estimatePrizes`, `shareOf`, `buildRefundTx`, `readShardEntries`, `awaitCommitted`, `awaitIndexer`.
- Produces: `renderTickets(node, state, nav)`; `startRefund({ card, entry, row, store, say })`.
- Not connected → `copy.connectPrompt` with a Connect button. Connected with no cards → "No tickets yet" with a link to Rounds. Each card: round label, "N tickets", outcome badge, then by action: **Enter more** → entry route; **Refund X CKB** per refundable entry; **Watch the draw** → draw route; WON → "You won: 1st place, 50 of 100 shares" plus `estimateLine` when the row has a pool, plus the disabled-looking notice `copy.claimSoon` ("Prize claiming opens soon") rendered as text, never a button; RETIRE_SOON → `copy.retireSoon` as text. Blocked entries show "This can't be refunded yet" with the chain's reason inside Technical details.
- Refund keeps today's rules exactly: the replay set is `readShardEntries(rpc, ledger.outPoint, ledger.state.frozen.entryCount)`; if its length differs from `frozen.entryCount` the Refund button is not offered and the card says "We couldn't rebuild this round's history. Reload and try again." Before signing, a summary: "X CKB returns to your wallet · Network fee under 0.01 CKB, paid from your balance." After `awaitIndexer`, `store.refresh()`; the success line is the confirmation.

- [ ] **Step 1: Write the failing tests:**

```js
test("an incomplete history replay offers no refund", async () => { /* readers.readShardEntries returns one fewer */ });
test("the refund is built from the replayed history, not the cells still on chain", async () => { /* spy buildRefundTx: allEntries === replay set */ });
test("a won card with no pool yet shows place and share and no figure", () => {});
test("claim-soon and retire-soon are text, with no action attached", () => {});
```

- [ ] **Step 2–4:** Run (FAIL), implement, run suite (PASS).
- [ ] **Step 5: Verify in a browser** with a connected JoyID wallet holding the `affb66f7` tickets: one card, 5 tickets, correct badge for the round's current state.
- [ ] **Step 6: Mutation probe.** Pass the live entry list as `allEntries` → "replayed history" red.
- [ ] **Step 7: Request a security review** of `refund.js` (signing path); fix CRITICAL and HIGH findings.
- [ ] **Step 8: Commit** `feat: My tickets across rounds, with refunds on the card`.

### Task 12: Vendor Three.js

**Files:**
- Create: `tools/vendor-three.sh`, `apps/web/vendor/three.module.min.js`, `apps/web/vendor/three.lock.json`
- Modify: `apps/web/vendor/README.md`, `apps/web/test/vendor.test.js`

**Interfaces:**
- Produces: `apps/web/vendor/three.module.min.js` importable as `import * as THREE from "../../vendor/three.module.min.js"`.
- `three.lock.json`: `{ "artifactSha256": "<hex>", "packages": { "three": "0.170.0" }, "tarballIntegrity": "sha512-FQK+LEpYc0fBD+J8g6oSEyyNzjp+Q7Ks1C568WWaoMRLW+TkNNWmenWeGgJjV105Gd+p/2ql1ZcjYvNiPZBhuQ==", "source": "package/build/three.module.min.js", "regenerate": "tools/vendor-three.sh" }`.
- `vendor-three.sh`: in a fresh temp directory, `npm pack three@0.170.0 --ignore-scripts`; verify the tarball's sha512 equals the pinned integrity and exit non-zero if not; extract only `package/build/three.module.min.js`; write the lock.

- [ ] **Step 1: Write the failing tests** in `vendor.test.js`:

```js
test("the vendored Three.js matches its lock file", () => { /* sha256(file) === lock.artifactSha256 */ });
test("the Three.js lock pins 0.170.0 and its registry integrity", () => {});
test("the vendored Three.js is a single file with no imports of its own", () => {
  assert.doesNotMatch(src, /\bfrom\s*["'][^"']+["']/); assert.doesNotMatch(src, /\bimport\s*\(/);
});
test("the vendored Three.js needs no eval", () => assert.doesNotMatch(src, /\beval\(|new Function\(/));
```

- [ ] **Step 2: Run.** Expected: FAIL (file missing).
- [ ] **Step 3: Write and run `tools/vendor-three.sh`.**
- [ ] **Step 4: Run** `node --test apps/web/test/vendor.test.js`. Expected: PASS. If "no eval" fails, stop and report: the strict CSP forbids it and the version choice must be revisited with Phill.
- [ ] **Step 5: Mutation probe.** Append one byte to the artifact → sha256 test red. Restore with `git checkout`.
- [ ] **Step 6: Document** the artifact in `apps/web/vendor/README.md` (the opening line "the only third-party code" becomes two artifacts).
- [ ] **Step 7: Commit** `chore: vendor Three.js 0.170.0, hash-pinned`.

### Task 13: The draw, as a timeline and as an accessible result

**Files:**
- Create: `apps/web/dapp/model/draw-script.js`, `apps/web/dapp/app/views/draw.js`, `apps/web/dapp/app/draw/fallback.js`
- Modify: `apps/web/dapp/app/main.js`, `apps/web/dapp/model/copy.js`
- Test: `apps/web/test/model-draw-script.test.js`

**Interfaces:**
- Consumes: `computeDraw` result (`{ seed, tickets, places, viable, positions: [{ prizeIndex, position }] }`), `lastEntropyHeight`, `msUntilBlock`, store.
- Produces:
  - `draw-script.js` (`window.DaowowDrawScript`):
    - `MAX_BALLS = 40`.
    - `seededRandom(seedHex) -> () => number` in `[0, 1)` — a deterministic PRNG (xorshift128 seeded from the first 16 bytes of the seed).
    - `buildDrawScript({ draw, myPositions: bigint[] }) -> { balls: [{ id: bigint, label: string, mine: boolean, drawn: boolean }], reveals: [{ place: number, ticket: bigint, mine: boolean, atMs: number }], durationMs: number, viable: boolean }`. Every drawn position and every one of `myPositions` is always a ball; the rest are filled with the lowest undrawn positions up to `MAX_BALLS`. Labels are `position + 1` ("Ticket 4"). Reveals are in place order (1st place first), 3500 ms apart after a 3000 ms tumble.
    - `drawPhase({ snapshot, tipHeight, hasDraw }) -> { phase: "not-sealed"|"countdown"|"ready", blocksLeft: bigint, lastHeight: bigint|null }`.
  - `fallback.js`: `renderResultList(node, script, { honesty })` — an ordered list "1st place — Ticket 4 (yours)".
  - `draw.js`: `renderDraw(node, { row, store, nav })` — states: not sealed ("The draw hasn't been scheduled yet."); countdown ("The result is fixed when block N is mined, in about 20 min", refreshed with `store.refresh()` every 15 s while this panel is visible, and the timer cleared when it is not); ready → the stage (Task 14) or the fallback list; `drawError` → error card and **no** winners. Controls always present once ready: **Skip to results**, **Replay**. The honesty line `copy.honestyLine(lastHeight)` is always on screen in the ready state: "This result was fixed on-chain at block N. The animation only reveals it."
  - Fallback is used when `matchMedia("(prefers-reduced-motion: reduce)").matches`, when a WebGL context cannot be created, or when the stage throws.

- [ ] **Step 1: Write the failing tests:**

```js
test("reveals are the real draw, in place order", () => {
  const s = buildDrawScript({ draw: DRAW /* positions [{prizeIndex:1,position:7},{prizeIndex:0,position:3}] */, myPositions: [] });
  assert.deepStrictEqual(s.reveals.map((r) => [r.place, r.ticket]), [[1, 3n], [2, 7n]]);
});
test("the same draw always yields the same script", () => assert.deepStrictEqual(buildDrawScript(a), buildDrawScript(a)));
test("at 200 tickets there are at most 40 balls, and every winner is among them", () => {});
test("the viewer's own tickets are always among the balls and marked", () => {});
test("an unviable round has no reveals and says so", () => {});
test("the seeded generator is deterministic and differs between seeds", () => {});
test("neither the script nor the stage calls Math.random", () => {
  for (const f of ["dapp/model/draw-script.js", "dapp/app/draw/stage.js", "dapp/app/views/draw.js"])
    if (exists(f)) assert.doesNotMatch(read(f), /Math\.random/, f);
});
test("the countdown targets the +192 block and reaches ready exactly there", () => {
  assert.strictEqual(drawPhase({ snapshot: sealedAt(1000n), tipHeight: 1191n, hasDraw: false }).blocksLeft, 1n);
  assert.strictEqual(drawPhase({ snapshot: sealedAt(1000n), tipHeight: 1192n, hasDraw: true }).phase, "ready");
});
test("an unsealed round is not-sealed", () => {});
test("the honesty line names the block", () => assert.match(honestyLine(1192n), /fixed on-chain at block 1,?192/));
```

- [ ] **Step 2–4:** Run (FAIL), implement `draw-script.js`, `fallback.js`, `draw.js` (stage stubbed to the fallback), run suite (PASS).
- [ ] **Step 5: Verify in a browser.** Old round `d15f6b5e` has a record on chain: `#/round/d15f6b5e/draw` shows the result list, and it matches `node tools/verify-draw.mjs apps/web/dapp/manifest.json --round d15f6b5e` line for line.
- [ ] **Step 6: Mutation probes.** (a) Sort reveals by position instead of place → "in place order" red. (b) Truncate balls before adding winners → "every winner is among them" red. (c) Target `+256` → "countdown targets" red.
- [ ] **Step 7: Commit** `feat: draw timeline, live countdown and accessible result list`.

### Task 14: The ball machine

**Files:**
- Create: `apps/web/dapp/app/draw/stage.js`
- Modify: `apps/web/dapp/app/views/draw.js`, `apps/web/dapp/dapp.css`
- Test: extend `apps/web/test/app-shell.test.js`

**Interfaces:**
- Consumes: `buildDrawScript` output, `seededRandom`, `THREE` (Task 12).
- Produces: `createStage(canvas, script, { seed, onReveal(reveal), onDone() }) -> { play(), skip(), replay(), dispose() }`. Throws synchronously if WebGL is unavailable. `onReveal` fires once per reveal in order, including on `skip()` (which fires all remaining reveals immediately). `dispose()` stops the animation loop and frees geometries, materials, textures and the renderer.

Before writing this file, invoke the `frontend-design` skill for art direction. Requirements the art direction must meet: a glass drum with tumbling balls, a chute, and a winners' rail (spec); Astra's palette (deep blue stage, paper-white balls, amber for drawn balls, green ring for the viewer's own); ball numbers drawn onto a `CanvasTexture`; drawn balls and the viewer's balls are labelled, the rest may be unlabelled at 40 balls; ball motion is kinematic (sphere-in-sphere bounce) driven by `seededRandom(seed)` with a fixed timestep, so a replay moves identically; `renderer.setPixelRatio(Math.min(devicePixelRatio, 2))`; the loop pauses on `document.hidden`; the canvas resizes with its container. The rail is mirrored in DOM text by `onReveal`, so a screen reader hears each place as it lands (`aria-live="polite"`).

- [ ] **Step 1: Write the failing tests** (static checks; the scene itself is verified in a browser):

```js
test("the stage imports Three.js only from the vendored file", () => {
  assert.match(read("dapp/app/draw/stage.js"), /from "\.\.\/\.\.\/\.\.\/vendor\/three\.module\.min\.js"/);
  assert.doesNotMatch(read("dapp/app/draw/stage.js"), /https?:\/\//);
});
test("the stage takes its randomness from the seeded generator", () => { /* matches seededRandom, not Math.random */ });
test("the stage exposes play, skip, replay and dispose", () => {});
```

- [ ] **Step 2–3:** Run (FAIL), implement `stage.js` and wire it into `draw.js` behind the fallback conditions.
- [ ] **Step 4: Run** the suite. Expected: PASS.
- [ ] **Step 5: Verify in a browser** on `#/round/d15f6b5e/draw`: (a) the winners on the rail equal the fallback list and `tools/verify-draw.mjs`; (b) Replay shows the same winners and the same motion; (c) Skip lands on the full result at once; (d) with "reduce motion" emulated, the list is shown and no canvas is created; (e) no CSP violation in the console; (f) with 4× CPU throttling at 390px width, a performance trace shows no long task over 50 ms during the tumble; (g) leaving the panel and returning five times leaves one WebGL context.
- [ ] **Step 6: Commit** `feat: Three.js ball-machine draw`.

### Task 15: How it works, old pages, and the site

**Files:**
- Modify: `apps/web/dapp/index.html` (`#view-how` content), `apps/web/test/how-it-works.test.js`, `apps/web/test/app-shell.test.js`
- Replace: `apps/web/dapp/how-it-works.html` with a refresh stub to `./#/how`
- Create: `tools/build-site.mjs`, `apps/web/dapp/_headers`, `apps/web/test/build-site.test.js`, `docs/deploy-daowow-org.md`
- Modify: `.gitignore` (add `/dist/`)

**Interfaces:**
- `build-site.mjs`: `node tools/build-site.mjs [outDir=dist/site]` copies, with no transformation, exactly: `apps/web/core.js`, `apps/web/chain/*.js`, `apps/web/vendor/*` (not the README), `apps/web/dapp/**` → `outDir/{core.js,chain/,vendor/,dapp/}`; writes `outDir/_redirects` containing `/ /dapp/ 302`; copies `apps/web/dapp/_headers` to `outDir/_headers`. It exits non-zero if any copied file contains `192.168.` or `localhost`. Exported `listSiteFiles()` returns the relative paths it would copy.
- `_headers`: for `/*` — the CSP from Global Constraints with `frame-ancestors 'none'` added, `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, `Permissions-Policy: camera=(), microphone=(), geolocation=()`.
- `#view-how`: the content of today's `how-it-works.html`, restyled. Its "What works today" section is rewritten: entering, refunds, My tickets and the animated draw work; transferring, claiming a prize (redeeming) and retiring are "not yet available in this interface".
- `docs/deploy-daowow-org.md`: the Cloudflare Pages steps for Phill (project connected to the repo, build command `node tools/build-site.mjs`, output `dist/site`, custom domain daowow.org, HTTPS enforced). Deployment itself is Phill's action; this plan does not run it.

- [ ] **Step 1: Write the failing tests.**

```js
// how-it-works.test.js — repointed at the #view-how section of dapp/index.html
// keep every existing assertion except the unbuilt list, which becomes:
for (const unbuilt of ["Transferring", "Redeeming", "Retiring"]) assert.match(section, new RegExp(unbuilt, "i"));
assert.doesNotMatch(section, /animated draw[^.]*not yet/i);
// app-shell.test.js
test("the three retired pages are script-free redirects into the app", () => {
  for (const [page, to] of [["entry.html", "./#/rounds"], ["refund.html", "./#/tickets"], ["how-it-works.html", "./#/how"]]) {
    const html = read(`dapp/${page}`);
    assert.match(html, new RegExp(`http-equiv="refresh" content="0; url=${to.replace(/[.#/]/g, "\\$&")}"`));
    assert.doesNotMatch(html, /<script/);
  }
});
// build-site.test.js
test("the site contains only allow-listed files", () => { /* every path starts with core.js, chain/, vendor/, dapp/ ; none ends .md, .test.js, .local.json */ });
test("no deployments file, test, tool or key material is published", () => {});
test("no published file mentions the LAN node", () => {});
test("the header CSP and the page CSP list the same sources", () => {});
test("the headers forbid framing", () => assert.match(read("dapp/_headers"), /frame-ancestors 'none'/));
```

- [ ] **Step 2–4:** Run (FAIL), implement, run suite (PASS).
- [ ] **Step 5: Verify the built site.** `node tools/build-site.mjs`, then serve `dist/site` on a spare port with `python3 -m http.server` and load `/`: it redirects to `/dapp/`, all four tabs work, and `grep -r "192.168" dist/site` prints nothing. Stop that server afterwards.
- [ ] **Step 6: Mutation probe.** Add `deployments/` to the copy list → "only allow-listed files" red.
- [ ] **Step 7: Commit** `feat: How it works in the app, retired page redirects, and the publishable site`.

### Task 16: Whole-app check

**Files:**
- Modify: `apps/web/PROGRESS.md`, `apps/web/ENTRY-README.md` (point at the one app), `README.md` (dApp section only)

- [ ] **Step 1: Run** `node --test apps/web/test/*.test.js`. Expected: PASS, and the total is at least 385 minus the one deleted `isSafeManifestUrl` test plus every test this plan adds. Report the aggregate count from the runner's summary line, not from scrolling output.
- [ ] **Step 2: Walk each Review Focus item in a browser** and record the result: (1) block `testnet.ckb.dev` in devtools → every tab shows the retry card, and unblocking plus Retry recovers; (2) covered by Task 5's test, confirm My tickets renders with the connected wallet; (3) `#/round/zzzz/draw` and `#/round/00000000/enter` show "We couldn't find that round"; (4) covered by Task 10's tests; (5) covered by Task 8's store test.
- [ ] **Step 3: Phone check.** Phill opens the built site over HTTPS on a phone with JoyID (a Cloudflare Pages preview deployment per `docs/deploy-daowow-org.md`): connect, see My tickets, watch a draw replay. This step is Phill's.
- [ ] **Step 4: Request a whole-branch review** (code-reviewer, then security-reviewer on `apps/web/dapp/app/` and the three new `chain/` files). Fix CRITICAL and HIGH findings, re-run the suite.
- [ ] **Step 5: Update the three docs** to describe the one app and remove instructions to hand-type `?manifest=` or `?round=`.
- [ ] **Step 6: Commit** `docs: point the dApp docs at the one app`.

---

## Spec coverage

| Spec item | Task |
|---|---|
| One app, connect once, tab bar, top on desktop | 8 |
| Home explainer (four points), current-round card, Enter button | 9 |
| Rounds, six states, newest first, never indexer order | 1, 4, 9 |
| My tickets from claims + entries; holder wins; no Refunded badge | 5, 11 |
| Actions on the card: Enter more, Refund, Claim/Redeem/Retire placeholders | 10, 11 |
| Prize figures, option B | 7, 11 |
| How it works restyled | 15 |
| Wallet pill, balance, disconnect | 8 |
| Draw: inputs, live countdown to last entropy block, browser derivation, cross-check, replay, highlight, honesty line, 200-ticket scale, fallback, skip | 3, 8, 13, 14 |
| No jargon, no hidden fees, no dead ends, never fake randomness | 8, 10, 11, 13 |
| No framework, vendored hash-pinned Three.js, strict CSP, textContent only | 8, 12, 15 |
| Hosting, public RPC, public manifest, HTTPS | 8, 15 |
| Existing guards survive; suite stays green; mutation probes | every task |
