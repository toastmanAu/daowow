# Gate 2a — dApp foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A web page that connects a JoyID wallet and shows the live DAOWOW round read from chain. No signing, no transaction building, no writes.

**Architecture:** A committed CCC+JoyID ESM bundle is the only third-party code. Thin modules under `apps/web/chain/` load a deployment manifest, page the indexer safely, decode cell data against Rust-generated oracles, and derive round state. The page imports them; nothing is hardcoded.

**Tech Stack:** Vanilla ES modules, no build step at serve time. Vendored `@ckb-ccc/core` 1.21.0 + `@ckb-ccc/joy-id` (bundled with esbuild). Node's built-in test runner for headless suites. Rust `daowow-core` for the vector oracles.

**Spec:** `docs/superpowers/specs/2026-09-18-dapp-foundation-design.md`

## Global Constraints

- **No signing, no transaction building, no broadcast anywhere in 2a.** The JoyID signer is constructed for its address only. A reviewer must reject any code that builds or sends a transaction.
- **No key material.** No private key, seed or password enters this repository, a script in it, or any agent's hands. Phill runs `ckb-cli` himself.
- **No hardcoded chain constants.** Network, RPC URL, code hashes, hash types and out points come from a deployment manifest. A wrong code hash reports an empty round, which is indistinguishable from a round that has not opened.
- **Every JavaScript decoder is pinned to a Rust-generated oracle, field by field.** A size check pins nothing about field offsets.
- **Never persist a terminal indexer cursor.** `get_cells` returns `last_cursor: "0x"` on an exhausted scan and `get_cells(after: "0x")` then returns nothing forever. Break on an empty page *before* recording a cursor.
- **Every guard gets a disable/re-enable round trip.** A green suite is not evidence a guard is pinned.
- **Contract binaries:** `cargo test` in `tests/integration` does not rebuild them; `read_bin` now refuses a stale binary. Rebuild with `cargo build --target riscv64imac-unknown-none-elf --release -p <contract>`.
- **Never rebuild a contract binary while a devnet run is in progress.**
- Commit after every task.

---

## File Structure

| Path | Responsibility |
|---|---|
| `crates/daowow-core/tests/gen_vectors.rs` | *(modify)* emit cell-encoding oracles |
| `tests/vectors/daowow_core_vectors.json` | *(regenerate)* the oracle |
| `tools/build-vendor-ccc.sh` | regenerate the vendored bundle |
| `apps/web/vendor/ccc-joyid.min.mjs` | the committed artifact |
| `apps/web/vendor/ccc-joyid.lock.json` | pinned versions + artifact sha256 |
| `apps/web/vendor/README.md` | what it is, how to regenerate, why vendored |
| `apps/web/chain/codec.js` | `decodeRoundConfigV1`, `decodeEntryShardDataV1` |
| `apps/web/chain/manifest.js` | load + validate a deployment manifest |
| `apps/web/chain/rpc.js` | JSON-RPC + safe `get_cells` paging |
| `apps/web/chain/discovery.js` | find rounds/shards, derive state |
| `apps/web/chain/wallet.js` | JoyID connect, address, balance |
| `apps/web/dapp/index.html` + `dapp.css` + `dapp.js` | the page |
| `apps/web/test/*.test.js` | headless suites |
| `tests/devnet/node_harness.py` | *(modify)* enable the `Indexer` RPC module |
| `docs/deploy-dev-testnet.md` | the procedure Phill runs |
| `tools/verify-deployment.mjs` | read-only check that deployed cells match local binaries |

---

### Task 1: Cell-encoding oracles in the Rust vectors

Round discovery needs JavaScript decoders for `RoundConfigV1` (358 bytes) and `EntryShardDataV1` (101 bytes). The vectors file currently carries only `canonical_sizes`, which pins nothing about field offsets.

**Files:**
- Modify: `crates/daowow-core/tests/gen_vectors.rs`
- Regenerate: `tests/vectors/daowow_core_vectors.json`

**Interfaces:**
- Produces: a `cell_encodings` key containing `round_config` and `shard_data`, each `{ "hex": "<canonical bytes>", "fields": { ...every field... } }`. Task 3 consumes it.

- [ ] **Step 1: Add the oracle emission**

In `gen_vectors.rs`, before the final `json!` assembly, build a canonical sample of each structure using values that are distinct per field — never zero, never repeated — so a decoder reading the wrong offset cannot accidentally produce the right answer:

