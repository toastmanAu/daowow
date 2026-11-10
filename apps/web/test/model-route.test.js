"use strict";
// The hash is the only input a stranger controls: a shared link. It is parsed
// into a closed set of routes, and anything else is "unknown" rather than a
// best guess, because acting on the wrong round is worse than showing nothing.
const { test } = require("node:test");
const assert = require("node:assert");
const { parseRoute, formatRoute, TABS } = require("../dapp/model/route.js");

const home = { tab: "home", round: null, panel: null, unknown: false };

test("an empty hash is home", () => {
  for (const h of ["", "#", "#/"]) assert.deepStrictEqual(parseRoute(h), home, JSON.stringify(h));
});
test("each tab parses", () => {
  assert.deepStrictEqual(TABS, ["home", "rounds", "tickets", "how"]);
  for (const t of TABS) {
    assert.deepStrictEqual(parseRoute(`#/${t}`), { tab: t, round: null, panel: null, unknown: false });
  }
});
test("a round link parses, lower-cased, for both panels", () => {
  assert.deepStrictEqual(parseRoute("#/round/AFFB66F7/draw"),
    { tab: "rounds", round: "affb66f7", panel: "draw", unknown: false });
  assert.strictEqual(parseRoute("#/round/affb66f7/enter").panel, "enter");
  assert.strictEqual(parseRoute("#/round/" + "ab".repeat(32) + "/draw").round, "ab".repeat(32));
});
test("a non-hex round token is unknown, never a route", () => {
  assert.deepStrictEqual(parseRoute("#/round/zzzz/draw"),
    { tab: "home", round: null, panel: null, unknown: true });
});
test("a round token that is too short or too long is unknown", () => {
  assert.strictEqual(parseRoute("#/round/abc/draw").unknown, true);
  // Ids can be ground to share a short prefix, so a link must carry at least 8.
  assert.strictEqual(parseRoute("#/round/affb66f/draw").unknown, true);
  assert.strictEqual(parseRoute("#/round/affb66f7/draw").unknown, false);
  assert.strictEqual(parseRoute("#/round/" + "a".repeat(65) + "/draw").unknown, true);
});
test("markup in the hash is unknown", () => {
  assert.strictEqual(parseRoute("#/round/<img src=x>/enter").unknown, true);
  assert.strictEqual(parseRoute("#/home<script>").unknown, true);
  assert.strictEqual(parseRoute("#/round/affb66f7/draw\n<b>").unknown, true);
});
test("an unknown panel or path is unknown", () => {
  assert.strictEqual(parseRoute("#/round/affb66f7/steal").unknown, true);
  assert.strictEqual(parseRoute("#/round/affb66f7").unknown, true);
  assert.strictEqual(parseRoute("#/admin").unknown, true);
  assert.strictEqual(parseRoute("#/rounds/extra").unknown, true);
});
test("the demo draw has its own route, with no round in it", () => {
  assert.deepStrictEqual(parseRoute("#/demo"),
    { tab: "home", round: null, panel: "demo", unknown: false });
  assert.strictEqual(formatRoute({ panel: "demo" }), "#/demo");
  assert.deepStrictEqual(parseRoute(formatRoute({ panel: "demo" })).panel, "demo");
  // It is not a tab and not a round panel.
  assert.strictEqual(parseRoute("#/demo/extra").unknown, true);
  assert.strictEqual(parseRoute("#/round/affb66f7/demo").unknown, true);
  assert.strictEqual(parseRoute("#/Demo").unknown, true);
});
test("format emits a short round id and round-trips through parse", () => {
  assert.strictEqual(formatRoute({ tab: "tickets" }), "#/tickets");
  const link = formatRoute({ round: "AFFB66F7" + "00".repeat(28), panel: "enter" });
  assert.strictEqual(link, "#/round/affb66f7/enter");
  assert.deepStrictEqual(parseRoute(link),
    { tab: "rounds", round: "affb66f7", panel: "enter", unknown: false });
});
