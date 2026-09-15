# Isolated DAOWOW withdrawal and settlement fixture — 2026-09-14

This fixture extends the actual creation-to-entropy history with the original
DAO deposit's DAOWOW-locked withdrawal preparation, native final withdrawal,
computed initial settlement funding and a final participant payout. It is a
bounded one-entry, one-winner MMR case, not general deployment readiness.

Live result: the full history passed in 207.266 seconds. Funding committed as
`0x15e1b61a642d16dbfd0d5351f69641df024cfba78140b5bd6e577796fb1886ed`;
final payout committed as
`0x1b631e2a183a1af132dc4bb64e03e06e6213dc4d5786d4f7c728cc84670de471`
at block 3639. The participant received 400 CKB principal plus 0.70133609 CKB
yield. The withdrawal-preparation epoch was 183 + 6/10, and final native
maturity was 363 + 2/10. All negative checks listed below passed.

All nine existing node/harness tests passed across focused commands: this
history test, the independent native DAO test (105.271 seconds), and seven
transport/lifecycle/basic-node tests (3.283 seconds). Logs are ephemeral:
`/tmp/daowow-full-round-first.log`,
`/tmp/daowow-full-round-native-regression.log`, and
`/tmp/daowow-full-round-harness.log`. Strict exporter Clippy, Python lint/format,
Rust formatting and whitespace checks pass. Core/VM suites were not rerun in
this test-only checkpoint; their previous 96/93 result remains historical.

Implemented and verified checks:

- Preserve the deposit's full 400 CKB capacity under its original DAOWOW lock.
- Reject a shortened DAO term and a missing original aggregation receipt.
- Derive phase-one timing from the actual deposit epoch plus the configured
  180-epoch term, retaining its fractional epoch.
- Derive native phase-two maturity from both committed epochs. Preparation
  after the first full term may require the next native 180-epoch period.
- Calculate native compensation from committed header accumulated rates and
  this exact deposit layout's 186 CKB occupied capacity.
- Derive complete initial liabilities from canonical entropy, schedule,
  receipt, entry capacity and winner membership proof using Rust core code.
  The contract independently derives and compares these values on the node.
- Reject a forged funding root and a one-Shannon-underpaid final payout.
  Underpayment is returned to sponsor change to preserve total capacity.
- Pay the participant's full deposit plus allocated yield. Sponsor inputs
  pay all fees; final sponsor change has a distinct lock so it cannot be
  mistaken for a second participant payout.

Rust and Python bounded reviews approved the fixture logic. The exporter
uses canonical funding and payout witness encoders. Its unit-test target has
zero tests; behavioral verification is the live node fixture, not that target.

No production contract code, testnet node, wallet or deployment is changed.
The existing broader legacy smoke-test issues remain separate and unresolved.

Remaining after this case: multiple participants/batches and failed rounds,
protocol-specific orphan/rebuild/refund/payout liveness across competing
branches, broader maturity and maximum valid proof cases, operational tooling,
and a gated hardened testnet rollout.
