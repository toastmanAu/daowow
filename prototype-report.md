# DAOWOW Prototype Report — first implementation sprint

Date: 2026-09-05
Scope: START_HERE.md Phase 0 + Phase 1 (the four proofs) and Milestones 0–3 of
`AGENT_HANDOFF.md` / `docs/implementation-plan.md`. UI, keeper SDK (CCC),
testnet deployment and the full contract set are explicitly **not** in this
sprint.

**Everything below is backed by executable tests on the real CKB-VM**
(ckb-testtool 1.1.1, in-process ckb-vm 0.24.14) plus 40 host unit tests for
the deterministic core. Reproduce with:

```sh
rustup target add riscv64imac-unknown-none-elf
cargo test -p daowow-core
cargo build --target riscv64imac-unknown-none-elf --release \
  -p round-type -p entry-shard-type -p entry-lock -p dao-lock \
  -p settlement-type -p accumulator-bench
cargo test -p daowow-integration-tests -- --test-threads=1 --nocapture
```

Exact versions: [`toolchain.lock.md`](toolchain.lock.md).

---

## 1. Environment and tooling

- rustc/cargo **1.98.1** pinned via `rust-toolchain.toml`; target
  `riscv64imac-unknown-none-elf`.
- `ckb-std =1.1.0` (features: allocator, calc-hash, ckb-types, dummy-atomic,
  type-id — the `libc`/`dlopen-c` C features are disabled so contracts build
  with a pure-Rust toolchain).
- `ckb-testtool =1.1.1` (in-process ckb-vm 0.24.14; `verify_tx` returns
  consumed cycles — used for all measurements).
- `ckb-system-scripts 0.5.4` provides the **native DAO binary** for tests; the
  DAO behaviour follows `reference/upstream/dao.c` (fetched from
  ckb-system-scripts master) and RFC-0023.
- `ckb-standalone-debugger v1.1.1` used as an independent second VM to debug
  transactions (`Context::dump_tx` JSON).
- Contracts are plain `bin` crates deployed with **hash_type `data1`** (VM V1).
  Vectors: `tests/vectors/daowow_core_vectors.json` (regenerate: `cargo test
  -p daowow-core --test gen_vectors`).

### Toolchain landmines hit (documented so nobody re-steps on them)

1. **`--no-rosegment` is mandatory** for rustc 1.98-linked scripts on this VM:
   without it `.rodata` shares the executable segment and every script dies at
   startup with `MemWriteOnExecutablePage`.
2. **The template-recommended `+zbb`/`lower-atomic` flags are unusable on
   1.98**: the `lower-atomic` LLVM pass no longer exists, so B-extension
   instructions survive and fault on the VM (`data1` scripts run
   ISA_IMC|B|MOP; plain `data` runs IMC only). We ship plain RV64IMAC code and
   deploy as `data1`.
3. **The `bytes` crate emits RISC-V atomics** (A-extension) from its
   refcounting; ckb-vm (IMC) faults on them. `vendor/bytes` replaces the
   refcount ops with single-threaded ones under `--cfg daowow_noatomic`
   (host builds keep real atomics). Scripts are single-threaded, so this is
   sound.
4. **ckb-std's buddy allocator** (buddy-alloc 0.6) corrupts memory on this
   toolchain; contracts use a 512 KiB bump allocator
   (`daowow_contracts_common::bump_alloc`) instead.
5. **testtool's `find_cell_dep_for_script` looks up Type scripts by
   `code_hash`** against a map keyed by `calc_script_hash` of registered cell
   types — the test harness mirrors genesis-style self-consistent hashes.

## 2. Prototype architecture (what exists)

```text
crates/
  daowow-core/            deterministic protocol logic (no_std), 40 unit tests
    encoding.rs           canonical fixed-width layouts (v0.2, LE, strict)
    leaf.rs               entry/liability/entropy leaf hashing (frozen domains)
    shard.rs              pure EntryShard state transitions
    accumulator/          smt (vendored CKB SMT) | mmr | imt + bench facade
    witness.rs            strict witness encodings for every script
    draw.rs               seed derivation + rejection sampling + draws
    accounting.rs         shannon-exact conservation helpers
  daowow-contracts-common/ on-chain shared helpers + bump allocator
contracts/
  round-type/             immutable RoundConfig creation/validation
  entry-shard-type/       sharded entry collection + accumulator transition
  entry-lock/             aggregation (membership proof) or refund — nothing else
  dao-lock/               native-DAO custody: phase1/phase2 rules
  settlement-type/        batched direct payouts with liability proofs
  accumulator-bench/      workload verifier used for the bakeoff
tests/
  integration/            proto1..proto4 + smoke + accumulator bakeoff
  vectors/                daowow_core_vectors.json, accumulator_bench.json
```

