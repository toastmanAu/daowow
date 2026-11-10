# DAOWOW UI sprint — progress notes

> **2026-09-18: `index.html` + `engine.js` model a SUPERSEDED design.** They pay
> prizes directly to participants. The shipped contracts issue one transferable
> claim NFT per ticket, whose holder redeems each batch's prize and finally
> retires the claim for a non-redeemable memento. Everything below describes
> that older model and is kept as history, not as a description of the
> protocol. The live, chain-connected view is `apps/web/dapp/`, specified in
> `docs/superpowers/specs/2026-09-18-dapp-foundation-design.md`.
>
> Since 2026-11-10 `apps/web/dapp/` is ONE app (`index.html`): connect once,
> then Home, Rounds, My tickets and How it works as tabs, with entering,
> refunds and the animated draw inside it. It loads its own `manifest.json`
> and needs no URL parameters. Design:
> `docs/superpowers/specs/2026-11-10-one-page-dapp-design.md`. To run it, serve
> the repository root and open `/apps/web/dapp/`; to publish it, see
> `docs/deploy-daowow-org.md`.


2026-09-15: a separate consumer-facing `entry.html` preview now provides ticket
selection/review and wallet-availability information. The existing simulator
below is preserved. See [entry preview notes](ENTRY-README.md); this is not a
live wallet or chain-connected entry UI. Historical completion claims below
refer to the local simulator only.

Date: 2026-09-05 (session 2). **The UI sprint is complete and verified.**
Context: protocol prototype (M0–M3) was complete and green — see
`prototype-report.md`; session 1 built `core.js`/`vectors.js` and most of
`engine.js`; this session fixed the engine, built the full UI and verified it
in a real browser. Read the bottom section for what is next.

## Environment (REBUILD AFTER RESTART — /tmp is wiped!)

A local Node.js is required to headless-test the JS core. Reinstall:

```sh
cd /tmp && curl -sL -o node.tar.xz https://nodejs.org/dist/v20.18.1/node-v20.18.1-linux-x64.tar.xz \
  && tar xf node.tar.xz
export PATH=/tmp/node-v20.18.1-linux-x64/bin:$PATH   # per-shell
node --version   # v20.18.1
```

Rust/cargo are installed user-locally (`~/.cargo`, rustc 1.98.1 + riscv target)
and survive restarts. `. "$HOME/.cargo/env"` per shell.

To open the UI: no build step, just open `apps/web/index.html` (works from
`file://`, zero dependencies), or serve it: `python3 -m http.server -d apps/web 8931`.

## State of the files

| File | State |
|---|---|
| `apps/web/core.js` | DONE, 11/11 Rust-vector conformance (`selfTest`). Dead placeholder line removed. |
| `apps/web/vectors.js` | DONE. Generated from `tests/vectors/daowow_core_vectors.json` (regen snippet below). |
| `apps/web/engine.js` | **DONE, headless-tested.** Full Method-B round machine; this session fixed the settle/AR bug, the capacity accounting, the refund/draw interaction and the position-space semantics (see "Protocol deltas" below). |
| `apps/web/test/engine.test.js` | **DONE, PASSING** (`ENGINE OK`): deterministic winners, exact shannon conservation, per-participant principal return, prize-pool identity, 4 adversarial rejections (-45/-75/-73/-57). |
| `apps/web/index.html` + `style.css` + `app.js` | **DONE, browser-verified.** Full lifecycle stepper, config panel, sharded entries with live MMR roots, entropy inputs, staggered winner reveal, DAO phase table, conservation breakdown, lock-hash-ordered payouts, ledger drawer (per-tx capacity moves + cycles), adversarial panel with mirrored error codes, verifier-bundle export, core-verification badge. Dark/teal/amber design per the agreed language, mobile-first collapse, zero dependencies, `file://`-safe. |

Run the headless suites:

```sh
node apps/web/test/core.test.js     # ALL 11 VECTOR CHECKS PASS
node apps/web/test/engine.test.js   # ENGINE OK
```

## Engine fixes this session (all empirically forced, tests updated)

1. **settle/AR bug (the "pick up here" bug)** — simulated AR growth truncated
   to zero (`8*360/10000 == 0n`) → compensation 0 → `[-72] fees exceed yield`.
   Fixed by explicit `yieldPercent` config (default 2) applied to *principal
   only*: `compensation = d.principal * yieldPercent / 100n`; padding earns
   nothing.
2. **Deposit padding conservation** — deposits now carry the full entry
   occupancy (`Σ(principal + 205 sh)`), matching proto2's "entry inputs exactly
   fund DAO deposits". Settlement treats carried padding as returned capacity,
   never prize money: `residual = carriedPadding − payoutOccupancy + dust`
   (≥ 0 enforced, `[-72] settlement overpays` otherwise). Conservation equation
   closes exactly: `realized = principal + prizes + occupancy + keeper + fees + residual`.
