# Claim NFT sub-project 1: mint and transfer

Date: 2026-09-16. Status: design for user review. Decisions recorded here were
made by the user on 2026-09-16: the claim type is a new mode of the
`entry-shard-type` binary, one claim cell is minted per ticket, and unclaimed
prizes leave a funding cell open indefinitely for the beta.

Inputs: `2026-09-15-prize-only-claim-amendment.md` (authoritative ownership
rules) and `2026-09-15-transferable-claim-lifecycle-design.md` (lifecycle).
This spec covers only the first two lifecycle modes. Redemption is
sub-project 2 and retirement plus memento is sub-project 3; each gets its own
spec. Nothing here changes principal or refund handling.

## Goal

Every accepted positional ticket becomes exactly one wallet-held claim cell,
minted in the same transaction as its entry, carrying the 81-byte
`PrizeRedemptionState`, transferable by its holder, and impossible to forge,
duplicate, remint, mutate or burn under the rules of this sub-project.

## Claim cell

| Field | Value |
| --- | --- |
| lock | the holder's own wallet lock (any script) |
| type code hash / hash type | those of the round's `entry_shard` script reference |
| type args | `[5] ‖ config_commitment(32) ‖ shard_id(u32 LE) ‖ position(u64 LE)` = 45 bytes |
| data | `PrizeRedemptionState::encode()`, 81 bytes, `ticket == ticket_id(commitment, shard_id, position)` |
| capacity | at least occupied capacity; funded by the entrant, separate from ticket principal |

Tag byte 5 is unused by the existing modes (0 public lock, 2 receipt, 3 seal,
4 entropy record). Dispatch is by args length 45 and tag 5, before every other
branch, so a claim cell can never be mistaken for a shard-family cell.

Identity is fully determined by the args. The data's `ticket` field is
redundant with the args and must match them in every mode; a mismatch is a
data error. Position is the shard-local absolute ticket position
`entry.position_base + index`, so the same position can never be minted twice:
the shard's `ticket_count` only grows and minting is allowed only for positions
in `[before.ticket_count, after.ticket_count)` of the append that creates them.

Occupied capacity with a secp256k1 lock is 8 + 53 + 78 + 81 = 220 bytes, so
220 CKB per ticket. A pure helper `claim_occupied_capacity(lock_script_size)`
gives the entry quote its number. This capacity is returned to the holder at
retirement (sub-project 3), never deducted from principal.

## Modes of the claim type script

The claim script runs once per claim cell because each cell's args are unique.
Every mode first decodes its own args and requires exactly one cell in the
relevant group side (a second group input or output is a group error).

### Mint (no group input, one group output)

The claim script cannot see the append witness, so it delegates to the shard
transition exactly as `entry-lock` delegates aggregation to the ledger:

1. There must be an input and an output whose type has the same code hash and
   hash type as the claim script, 36-byte args equal to
   `commitment ‖ shard_id` from the claim args, and data of length
   `SHARD_DATA_SIZE`. This proves an OPEN shard of the right identity
   transitions in this transaction, so the shard script runs.
2. Output data must decode and equal `PrizeRedemptionState::new(ticket_id)`.

The shard script does the counting (below). A claim created with no shard
transition, with a ledger, seal or entropy cell standing in for the shard, or
for a different commitment or shard than the one transitioning, fails here.

### Transfer (one group input, one group output)

Output data must be byte-identical to input data, and must decode with a
matching ticket. The lock is unconstrained: the holder's lock script on the
input is the authority, and the recipient lock is whatever the holder chose.
No config, cell dep or witness is read.

### Rejected in this sub-project

- Output data differs from input data: this is the redemption shape and fails
  with a dedicated code until sub-project 2 defines it.
- Group input with no group output: this is retirement and fails with a
  dedicated code until sub-project 3 defines it.

Because both shapes are rejected outright, no path exists that can alter paid
state or destroy a claim, which is the safety property the amendment demands
until the authenticated versions exist.

## Shard append: minting is mandatory

