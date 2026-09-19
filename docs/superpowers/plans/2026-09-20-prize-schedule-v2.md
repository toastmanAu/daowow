# Prize schedule v2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Payout depth scales with the field. A schedule commits a ticket threshold per place; a place pays only once the round reaches it.

**Architecture:** `PrizeSchedule` gains a parallel `thresholds` vector. Wire version 2 carries `(weight, min_tickets)` pairs. Version 1 remains decodable *and* remains the encoding emitted whenever thresholds are the v1 default, so no existing commitment moves.

**Tech Stack:** Rust `no_std` in `daowow-core`; the five riscv64 contracts that link it; `ckb-cli` for redeployment; the vendored JS client for display.

**Spec:** `docs/superpowers/specs/2026-09-19-prize-schedule-v2-design.md`

## Global Constraints

- **`weights_for` is consensus code.** It runs inside `entry-shard-type` via `computed_draw` and `round-type` via `creation_schedule`. Treat every change as financial software.
- **A v1 schedule's `encode()` output and therefore its `commitment()` must not change by a single byte.** Existing configs, golden vectors and the deployed dev round all commit to v1 bytes. The existing `COMMITMENT` constant in `schedule.rs`'s tests is the canary: if it fails, compatibility is broken.
- **v1 ≡ v2 with thresholds `[1, 2, …, n]`.** This identity is the migration proof, verified over ticket counts 0..39 during design.
- **`weights_for` keeps its `min(t, …)` cap.** Thresholds `[1,1,1]` must not pay three places in a two-ticket round.
- Validation fails closed, and every refusal gets its own named test — guards over one structure mask each other.
- **Every guard gets a disable/re-enable round trip.** A green suite is not evidence a guard is pinned.
- Rebuild contracts one package at a time; never during a devnet run. `read_bin` refuses a stale binary.
- Redeploy only contracts whose data hash actually moved, measured against `deployments/dev-testnet-manifest.json`.
- Commit after every task.

---

## File Structure

| Path | Responsibility |
|---|---|
| `crates/daowow-core/src/schedule.rs` | *(modify)* thresholds, v2 wire, selection |
| `crates/daowow-core/tests/gen_vectors.rs` | *(modify)* emit a v2 schedule oracle |
| `tests/vectors/daowow_core_vectors.json` | *(regenerate)* |
| `tests/integration/examples/devnet_round.rs` | *(modify)* demo schedule |
| `deployments/dev-testnet-*.toml` | *(modify)* only the contracts that moved |
| `deployments/dev-testnet-manifest.json` | *(regenerate)* |
| `docs/validation-2026-09-20-schedule-v2.md` | evidence |

---

### Task 1: Thresholds and the v2 wire, with v1 byte-identical

**Files:**
- Modify: `crates/daowow-core/src/schedule.rs`

**Interfaces:**
- Produces: `PrizeSchedule::new_tiered(weights, thresholds)`, `thresholds()`, v2 `encode`/`decode`. `new()` keeps its signature and v1 semantics. Task 2 consumes `thresholds()`.

- [ ] **Step 1: Write the failing tests**

Add to `schedule.rs`'s test module. The first is the compatibility canary and must pass unchanged:

```rust
    #[test]
    fn a_v1_schedule_still_encodes_to_the_same_bytes_and_commitment() {
        // The deployed round config, the golden vectors and every existing
        // test commit to these exact bytes. If v2 changed them, a live round
        // would stop validating against its own committed schedule.
        let s = PrizeSchedule::new(&[40, 25, 20, 10, 5]).unwrap();
        assert_eq!(s.encode(), WIRE.to_vec());
        assert_eq!(s.commitment(), COMMITMENT);
    }

    #[test]
    fn new_defaults_thresholds_to_the_v1_rule() {
        let s = PrizeSchedule::new(&[40, 25, 20, 10, 5]).unwrap();
        assert_eq!(s.thresholds(), &[1, 2, 3, 4, 5]);
    }

    #[test]
    fn a_tiered_schedule_round_trips_through_v2() {
        let s = PrizeSchedule::new_tiered(&[40, 25, 20, 10, 5], &[1, 8, 20, 50, 100]).unwrap();
        let wire = s.encode();
        assert_eq!(wire[0], 2, "a non-default table must emit version 2");
        assert_eq!(wire.len(), 5 + 16 * 5);
        assert_eq!(PrizeSchedule::decode(&wire).unwrap(), s);
    }

    #[test]
    fn a_v1_wire_decodes_with_the_default_thresholds() {
        let s = PrizeSchedule::decode(&WIRE).unwrap();
        assert_eq!(s.thresholds(), &[1, 2, 3, 4, 5]);
        assert_eq!(s, PrizeSchedule::new(&[40, 25, 20, 10, 5]).unwrap());
    }

    #[test]
    fn decreasing_thresholds_are_refused() {
        // A later place cannot open before an earlier one.
        assert_eq!(
            PrizeSchedule::new_tiered(&[40, 25], &[8, 1]),
            Err(CoreError::InvalidArgument)
        );
    }

    #[test]
    fn a_first_threshold_above_one_is_refused() {
        // Otherwise a round could draw with zero paying places, a state no
        // existing path expects.
        assert_eq!(
            PrizeSchedule::new_tiered(&[40, 25], &[2, 8]),
            Err(CoreError::InvalidArgument)
        );
    }

    #[test]
    fn a_threshold_count_mismatch_is_refused() {
        assert_eq!(
            PrizeSchedule::new_tiered(&[40, 25, 20], &[1, 8]),
            Err(CoreError::InvalidArgument)
        );
    }

    #[test]
    fn a_truncated_or_overlong_v2_wire_is_refused() {
        let s = PrizeSchedule::new_tiered(&[40, 25], &[1, 8]).unwrap();
        let wire = s.encode();
        assert_eq!(PrizeSchedule::decode(&wire[..wire.len() - 1]), Err(CoreError::Encoding));
        let mut long = wire.clone();
        long.push(0);
        assert_eq!(PrizeSchedule::decode(&long), Err(CoreError::Encoding));
    }

    #[test]
    fn an_unknown_version_is_refused() {
        let mut wire = PrizeSchedule::new(&[40, 25]).unwrap().encode();
        wire[0] = 3;
        assert_eq!(PrizeSchedule::decode(&wire), Err(CoreError::Encoding));
    }
```

- [ ] **Step 2: Run them and watch them fail**

```sh
cargo test -p daowow-core --lib schedule
```
Expected: the `new_tiered` and `thresholds` tests fail to compile; the two v1 tests pass already.

- [ ] **Step 3: Implement**

Replace the struct, constructors, `encode` and `decode`:

```rust
pub struct PrizeSchedule {
    weights: Vec<u64>,
    /// Minimum accepted tickets at which each place begins paying.
    /// Non-decreasing, and `thresholds[0] <= 1`.
    thresholds: Vec<u64>,
}

impl PrizeSchedule {
    /// A v1 schedule: place `i` pays from `i + 1` tickets, which is exactly
    /// the historical `min(tickets, len)` rule.
    pub fn new(weights: &[u64]) -> Result<Self, CoreError> {
        let thresholds: Vec<u64> = (1..=weights.len() as u64).collect();
        Self::new_tiered(weights, &thresholds)
    }

    pub fn new_tiered(weights: &[u64], thresholds: &[u64]) -> Result<Self, CoreError> {
        validate_weights(weights)?;
        validate_thresholds(weights.len(), thresholds)?;
        Ok(Self { weights: weights.to_vec(), thresholds: thresholds.to_vec() })
    }

    pub fn thresholds(&self) -> &[u64] {
        &self.thresholds
    }

    /// True when the table is the v1 default, in which case `encode` emits the
    /// v1 wire so existing commitments are unchanged.
    fn is_v1_default(&self) -> bool {
        self.thresholds
            .iter()
            .enumerate()
            .all(|(i, t)| *t == i as u64 + 1)
    }

    pub fn encode(&self) -> Vec<u8> {
        if self.is_v1_default() {
            // Byte-identical to the historical encoding. Any live round's
            // committed schedule must keep validating.
            let mut out = Vec::with_capacity(5 + self.weights.len() * 8);
            out.push(1);
            out.extend_from_slice(&(self.weights.len() as u32).to_le_bytes());
            for weight in &self.weights {
                out.extend_from_slice(&weight.to_le_bytes());
            }
            return out;
        }
        let mut out = Vec::with_capacity(5 + self.weights.len() * 16);
        out.push(2);
        out.extend_from_slice(&(self.weights.len() as u32).to_le_bytes());
        for (weight, threshold) in self.weights.iter().zip(&self.thresholds) {
            out.extend_from_slice(&weight.to_le_bytes());
            out.extend_from_slice(&threshold.to_le_bytes());
        }
        out
    }

    pub fn decode(data: &[u8]) -> Result<Self, CoreError> {
        if data.len() < 5 {
            return Err(CoreError::Encoding);
        }
        let version = data[0];
        let count = u32::from_le_bytes(data[1..5].try_into().map_err(|_| CoreError::Encoding)?);
        // Bound the untrusted count before any arithmetic or allocation.
        if count == 0 || count > MAX_SCHEDULE_PRIZES as u32 {
            return Err(CoreError::Encoding);
        }
        let count = count as usize;
        match version {
            1 => {
                if data.len() != 5 + count * 8 {
                    return Err(CoreError::Encoding);
                }
                let weights: Vec<u64> = data[5..]
                    .as_chunks::<8>().0.iter()
                    .map(|b| u64::from_le_bytes(*b)).collect();
                Self::new(&weights)
            }
            2 => {
                if data.len() != 5 + count * 16 {
                    return Err(CoreError::Encoding);
                }
                let mut weights = Vec::with_capacity(count);
                let mut thresholds = Vec::with_capacity(count);
                for pair in data[5..].as_chunks::<16>().0 {
                    weights.push(u64::from_le_bytes(pair[..8].try_into().unwrap()));
                    thresholds.push(u64::from_le_bytes(pair[8..].try_into().unwrap()));
                }
                let schedule = Self::new_tiered(&weights, &thresholds)?;
                // A v2 wire carrying the default table would give one schedule
                // two encodings and therefore two commitments. Refuse it so the
                // mapping stays one-to-one.
                if schedule.is_v1_default() {
                    return Err(CoreError::Encoding);
                }
                Ok(schedule)
            }
            _ => Err(CoreError::Encoding),
        }
    }
}

fn validate_thresholds(count: usize, thresholds: &[u64]) -> Result<(), CoreError> {
    if thresholds.len() != count || thresholds.first().is_none_or(|t| *t > 1) {
        return Err(CoreError::InvalidArgument);
    }
    if thresholds.windows(2).any(|w| w[1] < w[0]) {
        return Err(CoreError::InvalidArgument);
    }
    Ok(())
}
```

Note the `is_v1_default` refusal in the v2 branch: without it the same schedule would have two valid encodings and two commitments.

- [ ] **Step 4: Run the tests to verify they pass**

```sh
cargo test -p daowow-core
```
Expected: all pass, including the untouched `COMMITMENT` canary.

- [ ] **Step 5: Mutation round trip on each new guard**

Disable each in turn, confirm exactly its named test reds, restore:
`thresholds.len() != count`, the `> 1` first-threshold check, the non-decreasing check, the v2 length check, the `is_v1_default` refusal in `decode`, and the `is_v1_default` branch in `encode` (which must red the compatibility canary).

- [ ] **Step 6: Commit**

```sh
git add crates/daowow-core/src/schedule.rs
git commit -m "feat: prize schedule v2 wire with per-place ticket thresholds"
```

---

### Task 2: Selection by threshold, and the equivalence proof

**Files:**
- Modify: `crates/daowow-core/src/schedule.rs`

**Interfaces:**
- Consumes: `thresholds()` from Task 1.
- Produces: `weights_for` selecting by threshold. `min_viable_pool` follows automatically.

- [ ] **Step 1: Write the failing tests**

