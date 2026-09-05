# Testing Strategy

## Unit tests

Pure deterministic logic:
- amount multiplication overflow;
- ticket ranges;
- canonical sort/order;
- prize schedule sum;
- Shannon rounding;
- rejection sampling;
- duplicate winning position retry;
- settlement sharding;
- fee bounds.

## Script positive-path tests

- create Round;
- enter each shard;
- freeze shard;
- refund eligible Entry;
- aggregate accepted Entries into native DAO;
- DAO phase one;
- DAO phase two;
- batch finalization;
- entropy finalization;
- settlement shard payout;
- Round completion.

## Adversarial script tests

Attempt:
- changed participant lock;
- altered principal;
- fake ticket count;
- wrong Round ID;
- wrong shard ID;
- accumulator skipped Entry;
- sequence jump;
- re-open frozen shard;
- refund before deadline;
- refund after aggregation;
- aggregate same Entry twice;
- aggregate unaccepted Entry;
- phase-one DAO output at wrong index;
- phase-one capacity mutation;
- phase-one lock substitution;
- phase-two arbitrary operator output;
- keeper reward above cap;
- settlement payout to wrong lock;
- settlement overpay;
- settlement under-accounting residual;
- duplicate payout;
- malformed Molecule data;
- integer overflow boundary values.

## Property tests

Properties:

```text
sum(ticket_count) == total_tickets
sum(principal) == total_principal
all ticket ranges are disjoint
union(ticket ranges) == [0,total_tickets)
prize_total <= yield_pool
settlement outputs + fees + residual == settlement inputs
same seed+Round => same winners
address splitting with same ticket count does not alter aggregate probability model
```

## Cross-language vectors

Store JSON vectors under `tests/vectors/` covering:
- encoding;
- Round ID;
- Entry leaf;
- accumulator proof cases;
- seed derivation;
- rejection sampling;
- prize allocation;
- settlement allocation.

Rust and TypeScript must consume the exact same vectors.

## Scale tests

At minimum test:
- 1 participant / 1 ticket;
- 1 participant / many tickets;
- 100 participants;
- 32 shards;
- multiple Entries per participant;
- multiple DAO batches;
- deposit batches in different blocks;
- maximum prototype batch size;
- concurrent settlement shards.

## Testnet rehearsals

Run intentionally failed rounds:
- below minimum tickets;
- unaggregated Entry hitting deadline;
- missing entropy reveals;
- keeper disappears mid-round;
- coordinator DB deleted and state rebuilt from chain.
