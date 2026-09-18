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

const SOURCE = fs.readFileSync(
  path.join(__dirname, "..", "dapp", "dapp.js"), "utf8");

test("rejects manifest locations that are not same-origin paths", async () => {
  const { isSafeManifestUrl } = await import("../dapp/dapp.js");
  for (const good of ["/deployments/testnet-manifest.json", "/a/b.json"]) {
    assert.strictEqual(isSafeManifestUrl(good), true, good);
  }
  for (const bad of [
    "//evil.example/m.json",            // protocol-relative: fetches off-origin
    "https://evil.example/m.json",
    "deployments/m.json",               // relative, so not anchored
    '/x"><img src=x onerror=alert(1)>', // the injection the review found
    "/x<script>",
    "/x with spaces",
    "",
    null,
  ]) {
    assert.strictEqual(isSafeManifestUrl(bad), false, JSON.stringify(bad));
  }
});

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