3. **Entry/aggregated flag split** — `aggregate()` flagged round-level entries
   while `settle()` read participant-level copies; entry records are now shared
   objects (payouts were silently empty before).
4. **Draw position space (real protocol delta, see below)** — winners are
   resolved through shard-major prefix offsets instead of per-entry running
   sums; refunded ranges resolve to `?` (honestly unowned) instead of shifting
   later entries.
5. `export()` serialises BigInts (winners/shard); verified `JSON.stringify`-safe.
6. UI nits fixed: seed rendered as hex (was decimal byte list), draw-position
   display shows global ranges (local range in tooltip).

## Protocol delta discovered by the UI (raise with the core spec!)

`crates/daowow-core/src/shard.rs` assigns `position_base` **per shard**
(`running_position_base = shard.ticket_count`), while
`crates/daowow-core/src/accounting.rs::validate_position_tiling` requires
entry ranges to tile the **global** `[0, total_tickets)`. Both cannot hold for
multi-shard rounds without a global mapping. Consistent resolution (implemented
in the engine's `draw()`): global position space is the **shard-major
concatenation of the frozen shards** — shard `s` owns
`[prefix_s, prefix_s + count_s)`, and an entry's local
`[position_base, position_base + tickets)` maps to
`prefix_s + position_base`. Fully deterministic from public chain data (frozen
shard cells + entry cells). The core should adopt this in `M6/M7` (commit
per-shard prefix offsets in the finalisation cell; verifier recomputes).

## Verification performed this session

- Headless: `core.test.js` 11/11 vector checks; `engine.test.js` ENGINE OK
  (winners, conservation, principal returns, prize identity, adversarials);
  extra sweep proves every winning position resolves to an owner for
  shards ∈ {1,2,3,4,7}; refund-then-settle round stays conservative and
  `export()` stays serialisable.
- Browser (in-app browser against `python3 -m http.server -d apps/web`):
  full round driven through the real page buttons — create → enter ×8 →
  freeze → aggregate(3) → entropy → draw (staggered reveal) → DAO phase1+2 →
  settle → COMPLETE; all 4 adversarial buttons show mirrored rejections
  (-45/-75/-73/-57); refund via row button → `REFUNDED`; ledger drawer shows
  per-tx inputs/outputs/capacity moves/cycles; screenshots confirm layout on
  desktop and 375 px mobile.
- Note (test harness, not a page bug): the in-app browser's synthetic clicks
  and full-page screenshots are coordinate-offset/tiled; the page's own
  hit-testing is provably correct (`elementFromPoint` at button centers) and
  real click events drive the delegated handler. Verified with programmatic
  clicks (same code path).

## Remaining work (next sprint, in order)

1. **Molecule codegen** (carried from prototype-report): port `daowow.mol` to
   measured widths, swap hand-rolled codecs for generated ones.
2. **Batch accounting (M6)** + adopt the shard-prefix position mapping in the
   core (above); BatchCommitmentCell (TX-05) is specified but not implemented.
3. **Entropy/draw (M7)** on-chain reveal path + finalisation cell; randomness
   review (open-questions P0-3) still gates this.
4. **CCC/TypeScript keeper SDK (M9)** — install/read CCC agent skills before
   writing any CCC code.
5. Scale tests (100 participants / 32 shards / multi-batch withdrawals).
6. Optional UI polish: ticket-distribution bar per participant, confetti on
   jackpot, per-participant multi-entry support in the table (engine already
   models one entry per participant).

## vectors.js regeneration snippet (python)

```python
import json
v = json.load(open('tests/vectors/daowow_core_vectors.json'))
open('apps/web/vectors.js','w').write(
  '// generated from tests/vectors/daowow_core_vectors.json\n"use strict";\n'
  'const DAOWOW_VECTORS = ' + json.dumps(v, indent=2, sort_keys=True) + ';\n'
  'if (typeof module !== "undefined" && module.exports) module.exports = DAOWOW_VECTORS;\n'
  'if (typeof window !== "undefined") window.DAOWOW_VECTORS = DAOWOW_VECTORS;\n')
```

## Design language (kept from session 1)

Dark app (#0a0e14 background), teal/cyan accent for protocol states, amber for
prizes, red for rejections; system sans for prose + monospace for
hashes/amounts; card-based layout, 12px radii, 1px borders; numbers in
shannon-precision with CKB formatting (8 decimals); stage stepper glows on the
active stage. No CDN/external fonts (works offline via `file://`).

## Reference: protocol ground truth

- Spec: `docs/protocol-v0.2.md`, scripts: `docs/script-responsibilities.md`
- Sprint results + measured cycles: `prototype-report.md`
- ADR: `docs/ADR/0001-accumulator.md` (MMR selected)
- Vectors: `tests/vectors/daowow_core_vectors.json` (Rust-generated)
- Benchmarks: `tests/vectors/accumulator_bench.json`