```rust
    // Distinct, non-zero, non-repeating values: a decoder reading a
    // neighbouring field must produce a visibly wrong number, which a
    // zero-filled or uniform sample would hide.
    let sref = |n: u8, ht: u8| ScriptRef { code_hash: ckb_hash256_one(&[n]), hash_type: ht };
    let cfg = RoundConfigV1 {
        version: 1,
        round_id,
        ticket_price: 100_000_000_000,
        minimum_tickets: 50,
        maximum_tickets: 200,
        entry_start: 1_001,
        entry_end: 1_002,
        aggregation_deadline: 1_003,
        dao_term_periods: 2,
        entry_shard_count: 1,
        prize_schedule_hash: ckb_hash256_one(b"VECTOR-PRIZE-SCHEDULE"),
        fee_policy_hash: ckb_hash256_one(b"VECTOR-FEE-POLICY"),
        keeper_policy_hash: ckb_hash256_one(b"VECTOR-KEEPER-POLICY"),
        flags: 7,
        accumulator_id: ACC_SMT,
        entry_lock: sref(11, 2),
        dao_lock: sref(12, 2),
        settlement_type: sref(13, 2),
        entry_shard_type: sref(14, 2),
        dao_type: sref(15, 1),
    };
    let shard = EntryShardDataV1 {
        round_id,
        shard_id: 0,
        state: SHARD_STATE_OPEN,
        sequence: 3,
        entry_count: 4,
        ticket_count: 5,
        principal_total: 500_000_000_000,
        accumulator_root: ckb_hash256_one(b"VECTOR-ACC-ROOT"),
    };
    let cell_encodings = json!({
        "round_config": {
            "hex": hex(&cfg.encode()),
            "commitment": hex(&cfg.commitment()),
            "fields": {
                "version": cfg.version,
                "round_id": hex(&cfg.round_id),
                "ticket_price": cfg.ticket_price.to_string(),
                "minimum_tickets": cfg.minimum_tickets.to_string(),
                "maximum_tickets": cfg.maximum_tickets.to_string(),
                "entry_start": cfg.entry_start.to_string(),
                "entry_end": cfg.entry_end.to_string(),
                "aggregation_deadline": cfg.aggregation_deadline.to_string(),
                "dao_term_periods": cfg.dao_term_periods,
                "entry_shard_count": cfg.entry_shard_count,
                "prize_schedule_hash": hex(&cfg.prize_schedule_hash),
                "fee_policy_hash": hex(&cfg.fee_policy_hash),
                "keeper_policy_hash": hex(&cfg.keeper_policy_hash),
                "flags": cfg.flags,
                "accumulator_id": cfg.accumulator_id,
                "entry_lock": { "code_hash": hex(&cfg.entry_lock.code_hash), "hash_type": cfg.entry_lock.hash_type },
                "dao_lock": { "code_hash": hex(&cfg.dao_lock.code_hash), "hash_type": cfg.dao_lock.hash_type },
                "settlement_type": { "code_hash": hex(&cfg.settlement_type.code_hash), "hash_type": cfg.settlement_type.hash_type },
                "entry_shard_type": { "code_hash": hex(&cfg.entry_shard_type.code_hash), "hash_type": cfg.entry_shard_type.hash_type },
                "dao_type": { "code_hash": hex(&cfg.dao_type.code_hash), "hash_type": cfg.dao_type.hash_type },
            },
        },
        "shard_data": {
            "hex": hex(&shard.encode()),
            "fields": {
                "round_id": hex(&shard.round_id),
                "shard_id": shard.shard_id,
                "state": shard.state,
                "sequence": shard.sequence.to_string(),
                "entry_count": shard.entry_count.to_string(),
                "ticket_count": shard.ticket_count.to_string(),
                "principal_total": shard.principal_total.to_string(),
                "accumulator_root": hex(&shard.accumulator_root),
            },
        },
    });
```

u64 values are emitted as **strings**: JSON numbers are IEEE-754 doubles and `principal_total` in shannons exceeds 2^53 for realistic rounds, so a numeric encoding would silently round. Add `"cell_encodings": cell_encodings,` to the final `json!`.

- [ ] **Step 2: Add a Rust round-trip assertion**

In the same file, a test proving the emitted bytes decode back to the sample — so the oracle cannot itself be wrong:

```rust
#[test]
fn cell_encoding_oracles_round_trip() {
    // Guards the oracle Task 3's JavaScript is pinned to. If encode/decode
    // ever disagree, the JS decoder would be pinned to a lie.
    let round_id = ckb_hash256_one(b"DAOWOW-VECTOR-ROUND-1");
    let shard = EntryShardDataV1 {
        round_id, shard_id: 0, state: SHARD_STATE_OPEN, sequence: 3,
        entry_count: 4, ticket_count: 5, principal_total: 500_000_000_000,
        accumulator_root: ckb_hash256_one(b"VECTOR-ACC-ROOT"),
    };
    assert_eq!(EntryShardDataV1::decode(&shard.encode()).unwrap(), shard);
}
```

- [ ] **Step 3: Regenerate and verify**

