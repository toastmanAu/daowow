# Security repair checkpoint — 2026-09-06

Status: partial, local, not ready for a funded round. The confirmed testnet
manifest describes older prototype binaries and has not been changed.

2026-09-15 partial-round completion: actual partial acceptance now reaches
computed funding and full payout, preserving the earlier excluded-entry refund.
The accepted 400 CKB principal earns 0.70133609 CKB yield in this fixture; the
separate 400 CKB refund stays live. Full partial history and ten regressions
pass; Rust/Python reviews approve. No production contract or testnet changes.
See [full partial-round evidence](validation-2026-09-15-partial-full.md).

Partial-acceptance checkpoint, 2026-09-14: actual two-entry MMR history accepts
one entry into the DAO and refunds the other after deadline closure, preserving
the accepted DAO and receipt. A mismatched entry proof rejects. No production
contracts or testnet changed; broader histories and the partial round's eventual
payout remain open. See [partial evidence](validation-2026-09-14-partial.md).

Refund-reorg checkpoint, 2026-09-14: actual refund rollback and recovery now
passes with exact input restoration, full-capacity return and rejection of
underpayment and a distinct-hash duplicate spend. Nine focused tests pass;
no production contracts or testnet changed. Broader histories and production
keeper recovery remain open. See
[refund-reorg evidence](validation-2026-09-14-refund-reorg.md).

Funding/payout-reorg checkpoint, 2026-09-14: real longer branches orphan
funding and payout, restore spendable inputs, and support replacement funding
and complete payout. The final different-hash double spend rejects. The focused
test and eight regressions pass; Python/security review approves this bounded
fixture. No contract or testnet changes. Production keeper persistence and
broader reorg cases remain open. See
[settlement-reorg evidence](validation-2026-09-14-settlement-reorg.md).

Refund checkpoint, 2026-09-14: the isolated full node commits a full-capacity
refund for an actual excluded MMR entry after deadline closure. Five invalid
refund variants reject, alongside premature closure checks. Rust and Python
fixture reviews approve the bounded changes; no production contract edits.
One full-suite mining RPC timed out; the unchanged focused rerun passed, but
the complete run is not claimed green.
Broader failed-round and refund reorg coverage remain open. See
[refund evidence](validation-2026-09-14-refund.md).

Entropy-reorg checkpoint, 2026-09-14: the isolated one-entry history survives
replacement of the seal/entropy branch and completes computed funding and
payout using rebuilt canonical evidence. A paired dependency probe rejects the
orphan and commits with the canonical replacement. Ten node/harness tests pass
across focused runs; bounded Python/security review approved the fixture.
This does not establish production keeper recovery, refund liveness or recovery
of orphaned funding/payout transactions. No contract or testnet changes.
See [entropy-reorg evidence](validation-2026-09-14-entropy-reorg.md).

Later 2026-09-14 checkpoint: an actual one-entry MMR history now completes
DAOWOW-locked native DAO withdrawal, computed initial funding and final payout.
Shortened-term, missing-receipt, forged-root and one-Shannon-underpayment
mutations reject. Nine node/harness tests pass across focused runs; bounded
Rust/Python review is approved. No contract code or testnet deployment changed.
General round coverage and protocol-specific reorg/liveness remain open. See
[full-round evidence](validation-2026-09-14-full-round.md).

2026-09-14 checkpoint: canonical ledger closure, seal and scheduled entropy
now commit on the isolated full-node history. Bounded Rust/Python reviews
approved the fixture. The test does not establish an exact mempool cutoff or
premature-block rejection; DAO withdrawal/funding/payout history and protocol
reorg/liveness remain open. See [entropy evidence](validation-2026-09-14-entropy.md).

Later 2026-09-13 checkpoint: real entry → freeze → ledger → native DAO
aggregation now commits on the isolated full node. Config lookup now uses a
fixed-size read so large code deps before config cannot exhaust the heap.
Core (96) and targeted security/lifecycle VM tests (93) pass with rebuilt
contracts. Broader legacy smoke tests have separate open prerequisites and
an obsolete expectation; the full integration package is not claimed green.
See [aggregation evidence](validation-2026-09-13-aggregation.md).

