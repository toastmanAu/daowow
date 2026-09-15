# Isolated refund reorg recovery — 2026-09-14

An actual one-entry MMR refund now survives a competing-branch rollback and
explicit recovery. The original history creates and freezes the entry, closes
the unaccepted ledger at the deadline, and commits a full 400 CKB refund.

A second isolated node validates the shared prefix ending before the refund,
mines a longer branch without that transaction, and relays it to the original
node. Canonical tip/block-hash checks establish branch replacement. The old
refund is no longer committed, both its outputs are non-live, and the exact
entry and sponsor cells match snapshots taken before the original refund.

On the fresh fork, a one-Shannon-short refund rejects, with the missing Shannon
returned to sponsor change so total capacity is preserved. A valid replacement
refund changes only the sponsor fee by 100,000 Shannons. It commits and is
relayed to the original node, where canonical inclusion and the exact ordinary
400 CKB participant output are checked. Both inputs are spent and the old
refund output remains non-live. A different-hash repeat spend rejects.

## Verification

The new test first failed at its missing-recovery assertion after the actual
refund committed. With the recovery implementation, this focused command
passed **nine tests in 18.285 seconds**, exit zero:

```sh
DAOWOW_RUN_ISOLATED_NODE=1 PYTHONPATH=tests/devnet python3 -m unittest test_node_harness test_round_creation.RoundCreationTests.test_excluded_entry_refund_after_deadline test_round_creation.RoundCreationTests.test_orphaned_refund_recovery -v
```

- Orphaned refund: `0x2ab7d61d04de970b8d9d6905510f4b107102440308c2625a85e7f53660675a33`
- Recovered refund: `0xf1722deb1e43389c57a2ee0b9216cea782feeca7702b7adec21ddf27014a9557`

These identify disposable-chain transactions, not testnet deployments. No
production contract, Rust exporter, wallet or public node was changed.

Bounded Python/security review approved the change. Ruff lint/format and
whitespace checks pass. Default discovery passes four unit tests and skips
nine opt-in Docker tests.

## Limits

This covers a short refund rollback with stable entry and closed-ledger history,
one entry, one participant and MMR. Deeper authority/maturity rollbacks,
multiple entries/participants and partially accepted histories remain open.
Recovery transactions are explicitly submitted on the fresh fork and relayed
as blocks, not through a production keeper on the original node. Persistent
journaling, restart recovery and mempool conflict handling remain unvalidated.

The complete 13-test live suite was not run here; the previously observed
Docker mining RPC timeout remains a separate harness reliability issue.
See [harness instructions](../tests/devnet/README.md) and the
[funding/payout recovery report](validation-2026-09-14-settlement-reorg.md).