```sh
cargo test -p daowow-core --test gen_vectors -- --nocapture
python3 -c "import json; v=json.load(open('tests/vectors/daowow_core_vectors.json')); \
  assert len(v['cell_encodings']['round_config']['hex'])==716, 'round_config must be 358 bytes'; \
  assert len(v['cell_encodings']['shard_data']['hex'])==202, 'shard_data must be 101 bytes'; \
  print('oracle sizes OK')"
```

- [ ] **Step 4: Commit**

```sh
git add crates/daowow-core/tests/gen_vectors.rs tests/vectors/daowow_core_vectors.json
git commit -m "test: emit cell-encoding oracles for the JavaScript decoders"
```

---

### Task 2: Vendor the CCC + JoyID bundle

**Files:**
- Create: `tools/build-vendor-ccc.sh`, `apps/web/vendor/README.md`, `apps/web/vendor/ccc-joyid.min.mjs`, `apps/web/vendor/ccc-joyid.lock.json`
- Test: `apps/web/test/vendor.test.js`

**Interfaces:**
- Produces: `apps/web/vendor/ccc-joyid.min.mjs` exporting `ccc` and `joyid`. Tasks 5, 7, 8 consume it.

- [ ] **Step 1: Write the failing provenance test**

`apps/web/test/vendor.test.js`:

```js
"use strict";
const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const crypto = require("node:crypto");
const path = require("node:path");

const VENDOR = path.join(__dirname, "..", "vendor");
const ARTIFACT = path.join(VENDOR, "ccc-joyid.min.mjs");
const LOCK = path.join(VENDOR, "ccc-joyid.lock.json");

test("the vendored artifact matches its lock file", () => {
  const lock = JSON.parse(fs.readFileSync(LOCK, "utf8"));
  const got = crypto.createHash("sha256").update(fs.readFileSync(ARTIFACT)).digest("hex");
  // A silent swap of the only third-party code in the tree fails here.
  assert.strictEqual(got, lock.artifactSha256);
});

test("the vendored crypto agrees with the Rust oracle", async () => {
  // Positive control: a value impossible to produce by accident. If the
  // vendored bundle does not hash the way the contracts hash, everything
  // built on it is wrong, and this is the cheapest place to find out.
  const vectors = JSON.parse(
    fs.readFileSync(path.join(__dirname, "..", "..", "..", "tests", "vectors",
      "daowow_core_vectors.json"), "utf8"));
  const { ccc } = await import("../vendor/ccc-joyid.min.mjs");
  const got = ccc.hashCkb(ccc.bytesFrom(vectors.domain_hash.input, "utf8")).replace(/^0x/, "");
  assert.strictEqual(got, vectors.domain_hash.output);
});
```

- [ ] **Step 2: Run it and watch it fail**

```sh
node --test apps/web/test/vendor.test.js
```
Expected: FAIL, no such file `vendor/ccc-joyid.lock.json`.

- [ ] **Step 3: Write the build script**

`tools/build-vendor-ccc.sh`:

```sh
#!/usr/bin/env bash
# Regenerates apps/web/vendor/ccc-joyid.min.mjs.
#
# The output is committed so the served page needs no build step, no CDN and
# no node_modules. This script is the only thing that touches npm, and it runs
# with lifecycle scripts disabled.
set -euo pipefail

CORE_VERSION="1.21.0"
JOYID_VERSION="1.2.3"

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="$ROOT/apps/web/vendor"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

cd "$WORK"
npm init -y >/dev/null
printf 'ignore-scripts=true\n' > .npmrc
npm install --ignore-scripts --no-audit --no-fund \
  "@ckb-ccc/core@${CORE_VERSION}" "@ckb-ccc/joy-id@${JOYID_VERSION}" esbuild >/dev/null

cat > entry.mjs <<'ENTRY'
export * as ccc from "@ckb-ccc/core";
export * as joyid from "@ckb-ccc/joy-id";
ENTRY

./node_modules/.bin/esbuild entry.mjs --bundle --format=esm \
  --platform=browser --target=es2022 --minify --outfile="$OUT/ccc-joyid.min.mjs"

SHA="$(sha256sum "$OUT/ccc-joyid.min.mjs" | cut -d' ' -f1)"
JOYID_RESOLVED="$(node -p "require('./node_modules/@ckb-ccc/joy-id/package.json').version")"
CORE_RESOLVED="$(node -p "require('./node_modules/@ckb-ccc/core/package.json').version")"
cat > "$OUT/ccc-joyid.lock.json" <<LOCK
{
  "artifactSha256": "$SHA",
  "packages": {
    "@ckb-ccc/core": "$CORE_RESOLVED",
    "@ckb-ccc/joy-id": "$JOYID_RESOLVED"
  },
  "builtWith": "esbuild --bundle --format=esm --platform=browser --target=es2022 --minify",
  "regenerate": "tools/build-vendor-ccc.sh"
}
LOCK
echo "wrote $OUT/ccc-joyid.min.mjs ($SHA)"
```