2026-09-13 protocol-history checkpoint: the isolated node commits the actual
round configuration and both empty MMR shards. Missing-shard and
missing-schedule variants reject. Rust exporter and Python/container review
approved this bounded creation fixture; the prior native DAO fixture review
gap is closed. The full DAOWOW lifecycle/reorg gate remains incomplete. See
[round creation evidence](validation-2026-09-13-round-creation.md).

2026-09-12 node checkpoint: eight tests pass, including real native DAO
deposit/preparation, premature-withdrawal rejection and compensated withdrawal
after exact fractional-maturity submission. The basic competing-branch reorg
also passes. Docker has no host mounts, published ports or external networking.
DAOWOW history/reorg validation and broader native maturity cases remain open;
independent review of the new fixture was approved on 2026-09-13.
See [native DAO evidence](validation-2026-09-12-native-dao.md).

64-liability checkpoint (2026-09-11): creation and consumption of the resulting
funding cell pass on MMR, SMT and IMT. Thirty-two distinct depositors and 32
prize-only winners are authenticated, with known participant scripts and
sponsor-funded capacity top-ups. Invalid detached payloads at160KiB and one
byte above reject normally. Bounded fixture review approved this test-only
change; history before phase2 remains seeded. See the
[64-liability report](benchmarks/2026-09-11-64-liability-creation.md).

Distinct-owner budget fix, 2026-09-11: the owner-approved verification split
reduces SMT initial creation from 73,445,370 to 32,957,450 cycles. The DAO lock
requires the exact configured new settlement output and rejects matching
settlement inputs; settlement creation performs full verification once. Native
DAO validation remains unchanged. The unchanged 70M regression now passes.
See the [verification-split report](benchmarks/2026-09-11-single-verification.md).

Latest local checkpoint (2026-09-11): 96 core and 93 targeted VM tests pass.
All five RISC-V release contracts build; strict default/no_std core and
five-contract Clippy, formatting and whitespace gates pass. Shared creation
authentication and sponsor-aware payout accounting passed bounded Rust/security
reviews. No node lifecycle validation or deployment occurred. Full history,
maximum creation heap/witness cases and node maturity/reorg remain open.

Later creation-limit tests exposed native DAO rejection of large inline
witnesses and excessive repeated ledger/config validation. Bounded detached
evidence transport and private-state validation reuse repair these cases;
32-entry/32-prize/256-shard fixtures pass for MMR, SMT and IMT. SMT is close to
70M, so this is not a worst-case cost guarantee. See the
[creation-limit report](benchmarks/2026-09-11-entitlement-creation.md).

Previous pure-library checkpoint (2026-09-10): 96 core tests pass after adding the
bounded entitlement payload codec, with strict default/no_std core Clippy and
formatting passing. This codec checkpoint did not rerun VM or node validation.

Previous full checkpoint (2026-09-10): 91 core and 72 targeted VM tests pass after
initial-entitlement derivation and schedule-at-creation enforcement. All five
RISC-V release contracts build; strict default/no_std core and five-contract
Clippy, repository formatting and whitespace gates pass. Integration fixtures
still emit existing unused/dead-code warnings; strict integration-test Clippy
is not claimed.

Previous full verification (2026-09-10): all five RISC-V contracts build; 69 core
tests and 70 targeted VM tests pass, including the cursor-skipping regression
and eleven canonical public shard-lock tests.
Core default/no_std and contract Clippy plus repository formatting pass.
Earlier counts below describe historical checkpoints, not the current suite.
Codec, shard-fix and indexed settlement semantic reviews are complete within their bounded scope;
the project is not independently audited or ready for a funded round.

