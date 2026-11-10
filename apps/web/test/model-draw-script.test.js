"use strict";
// The draw as a timeline. The winners were fixed by the chain before any of
// this runs; the script only decides the ORDER and TIMING of revealing them.
// Nothing here may invent, reorder by anything but place, or randomise a
// result.
const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const { MAX_BALLS, seededRandom, buildDrawScript, drawPhase } =
  require("../dapp/model/draw-script.js");
const copy = require("../dapp/model/copy.js");

const SEED = "a1".repeat(32);
const draw = (positions, over = {}) => ({
  seed: SEED, tickets: 10n, places: positions.length, viable: true,
  positions: positions.map(([prizeIndex, position]) => ({ prizeIndex, position })), ...over,
});

test("reveals are the real draw, in place order", () => {
  // First place went to the HIGHER ticket, so place order and ticket order
  // differ and sorting by the wrong one is visible.
  const s = buildDrawScript({ draw: draw([[1, 3], [0, 7]]), myPositions: [] });
  assert.deepStrictEqual(s.reveals.map((r) => [r.place, r.ticket]), [[1, 7n], [2, 3n]]);
  assert.strictEqual(s.viable, true);
});

test("reveals are spaced out after an opening tumble", () => {
  const s = buildDrawScript({ draw: draw([[0, 3], [1, 7], [2, 1]]), myPositions: [] });
  assert.deepStrictEqual(s.reveals.map((r) => r.atMs), [3000, 6500, 10000]);
  assert.ok(s.durationMs > 10000);
});

test("the same draw always yields the same script", () => {
  const a = () => buildDrawScript({ draw: draw([[1, 7], [0, 3]]), myPositions: [2n] });
  assert.deepStrictEqual(a(), a());
});

test("ten tickets are ten balls, labelled from 1", () => {
  const s = buildDrawScript({ draw: draw([[0, 3]]), myPositions: [] });
  assert.strictEqual(s.balls.length, 10);
  assert.deepStrictEqual(s.balls.map((b) => b.label), ["1", "2", "3", "4", "5", "6", "7", "8", "9", "10"]);
  assert.deepStrictEqual(s.balls.filter((b) => b.drawn).map((b) => b.id), [3n]);
});

test("at 200 tickets there are at most 40 balls, and every winner is among them", () => {
  assert.strictEqual(MAX_BALLS, 40);
  const winners = [[0, 199], [1, 150], [2, 77]];
  const s = buildDrawScript({ draw: draw(winners, { tickets: 200n }), myPositions: [] });
  assert.strictEqual(s.balls.length, 40);
  const ids = new Set(s.balls.map((b) => b.id));
  for (const [, p] of winners) assert.ok(ids.has(BigInt(p)), `ticket at ${p} must be a ball`);
  assert.strictEqual(new Set(s.balls.map((b) => String(b.id))).size, 40, "no ball twice");
});

test("the viewer's own tickets are always among the balls and marked", () => {
  const s = buildDrawScript({ draw: draw([[0, 199]], { tickets: 200n }), myPositions: [188n, 199n] });
  const mine = s.balls.filter((b) => b.mine).map((b) => b.id);
  assert.deepStrictEqual(mine, [188n, 199n]);
  assert.strictEqual(s.reveals[0].mine, true);
  assert.strictEqual(buildDrawScript({ draw: draw([[0, 5]]), myPositions: [4n] }).reveals[0].mine, false);
});

test("a position outside the round is never made into a ball", () => {
  const s = buildDrawScript({ draw: draw([[0, 3]]), myPositions: [55n] });
  assert.ok(!s.balls.some((b) => b.id === 55n));
});

test("an unviable round has no reveals and says so", () => {
  const s = buildDrawScript({ draw: draw([], { viable: false, tickets: 2n }), myPositions: [] });
  assert.deepStrictEqual(s.reveals, []);
  assert.strictEqual(s.viable, false);
});

test("the seeded generator is deterministic, in range, and differs between seeds", () => {
  const a = seededRandom(SEED), b = seededRandom(SEED), c = seededRandom("b2".repeat(32));
  const run = (r) => Array.from({ length: 50 }, () => r());
  const xs = run(a);
  assert.deepStrictEqual(xs, run(b));
  assert.notDeepStrictEqual(xs, run(c));
  assert.ok(xs.every((x) => x >= 0 && x < 1));
  assert.ok(new Set(xs).size > 45, "it must not be stuck");
  assert.ok(run(seededRandom("00".repeat(32))).some((x) => x !== 0), "a zero seed must still move");
});

test("neither the script nor the draw screen calls Math.random", () => {
  for (const f of ["dapp/model/draw-script.js", "dapp/app/draw/stage.js", "dapp/app/draw/fallback.js", "dapp/app/views/draw.js"]) {
    const file = path.join(__dirname, "..", f);
    if (!fs.existsSync(file)) continue;
    const code = fs.readFileSync(file, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    assert.doesNotMatch(code, /Math\.random/, f);
  }
});

const sealedAt = (h) => ({ seal: { inclusionHeight: h }, record: null });

test("the countdown targets the +192 block and reaches ready exactly there", () => {
  assert.deepStrictEqual(drawPhase({ snapshot: sealedAt(1000n), tipHeight: 1191n, hasDraw: false }),
    { phase: "countdown", blocksLeft: 1n, lastHeight: 1192n });
  assert.deepStrictEqual(drawPhase({ snapshot: sealedAt(1000n), tipHeight: 1192n, hasDraw: true }),
    { phase: "ready", blocksLeft: 0n, lastHeight: 1192n });
});

test("the block has arrived but the result is not in hand yet: still not ready", () => {
  assert.strictEqual(drawPhase({ snapshot: sealedAt(1000n), tipHeight: 1300n, hasDraw: false }).phase, "countdown");
});

test("a round with a record on chain is ready, naming the record's own block", () => {
  const snapshot = { seal: null, record: { record: { inclusionHeight: 5000n } } };
  assert.deepStrictEqual(drawPhase({ snapshot, tipHeight: 9000n, hasDraw: true }),
    { phase: "ready", blocksLeft: 0n, lastHeight: 5192n });
});

test("an unsealed round is not-sealed", () => {
  assert.deepStrictEqual(drawPhase({ snapshot: { seal: null, record: null }, tipHeight: 1n, hasDraw: false }),
    { phase: "not-sealed", blocksLeft: 0n, lastHeight: null });
});

test("a result line names the place and the ticket, and marks the viewer's", () => {
  assert.strictEqual(copy.resultLine(1, "4", true), "1st place — Ticket 4 (yours)");
  assert.strictEqual(copy.resultLine(2, "8", false), "2nd place — Ticket 8");
});

test("the countdown line names the block and says 'about'", () => {
  assert.strictEqual(copy.drawCountdown(1192n, 20n * 60000n),
    "The result is fixed when block 1,192 is mined, in about 20 min.");
});