Both versions are the ones measured during design (`@ckb-ccc/core` 1.21.0, `@ckb-ccc/joy-id` 1.2.3); the script records what npm actually resolved, so a drift shows up in the lock file rather than silently.

- [ ] **Step 4: Build, then run the test to verify it passes**

```sh
chmod +x tools/build-vendor-ccc.sh && ./tools/build-vendor-ccc.sh
node --test apps/web/test/vendor.test.js
```
Expected: both tests PASS.

- [ ] **Step 5: Prove the provenance guard bites**

Mutation round trip. Append one byte to the artifact, re-run, confirm the sha256 test goes red, restore by rebuilding:

```sh
printf '\n' >> apps/web/vendor/ccc-joyid.min.mjs
node --test apps/web/test/vendor.test.js   # expect the sha256 test to FAIL
./tools/build-vendor-ccc.sh
node --test apps/web/test/vendor.test.js   # green again
```

- [ ] **Step 6: Write `apps/web/vendor/README.md`**

State: what the artifact is; that it is the only third-party code in the tree; that it is committed so the page needs no build step, CDN or `node_modules`; how to regenerate; that `ccc-joyid.lock.json` pins it and `vendor.test.js` enforces both the hash and agreement with the Rust oracle; and that `elliptic` (GHSA-848j-6mx2-7j84, low, via `@joyid/ckb`) is present in the artifact — runtime surface, not build-time only.

- [ ] **Step 7: Commit**

```sh
git add tools/build-vendor-ccc.sh apps/web/vendor apps/web/test/vendor.test.js
git commit -m "feat: vendor the CCC + JoyID bundle with a provenance test"
```

---

### Task 3: Cell decoders pinned to the oracle

**Files:**
- Create: `apps/web/chain/codec.js`, `apps/web/test/codec.test.js`

**Interfaces:**
- Consumes: `cell_encodings` from Task 1.
- Produces: `decodeRoundConfigV1(bytes) -> object`, `decodeEntryShardDataV1(bytes) -> object`, `SHARD_STATE`. u64 fields are returned as **BigInt**. Tasks 6 and 8 consume these.

- [ ] **Step 1: Write the failing test**

`apps/web/test/codec.test.js` asserts every field of both structures against the oracle, and refuses wrong-length input:

```js
"use strict";
const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const { decodeRoundConfigV1, decodeEntryShardDataV1 } = require("../chain/codec.js");

const V = JSON.parse(fs.readFileSync(
  path.join(__dirname, "..", "..", "..", "tests", "vectors", "daowow_core_vectors.json"), "utf8"));
const unhex = (s) => Uint8Array.from(s.match(/../g).map((b) => parseInt(b, 16)));

test("decodeRoundConfigV1 reproduces every field of the Rust oracle", () => {
  const o = V.cell_encodings.round_config;
  const got = decodeRoundConfigV1(unhex(o.hex));
  const f = o.fields;
  assert.strictEqual(got.version, f.version);
  assert.strictEqual(got.roundId, f.round_id);
  assert.strictEqual(got.ticketPrice, BigInt(f.ticket_price));
  assert.strictEqual(got.minimumTickets, BigInt(f.minimum_tickets));
  assert.strictEqual(got.maximumTickets, BigInt(f.maximum_tickets));
  assert.strictEqual(got.entryStart, BigInt(f.entry_start));
  assert.strictEqual(got.entryEnd, BigInt(f.entry_end));
  assert.strictEqual(got.aggregationDeadline, BigInt(f.aggregation_deadline));
  assert.strictEqual(got.daoTermPeriods, f.dao_term_periods);
  assert.strictEqual(got.entryShardCount, f.entry_shard_count);
  assert.strictEqual(got.prizeScheduleHash, f.prize_schedule_hash);
  assert.strictEqual(got.feePolicyHash, f.fee_policy_hash);
  assert.strictEqual(got.keeperPolicyHash, f.keeper_policy_hash);
  assert.strictEqual(got.flags, f.flags);
  assert.strictEqual(got.accumulatorId, f.accumulator_id);
  for (const name of ["entry_lock", "dao_lock", "settlement_type", "entry_shard_type", "dao_type"]) {
    const camel = name.replace(/_(.)/g, (_, c) => c.toUpperCase());
    assert.strictEqual(got[camel].codeHash, f[name].code_hash, `${name} code hash`);
    assert.strictEqual(got[camel].hashType, f[name].hash_type, `${name} hash type`);
  }
});

test("decodeEntryShardDataV1 reproduces every field of the Rust oracle", () => {
  const o = V.cell_encodings.shard_data;
  const got = decodeEntryShardDataV1(unhex(o.hex));
  const f = o.fields;
  assert.strictEqual(got.roundId, f.round_id);
  assert.strictEqual(got.shardId, f.shard_id);
  assert.strictEqual(got.state, f.state);
  assert.strictEqual(got.sequence, BigInt(f.sequence));
  assert.strictEqual(got.entryCount, BigInt(f.entry_count));
  assert.strictEqual(got.ticketCount, BigInt(f.ticket_count));
  assert.strictEqual(got.principalTotal, BigInt(f.principal_total));
  assert.strictEqual(got.accumulatorRoot, f.accumulator_root);
});

test("a wrong-length cell is refused, never best-effort decoded", () => {
  const o = V.cell_encodings.round_config;
  const short = unhex(o.hex).slice(0, 357);
  assert.throws(() => decodeRoundConfigV1(short), /358/);
  assert.throws(() => decodeEntryShardDataV1(new Uint8Array(100)), /101/);
});
```

