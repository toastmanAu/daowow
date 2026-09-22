# Gate 2b — entry and claim minting Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A connected visitor sees an exact, complete quote — including the payout table — then builds, signs and broadcasts TX-02, receiving one claim NFT per ticket. Plus refunds, and a page explaining the methodology.

**Architecture:** The browser builds the whole transaction. `apps/web/core.js` already has the MMR and the entry-leaf hash; 2b adds the encoders, the witness, the quote and the transaction builder, each pinned to Rust-generated vectors. Signing goes through the vendored JoyID signer; nothing is assumed about the wallet beyond its lock script.

**Tech Stack:** Vanilla ES modules over the vendored CCC+JoyID bundle; Rust `daowow-core` for oracles; `ckb-testtool` and the Docker devnet for on-chain proof.

**Spec:** `docs/superpowers/specs/2026-09-19-dapp-entry-design.md`

## Global Constraints

- **This gate moves value.** Everything before it was read-only by design.
- **Nothing is hardcoded** (D2). Ticket price, cap, minimum, thresholds and every capacity come from the round config, the committed schedule and the connected wallet's lock. The check: the only numeric literals in the client are protocol constants — `100000000` shannons per CKB, the 358/101/132/81/45-byte sizes, the 33-byte ScriptRef. A future round priced differently must need **no** client change.
- **Every JavaScript encoder is byte-checked against the Rust**, not against itself. A codec that agrees only with its own tests is the recurring failure in `~/.claude/rules/ckb-transactions.feedback.md`.
- **The visitor confirms our quote before the signer is invoked** (D6).
- **Contention is a flow, not an error** (D5). One shard means every entrant competes for one cell.
- **Nothing is described as live that is not built** (D7). At 2b: entry and refund. Transfer, redemption, retirement and the draw reveal are 2c and 2d.
- **The draw description must not overclaim** (D7): four block hashes at +64/+128/+192/+256 after the seal, not a VRF or a beacon.
- Every guard gets a disable/re-enable round trip. Rebuild contracts one package at a time, never during a devnet run.
- Commit after every task.

---

## File Structure

| Path | Responsibility |
|---|---|
| `tests/integration/tests/common/mod.rs` | *(modify)* MMR entry builder |
| `crates/daowow-core/tests/gen_vectors.rs` | *(modify)* entry/claim/witness oracles |
| `apps/web/chain/entry-codec.js` | entry, claim args, claim state, ticket id |
| `apps/web/chain/mmr-witness.js` | peaks and the append witness |
| `apps/web/chain/quote.js` | capacity arithmetic and the payout table |
| `apps/web/chain/schedule.js` | decode a committed schedule, v1 and v2 |
| `apps/web/chain/entry-tx.js` | assemble TX-02 |
| `apps/web/chain/refund-tx.js` | assemble TX-04 |
| `apps/web/dapp/entry.html` + `entry-view.js` | the entry view |
| `apps/web/dapp/how-it-works.html` | the methodology page |
| `tools/create-demo-round.mjs` | one-off round creation for validation |
| `docs/validation-2026-09-**-entry.md` | evidence |

---

### Task 1: An MMR entry builder for the integration harness

Closes the gap D1 records: `build_entry_tx` is `SmtHost`-only, so the beta config tests run SMT rather than the beta's MMR. The client's whole entry path is MMR, and the harness must be able to exercise it.

**Files:**
- Modify: `tests/integration/tests/common/mod.rs`, `tests/integration/tests/proto1_entry_shard.rs`

- [ ] **Step 1: Write the failing test**

In `proto1_entry_shard.rs`, switch `beta_config` to `ACC_MMR` and its two tests to `World::new(ACC_MMR)`, per the comment already in that file. Expect the accept-at-cap test to fail with `-33` (`SHARD_ERROR_ENTRY_CELL`) — the SMT witness handed to the MMR verifier, exactly as measured on 2026-09-20.

- [ ] **Step 2: Run it and confirm that exact failure**

```sh
cd tests/integration && cargo test --test proto1_entry_shard the_beta_config
```

- [ ] **Step 3: Implement the MMR path**

