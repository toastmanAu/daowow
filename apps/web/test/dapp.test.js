"use strict";
// The ?manifest= parameter is the only attacker-reachable input the page
// takes. It reached an Error message that was interpolated into innerHTML,
// which is HTML injection: enough to plant phishing markup on a page whose
// job is to be trusted with a wallet, even under a CSP that blocks inline
// script. Found by review, fixed, and pinned here.
const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

// The parameter is gone: the app loads one manifest from its own folder. The
// two fences below stay, pointed at the code that now talks to the page.
const SOURCE = ["app/main.js", "app/dom.js", "model/store.js"].map((f) => fs.readFileSync(
  path.join(__dirname, "..", "dapp", f), "utf8")).join("\n");

test("no error path interpolates a message into innerHTML", () => {
  // A regression fence: showError builds DOM and sets textContent. If a later
  // edit reintroduces a template-literal innerHTML carrying ${e.message} or
  // ${manifestUrl}, this fails.
  const sinks = SOURCE.match(/innerHTML\s*=\s*`[^`]*`/g) ?? [];
  for (const sink of sinks) {
    assert.ok(!sink.includes("e.message"),
      `innerHTML must not carry an error message: ${sink.slice(0, 60)}`);
    assert.ok(!sink.includes("manifestUrl"),
      `innerHTML must not carry the manifest URL: ${sink.slice(0, 60)}`);
  }
});

test("no thrown message reflects the manifest URL back to the page", () => {
  // Defence in depth over the validator and over textContent rendering: the
  // visitor's own string is never echoed into what the page displays.
  const throws = SOURCE.match(/throw new Error\([^)]*\)/g) ?? [];
  for (const t of throws) {
    assert.ok(!t.includes("manifestUrl"),
      `thrown messages must not carry the manifest URL: ${t}`);
  }
});