Wire formats are hand-rolled fixed-width little-endian (the Molecule skeleton
`schemas/daowow.mol` itself says layouts must not be frozen before
benchmarking — this sprint produced the numbers to freeze them in Molecule
form next sprint). All hash domains are frozen strings in `daowow-core`.

## 3. The four Phase-1 proofs — results

### P1-a Entry shard contention + accumulator (proto1, 5/5 green)

- Contended shard heads serialize through the UTXO model: two sequential
  entry txs on the same shard pass end-to-end on CKB-VM (886,973 and 932,227
  cycles).
- Batched entries: 2-entry tx = 1,789,784 cycles; parallel shards verified
  independently in the same context.
- Every entry cell is bound one-to-one to a witnessed entry (uncovered entry
  cells rejected, `-33`); principal = tickets × price enforced (`-31`);
  sequence/counter jumps rejected (`-31`); forged accumulator roots rejected
  (`-33`); OPEN→FROZEN only, frozen cells immutable (`-34`).

### P1-b Entry membership proof (proto2, 3/3 green)

- Freeze → aggregate 3 entries (600 CKB principal) into a **native Nervos DAO
  deposit cell** locked by DAOWOWDAOLock(round, batch): **1,579,288 cycles**.
  Membership proofs verified against the frozen shard accumulator on-chain.
- Adversarial: unaccepted entry (wrong nonce/leaf) rejected `-45`; entry value
  routed to a non-DAO destination rejected `-47`; capacity of entry inputs
  must exactly fund DAO deposits.

### P1-c DAO custody transition (proto3, 5/5 green)

- Phase 1 (deposit → withdrawing): 53,457 cycles. The dao-lock enforces
  same-index output, capacity/type preservation, **no lock substitution**
  (`-57`) and the correct deposit block number in cell data (`-58`), matching
  dao.c's structure checks.
- Phase 2 (withdrawing → settlement funding): 64,243 cycles with the native
  DAO computing compensation from mock header DAO fields (AR 1.00 → 1.01).
  `since` is an absolute epoch (RFC-0023); witness `input_type` carries the
  deposit header index. Realised capacity may only land in settlement-type
  cells of the same round (`-59` otherwise).
- No privileged key anywhere: entry-lock has no operator path, dao-lock
  phase-2 only relaxes into same-round settlement state.

### P1-d Direct batched settlement (proto4, 3/3 green)

- Funding cell (as produced by dao-lock phase 2) → 4 direct payouts =
  **2,271,102 cycles**; drain batch of 2 = 1,140,185 cycles. Payouts are
  ordinary cells (no type, empty data) locked by each participant's own
  script; amounts = principal + prize + occupied capacity of the output.
- Payouts are authorized by SMT liability proofs against the funding root and
  consumed in strictly ascending lock-hash order (cursor advances) — no claim
  contract, no double payout.
- Adversarial: conservation violation rejected `-72`; bad liability proof
  `-73`; duplicate/out-of-order payout `-75`.

## 4. Accumulator bakeoff (Milestone 3) — MMR selected

Measured on CKB-VM, sizes 0/15/255/4095 leaves (full table +
JSON: `tests/vectors/accumulator_bench.json`, ADR:
[`docs/ADR/0001-accumulator.md`](docs/ADR/0001-accumulator.md)):

| acc | append @0 | append @4095 | witness @4095 | mem/op @4095 | proof @4095 |
|---|---|---|---|---|---|
| SMT (insert certificate) | 833K | 1,112K | 1,074 B | 602K | 467 B |
| **MMR (selected)** | **75K** | **185K** | **534 B** | **108K** | 419 B |
| IMT (depth 32) | 8,024K | 8,117K | 1,132 B | 249K | 1,024 B |

MMR wins because append authorization is native (peak-list rebagging against
the committed old root — no history rewriting possible) and every measured
cost is 3–10x lower than the alternatives. Membership costs grow
logarithmically. The SMT remains in the tree (vendored, pure-Rust hasher) and
is used for the *settlement liabilities root*, where the set is built once
off-chain and only membership is ever proven on-chain — the SMT's weak spot
(append authorization) is not exercised there.

## 5. Occupied capacity per cell (RFC-0023 convention: capacity + data + lock(33+args) + type(33+args))

| cell | bytes | CKB |
|---|---|---|
| RoundConfig (data 358 B, secp lock) | 361 | 36.1 |
| EntryShard (data 101 B, secp lock, type args 8) | 195 | 19.5 |
| Entry (data 132 B, entry-lock args 32, no type) | 205 | 20.5 |
| DAO deposit (data 8 B, dao-lock args 40, DAO type) | 121 | 12.1 |
| Settlement funding (data 128 B, secp lock, type args 8) | 200 | 20.0 |
| Participant payout (data 0, participant lock) | 61+args | 6.1+ |

Implications (spec §"never silently deduct"):