Parameterise `build_entry_tx` on the accumulator. For `ACC_MMR` the witness is `encode_shard_append_witness_mmr(&entries, &old_peaks, &new_peaks)`, where a peak list is **one byte of count followed by 32 bytes per peak** — the encoding `devnet_round.rs` already uses:

```rust
let mut peaks = vec![host.peaks().len() as u8];
for peak in host.peaks() {
    peaks.extend_from_slice(peak);
}
```

An empty shard's old peaks are the single byte `[0]`. The contract checks `bag_peaks(old_peaks) == before.accumulator_root` and that the old peak count equals `before.entry_count.count_ones()`.

- [ ] **Step 4: Run to green, then run the whole suite**

- [ ] **Step 5: Mutation round trip**

Corrupt one byte of `new_peaks` and confirm the append is refused with `-33`.

- [ ] **Step 6: Commit**

---

### Task 2: Entry, claim and ticket encoders in JavaScript

**Files:**
- Modify: `crates/daowow-core/tests/gen_vectors.rs`, regenerate vectors
- Create: `apps/web/chain/entry-codec.js`, `apps/web/test/entry-codec.test.js`

**Interfaces:**
- Produces: `encodeEntryDataV1(entry) -> Uint8Array` (132 bytes), `ticketId(commitment, shardId, position) -> hex`, `encodeClaimArgs({commitment, shardId, position}) -> Uint8Array` (45 bytes), `initialClaimState(args) -> Uint8Array` (81 bytes). Tasks 3, 5 consume these.

- [ ] **Step 1: Emit the oracles**

Add to `gen_vectors.rs` an `entry_encoding` key giving a canonical `EntryDataV1`'s hex and every field, its `entry_leaf`, and for one ticket the `ticket_id`, `claim_args` hex and `initial_state` hex. Use distinct non-zero values per field, as the cell-encoding oracle does, so a wrong offset is visible.

- [ ] **Step 2: Write the failing test**

Assert each JavaScript encoder reproduces its oracle byte for byte, and that wrong-length input is refused.

- [ ] **Step 3: Implement**

Layouts, from `crates/daowow-core/src/encoding.rs` and `claim.rs`:

```
EntryDataV1, 132 bytes
   0..32   round_id
  32..36   shard_id            u32 LE
  36..68   participant_lock_hash
  68..76   ticket_count        u64 LE
  76..84   principal           u64 LE
  84..92   position_base       u64 LE
  92..100  entry_nonce         u64 LE
 100..132  entropy_commitment

ClaimArgs, 45 bytes
       0   CLAIM_TAG = 5
   1..33   commitment
  33..37   shard_id            u32 LE
  37..45   position            u64 LE

ticket_id  = blake2b("DAOWOW_TICKET_ID_V1", commitment, shard_id LE, position LE)
claim data = PrizeRedemptionState::new(ticket_id), 81 bytes
       0   version = 1
   1..33   ticket_id
  33..65   paid_root   (32 zeros on mint)
  65..73   paid_count  u64 LE, zero on mint
  73..81   paid_total  u64 LE, zero on mint
```

Verified against `redemption.rs::encode` while writing this plan; the oracle test is what keeps it true.

- [ ] **Step 4: Run to green, then mutation round trip**

Shift one field offset by a byte and confirm the named test reds — as the round-config decoder's offsets were proven in 2a.

- [ ] **Step 5: Commit**

---

### Task 3: The MMR append witness in JavaScript

**Files:**
- Create: `apps/web/chain/mmr-witness.js`, `apps/web/test/mmr-witness.test.js`
- Modify: `crates/daowow-core/tests/gen_vectors.rs`

**Interfaces:**
- Consumes: `encodeEntryDataV1` (Task 2), `MmrHost` from `core.js`.
- Produces: `encodePeaks(peaks) -> Uint8Array`, `encodeAppendWitnessMmr(entries, oldPeaks, newPeaks) -> Uint8Array`.

- [ ] **Step 1: Emit the oracle**

A witness over two canonical entries with real old and new peak lists, as hex, plus the peak lists themselves.

