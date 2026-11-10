"use strict";
// The demo draw is a pretend round shown from Home. It must use the real
// selection function, must be repeatable, and must never be mistakable for,
// or collide with, a real round's result.
const { test } = require("node:test");
const assert = require("node:assert");
const core = require("../core.js");
const demo = require("../dapp/model/demo-draw.js");
const { buildDrawScript } = require("../dapp/model/draw-script.js");

const unhex = (s) => Uint8Array.from(s.match(/../g), (b) => parseInt(b, 16));

test("a demo draw has the shape of a real one and is marked as a demo", () => {
  const draw = demo.buildDemoDraw(1);
  assert.strictEqual(draw.demo, true);
  assert.strictEqual(draw.viable, true);
  assert.strictEqual(draw.tickets, BigInt(demo.DEMO_TICKETS));
  assert.strictEqual(draw.places, demo.DEMO_PLACES);
  assert.match(draw.seed, /^[0-9a-f]{64}$/);
  assert.strictEqual(draw.positions.length, demo.DEMO_PLACES);
});

test("the winners are exactly what the real selection function gives for the seed", () => {
  for (const run of [1, 2, 77]) {
    const draw = demo.buildDemoDraw(run);
    assert.deepStrictEqual(draw.positions,
      core.drawPositions(unhex(draw.seed), demo.DEMO_TICKETS, demo.DEMO_PLACES));
  }
});

test("winning tickets are distinct and inside the pretend round", () => {
  for (let run = 1; run <= 50; run++) {
    const tickets = demo.buildDemoDraw(run).positions.map((p) => p.position);
    assert.strictEqual(new Set(tickets).size, demo.DEMO_PLACES, `run ${run}`);
    for (const t of tickets) assert.ok(t >= 0 && t < demo.DEMO_TICKETS, `run ${run}`);
  }
});

test("the same run always gives the same result, and another run a different seed", () => {
  assert.deepStrictEqual(demo.buildDemoDraw(3), demo.buildDemoDraw(3));
  const seeds = new Set([1, 2, 3, 4, 5].map((r) => demo.buildDemoDraw(r).seed));
  assert.strictEqual(seeds.size, 5);
});

test("the demo seed is made under its own tag, never a real draw's", () => {
  assert.strictEqual(demo.DEMO_TAG, "DAOWOW_DEMO_DRAW_V1");
  const u32 = new Uint8Array(4);
  new DataView(u32.buffer).setUint32(0, 1, true);
  const hex = (b) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
  assert.strictEqual(demo.buildDemoDraw(1).seed, hex(core.H(demo.DEMO_TAG, u32)));
  assert.notStrictEqual(demo.buildDemoDraw(1).seed, hex(core.H("DAOWOW_AUTHENTICATED_DRAW_V1", u32)));
});

test("a run that is not a small whole number is refused", () => {
  for (const bad of [0, -1, 1.5, NaN, "2", 2 ** 32, null, undefined]) {
    assert.throws(() => demo.buildDemoDraw(bad), /demo run/, String(bad));
  }
});

test("the next run counts up and wraps before it can be refused", () => {
  assert.strictEqual(demo.nextRun(1), 2);
  assert.strictEqual(demo.nextRun(demo.MAX_RUN), 1);
  demo.buildDemoDraw(demo.MAX_RUN);
});

test("the demo plays through the ordinary draw script: every ball shown, one reveal per place", () => {
  const script = buildDrawScript({ draw: demo.buildDemoDraw(1), myPositions: [] });
  assert.strictEqual(script.viable, true);
  assert.strictEqual(script.balls.length, demo.DEMO_TICKETS);
  assert.deepStrictEqual(script.reveals.map((r) => r.place), [1, 2, 3]);
  assert.ok(script.balls.every((b) => !b.mine));
});