- Entry capacity = principal + 205 shannons of structural overhead. The
  overhead is **principal-proportional padding**: it is carried into the DAO
  deposit as occupied capacity, earns nothing, and is returned at settlement
  (the settlement payout formula pays principal + prize + output occupancy
  explicitly). At a 100 CKB ticket price the entry overhead is ~0.002% of
  principal — acceptable; at 1 CKB tickets it would be 0.2% and the minimum
  viable ticket price question (open-questions P1-14) must be answered before
  lowering prices.
- 32 shards cost ~624 CKB of locked capacity overhead for the shard cells
  alone (sponsored by the round creator; returned/refunded with the round).

## 6. Batching limits measured

- **Entries per shard tx**: tested 1 and 2 per tx; witness cost per entry is
  ~440 B (entry) + 2 SMT certificates at n=4095 ≈ 934 B/entry (append_prf
  column) — at the 32 KB witness ceiling that bounds entries-per-tx in the
  hundreds even at large shard sizes; practically the limit is the entry
  cells' output count per tx. Batch size should be a keeper policy constant.
- **Entries per aggregation tx**: 3 proven; cycle cost 1.58M for 3 entries
  dominated by per-entry membership proofs (~108K each at n=4095) + fixed
  script cost, so the practical ceiling is cycle-budget-driven (CKB
  max_cycles = 70M for this account level ⇒ hundreds of entries/tx).
- **DAO cells per withdrawal tx**: phase-1/phase-2 scripts iterate the group
  and were tested with 1; the native DAO + header-dep/witness growth
  (P1-9/10) still needs a dedicated scale test.
- **Direct payouts per settlement tx**: 4 + drain proven; 2.27M cycles for 4
  payouts implies a ceiling of ~100 payouts/tx at 70M cycles (dominated by
  SMT membership verifies); witness size is the second bound.

## 7. Required protocol-spec changes (empirically forced)

1. **MMR replaces SMT/MMR/IMM ambiguity** in §5 — ADR-0001. `accumulator_id`
   is a round config field so old rounds keep their verifier.
2. **`EntryDataV1.position_base` added** — ticket ranges must be
   self-evidencing on-chain (T-11/T-03 support); pure addition to the mol
   skeleton.
3. **`EntryShardDataV1.state` (u8) + sequence semantics** — sequence advances
   by entries-per-tx (batched collection), batch bound = keeper policy.
4. **Refund path needs no participant signature**: entry-lock refund pays
   exclusively to the committed participant lock hash, gated by an
   absolute-epoch `since` ≥ `aggregation_deadline` enforced by consensus +
   script. This removes all signature-verification code from v0.2 contracts.
   (Trade-off: anyone can *trigger* a refund after the deadline, but only the
   participant can *receive* it.)
5. **Phase-2 destination rule** narrowed for v0.2: realised capacity flows
   only to settlement-type funding cells of the same round; batch-level
   accounting (M6) will bind batch_id → funding cell explicitly.
6. **Deposit cell layout confirmed**: dao.c requires (and dao-lock re-checks)
   same-index withdrawing outputs with block-number data; lock substitution
   protection is **entirely** the lock's job (dao.c explicitly permits any
   lock on the withdrawing cell) — T-02 mitigation validated by test.

## 8. Known gaps / next tasks

- **Batch accounting (M6)**: dao-lock currently proves same-round settlement
  destination, not per-batch principal sums; BatchCommitmentCell (TX-05) is
  specified but not implemented.
- **Entropy/draw (M7)**: seed derivation + rejection sampling implemented with
  vectors, but no on-chain reveal path or finalisation cell yet; randomness
  review (open-questions P0-3) still blocks this.
- **Molecule codegen**: layouts are frozen-by-benchmark; next sprint should
  port `daowow.mol` to the measured widths and swap hand-rolled codecs for
  generated ones.
- **Scale tests**: 100 participants / 32 shards / multi-batch DAO withdrawals
  (testing-strategy scale list) — the harness now exists for these.
- **CCC/TypeScript**: not started — per plan this begins with the keeper SDK
  (M9); install/read CCC agent skills before writing any CCC code.
- **Secp256k1 participant locks**: tests use a stand-in always-success lock;
  real secp locks only change the participant-lock-hash derivation, not the
  scripts.

## 9. Commands

```sh
# host unit tests (deterministic core, 40 tests)
cargo test -p daowow-core

# build all contracts (RISC-V)
cargo build --target riscv64imac-unknown-none-elf --release \
  -p round-type -p entry-shard-type -p entry-lock -p dao-lock \
  -p settlement-type -p accumulator-bench

# on-VM integration suites (cycles printed for each measurement)
cargo test -p daowow-integration-tests -- --test-threads=1 --nocapture

# regenerate vectors
cargo test -p daowow-core --test gen_vectors -- --nocapture
cargo test -p daowow-integration-tests --test accumulator_bakeoff -- --nocapture
```
