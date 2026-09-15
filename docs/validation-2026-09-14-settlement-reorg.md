# Isolated funding and payout reorg recovery — 2026-09-14

Result: a real one-entry MMR history passes two competing-branch rollbacks and
explicit recovery through the full participant payout. No production contracts,
Rust exporter, wallet, public node or testnet funds were changed.

## Executed history

The original node completes the entire round through native DAO maturity,
computed funding and payout. A second isolated node validates the same genesis
and all 3,635 blocks preceding funding. It mines a longer competing branch
without the funding transaction or its child payout, then relays it to the
original node. Canonical tip and block-hash checks establish a real reorg.

The test checks that both orphan transactions are no longer committed, their
outputs are non-live, and the funding transaction's DAO and sponsor inputs are
live again. The old payout fails dependency/input resolution on the fresh fork,
which never received the orphan transaction chain in its mempool.

Replacement funding uses the same entitlement evidence, participant capacity
and settlement data, with a 100,000-Shannon sponsor fee adjustment to produce a
different transaction hash. It commits on the fork and is relayed to the original
node, where canonical inclusion and exact live settlement output are verified.

A payout of that funding commits only on the original node. A second longer
branch removes it. The test checks that the payout is no longer committed, its
output is non-live, and the exact settlement cell is live again. Replacement
payout, again with only a sponsor fee adjustment, commits and becomes canonical.

The participant receives **400 CKB principal plus 0.70133609 CKB yield**.
The old outputs remain non-live and the final inputs are spent. A further
different-hash attempt to spend the same inputs rejects, avoiding reliance on
duplicate-transaction-hash rejection as evidence against double payment.

## Verification

```sh
DAOWOW_RUN_ISOLATED_NODE=1 PYTHONPATH=tests/devnet python3 -m unittest test_round_creation.RoundCreationTests.test_orphaned_funding_and_payout_recovery -v
```

Passed in **434.409 seconds**, exit zero. Run identifiers (disposable chain):

- Original funding: `0x74759c4449d396e0e2eed7e8a7df5c018f562f91b5fdb84fc04288585b1faa90`
- Recovered funding: `0x0405e9f4c97612a55631f3a32574f1df694892f83c94ab14ec882734316acb4e`
- Separately orphaned payout: `0x793e5c7b25f91eca04cef2783952fa3deff2789e77d974f1fc3a5a66a04bbe80`
- Final payout: `0x890e62aa9629a5ffac19d611e9696c9e8b7e5d8defc98d58dfa4fb8374a4b0ac`

Eight focused harness/refund regressions also passed in **7.811 seconds**:

```sh
DAOWOW_RUN_ISOLATED_NODE=1 PYTHONPATH=tests/devnet python3 -m unittest test_node_harness test_round_creation.RoundCreationTests.test_excluded_entry_refund_after_deadline -v
```

Default discovery passes four non-Docker tests and skips eight opt-in tests.
Ruff lint/format and whitespace checks pass. Bounded Python/security review
approved the changes. The new test initially failed at an explicit missing
recovery-fixture assertion; the live run above validates the implemented path.
The complete 12-test live suite was not run in this checkpoint. The previously
observed Docker mining RPC timeout remains an open harness reliability issue;
this run did not encounter it, and no retries or weakened assertions were added.

## Limits

Recovery is explicit test code, not a restart-safe keeper or transaction journal.
The replacement transactions are submitted on the fresh fork and relayed as
blocks; this does not prove mempool conflict eviction and resubmission behavior
for a production keeper on the original node. Participant authorization uses
the existing disposable always-success fixture, not a real wallet.

These are short rollbacks after maturity with stable deposit/withdrawal/entropy
history, one participant, one batch and MMR. They do not cover deeper maturity
or entropy rollbacks combined with settlement rollback, refund reorg recovery,
partial/multi-party payout recovery, node restarts or arbitrary competing spends.
The dev chain uses Dummy PoW and is not testnet-consensus equivalence.

Implementation: `tests/devnet/settlement_reorg.py` and the recovery branch in
`tests/devnet/test_round_creation.py`. See the
[harness instructions](../tests/devnet/README.md).
