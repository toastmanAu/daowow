"use strict";
// tools/round-rules.mjs is a PORT of two Rust rules, and a port drifts. These
// tests pin each rule to the Rust it came from, by line, so a change on one
// side shows up as a failure rather than as a transaction the chain refuses
// with a code that cannot say which rule broke.
//
// Both rules are reported by round-type as -17 ROUND_ERROR_CONFIG. That single
// code covers the whole creation branch, which is exactly why checking locally
// is worth the duplication.
const { test } = require("node:test");
const assert = require("node:assert");

const load = () => import("../../../tools/round-rules.mjs");

const CKB = 100000000n;
// The demo round, which must stay valid.
const valid = {
  version: 1,
  ticketPrice: 10000n * CKB,
  minimumTickets: 5n,
  maximumTickets: 10n,
  entryStart: 13881n,
  entryEnd: 13887n,
  aggregationDeadline: 13889n,
  daoTermPeriods: 1,
  entryShardCount: 1,
  accumulatorId: 1,   // ACC_MMR
};

test("the demo round passes every rule", async () => {
  const { validateRoundConfig } = await load();
  assert.deepStrictEqual(validateRoundConfig(valid), []);
});

// encoding.rs:192-230, one rule per case.
const cases = [
  ["version must be 1 (encoding.rs:193)", { version: 2 }, /version/],
  ["ticket_price must not be 0 (encoding.rs:196)", { ticketPrice: 0n }, /ticket_price/],
  ["entry_shard_count must not be 0 (encoding.rs:199)", { entryShardCount: 0 }, /entry_shard_count/],
  ["entry_shard_count must not exceed 256 (encoding.rs:199)", { entryShardCount: 257 }, /entry_shard_count/],
  // A cap is per-shard, so a capped round may not shard at all.
  ["a capped round cannot shard (encoding.rs:207)", { entryShardCount: 2 }, /cannot shard/],
  ["minimum must not exceed maximum (encoding.rs:215)", { minimumTickets: 11n }, /minimum_tickets/],
  ["entry_start must not exceed entry_end (encoding.rs:218)", { entryStart: 99999n }, /out of order/],
  ["entry_end must not exceed the deadline (encoding.rs:218)", { aggregationDeadline: 13886n }, /out of order/],
  ["the deadline must fit the epoch field (encoding.rs:221)", { aggregationDeadline: 0x1000000n }, /epoch field/],
  ["dao_term_periods must not be 0 (encoding.rs:224)", { daoTermPeriods: 0 }, /dao_term_periods/],
  ["accumulator_id must not exceed ACC_IMT (encoding.rs:227)", { accumulatorId: 3 }, /accumulator_id/],
];

for (const [name, patch, pattern] of cases) {
  test(name, async () => {
    const { validateRoundConfig } = await load();
    const problems = validateRoundConfig({ ...valid, ...patch });
    assert.ok(problems.length > 0, "expected at least one problem");
    assert.ok(problems.some((p) => pattern.test(p)),
      `no problem matched ${pattern}; got ${JSON.stringify(problems)}`);
  });
}

// The two guards that encoding.rs:211-214 deliberately keeps separate, with a
// review ruling attached saying not to merge them. Merging would make one
// unreachable, so each is pinned by a case only it can refuse: a capped
// multi-shard round whose minimum is FINE, and an unshardable minimum/maximum
// inversion at ONE shard.
test("the capped-shard and minimum-exceeds-maximum rules are independently reachable", async () => {
  const { validateRoundConfig } = await load();
  const shardedOnly = validateRoundConfig({ ...valid, entryShardCount: 2, minimumTickets: 1n });
  assert.ok(shardedOnly.some((p) => /cannot shard/.test(p)));
  assert.ok(!shardedOnly.some((p) => /minimum_tickets/.test(p)),
    "this case must not also trip the minimum rule, or neither is pinned");

  const minimumOnly = validateRoundConfig({ ...valid, entryShardCount: 1, minimumTickets: 11n });
  assert.ok(minimumOnly.some((p) => /minimum_tickets/.test(p)));
  assert.ok(!minimumOnly.some((p) => /cannot shard/.test(p)));
});

// daowow-contracts-common/src/lib.rs:54, checked at round-type/src/main.rs:67.
// Pinned to a value three independent implementations agree on: CCC's
// hashTypeId, a hand-rolled molecule struct, and Python's blake2b with
// person=b"ckb-default-hash".
test("the creation round id is the Type ID derivation over input 0", async () => {
  const { creationRoundId } = await load();
  const input = {
    previous_output: {
      tx_hash: "0x86cb7a8ebac06ec26099e7da062764a64be61b4fa763c4509f82adc18f3400be",
      index: "0x2",
    },
    since: "0x0",
  };
  assert.strictEqual(creationRoundId(input, 0),
    "d15f6b5e968ec136d152b7c10132a1a8ddfcaaaa1fcd1e7692eb939e0a454fe4");
});

test("the config output index is part of the derivation", async () => {
  // Not decoration: it is why a round id identifies one output of one spend
  // rather than merely the spend.
  const { creationRoundId } = await load();
  const input = {
    previous_output: { tx_hash: "0x" + "11".repeat(32), index: "0x0" },
    since: "0x0",
  };
  assert.notStrictEqual(creationRoundId(input, 0), creationRoundId(input, 1));
});