- [ ] **Step 2: Write the failing test**

Byte-for-byte against the oracle. Include the empty-shard case, whose old peaks are the single byte `0x00`.

- [ ] **Step 3: Implement**

```
witness = u32 LE entry count
        | each entry's 132 bytes
        | u32 LE old_peaks length | old_peaks
        | u32 LE new_peaks length | new_peaks

peaks   = u8 count | 32 bytes per peak
```

- [ ] **Step 4: Verify the roots agree with the contract's rule**

`core.js`'s `MmrHost` must produce a root equal to `bag_peaks(peaks)`; assert against the existing `mmr.root_after_5_appends` vector so the client's peaks are the ones the contract will accept.

- [ ] **Step 5: Mutation round trip, then commit**

---

### Task 4: The quote, including the payout table

**Files:**
- Create: `apps/web/chain/schedule.js`, `apps/web/chain/quote.js`, and their tests

**Interfaces:**
- Produces: `decodeSchedule(bytes) -> { weights, thresholds }` handling v1 and v2; `placesFor(schedule, tickets) -> number`; `quoteEntry({ config, schedule, lockScript, tickets }) -> { principal, claimCapacity, entryCellCapacity, total, placesNow, nextThreshold }`.

- [ ] **Step 1: Write the failing tests**

Pin `placesFor` to the `prize_schedule_v2.places_at` oracle already in the vectors — both sides of every threshold. Pin the capacity arithmetic to the Rust helpers:

```
claim cell  = 8 + lock_script_size + (32 + 1 + 45) + 81      [claim_occupied_capacity]
entry cell  = principal + (8 + 132 + 33 + 64)                [237 CKB over principal]
total       = tickets * ticket_price + tickets * claim_cell + entry_cell_overhead + fee
```

`lock_script_size` is `32 + 1 + args.length` from the **connected wallet's own lock** — 55 for JoyID's 22-byte args, giving 222 CKB; 53 for secp, giving 220. Assert both, so an assumed constant fails.

- [ ] **Step 2: Implement, run to green**

v1 decoding must yield thresholds `[1, 2, …, n]`, since v1 *is* v2 with that table.

- [ ] **Step 3: Mutation round trip**

Change `<=` to `<` in the threshold comparison and confirm the boundary cases red. Drop the claim-capacity term and confirm the total test reds.

- [ ] **Step 4: Commit**

---

### Task 5: Assemble TX-02

**Files:**
- Create: `apps/web/chain/entry-tx.js`, `apps/web/test/entry-tx.test.js`

**Interfaces:**
- Produces: `buildEntryTx({ rpc, manifest, config, schedule, shard, lock, tickets, nowEpoch }) -> { tx, expectedShardAfter, claims }`.

- [ ] **Step 1: Write the failing test**

Against a fixture shard, assert the shape: input 0 is the shard head; outputs are the shard successor, the entry cell, one claim per ticket, then change; `since` is `ABSOLUTE_EPOCH_FLAG | entry_start` at minimum; the witness is the Task 3 encoding; every cell dep named by the manifest is present.

**Cell deps are not optional.** A missing dep is `ScriptNotFound` at broadcast, and `ckb-testtool` cannot catch it because its context makes every deployed binary available regardless (recorded 2026-09-17).

- [ ] **Step 2: Implement**

The shard successor advances `sequence`, `entry_count`, `ticket_count`, `principal_total` and `accumulator_root`. `entry_nonce` must equal `first_nonce_in_tx + nonce_index_in_tx` (`shard.rs:46`), and `position_base` continues from the shard's current `ticket_count`.

- [ ] **Step 3: Run to green, mutation round trip, commit**

---

### Task 6: Contention

**Files:**
- Create: `apps/web/chain/contention.js` and its test

- [ ] **Step 1: Write the failing test**

Simulate the head advancing between read and broadcast: the client must detect it, rebuild against the new head — new peaks, new position, new nonce — and not report a generic failure. Assert a bounded retry count and that it stops with an explanation rather than looping.

- [ ] **Step 2: Implement, run to green, mutation round trip, commit**