The ledger/entry/receipt/DAO wiring also passed bounded Rust/security review.
All four requested adversarial test gaps were subsequently covered and
re-reviewed. Cost tuning subsequently reduced the maximum-batch SMT fixture
from 637.6M to 47.4M cycles under the ordinary 70M harness ceiling, with
bounded approval of canonical-input validation delegation. See
[the cycle report](benchmarks/2026-09-08-atomic-ledger.md), not a deployment claim.

## Implemented locally

- DAO phase2 forces configured settlement creation, which authenticates the exact
  withdrawing input, canonical receipt and immutable entropy dependency, native
  header-derived realization and complete derived funding bytes/capacity. This
  rejects standalone fabricated funding and altered roots/counts/accounting.
  WitnessArgs.output_type carries evidence while input_type retains the native
  DAO header index at the absolute DAO input witness. Twenty-seven DAO lifecycle
  tests and one standalone-creation regression pass. Historical dependencies
  are seeded in these fixtures. Expanded dependency groups and failed-round
  creation pass; duplicate dependencies and multiple matching DAO inputs reject.
  Maximum sparse proofs, distinct initial liabilities and simultaneous memory
  bounds remain open. Large payloads use the detached transport described above.

- Settlement pays full-capacity principal plus prize without adding occupied
  capacity twice. Extra output capacity and fees are sponsor gifts, not funding
  deductions or repayable claims. Sixteen payout tests pass. The synthetic
  64-liability final drain initially exhausted the 512-KiB monotonic heap;
  allocation-free lock-hash scanning resolves it at 7,394,402 cycles. Bounded
  review approved accounting and lookup. This does not prove maximum initial
  entitlement creation or real-node validity; see the
  [payout cycle report](benchmarks/2026-09-11-settlement-tail.md).

- The phase2 entitlement payload codec now carries a canonical schedule,
  complete batch entries/capacities and per-prize entry/proof records. It is
  intended for WitnessArgs.output_type, leaving native DAO input_type alone.
  It carries no claimed root/count, realized amount or witness-selected entropy.
  Counts, proof lengths, exact byte boundaries and the 160-KiB payload cap are
  checked; proof bytes are borrowed. Five test groups include exact-size limits,
  all truncations and a decode-to-entitlement test rejecting altered capacity.
  The bounded codec passed Rust/security review. Contract loading and canonical
  dependency enforcement are wired; maximum creation VM heap feasibility and
  full historical chain validation are still required.

- `InitialEntitlements` now replays complete batch entries/capacities against
  every receipt field and digest, checks accepted batch/nonce ranges, derives
  full-capacity principal plus actual-growth allocations and builds sorted,
  consolidated liability MMR roots/counts. Successful batches use the same
  verified global owners. Failed-round proportional allocation consolidates
  participants before rounding, then distributes residual Shannons in hash
  order. Eight test groups cover cross-batch owners, zero yield, altered receipt
  fields/capacities, later batches, u64 maximum, input bounds and split-entry
  rounding. Bounded Rust/security review approved this pure primitive. The
  shared contract caller now authenticates exact receipt batch identity,
  canonical dependency identities and native DAO realized value. Full-chain
  fixture history and real-node validation are not yet demonstrated.

- Round-type and each canonical shard now require the valid committed schedule
  during creation, including the untyped-config route. The ABI is
  WitnessArgs.output_type at the absolute config output index, with the full
  witness bounded to 4096 bytes before allocation. Lock data remains separate.
  Missing/malformed/mismatched schedules and oversized witnesses reject; the
  32-prize schedule and an extra witness slot at index1 pass VM validation.
  Immutable round updates do not require another schedule witness. Bounded
  Rust/security review approved the helper and both creation checks. See the
  [creation-cycle checkpoint](benchmarks/2026-09-10-round-schedule.md).