- [ ] **Step 2: Run it and watch it fail**

```sh
node --test apps/web/test/codec.test.js
```
Expected: FAIL, cannot find module `../chain/codec.js`.

- [ ] **Step 3: Implement the decoders**

`apps/web/chain/codec.js`. Offsets are taken from `crates/daowow-core/src/encoding.rs`; the oracle is what proves they are right:

```js
"use strict";
// Byte layouts mirror crates/daowow-core/src/encoding.rs. They are pinned
// field by field to Rust-generated vectors in test/codec.test.js: a size
// check alone would not catch an offset that is four bytes out, because the
// wrong field still decodes to a plausible number.

const ROUND_CONFIG_SIZE = 358;
const SHARD_DATA_SIZE = 101;
const SHARD_STATE = Object.freeze({ OPEN: 0, FROZEN: 1 });

const hex = (b, o, n) =>
  Array.from(b.slice(o, o + n), (x) => x.toString(16).padStart(2, "0")).join("");

function view(bytes) {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

function scriptRef(bytes, off) {
  return { codeHash: hex(bytes, off, 32), hashType: bytes[off + 32] };
}

function decodeRoundConfigV1(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.length !== ROUND_CONFIG_SIZE) {
    throw new Error(`round config must be exactly ${ROUND_CONFIG_SIZE} bytes`);
  }
  const d = view(bytes);
  return {
    version: d.getUint32(0, true),
    roundId: hex(bytes, 4, 32),
    ticketPrice: d.getBigUint64(36, true),
    minimumTickets: d.getBigUint64(44, true),
    maximumTickets: d.getBigUint64(52, true),
    entryStart: d.getBigUint64(60, true),
    entryEnd: d.getBigUint64(68, true),
    aggregationDeadline: d.getBigUint64(76, true),
    daoTermPeriods: d.getUint32(84, true),
    entryShardCount: d.getUint32(88, true),
    prizeScheduleHash: hex(bytes, 92, 32),
    feePolicyHash: hex(bytes, 124, 32),
    keeperPolicyHash: hex(bytes, 156, 32),
    flags: d.getUint32(188, true),
    accumulatorId: bytes[192],
    entryLock: scriptRef(bytes, 193),
    daoLock: scriptRef(bytes, 226),
    settlementType: scriptRef(bytes, 259),
    entryShardType: scriptRef(bytes, 292),
    daoType: scriptRef(bytes, 325),
  };
}

function decodeEntryShardDataV1(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.length !== SHARD_DATA_SIZE) {
    throw new Error(`shard data must be exactly ${SHARD_DATA_SIZE} bytes`);
  }
  const d = view(bytes);
  return {
    roundId: hex(bytes, 0, 32),
    shardId: d.getUint32(32, true),
    state: bytes[36],
    sequence: d.getBigUint64(37, true),
    entryCount: d.getBigUint64(45, true),
    ticketCount: d.getBigUint64(53, true),
    principalTotal: d.getBigUint64(61, true),
    accumulatorRoot: hex(bytes, 69, 32),
  };
}

const api = { decodeRoundConfigV1, decodeEntryShardDataV1, SHARD_STATE,
  ROUND_CONFIG_SIZE, SHARD_DATA_SIZE };
if (typeof module !== "undefined" && module.exports) module.exports = api;
if (typeof window !== "undefined") window.DaowowCodec = api;
```

- [ ] **Step 4: Run the test to verify it passes**

```sh
node --test apps/web/test/codec.test.js
```
Expected: 3 tests PASS.

- [ ] **Step 5: Prove the oracle bites**

Shift one offset, confirm the named test goes red, restore. This is the whole point of Task 1:

```sh
sed -i 's/d.getBigUint64(44, true)/d.getBigUint64(45, true)/' apps/web/chain/codec.js
node --test apps/web/test/codec.test.js   # expect the round_config test to FAIL
sed -i 's/d.getBigUint64(45, true),\n    maximumTickets/d.getBigUint64(44, true),\n    maximumTickets/' apps/web/chain/codec.js
```
Restore by hand if `sed` cannot match, and confirm green before continuing.

- [ ] **Step 6: Commit**

```sh
git add apps/web/chain/codec.js apps/web/test/codec.test.js
git commit -m "feat: decode round config and shard data, pinned to the Rust oracle"
```

---

### Task 4: Deployment manifest loader

**Files:**
- Create: `apps/web/chain/manifest.js`, `apps/web/test/manifest.test.js`

**Interfaces:**
- Produces: `loadManifest(json) -> { network, rpcUrl, scripts: { roundType, entryShardType, entryLock, daoLock, settlementType } }`, each script `{ codeHash, hashType, outPoint: { txHash, index } }`. Throws on anything unrecognised. Tasks 6, 8 consume it.

- [ ] **Step 1: Write the failing test**

Cover: a good manifest loads; an unknown `schemaVersion` is refused; a missing script is refused; a missing `rpcUrl` is refused. Every refusal asserts a distinct message, so one guard's deletion cannot be masked by another's.

- [ ] **Step 2: Run it and watch it fail**

```sh
node --test apps/web/test/manifest.test.js
```

- [ ] **Step 3: Implement `loadManifest`**

Refuse rather than best-effort parse: `if (m.schemaVersion !== 1) throw new Error(...)`. Validate each script has a 32-byte hex `codeHash`, a `hashType` in `{data, type, data1, data2}` and an out point. Return a frozen object.

- [ ] **Step 4: Run the test to verify it passes, then mutation-check each refusal**

Delete each guard in turn; confirm exactly its named test goes red; restore.

- [ ] **Step 5: Commit**

```sh
git add apps/web/chain/manifest.js apps/web/test/manifest.test.js
git commit -m "feat: load and validate a deployment manifest"
```

---

### Task 5: RPC client with safe indexer paging

**Files:**
- Create: `apps/web/chain/rpc.js`, `apps/web/test/rpc.test.js`

**Interfaces:**
- Produces: `createRpc(url, { fetchImpl }) -> { call(method, params), getCells(searchKey, { limit }) }`. `getCells` is an async generator yielding cells. Tasks 6, 7 consume it.

- [ ] **Step 1: Write the failing test, with a fixture captured from a real node**

The fixture must be **captured**, not hand-written. A hand-written mock returning `"0x64"` on an empty page instead of the real `"0x"` is exactly what hid the 2026-07-19 cursor-poison bug behind 360 green tests. Capture with:

```sh
curl -s -X POST https://testnet.ckb.dev/rpc -H 'Content-Type: application/json' \
  -d '{"id":1,"jsonrpc":"2.0","method":"get_cells","params":[{"script":{"code_hash":"0x9bd7e06f3ecf4be0f2fcd2188b23f1b9fcc88e5d4b65a8637b17723bbda3cce8","hash_type":"type","args":"0xa776bf02d19cafa3749d906cc2c9ab1cf1e80ff7"},"script_type":"lock"},"asc","0x2"]}' \
  | python3 -m json.tool > apps/web/test/fixtures/get_cells.page1.json
```

Then capture a genuinely exhausted page by passing that page's `last_cursor` back, and record whatever it really returns.

Tests: paging walks multiple pages; **a terminal cursor is never returned to the caller or reused**; an empty page ends iteration before any cursor is recorded; an RPC error is thrown rather than swallowed.

- [ ] **Step 2: Run it and watch it fail**

- [ ] **Step 3: Implement**

```js
async function* getCells(searchKey, { limit = 100 } = {}) {
  let cursor;
  for (;;) {
    const page = await call("get_cells", [searchKey, "asc", "0x" + limit.toString(16), cursor]);
    const objects = page.objects ?? [];
    // Break BEFORE recording a cursor. An exhausted scan returns
    // last_cursor "0x", and get_cells(after: "0x") returns nothing forever
    // after that, even once matching cells exist. Never persist or reuse it.
    if (objects.length === 0) return;
    for (const o of objects) yield o;
    const next = page.last_cursor;
    if (!next || next === "0x" || next === "0X") return;
    cursor = next;
  }
}
```

`fetchImpl` must be bound: `fetch.bind(globalThis)`. Storing bare `window.fetch` on an object and calling it as a method throws "Illegal invocation" on a native fetch — a 2026-06-29 incident where every test passed because the suite injected a plain mock with no brand check.

- [ ] **Step 4: Run the test to verify it passes**

