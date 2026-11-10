"use strict";
// The result player, run rather than read. It is the one place the 3D library
// is loaded, for the real draw screen and the demo alike, so what it does
// around that slow load is pinned here by behaviour:
//
//   - a screen left while the library is still loading builds no machine;
//   - a machine that cannot be built leaves the result as a plain list;
//   - "reduce motion" gets the list at once and never loads the library.
//
// Node has no page, so this supplies the few page objects the player touches.
// It has no WebGL either, which is exactly the "machine cannot be built" case.
const { test, beforeEach } = require("node:test");
const assert = require("node:assert");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const copy = require("../dapp/model/copy.js");
const drawScript = require("../dapp/model/draw-script.js");
const demo = require("../dapp/model/demo-draw.js");

class Node {}
class FakeElement extends Node {
  constructor(tag) {
    super();
    this.tag = tag;
    this.children = [];
    this.attributes = {};
    this.listeners = {};
    this.hidden = false;
    this.className = "";
  }
  setAttribute(key, value) { this.attributes[key] = value; }
  addEventListener(type, fn) { (this.listeners[type] ??= []).push(fn); }
  append(...nodes) { this.children.push(...nodes); }
  set textContent(value) { this.children = value === "" ? [] : [String(value)]; }
  get textContent() {
    return this.children.map((c) => (typeof c === "string" ? c : c.textContent)).join("");
  }
  click() { for (const fn of this.listeners.click ?? []) fn(); }
}

let created; // every element tag the code under test asked the page for
let reduceMotion;

beforeEach(() => {
  created = [];
  reduceMotion = false;
  globalThis.Node = Node;
  globalThis.document = {
    createElement(tag) { created.push(tag); return new FakeElement(tag); },
  };
  globalThis.window = {
    DaowowCopy: copy,
    DaowowDrawScript: drawScript,
    matchMedia: () => ({ matches: reduceMotion }),
  };
});

const loadPlayer = () =>
  import(pathToFileURL(path.join(__dirname, "..", "dapp", "app", "draw", "player.js")).href);

const script = () =>
  drawScript.buildDrawScript({ draw: demo.buildDemoDraw(1), myPositions: [] });

const parts = (player) => {
  const [host, controls, , rail, note] = player.nodes;
  return { host, controls, rail, note };
};
const canvases = () => created.filter((tag) => tag === "canvas").length;

test("a player left while the 3D library is loading builds no machine and shows nothing", async () => {
  const { createPlayer } = await loadPlayer();
  const player = createPlayer(script());
  const { host, controls, rail, note } = parts(player);
  const started = player.start(); // now waiting on the library
  player.dispose();               // the screen is left before it arrives
  await started;
  assert.strictEqual(canvases(), 0, "no canvas, so no stage and no graphics context");
  assert.strictEqual(host.hidden, true);
  assert.strictEqual(controls.hidden, true);
  assert.deepStrictEqual(rail.children, [], "a screen nobody is on gets no result list either");
  assert.strictEqual(note.hidden, true);
});

test("when the machine cannot be built the result is shown as the plain list, with the reason", async () => {
  const { createPlayer } = await loadPlayer();
  const made = script();
  const player = createPlayer(made);
  const { host, controls, rail, note } = parts(player);
  await player.start();
  // The control for the test above: this path really does reach the stage.
  assert.strictEqual(canvases(), 1, "the machine was attempted");
  assert.deepStrictEqual(host.children, [], "the failed canvas is taken away");
  assert.strictEqual(host.hidden, true);
  assert.strictEqual(controls.hidden, true);
  assert.deepStrictEqual(rail.children.map((li) => li.textContent),
    made.reveals.map((r) => copy.resultLine(r.place, r.label, r.mine)));
  assert.strictEqual(note.hidden, false);
  assert.strictEqual(note.textContent, copy.errors.noWebgl);
});

test("reduce motion gets the list at once, with no machine and no apology", async () => {
  const { createPlayer } = await loadPlayer();
  reduceMotion = true;
  const made = script();
  const player = createPlayer(made);
  const { host, rail, note } = parts(player);
  await player.start();
  assert.strictEqual(canvases(), 0);
  assert.strictEqual(host.hidden, true);
  assert.strictEqual(rail.children.length, made.reveals.length);
  assert.strictEqual(note.hidden, true);
});

test("skip and replay do nothing when there is no machine to drive", async () => {
  const { createPlayer } = await loadPlayer();
  reduceMotion = true;
  const player = createPlayer(script());
  const { controls, rail } = parts(player);
  await player.start();
  const before = rail.children.length;
  for (const button of controls.children) button.click();
  assert.strictEqual(rail.children.length, before, "replay must not wipe a list it cannot refill");
});