---

### Task 7: The entry view, signing and broadcast

**Files:**
- Create: `apps/web/dapp/entry.html`, `apps/web/dapp/entry-view.js`

- [ ] **Step 1: Build the view**

Ticket count selector; the full quote from Task 4; the payout table showing places paid now and the next threshold; and an explicit confirmation control. Port `entry.css`'s visual language.

**The signer is invoked only after that confirmation** (D6). Render errors with `textContent`, never `innerHTML` — the XSS fixed in 2a came from exactly that.

- [ ] **Step 2: Verify in a browser**

Zero console errors; the quote matches Task 4's arithmetic; the payout table matches the committed schedule.

- [ ] **Step 3: Commit**

---

### Task 8: Refunds (TX-04)

**Files:**
- Create: `apps/web/chain/refund-tx.js`, and a holdings view listing refundable entries

- [ ] **Step 1: Write the failing test**

An excluded entry is refundable after the aggregation deadline. Refundability is **derived from chain state every time**, never cached — a reorg can reverse it, and the beta plan forbids an irreversible local flag.

- [ ] **Step 2: Implement, run to green, mutation round trip, commit**

---

### Task 9: The methodology page

**Files:**
- Create: `apps/web/dapp/how-it-works.html`

- [ ] **Step 1: Write it**

Lead with the fact everything else depends on:

> Prizes are funded by Nervos DAO yield on the pooled principal. Entrants get their principal back whether they win or lose. Nobody's stake pays anybody else's prize.

Then: where prizes come from; how many places pay and why depth scales; how winners are chosen; what it costs beyond principal; what a ticket is; how long capacity is committed.

- [ ] **Step 2: Check it against the two honesty constraints**

Nothing described as live that is not built, and the draw section stating its limits — four block hashes at +64/+128/+192/+256 after the seal, sealed entry set first, **not** a VRF or a beacon, and a miner controlling those blocks could in principle grind.

- [ ] **Step 3: Commit**

---

### Task 10: A round to enter

Entry cannot be validated without a round, and round creation is gate 3. This is a deliberate, minimal stand-in — **operator-run, not part of the client**.

**Files:**
- Create: `tools/create-demo-round.mjs`

- [ ] **Step 1: Build the round at the demo shape**

`ticket_price` 10,000 CKB, `maximum_tickets` 10, `minimum_tickets` 5, one shard, `ACC_MMR`, and the tiered schedule `[40,25,20,10,5]` / `[1,8,20,50,100]`. It must print the transaction for review and **not sign** — Phill signs, as with every other transaction in this repository.

- [ ] **Step 2: Mark it clearly as a stand-in**

A header comment and terminal output saying this is not the gate 3 operator flow and must not be relied on as one.

- [ ] **Step 3: Commit**

---

### Task 11: Live validation

- [ ] **Step 1: Devnet**

A real entry on the devnet: claim cells exist under the entrant's lock, the shard advances, and the round's ticket count matches.

- [ ] **Step 2: Testnet**

Create the demo round, enter it, and confirm on chain. Record the transaction hashes, the quote the client showed against what the chain actually charged, and the claim cells minted.

- [ ] **Step 3: Record everything, including what did not work**

Into `docs/validation-*.md`. "It worked" without the numbers is not evidence.

---

## Self-review

- **Spec coverage.** D1 → Tasks 1, 3. D2 → Task 4. D3 → Task 10. D4 → Task 4. D5 → Task 6. D6 → Task 7. D7 → Tasks 4, 9.
- **Ordering.** Task 2 precedes 3 and 5; Task 4 precedes 7; Task 10 precedes Task 11's testnet leg. Task 1 is independent and first because it closes a known gap and de-risks the MMR path before any client code depends on it.
- **The riskiest task is 5**, where a wrong successor or a missing cell dep fails only at broadcast. Its test asserts cell deps explicitly, because `ckb-testtool` structurally cannot catch a missing one.
- **Known scope edge.** Task 10 reaches into gate 3. Without it 2b cannot be demonstrated on testnet at all, so it is included, minimal, and labelled.