- `ComputedDraw` derives the approved seed and up to 32 distinct positions
  from config-bound closed ledgers and the immutable entropy snapshot. Global
  offsets use accepted tickets, excluding frozen suffixes. Per-prize proofs
  authenticate complete winner entries through MMR, SMT or IMT and check accepted
  nonces and checked ticket intervals. Empty/under-minimum rounds have no winners.
  Nine test groups cover sparse shards, genuine-but-excluded proofs, missing/
  extra/wrong owners, all accumulator branches, an independently calculated seed
  vector, entropy mutations and overflow. This is a pure API: canonical entropy
  cell/header provenance and initial-entitlement contract enforcement remain
  required. Bounded Rust/security review approved the module and its nine test
  groups with no actionable findings. No contract code or node state changed
  in this checkpoint.

- The approved schedule primitive now validates 1–32 positive weights, checked
  weight totals, exact canonical version/count/weight encoding and the
  domain-separated config commitment. Short-ticket rounds use the first
  available weights, normalize them and assign dust to first prize. Five new
  test groups include an independently calculated commitment vector and
  malformed/substituted schedules. Bounded Rust review approved this primitive
  after allocation and API-documentation fixes. This pure API does not authenticate a config
  cell or DAO yield, compute winners, or enforce initial funding entitlements.

- Canonical shard zero can now transition exactly once from its closed ledger
  into a seal containing all closed-shard snapshots in ID order. Creation
  authenticates the other canonical shard dependencies, retains public locks
  and capacity, and excludes entry inputs. The seal now has exactly one spending
  path: transition to its authenticated scheduled-entropy record.
  Shard-zero excluded entries can refund using the preserved snapshot. VM
  coverage includes 256-shard sealing and two-entry refunds against a 256-shard
  seal, under the ordinary cycle ceiling. This is not an unbounded refund
  batch-size guarantee. Seal bytes are `03 || count[u32] || ledger[207] * count`.
  Contract-computed winners and derived entitlements are now wired as above.
  Bounded Rust/security review approved seal creation and refund preservation
  after the maximum-size tests; this is not a complete protocol audit.

- The seal's canonical shard-zero input now anchors a version-4 entropy record.
  Its actual inclusion header is loaded through the input-associated syscall;
  header deps must be exactly that anchor followed by heights +64/+128/+192.
  Only relative-block `since` with value at least 256 and no other flag bits is
  accepted. Output bytes are recomputed from the unchanged seal and actual
  header hashes. Version-4 spending/downgrade is forbidden in this stage.
  Both seal and entropy snapshots preserve excluded-entry refunds. VM tests
  include 256-shard entropy and two-entry refunds, false anchor, wrong height
  with matching forged output, missing/reordered/extra headers, bad delay flags,
  changed snapshots/locks/capacity, and replay. Bounded security review approved
  this transition. Node consensus must still validate header chain membership
  and elapsed relative maturity; mock-header VM fixtures do not establish them.
  Wire: `04 || seal_bytes || inclusion_height[u64] || inclusion_hash[32] ||
  entropy_hashes[3 * 32]`. Schedule authentication is now enforced at creation;
  contract-computed winner/initial-liability enforcement remains a release blocker.

- Shards now require the canonical permissionless lock (same shard code/hash
  type, one-byte args `00`) on creation and both sides of updates. The lock
  checks every input has the matching enforcing shard or receipt type. Unknown
  modes, missing types and public-lock-as-type misuse fail closed. Shard
  capacity cannot decrease. Real round creation followed by permissionless
  freeze and the new adversarial lock/capacity cases pass in the VM.
  Frozen shards now initialize 207-byte ledgers. Atomic aggregation advances
  the accepted prefix, deposits full entry capacity and creates immutable,
  digest-bound 73-byte receipts. Terminal closure gates excluded-entry refunds.
- Round creation identity binds the first packed transaction input and the
  config output index; immutable updates retain the configuration.
- Entry, shard and DAO scripts authenticate config data through a hash
  commitment in their args. Substituted configuration VM cases are rejected.
- Shard creation requires the anchored config in the same transaction;
  attempts to recreate a shard using an existing config dependency fail.
  Round creation now requires every configured canonical shard. The positive
  test executes config and shard creation scripts together, with sponsor change.