- [ ] **Step 5: Prove the cursor guard bites**

Remove the `next === "0x"` check, confirm the named test goes red, restore.

- [ ] **Step 6: Commit**

```sh
git add apps/web/chain/rpc.js apps/web/test/rpc.test.js apps/web/test/fixtures
git commit -m "feat: JSON-RPC client with cursor-safe indexer paging"
```

---

### Task 6: Enable the devnet's Indexer RPC module

Discovery needs `get_cells`. Verified 2026-09-18 against the pinned image (CKB 0.209.0): default modules are `["Net", "Pool", "Miner", "Chain", "Stats", "Subscription", "Experiment", "Debug", "Terminal"]` — **`Indexer` is absent**, so the devnet cannot serve discovery today.

**Files:**
- Modify: `tests/devnet/node_harness.py`

- [ ] **Step 1: Extend the existing modules patch**

The harness already rewrites `modules = [` to inject `"IntegrationTest", `. Extend that same substitution to inject `"Indexer", ` as well, and assert the substitution count is 1 as the existing code does.

- [ ] **Step 2: Verify against a running node**

```sh
DAOWOW_RUN_ISOLATED_NODE=1 python3 -m unittest tests.devnet.test_node_harness -v
```
Then, with a node up, confirm `get_indexer_tip` answers. If the harness has no convenient hook, add one assertion to `test_node_harness.py` that the method does not return a "module not enabled" error.

- [ ] **Step 3: Commit**

```sh
git add tests/devnet/node_harness.py tests/devnet/test_node_harness.py
git commit -m "test: enable the devnet Indexer module so discovery can be exercised"
```

---

### Task 7: Round discovery and state derivation

**Files:**
- Create: `apps/web/chain/discovery.js`, `apps/web/test/discovery.test.js`

**Interfaces:**
- Consumes: `createRpc` (Task 5), `loadManifest` (Task 4), the decoders (Task 3).
- Produces: `findRounds(rpc, manifest) -> [{ config, outPoint, shards, state, ticketsSold, ticketsRemaining, viable }]`.

- [ ] **Step 1: Write the failing test**