In `entry-shard-type` the shard transition already matches every new entry-lock
output one-to-one with a witness entry. The same pass now also collects every
output whose type is a claim for this shard (same code hash and hash type, args
length 45, tag 5, `commitment ‖ shard_id` equal to the shard's own args), then
hands `(position, lock_hash, data)` per claim to a pure core validator:

- the number of claims equals the number of new tickets
  `after.ticket_count - before.ticket_count`;
- positions are exactly the set `[before.ticket_count, after.ticket_count)`,
  each once (a bitmap over the range; no allocation proportional to history);
- each claim's lock hash equals the `participant_lock_hash` of the witness
  entry whose `[position_base, position_base + ticket_count)` contains it;
- each claim's data equals `PrizeRedemptionState::new(ticket_id(commitment,
  shard_id, position)).encode()`.

On every other shard transition (create, freeze, frozen no-op) and on the
ledger, seal, entropy and receipt modes, the count of claim outputs for that
shard must be zero. This closes the hole where a freeze transaction, which does
satisfy the claim script's "shard transitions" check, could mint free claims.

Minting to the entrant's lock is the amendment's "issued to the entrant's
wallet". The entry cell keeps `participant_lock_hash` for principal and refund;
the claim's lock is the same script at mint and diverges only on transfer.

Every existing append builder must add claim outputs or its transaction fails:
`proto1_entry_shard`, `proto2_membership`, `security_ledger`,
`accumulator_bakeoff`, the `devnet_round` example and the shared harness. A
single harness helper `claim_outputs_for(world, cfg, before, entries)` returns
the exact cells so builders cannot drift from the rule. The Python devnet
harness drives the example binary and is updated with it.

## Pure core additions (`crates/daowow-core/src/claim.rs`)

- `CLAIM_ARGS_SIZE = 45`, `CLAIM_TAG = 5`.
- `ClaimArgs { commitment, shard_id, position }` with strict `encode()` and
  `decode()`, and `ticket_id()` delegating to `ticket::ticket_id`.
- `initial_state_bytes(&ClaimArgs) -> [u8; 81]`.
- `MintedClaim { position, lock_hash, data: [u8; 81] }`.
- `validate_mint(before_tickets, after_tickets, commitment, shard_id,
  entries: &[EntryDataV1], claims: &[MintedClaim]) -> Result<(), CoreError>`
  implementing the four rules above. Bounded by the batch: at most
  `MAX_BATCH_ENTRIES` entries and their tickets per append.
- `validate_transfer(args, input_data, output_data) -> Result<(), CoreError>`.
- `claim_occupied_capacity(lock_script_size) -> u64`.

All are `no_std`, allocation-free except the position bitmap, and unit-tested
on the host with ordinary and adversarial fixtures before any contract code.

## Error codes

Claim mode takes the reserved range: `CLAIM_ERROR_ARGS -91`,
`CLAIM_ERROR_DATA -92`, `CLAIM_ERROR_GROUP -93`, `CLAIM_ERROR_MINT -94` (no
qualifying shard transition), `CLAIM_ERROR_TRANSITION -95` (data changed; no
redemption path yet), `CLAIM_ERROR_RETIRE -96` (no retirement path yet). The
shard side adds `SHARD_ERROR_CLAIM_CELL -38` for any mint-rule violation.

## Verification

Host: unit tests for every rule of `validate_mint` and `validate_transfer`
with deliberate mutation probes recorded in the plan (each guard must fail a
named test when removed).

VM (`tests/integration`): a new `claim_lifecycle.rs` suite and a
`security_claims.rs` suite in the existing fixture style.

Accepted: append minting one claim per ticket across two entries with
different ticket counts; two consecutive appends minting disjoint positions;
transfer of one claim; transfer of two claims in one transaction; transfer of
a claim to the entrant's own lock.

Rejected: missing claim; extra claim; duplicate position; position below
`before.ticket_count` (remint); position at or beyond `after.ticket_count`;
claim locked to a non-entrant lock; claim with nonzero paid state; claim whose
data ticket does not match its args; claim for another shard or commitment in
the same transaction; claim minted in a freeze transaction; claim minted with
a ledger cell standing in for the shard; claim minted with no shard at all;
transfer with altered data; transfer with two group outputs; input claim with
no output (burn).

Cost: measure cycles for an append at `MAX_BATCH_ENTRIES` entries with the
largest ticket count the fixture supports, and record claim cell occupied
capacity, in the plan's results section. The claim script's own cost is
constant per cell; the shard's scan grows with the transaction's output count.

## Out of scope

Redemption, funding-cell prize commitments, retirement, memento, artwork
rendering, wallet display, the web entry quote and any config change. The
claim's `PrizeRedemptionState` stays at its initial value throughout this
sub-project; the only way it will ever change is the authenticated redemption
transaction of sub-project 2.