- Freeze and refund use validated absolute epoch values, including fractional
  encoding checks, instead of comparing packed bits to integer epochs.
- Refunds sum full input capacities, including occupied capacity, and require
  ordinary empty-data participant outputs. The accounting also includes
  same-participant entry inputs from other configuration groups.
- Entry capacity includes real occupied capacity in shannons. Settlement
  payouts likewise use the occupied-capacity syscall.
- Indexed settlement uses an immutable MMR root/count and numeric next-unpaid
  cursor. Each payout proves the exact next index, blocking skips and replay;
  final consumption requires all indices paid and exact capacity conservation.
  Updates preserve the funding lock. Only one spending type group of the same settlement
  implementation is allowed per transaction, preventing shared payout reuse.
  Separate batch transactions can still run independently.
- Core frozen-position validation derives shard-major offsets and rejects
  missing/duplicate shards, nonce gaps and inconsistent counters. It does not
  authenticate accumulator roots or replace entry membership verification.
- MMR membership binds the mountain slot and path height to count/position
  and rejects trailing proof bytes. SMT insertion replays the same absence
  proof with the new leaf, preventing hidden extra insertions. Batched SMT
  appends now chain exact intermediate roots, in witness order.
- Draw sampling rejects the finite limit itself, handles power-of-two
  universes, rejects short output buffers and zero ticket counts, and uses
  checked, sequential retries. `rejection_sample` now returns a `Result`.
- DAO aggregation requires the native DAO type and eight zero data bytes.
  Phase one checks the full configured term from the deposit inclusion
  epoch, preserving fractions. Phase two independently calculates each
  input's native DAO compensation and requires the entire group's realised
  capacity in one config/batch-bound funding output. Fees require sponsorship.
- Final settlement can consume the funding cell when every Shannon goes to
  verified payouts. Partial settlement requires sufficient occupied capacity;
  the positive final-batch test no longer creates a zero-capacity cell.
- DAO withdrawal and settlement funding now require a canonical public lock:
  the settlement implementation's code/hash type with one-byte args `00`.
  It authorises spending only alongside the matching 72-byte-args
  settlement type. Missing/wrong types and attempts to use public-lock mode
  as a permissive type are rejected. No creator-selected signing key can
  gate payouts. This does not authenticate the liability root itself.
- Strict core and RISC-V contract lint gates pass. Unsupported dormant SMT
  trie branches were removed without enabling a new tree mode. Shared
  contract helpers build as an rlib, not an allocator-less standalone cdylib.
  Repository formatting was normalised to unblock review.
- JavaScript MMR verification now binds peak/path to the claimed position,
  rejects noncanonical trailing bytes and avoids signed 32-bit peak-count
  truncation. Draw inputs reject unsafe integer ranges and duplicate/rejection
  retries follow the corrected Rust order. Five security checks, eleven
  existing vector checks and the demonstration engine test pass.
- `daowow-core::lifecycle` now provides a tested accepted-prefix ledger:
  membership-checked sequential batches commit full entry data and input
  capacities; terminal closure excludes the unaggregated suffix permanently.
  Five tests cover skips, replay, forged membership, changed configuration,
  capacity binding/overflow, batch bounds, closure timing and no reopening.
  These primitives are now connected to shard, entry and receipt scripts.
  DAO phase one authenticates the receipt's creating transaction against the
  deposit outpoint. They do not establish draw or initial-entitlement security.

## Breaking script args changes

Settlement funding now uses the incompatible 112-byte V2 codec: u64 next-unpaid
cursor and immutable u64 liability count replace the old hash cursor. Payout
proofs are position-bound MMR proofs, not SMT proofs. Other fixed data layouts
remain V1, but script args are also incompatible with the deployed prototype.
Builders and deployment artifacts need updating
before use. Config commitment is CKB hash of `DAOWOW_CONFIG_V2` followed by
the encoded configuration.