```rust
    #[test]
    fn v1_and_v2_agree_for_every_ticket_count() {
        // The migration proof: v1 IS v2 with thresholds [1, 2, ..., n], so a
        // schedule built either way must select identically at every size.
        let weights = [40, 25, 20, 10, 5];
        let v1 = PrizeSchedule::new(&weights).unwrap();
        let v2 = PrizeSchedule::new_tiered(&weights, &[1, 2, 3, 4, 5]).unwrap();
        for tickets in 1..40u64 {
            assert_eq!(
                v1.weights_for(tickets).unwrap(),
                v2.weights_for(tickets).unwrap(),
                "disagreed at {tickets} tickets"
            );
        }
    }

    #[test]
    fn a_place_opens_exactly_at_its_threshold() {
        let s = PrizeSchedule::new_tiered(&[40, 25, 20, 10, 5], &[1, 8, 20, 50, 100]).unwrap();
        for (tickets, places) in [
            (1, 1), (7, 1), (8, 2), (19, 2), (20, 3),
            (49, 3), (50, 4), (99, 4), (100, 5), (1000, 5),
        ] {
            assert_eq!(
                s.weights_for(tickets).unwrap().len(), places,
                "{tickets} tickets should pay {places}"
            );
        }
    }

    #[test]
    fn selection_never_exceeds_the_ticket_count() {
        // Thresholds alone would pay three places to a two-ticket round, and
        // there are not three distinct positions to draw.
        let s = PrizeSchedule::new_tiered(&[40, 25, 20], &[1, 1, 1]).unwrap();
        assert_eq!(s.weights_for(2).unwrap().len(), 2);
        assert_eq!(s.weights_for(1).unwrap().len(), 1);
    }

    #[test]
    fn min_viable_pool_follows_the_threshold_selection() {
        let s = PrizeSchedule::new_tiered(&[40, 25, 20, 10, 5], &[1, 8, 20, 50, 100]).unwrap();
        // At 7 tickets only place 0 pays, so the bar is ceil(40/40) = 1.
        assert_eq!(s.min_viable_pool(7).unwrap(), 1);
        // At 8 the second place opens: ceil(65/25) = 3.
        assert_eq!(s.min_viable_pool(8).unwrap(), 3);
    }
```

- [ ] **Step 2: Run them and watch them fail**

Expected: `a_place_opens_exactly_at_its_threshold` fails, since `weights_for` still ignores thresholds.

- [ ] **Step 3: Implement**

```rust
    pub fn weights_for(&self, tickets: u64) -> Result<&[u64], CoreError> {
        if tickets == 0 {
            return Err(CoreError::InvalidArgument);
        }
        // Thresholds are non-decreasing, so the open places are a prefix.
        let open = self.thresholds.iter().take_while(|t| **t <= tickets).count();
        // Capped at the ticket count: a place cannot be paid to a position
        // that does not exist (see the [1,1,1] case).
        let count = open.min(tickets.min(usize::MAX as u64) as usize);
        Ok(&self.weights[..count])
    }
```

- [ ] **Step 4: Run the tests to verify they pass, then the whole suite**

```sh
cargo test -p daowow-core
```

- [ ] **Step 5: Mutation round trip**

Remove the `min(...)` cap and confirm `selection_never_exceeds_the_ticket_count` reds. Change `<=` to `<` in `take_while` and confirm `a_place_opens_exactly_at_its_threshold` reds.

- [ ] **Step 6: Commit**

```sh
git add crates/daowow-core/src/schedule.rs
git commit -m "feat: select paying places by committed ticket threshold"
```

---

### Task 3: Vectors for the JavaScript client

**Files:**
- Modify: `crates/daowow-core/tests/gen_vectors.rs`
- Regenerate: `tests/vectors/daowow_core_vectors.json`

- [ ] **Step 1: Emit a v2 oracle**

Beside `cell_encodings`, add a `prize_schedule_v2` key with the demo schedule's hex, its commitment, its weights and thresholds, and a `places_at` map giving the selected count at representative ticket counts (1, 7, 8, 19, 20, 49, 50, 99, 100). The client renders the payout table, so it needs an oracle for the selection rule, not only the bytes.

- [ ] **Step 2: Regenerate and check**

```sh
cargo test -p daowow-core --test gen_vectors -- --nocapture
python3 -c "
import json; v=json.load(open('tests/vectors/daowow_core_vectors.json'))
s=v['prize_schedule_v2']
assert len(s['hex']) == 2*(5+16*5), len(s['hex'])
assert s['places_at']['7'] == 1 and s['places_at']['8'] == 2
print('v2 oracle OK')"
```

- [ ] **Step 3: Confirm the v1 vectors did not move**

```sh
git diff --stat tests/vectors/daowow_core_vectors.json
```
Only additions are acceptable. A changed existing value means Task 1's compatibility guarantee is broken — stop and fix it there.

- [ ] **Step 4: Commit**

---

### Task 4: Measure which contracts actually changed

`daowow-core` links into all five, so which binaries move is a fact to measure, not predict.

- [ ] **Step 1: Rebuild all five**

```sh
for c in round-type entry-shard-type entry-lock dao-lock settlement-type; do
  cargo build --target riscv64imac-unknown-none-elf --release -p "$c"
done
```

- [ ] **Step 2: Diff against the deployed hashes**

