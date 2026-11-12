# Validation — gate 3c, settlement tooling, 2026-11-13

Spec `docs/superpowers/specs/2026-10-01-gate-3bc-design.md`,
plan `docs/superpowers/plans/2026-10-01-gate-3bc.md`, Tasks 9 to 14.

Gate 3c is the tooling that returns a round's money once its tickets are in
the Nervos DAO: DAO phase one, DAO phase two, and payout. It proves the
**tooling**. The protocol itself was already proven by
`tests/devnet/test_round_creation.py`.

## What is proven, and how

| what | evidence |
|---|---|
| Settlement cell codec | byte for byte against the Rust vector, every field |
| Settlement derivation (`deriveEntitlements`) | byte for byte against three Rust-derived vectors: a viable round, one holder with two entries, a round below its minimum |
| Batch evidence and payout witnesses | byte for byte against Rust's encoders |
| DAO phase one, built in JavaScript | matched the Python reference; **accepted by an isolated devnet node** |
| DAO phase two, built in JavaScript | inputs, header deps, settlement cell, its data and the witness **identical** to the transaction assembled from the Rust exporter; accepted by the devnet node |
| Final payout, built in JavaScript | payment output and witness identical to the reference; accepted by the devnet node, closing the settlement cell |
| Phase one for the live round `0xaffb66f7…` | built from testnet, then run under `ckb-debugger` against the **deployed** binaries: `dao-lock` returns 0, the native DAO type returns 0. With the output data zeroed the lock returns -58, so the harness can fail |
| The pre-signing checker | 61 guards, each turned red by its own mutation |

Web suite: 921 passing. Devnet: `tests/devnet/test_js_lifecycle.py`, one
history (one deposit, one participant, two shards).

## Three things the contracts fix that the plan and the app did not say

**1. Payout is about sixty days after the deposit, not thirty.**
`dao-lock` refuses phase one until a full term after the deposit
(`absolute_epoch_after_dao_term`, 180 epochs for one term). The native DAO
then rounds the stay up to whole 180-epoch cycles from the deposit, so a
withdrawal prepared at any point after epoch D+180 matures at D+360. The
devnet suite asserts exactly this (`maturity_deltas == {360}`). Interest
accrues only until phase one's block, so about thirty days of interest are
earned over a sixty-day lock.

Landing phase one in the single block where the first cycle is still open is
not a plan: it needs the withdrawal's block to sit at exactly the deposit's
fraction of its epoch.

The app's timeline says "Savings term: about 30 days" and "Payout after the
savings term". For a one-term round that is thirty days short.

**2. The last participant of each batch waits for the winners.**
While prizes are unredeemed the settlement cell must survive the last payout,
and a cell cannot hold less than its own floor of 307 CKB. A sponsor cannot
top it up: the contract requires capacity in to equal payouts plus capacity
out. So unless at least 307 CKB of a batch's prizes are still unredeemed, the
participant with the highest lock hash in that batch cannot be repaid until
every prize owed by that batch has been redeemed. Every batch owes a share of
every prize, so one winner who never redeems holds back one depositor in
every batch.

Redemption is gate 2c and has no tooling yet. Until it exists, a round with a
small prize pool cannot be fully repaid.

**3. A prize that rounds to zero strands its batch.**
`InitialEntitlements::derive` refuses to create a settlement cell if any
drawn place is allocated zero from that batch's interest. The builder refuses
locally and says the deposit cannot be withdrawn as things stand. It has not
occurred; it would need a very small batch or a very uneven schedule.

## Things that were wrong or missing, in the order they surfaced

1. **Phase one cannot carry a dep group.** `authenticated_deposit_receipt`
   rejects the whole transaction on any cell dep that is not a plain code dep.
   The system lock normally arrives as a dep group. The builder refuses one,
   and `resolveCodeDeps` opens the group into its code cell and data cell.
2. **Phase two needs the round's recorded result.** The settlement type reads
   the entropy record as a cell dep. A round must be sealed and its result
   recorded before any deposit can be withdrawn into settlement. Round
   `0xaffb66f7…` is not yet sealed.
3. **The principal owed is the entry cell's capacity,** not the ticket price
   paid. The vectors use 5,237 CKB of capacity against 5,000 CKB of principal
   so the difference is visible.
4. **The contract takes the first output under a participant's lock as their
   payment.** Payments are placed before the sponsor's change so a sponsor who
   is also a participant cannot shadow their own payment.
5. **The checker crashed on an input that was not a DAO cell.** Found by its
   own test; it now reports the reason.
6. **The devnet module ran every history twice.** Importing the test class by
   name made the loader collect it. It is imported as a module now.

## Numbers against the plan's predictions

| | predicted | measured |
|---|---|---|
| settlement cell floor | not predicted | 307 CKB (8 + 160 + 34 + 105) |
| withdrawing cell occupied | not predicted | 186 CKB (8 + 137 + 33 + 8) |
| payouts per transaction | "compute, do not pick" | 32: a batch holds at most 32 entries. Worst-case witness 22,276 bytes, about 4% of the 512 KiB script heap |
| maturity | D + 180 × periods | D + 180 × (periods + 1) |

## The live round, so this is actionable

Round `0xaffb66f7…` on testnet, one batch:

- deposit of 100,474 CKB committed in block 23,024,065, epoch 14,168;
- phase one can be sent from **epoch 14,349** (about 11 December 2026);
- the withdrawal then matures at **epoch 14,528** (about 10 January 2027),
  provided phase one is committed before then;
- before phase two the round must be closed, sealed and its result recorded.

The command, when the time comes:

```sh
node tools/dry-run-settlement.mjs deployments/dev-testnet-manifest.json \
    --round 0xaffb66f7 --out phase-one.json
```

It reports where each batch stands on every run, and refuses to write a file
for a transaction its own checks would refuse.

## What remains unproven

- **Settlement on public testnet.** Nothing can be sent before epoch 14,349.
- **More than one batch.** Every proof here has one deposit. Round
  `0x0526654b…` will have several, and its phase one will spend several
  deposits in one transaction. The builder and checker are tested for it; no
  node has seen it.
- **A payout that is not the last.** The devnet history has one participant,
  so the part-way path (a settlement cell that survives) has run only in unit
  tests.
- **A round that did not draw,** where the pool is shared among participants.
  Pinned to a Rust vector; never built against a node.
- **Prize redemption** in JavaScript. Gate 2c.
- **Finding a participant's lock script.** The operator command takes it from
  the outputs of the transaction that made their entry. An entrant whose lock
  appears on no output of that transaction would not be found, and the command
  would refuse to build their payout.

## Rulings made during the work

- The devnet run drives the three new builders, not the whole lifecycle from
  creation. The earlier steps' builders are already proven on public testnet.
- The checkers live in `tools/settlement-rules.mjs`, not in
  `lifecycle-rules.mjs`, and the operator command is its own file,
  `tools/dry-run-settlement.mjs`, rather than new branches in the 670-line
  `dry-run-lifecycle.mjs`.
- One batch per phase-two transaction and per payout transaction. Phase one
  takes every deposit of the round at once.
- The pinned node image was pulled by digest; it was no longer cached.