Round-state derivation is pure and gets tested directly: **pending** before `entryStart`; **open** when the shard is OPEN and within the window; **frozen** when the shard state is FROZEN; `ticketsRemaining = maximumTickets - ticketCount`; `viable = ticketCount >= minimumTickets`. Include a case at exactly `entryStart` (inclusive, matching the contract's `since` check) and one at exactly `minimumTickets`.

- [ ] **Step 2: Run it and watch it fail**

- [ ] **Step 3: Implement**

Search `get_cells` with `script_type: "type"` and the manifest's `roundType` code hash, decode each cell's data as a round config, then find that round's shards by `entryShardType` filtered on the round id. Do **not** filter by `script_len_range` unless a test proves the bound: it measures the *serialized* script length (32 + 1 + args) and is half-open, so `[65, 65]` matches nothing — a 2026-08-10 incident that returned zero cells with no error while 29 sat on chain.

- [ ] **Step 4: Run the test to verify it passes**

- [ ] **Step 5: Commit**

```sh
git add apps/web/chain/discovery.js apps/web/test/discovery.test.js
git commit -m "feat: discover rounds and derive their state from chain"
```

---

### Task 8: JoyID wallet connection, address and balance only

**Files:**
- Create: `apps/web/chain/wallet.js`

**Interfaces:**
- Produces: `connect() -> { address, lockScript, balance() }`, `disconnect()`.

- [ ] **Step 1: Implement against the vendored bundle**

Construct the JoyID signer, read its address and lock script, sum capacity via the client. **No transaction is built and nothing is signed** — a reviewer must reject any such code in this task.

- [ ] **Step 2: Verify the module loads and exposes only read operations**

```sh
node -e "import('./apps/web/chain/wallet.js').then((m) => console.log(Object.keys(m)))"
grep -nE "signTransaction|sendTransaction|buildTransaction" apps/web/chain/wallet.js && \
  echo "FAIL: signing surface present" || echo "OK: no signing surface"
```

- [ ] **Step 3: Commit**

```sh
git add apps/web/chain/wallet.js
git commit -m "feat: JoyID connection exposing address and balance only"
```

---

### Task 9: The page

**Files:**
- Create: `apps/web/dapp/index.html`, `apps/web/dapp/dapp.css`, `apps/web/dapp/dapp.js`

- [ ] **Step 1: Build the page**

Port `entry.css`'s visual system — dark background, teal/cyan for protocol state, amber for prizes, monospace for hashes and amounts, mobile-first. Show: the round's state badge, tickets sold against the cap, the viability threshold, ticket price, the entry window, and a connect button showing address and balance once connected.

CSP must allow exactly the RPC origin and nothing else:

```html
<meta http-equiv="Content-Security-Policy"
      content="default-src 'none'; script-src 'self'; style-src 'self';
               img-src 'self' data:; connect-src https://testnet.ckb.dev;
               form-action 'none'; base-uri 'none'">
```

`entry.html` disallows all network access; this relaxes it deliberately and narrowly. Widen it only for an origin the manifest actually names.

- [ ] **Step 2: Verify in a browser**

Serve and load it; confirm no console errors and that only expected requests are made:

```sh
python3 -m http.server 8931 --bind 127.0.0.1 --directory apps/web
```

- [ ] **Step 3: Commit**

```sh
git add apps/web/dapp
git commit -m "feat: the read-only round view"
```

---

### Task 10: Mark the simulator as historical

**Files:**
- Modify: `apps/web/index.html`, `apps/web/PROGRESS.md`

- [ ] **Step 1: Add the banner**

A prominent, non-dismissible banner at the top of `index.html`: this simulates a **superseded** design in which prizes were paid directly to participants; the shipped protocol issues transferable claim NFTs that holders redeem, and the live view is at `dapp/`. Note the same in `PROGRESS.md`.

- [ ] **Step 2: Commit**

```sh
git add apps/web/index.html apps/web/PROGRESS.md
git commit -m "docs: mark the simulator as modelling a superseded design"
```

---

### Task 11: Deployment procedure and a read-only verifier

Phill runs the deployment. This task produces what he needs and a check that what landed is what we built. **No step here signs anything.**

**Files:**
- Create: `docs/deploy-dev-testnet.md`, `tools/verify-deployment.mjs`

- [ ] **Step 1: Write the procedure**

`docs/deploy-dev-testnet.md`: build the five contracts; deploy each as a plain code cell with `ckb-cli` from
`ckt1qzda0cr08m85hc8jlnfp3zer7xulejywt49kt2rr0vthywaa50xwsqd8w6ls95vu473hf8vsdnpvn2cu785qlac0rckws`;
record each out point. State the cost table (615,809 CKB total) and that `hash_type` is `data1`, not Type ID, per the spec. State explicitly that no key material is shared with, or stored by, anyone else.

- [ ] **Step 2: Write the verifier**

`tools/verify-deployment.mjs` reads the manifest, fetches each code cell, and asserts its data hash equals the blake2b-256 of the local binary — the only check that proves the chain runs the code in this tree. Read-only; it never builds or sends a transaction.

- [ ] **Step 3: Verify the verifier fails when it should**

Point it at a wrong out point and confirm it reports a mismatch rather than passing. A verifier that cannot fail proves nothing — 2026-09-12's positive-control lesson.

- [ ] **Step 4: Commit**

```sh
git add docs/deploy-dev-testnet.md tools/verify-deployment.mjs
git commit -m "docs: dev deployment procedure and a read-only binary verifier"
```

---

### Task 12: Live validation

Every trap in this plan is invisible to a mock. This task is not optional.

**Files:**
- Create: `docs/validation-2026-09-18-dapp-discovery.md`

- [ ] **Step 1: Devnet run**

With the Indexer module enabled (Task 6), run a devnet round and point discovery at the devnet RPC. A real round exists there, so this exercises decode and state derivation against genuine cell data. Record the round id, ticket count and derived state.

- [ ] **Step 2: Testnet run**

Against the dev deployment, confirm: the page reaches `https://testnet.ckb.dev/rpc` from a browser with no proxy; discovery returns the deployed scripts; `tools/verify-deployment.mjs` reports every data hash matching the local binaries.

- [ ] **Step 3: Record both**

Write the results, including anything that did not work, into the validation doc. Note explicitly if no round exists on testnet yet — "found zero rounds" is a real result but a weak one, and must not be reported as discovery being proven.

- [ ] **Step 4: Commit**

```sh
git add docs/validation-2026-09-18-dapp-discovery.md
git commit -m "docs: record live discovery validation on devnet and testnet"
```

---

## Self-review

- **Spec coverage.** D1 → Task 2. D2 → Tasks 2, 8. D3 → Tasks 6, 11, 12. D4 → Task 4. D5 → Tasks 1, 3. D6 → Task 10. The dev-deployment section → Tasks 11, 12. Non-goals are enforced by Task 8's explicit grep check and the global constraints.
- **Ordering.** Task 3 needs Task 1's oracle. Tasks 5 and 7 need Task 2's bundle only for the page, not for the codecs, so they can proceed in parallel with it. Task 12 needs Tasks 6 and 11.
- **Known gap, stated rather than hidden.** Task 12's testnet leg can only prove discovery finds *scripts* until a round exists on testnet; creating one is operator work belonging to gate 3. The devnet leg is what proves round decoding against real cell data.
