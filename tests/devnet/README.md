# Isolated full-node validation harness

This standard-library Python harness runs the cached, digest-pinned CKB image
in disposable containers. It never connects to a supplied RPC URL or wallet.

Run transport and lifecycle unit tests without Docker:

```sh
python3 -m unittest discover -s tests/devnet -v
```

Explicitly enable the full-node tests (requires Docker daemon access and the
cached image; the harness does not pull it):

```sh
cargo build --offline --release --target riscv64imac-unknown-none-elf -p smoke-minimal -p round-type -p entry-shard-type -p entry-lock -p dao-lock -p settlement-type
cargo build --offline -p daowow-integration-tests --example devnet_round
DAOWOW_RUN_ISOLATED_NODE=1 python3 -m unittest discover -s tests/devnet -v
```

Image:
`nervos/ckb@sha256:4d6e113b4e95d5b4802e36b9199c585666c0e66ff400b398f3117f36d4f304f8`.

Each container has network mode `none`, no published ports or host mounts,
read-only root filesystem, all capabilities dropped and no-new-privileges.
Generated config and chain state live in a 1-GiB tmpfs, with a 2-GiB memory
limit, two CPUs and a 256-process limit. RPC travels over container-local
loopback through `docker exec`, not the host LAN. Cleanup removes only the
specific container ID persisted in this harness's private CID file, including
when launch times out after creation. No pruning or broad cleanup
commands are used.

The generated dev spec uses a 3.5B maximum block-cycle limit and Dummy PoW.
These are controlled dev-chain tests, not testnet-consensus equivalence.
IntegrationTest RPC is enabled only inside these isolated containers.

The live suite uses the locally built `smoke-minimal` always-success lock for
disposable genesis funds. It reads that one ELF and streams it into the
container; it never loads signing keys. **This lock is a test fixture, not a
safe lock for real funds.** The additional genesis cells change the fixture
genesis hash relative to the earlier empty-block harness.

`IsolatedNode(daowow=True)` additionally includes the five locally built
DAOWOW binaries in that node's disposable genesis. Default native DAO and
basic reorg fixtures retain their existing genesis. No code deployment is
sent to testnet. The Rust exporter emits canonical configuration, shard and
witness bytes; the Python test assembles the RPC transaction around them.

Current live coverage (fifteen tests total, including four non-Docker tests):

- Assert dev chain identity, target block-cycle limit and container isolation.
- Mine a block and check its canonical hash and height; verify cleanup.
- Start two nodes with identical genesis and distinct block-assembler messages.
  Mine a one-block branch and a competing three-block branch. Submit the latter
  to the former and assert its canonical height-one hash and tip change.
- Spend the isolated genesis fixture and verify actual commitment.
- Commit a native DAO deposit and withdrawal preparation; reject the final
  withdrawal immediately and one fractional-epoch step before maturity.
  Submit at the exact maturity fraction, mine through the proposal window,
  and verify the committed compensated payout and consumed input. This mines
  approximately 1,800 blocks and currently takes about two minutes.
- Create an immutable DAOWOW round and both configured empty MMR shards in
  one committed transaction. Reject missing-shard and missing-schedule
  variants, then assert exact live output scripts, capacities and data.
- Continue that actual history with one MMR entry, both shard freezes at
  epoch two, ledger initialization and atomic aggregation into a full-capacity
  native DAO deposit plus authenticated receipt. Corrupt roots, premature
  freeze and one-Shannon-short deposits reject. Code deps precede config,
  exercising the bounded configuration scan with large binary dependencies.
- Close both ledgers and commit the canonical seal; a missing shard dep rejects.
  Authenticate the actual +64/+128/+192 headers in the entropy successor.
  Submission at +192 rejects; after tip +256, wrong-header and forged-data
  mutations reject and valid entropy commits. This does not test the precise
  pool-admission cutoff or submit a deliberately premature block.
- Withdraw the original DAO deposit under DAOWOW's lock after the configured
  term, with same-transaction receipt authentication. Reject a shortened term
  and missing receipt. After native maturity, derive and commit initial
  funding, reject a forged root, then consume that funding into the complete
  participant payout; one-Shannon underpayment rejects. This one-entry MMR
  history mines roughly 3,600 blocks and takes several minutes.
- Repeat that history with a longer competing branch replacing the seal's
  inclusion and entropy. Assert canonical tip replacement and that the old
  entropy cell is no longer live. A control-paired sponsor transaction rejects
  the orphaned cell dependency and commits with the rebuilt canonical one.
  Continue actual withdrawal, computed funding and final payout on that chain.
- Leave the actual entry unaggregated, reject early closure, then close the
  populated ledger at the aggregation deadline. Return the entire 400 CKB
  entry cell to the participant. Missing closed-ledger authority, premature
  `since`, missing membership proof, one-Shannon underpayment and nonempty
  refund output data reject. Sponsor change has a separate lock identity.
- Replace a committed refund with a longer branch, assert exact entry/sponsor
  input restoration, and commit a replacement full-capacity refund. Reject
  underpayment after rollback and a distinct-hash duplicate spend afterward.
- Append two same-owner entries, accept only the first into a DAO deposit,
  close the partially accepted ledger at the deadline and refund the excluded
  entry in full. Reject using the accepted entry's proof for that refund and
  verify the accepted DAO deposit and receipt remain live and unchanged.
- Continue that partially accepted round through seal, authenticated entropy,
  DAOWOW-locked withdrawal, computed funding and full payout. Verify the
  excluded 400 CKB refund remains live and unchanged, separately from the
  accepted 400 CKB principal plus actual DAO yield.
- Orphan committed funding and its child payout using a longer branch. Assert
  restored withdrawing DAO/sponsor inputs, reject the orphan payout on the
  fresh fork, and commit replacement funding with unchanged participant data
  and capacity. Separately orphan a payout of that funding, assert the exact
  settlement cell is restored, and recover the complete payout. A distinct-hash
  attempt to spend the consumed funding again rejects. This fixture validates
  roughly 3,600 shared blocks on a second node and takes about seven minutes.

Unit tests additionally cover HTTP framing, non-success HTTP responses,
interrupted-launch cleanup and already-removed containers. Docker live tests
are skipped unless the explicit environment opt-in is present.

These are actual competing-branch reorgs, not manual truncate/rewind. The entropy
case rebuilds evidence in test code, not a production keeper. Its orphan-rejection
probe tests cell-dependency resolution, not a stale settlement witness directly.
Refunds now cover one unaggregated entry after deadline closure and a short
refund rollback/recovery, but not broader failed-round histories. Funding/payout recovery is
covered by a controlled fixture, not persistent production keeper tooling.
The DAOWOW histories have one participant, up to two entries and at most one
accepted batch; multi-participant/batch cases remain open. Both the short
partial-refund fixture and its full payout continuation are covered.
The independent native DAO coverage uses
one same-epoch deposit/prepare fixture with a nonzero epoch fraction; broader
epoch-length and withdrawal-period cases remain follow-up work.