| Script | Local args |
| --- | --- |
| round-type | round ID (32 bytes) |
| entry-shard-type | config commitment (32) + shard ID (LE u32) |
| shard lock | same shard implementation, one-byte args `00` |
| entry-lock | participant lock hash (32) + config commitment (32) |
| batch receipt type | tag `02` (1) + config commitment (32) + shard ID (4) + batch ID (8) + digest (32) |
| dao-lock | round ID (32) + batch ID (LE u64) + config commitment (32) + batch digest (32) |
| settlement-type funding produced by DAO withdrawal | config commitment (32) + batch ID (LE u64) + batch digest (32) |
| settlement funding lock | same settlement implementation, one-byte args `00` |

DAO withdrawal enforces the funding args above. Standalone settlement
creation still does not authenticate configuration or entitlements; the new
args alone do not close that security boundary. SMT batched append witnesses
must carry sequential absence/inclusion certificates, not pre-batch absence
proofs paired with final-root inclusion proofs.

DAO phase one currently accepts only explicit, nonduplicate Code dependencies;
builders must expand dependency groups. This restriction ensures raw dependency
outpoints and resolved syscall indices agree when authenticating receipt provenance.
No new deployment or transaction signing has occurred.

The owner approved returning full deposited capacity, treating only actual DAO
growth as yield, and sponsor-funded fees and extra payout capacity. Initial
entitlement construction still needs to enforce that policy.
The newly tested `allocate_prizes_complete` helper assigns all prize rounding
dust to the first prize, as approved, without changing the legacy allocator.
It is a pure accounting helper, not authentication of a supplied schedule/root.
Failed-round proportional yield returns are approved but not yet implemented.

Node preflight update (2026-09-09): the owner's RPC at
`http://192.168.68.134:8114` is reachable, reports the expected testnet genesis,
and has an indexer matching its reported tip. All five historical code cells
are live with manifest-matching hashes. Read-only validation RPC methods are
recognized. No devnet was started and no node-level lifecycle result is claimed;
see [the full validation checkpoint](validation-2026-09-09.md). The
approved testnet entropy offsets are +64/+128/+192 from seal inclusion, with
finalization at +256 or later. The input-bound header and relative-since checks
are implemented and VM-tested; full-node lifecycle validation remains unfinished.

## Verification

Pinned toolchain, offline locked dependencies:

```sh
cargo build --offline --locked --target riscv64imac-unknown-none-elf --release -p round-type -p entry-shard-type -p entry-lock -p dao-lock -p settlement-type
cargo test --offline --locked -p daowow-core --lib
cargo test --offline --locked -p daowow-integration-tests --test round_validation --test security_refunds --test security_freeze --test security_config --test security_shard_lock --test security_ledger --test proto1_entry_shard --test proto2_membership --test proto3_dao_lifecycle --test proto4_settlement
cargo clippy --offline --locked -p daowow-core -- -D warnings
cargo clippy --offline --locked -p daowow-core --no-default-features -- -D warnings
cargo clippy --offline --locked --target riscv64imac-unknown-none-elf --release -p round-type -p entry-shard-type -p entry-lock -p dao-lock -p settlement-type -- -D warnings
cargo fmt --all -- --check
node apps/web/test/security.test.js
node apps/web/test/core.test.js
node apps/web/test/engine.test.js
```

Results: build succeeds; 55 core tests and 35 VM tests pass. Integration-test
harness warnings remain; core and contract strict Clippy gates pass. Shared
settlement payout reuse, decoy DAO funding, wrong-batch funding, missing
canonical shards, and early phase-one withdrawal were accepted before their
guards and rejected afterward. These are VM harness checks, not node-level
capacity, maturity or complete-round validation.

Independent review is incomplete. The reviewer confirmed core check/Clippy,
then initially stopped on formatting. Formatting is now repaired, but the
resumed review hit an account usage limit before security diff inspection.
No independent security approval is claimed.

## Still blocking

