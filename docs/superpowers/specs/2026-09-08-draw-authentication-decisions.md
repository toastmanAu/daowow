# Draw and entitlement authentication: decisions to close

Status: architecture work in progress, not an implemented protocol. The
canonical shard ledger and indexed settlement designs remain approved.

## Established dependencies

1. Shard public locks must allow permissionless progress without a creator
   signature. Canonical shard types retain uniqueness and capacity.
2. Atomic aggregation must consume actual entries and advance the canonical
   ledger, creating a digest-bound receipt and native DAO deposit. The
   approved ledger spec describes the 104-byte DAO args and receipt rules.
3. A unique universe record must commit every canonical closed shard's
   accepted prefix, global shard-major ticket offsets and batch commitments.
4. Future entropy must be selected before its hashes are knowable. A keeper's
   chosen header or a merely time-delayed witness is not sufficient.
5. Contract-computed winners, authenticated batch entries and actual native
   DAO withdrawal value must determine the complete sorted/consolidated
   liability list. The contract rebuilds the indexed MMR root/count; neither
   is taken on trust from a creator's witness.

## Approved accounting policy

The user approved the following for the initial testnet implementation:

- Return every entry's full input capacity, including entry-cell overhead.
- Define each batch's prize budget as actual realised DAO withdrawal minus
  that batch's full deposited capacity, not minus ticket principal alone.
- Sponsors fund transaction fees, new state/receipt cells and any additional
  occupied capacity needed to make winner/participant payout cells valid.
- Sponsor-funded payout top-ups are explicit contributions, not recoverable
  claims against participant principal or prize yield.
- User subsequently approved assigning prize-allocation rounding dust to the
  first prize and returning failed-round DAO yield proportionally to depositors
  alongside their full deposited capacity. Deterministic failed-round remainder
  handling must conserve every Shannon and use a committed participant order.

This changes the current assumption that settlement funding equals only the
DAO group's realised capacity when extra payout capacity is needed. Either
the sponsor must top up the funding under an authenticated allocation rule,
or pay the extra directly in payout transactions with separately checked
conservation. Do not silently relax exact DAO routing to allow arbitrary
top-ups or deductions. The selected mechanism must be specified and tested.

## Remaining protocol choices

### Unique seal and refund liveness

Closed shard cells must remain usable for excluded-entry refunds. Simply
consuming them to make a universe record would strand those entries. The
recommended approach is a one-time seal transition anchored to canonical
shard zero, preserving each closed ledger or an authenticated successor.
Repeated seal creation must fail even when every input field matches.
Ordinary closed-to-identical-closed transitions alone do not supply uniqueness.

### Future entropy

Use fixed participant commitments, never optional reveals. A candidate is
fixed positive block offsets from the unique seal's actual inclusion block.
That inclusion header must be authenticated against the seal cell, and every
entropy header must match its predetermined height. Header-dependency and
reorg behavior must be tested on a real node. The owner approved offsets
+64, +128 and +192 from actual seal inclusion, with finalization no earlier
than +256. These testnet parameters do not remove miner bias and are not a
mainnet randomness guarantee.

### Multiple batches and rounding

Approved by the owner on 2026-09-10: independently maturing batches each
distribute their own realised DAO yield to the same authenticated global winner
list under the committed prize weights. They do not wait on one global payout
cell. All prize-allocation rounding dust goes to first prize, independently for
each batch. Sponsor-funded payout-cell capacity remains a contribution, not a
deduction from those prizes or a recoverable claim against participants.

The tested `allocate_prizes_complete` helper implements the rounding rule;
the legacy `allocate_prizes` helper does not. Authentication and settlement
wiring remain unfinished. See `2026-09-10-computed-entitlements-design.md` for
the proposed implementation boundaries and validation gates.

### Incomplete rounds

If too few tickets are accepted after some funds enter native DAO, failure
cannot erase those participants' claims. A matured refund path is needed for
those batches. Excluded, unaggregated entries use the terminal-ledger refund
path. A minimum-ticket check must not make either group permanently unspendable.

## Implementation boundary

These are independent gaps beyond the corrected payout cursor. Neither
public shard locks nor core ledger codecs establish draw or initial-root
authentication. Keep funded-round readiness blocked until all transaction
boundaries, economic choices, adversarial tests and node checks are complete.