```sh
node --input-type=module -e "
import fs from 'node:fs';
import { ccc } from './apps/web/vendor/ccc-joyid.min.mjs';
const m = JSON.parse(fs.readFileSync('deployments/dev-testnet-manifest.json','utf8'));
for (const [name, s] of Object.entries(m.scripts)) {
  const local = ccc.hashCkb(fs.readFileSync('target/riscv64imac-unknown-none-elf/release/' + name));
  console.log((local === s.codeHash ? '  same  ' : ' MOVED  ') + name.padEnd(18) + local);
}"
```

- [ ] **Step 3: Record the result**

Write the list of moved contracts into `docs/validation-2026-09-20-schedule-v2.md`. Only these are redeployed. `round-type` and `entry-shard-type` are expected; the other three are the interesting cases.

- [ ] **Step 4: Run the full gate**

```sh
cargo test -p daowow-core
cd tests/integration && cargo test
```
Expected: core and integration green. `read_bin`'s freshness guard now passes because Step 1 rebuilt everything.

- [ ] **Step 5: Commit**

---

### Task 5: Redeploy the changed contracts

Phill runs this; no key material enters the repository. Follow `docs/deploy-dev-testnet.md`, which is already strictly sequential.

- [ ] **Step 1: Write a config holding only the moved contracts**

`deployments/dev-testnet-v2.toml`, same `enable_type_id = false` and same `[lock]` as the existing configs.

- [ ] **Step 2: Size it**

```sh
node tools/check-deploy-size.mjs deployments/dev-testnet-v2.toml
```
Split if it exceeds the budget. `entry-shard-type` alone is 229 KB, so one config may well be enough — but check rather than assume, since that is exactly the check whose absence cost a failed broadcast.

- [ ] **Step 3: Deploy, one part at a time**

`gen-txs`, confirm the totals, `sign-txs`, `apply-txs`, then **wait for committed** before any second part.

- [ ] **Step 4: Regenerate and verify the manifest**

```sh
node tools/manifest-from-deploy.mjs "$CKB_URL" dev-deploy-a.json dev-deploy-b.json dev-deploy-v2.json \
  > deployments/dev-testnet-manifest.json
node tools/verify-deployment.mjs deployments/dev-testnet-manifest.json
```
Must report 5/5 and exit 0. The unchanged contracts keep their original out points; only the moved ones are new.

- [ ] **Step 5: Reclaim the superseded cells**

The replaced code cells are now unreferenced. Confirm with `tools/audit-wallet-cells.mjs` and reclaim per `docs/reclaim-testnet-capacity.md`.

- [ ] **Step 6: Commit the manifest and validation record**

---

### Task 6: A devnet round at the demo schedule

**Files:**
- Modify: `tests/integration/examples/devnet_round.rs`

- [ ] **Step 1: Configure the demo schedule**

Set the exporter's schedule to weights `[40, 25, 20, 10, 5]` with thresholds `[1, 8, 20, 50, 100]`, and its round to the demo shape: `ticket_price` 10,000 CKB, `maximum_tickets` 10, `minimum_tickets` 5, one shard.

- [ ] **Step 2: Assert the payout depth on chain**

In the devnet round history, assert that a ten-ticket round draws **exactly two** positions, and print both prize amounts. This is the end-to-end proof that the threshold rule reaches consensus, not merely the host.

- [ ] **Step 3: Run the devnet suite**

```sh
DAOWOW_RUN_ISOLATED_NODE=1 python3 -m unittest discover -s tests/devnet -v
```
Expected: all green, and the log shows two drawn positions at ten tickets.

- [ ] **Step 4: Record and commit**

Append the result to `docs/validation-2026-09-20-schedule-v2.md`, including both prize amounts and whether either needed a sponsor top-up.

---

## Self-review

- **Spec coverage.** D1 → Task 2 (selection keys on tickets). D2 → Task 1 (thresholds inside the committed wire). D3 → Task 1. D4 → Task 2. D5 → Tasks 3 and 6. Blast radius → Tasks 4 and 5. D7's payout table is 2b's client work and is deliberately not here.
- **Ordering.** Task 2 needs Task 1's `thresholds()`. Task 4 needs both. Task 5 needs Task 4's measurement. Task 6 can run before Task 5, since the devnet deploys its own binaries.
- **Risk concentrated in Task 1.** The compatibility guarantee lives entirely in `encode`'s `is_v1_default` branch, and the existing `COMMITMENT` constant is what catches a mistake. That is why the mutation round trip explicitly includes disabling that branch.