Review update: the 2026-09-07 bounded semantic review identified a separate
settlement ordering defect. A keeper can supply an increasing subset that
skips earlier unpaid keys, then advance the cursor beyond them. Those earlier
liabilities become unpayable even if the root itself is authenticated. The
permissionless lock makes this an arbitrary-caller griefing path. Settlement
must prove contiguous progress through an authenticated liability ordering,
not merely membership and increasing keys. This finding is repaired by the
indexed V2 settlement implementation described below.

The same review found that shard creation accepts anchored configuration
bytes without requiring a round type on that output. An untyped configuration
output can therefore bypass the round script's complete-shard creation check.
This does not duplicate an existing legitimate anchored round, but invalidates
the stronger claim that every accepted shard proves complete atomic round
creation. This finding is now repaired locally: each shard creation group
independently enforces the complete canonical output set. The new VM test
accepted an incomplete set before the fix and rejects it afterward. Complete
sets with typed or untyped configuration outputs remain valid. Bounded
semantic review found no additional issue in this fix; 14 related VM tests
pass (round validation, entry shards, configuration and freeze suites).

The settlement finding was reproduced by paying a larger key before a smaller
one. The proposed
[remaining-liabilities design](superpowers/specs/2026-09-07-settlement-remaining-liabilities-design.md)
was implemented and then removed after semantic review found SMT proof
representation ambiguity under deletion. The ambiguity is now reproduced
in a passing core test; no deletion API remains in production. The approved
[indexed replacement](superpowers/specs/2026-09-08-indexed-settlement-design.md)
is now implemented and bounded-reviewed. Tests reject initial/interior skips,
replay, root/count/cursor changes and premature finalisation; valid batched
payouts pass. Initial root/count authentication is still a separate blocker.

1. Batch IDs and full input capacities now have authenticated receipt records.
   The proposed payout root must still be derived from those committed inputs.
2. Settlement creation still trusts a supplied liability root. Membership
   proofs against an attacker-chosen root do not authenticate entitlements.
   An authenticated draw/finalisation path is still missing.
3. Per-shard terminal accepted/excluded prefixes are now enforced by spending
   scripts. A unique round-wide seal and authenticated entropy remain missing.
   `since` supplies a lower bound, not an enforceable entry closing time;
   freeze timing alone does not close this gap or resolve failed aggregation.
4. The initial reserve/fee allocation policy still needs enforcement. The
   canonical permissionless lock and final zero-remainder consumption are
   repaired, but neither determines who owns each initial reserve Shannon
   or how that reserve is separated from prize yield.
5. Full node-level round execution and wider independent review remain open.
   Cross-config repayment reuse, accepted-entry refunds, receipt destruction,
   raw dependency ambiguity and terminal reopening now have VM regressions.
   The 32-participant SMT batch now costs about 47.4 million cycles within the
   ordinary 70-million-cycle harness budget; other accumulators, worst-case
   proof sizes and node admission still need operational validation.
6. Builders, protocol documentation and fresh deployment/signing artifacts
   must adopt the new ABI only after these gates close.

The user approved the full authenticated draw/finalisation path, with fixed
participant commitments and predetermined future block hashes (no optional
reveals). That scope is not being replaced with a principal-only release.
The seal/draw/initial-entitlement lifecycle remains unimplemented and blocks funded rounds.
Execution plan: [security-closure](superpowers/plans/2026-09-05-security-closure.md).

## Approved ledger design and next implementation unit

The user approved the [canonical shard ledger specification](superpowers/specs/2026-09-07-shard-aggregation-ledger-design.md).
The first detailed implementation unit is [ledger codecs](superpowers/plans/2026-09-07-ledger-codecs.md).
Its core implementation is now complete: 207-byte ledger state, 73-byte batch
receipts, checked shard/batch IDs and bounded indexed witnesses. The new
codecs passed bounded semantic review with no concrete findings. They cover
serialization and core rules. Ledger contract wiring is now implemented locally
and has received a bounded review with no critical/high finding.
A generic
native workspace test command fails to link CKB contracts due to duplicate
`_start`; it is not a substitute for the documented core/RISC-V/VM commands.
The bounded semantic review is not a full independent audit or release approval.
